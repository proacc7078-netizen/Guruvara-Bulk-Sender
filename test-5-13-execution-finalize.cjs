/*
 * Phase 5.13 - CampaignExecution parent status lifecycle tests.
 *
 * Verifies that the ExecutionQueueWorker aggregates the final state of its
 * recipients back onto the parent CampaignExecution row:
 *   - every recipient delivered          -> parent COMPLETED
 *   - recipients terminal, some FAILED   -> parent FAILED
 *   - any recipient still PENDING/RUNNING (including one waiting for a
 *     scheduled retry)                   -> parent stays open, never finalized
 *   - a parent left PENDING/RUNNING while every recipient is already terminal
 *     (worker interrupted before the aggregate update, or a row created before
 *     the PENDING -> RUNNING transition existed) is repaired by the worker
 *   - terminal parents (COMPLETED/FAILED/CANCELLED) are never re-transitioned
 *
 * Uses a temporary SQLite database and a mocked WhatsApp adapter injected into
 * the existing provider registry: no real WhatsApp message is sent and no
 * provider credentials are used.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

let C = 0;
let F = 0;

function check(name, cond, extra) {
  C++;
  if (!cond) F++;
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (extra !== undefined ? ' | ' + extra : ''));
}

const REPO_ROOT = __dirname;

async function main() {
  console.log('=== Phase 5.13: CampaignExecution parent status lifecycle ===\n');

  const dbPath = path.join(os.tmpdir(), 'exec513-' + Date.now() + '.db');
  process.env.DATABASE_URL = 'file:' + dbPath;
  const { execSync } = require('child_process');
  execSync('npx prisma db push --schema=prisma/schema.prisma --skip-generate', {
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdio: 'pipe',
  });

  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: 'file:' + dbPath } } });

  /* -------- Mocked provider (same registry-patch pattern as 6.0D) -------- */
  const calls = { sendText: [] };
  const permanentFailNumbers = new Set();
  const retryableFailNumbers = new Set();

  const adapter = {
    getStatus: async () => 'CONNECTED',
    connect: async () => { },
    disconnect: async () => { },
    getMessageStatus: async () => 'UNKNOWN',
    sendMedia: async (to, media, caption) => {
      calls.sendText.push({ to, msg: caption, media });
      return { success: true, providerMessageId: 'wamid.MEDIA' };
    },
    sendText: async (to, msg) => {
      calls.sendText.push({ to, msg });
      if (permanentFailNumbers.has(to)) {
        return {
          success: false,
          errorCode: 'WHATSAPP_CONFIGURATION_INVALID',
          errorMessage: 'simulated invalid recipient',
        };
      }
      if (retryableFailNumbers.has(to)) {
        return {
          success: false,
          errorCode: 'WHATSAPP_PROVIDER_UNAVAILABLE',
          errorMessage: 'simulated transient provider failure',
          metaError: { httpStatus: 503 },
        };
      }
      return { success: true, providerMessageId: 'wamid.OK.' + calls.sendText.length };
    },
  };

  // Plain require (NOT a fresh copy) so the patch lands on the very same module
  // instance that executionDelivery.service.js already bound to.
  const providerMod = require('./apps/server/dist/services/whatsapp/WhatsAppAdapter.js');
  const originalGetAdapter = providerMod.whatsappProviderRegistry.getAdapter;
  providerMod.whatsappProviderRegistry.getAdapter = () => adapter;

  const { ExecutionQueueWorker } = require('./apps/server/dist/services/executionQueueWorker.js');

  /* ------------------------------- Seeding ------------------------------ */
  let seq = 0;
  const stamp = Date.now();

  async function newRecipient(tag) {
    seq++;
    return prisma.recipient.create({
      data: {
        name: 'P513 ' + tag + ' ' + seq,
        whatsappNumber: '+1555100' + String(1000 + seq),
        normalizedPhone: 'p513-' + stamp + '-' + seq,
        status: 'ACTIVE',
        source: 'MANUAL',
        consentStatus: 'GRANTED',
      },
    });
  }

  async function addRecipient(executionId, tag, opts) {
    const o = opts || {};
    const recipient = await newRecipient(tag);
    await prisma.campaignExecutionRecipient.create({
      data: {
        executionId,
        recipientId: recipient.id,
        whatsappNumber: recipient.whatsappNumber,
        name: recipient.name,
        status: o.status || 'PENDING',
        providerMessageId: o.providerMessageId || null,
        sentAt: o.sentAt || null,
        attemptCount: o.attemptCount || 0,
        nextAttemptAt: o.nextAttemptAt || null,
      },
    });
    return recipient;
  }

  async function newExecution(tag, opts) {
    const o = opts || {};
    seq++;
    const campaign = await prisma.campaign.create({ data: { name: 'P513 ' + tag + ' ' + seq } });
    const execution = await prisma.campaignExecution.create({
      data: {
        campaignId: campaign.id,
        status: o.status || 'PENDING',
        scheduledAt: new Date(),
        startedAt: o.status === 'RUNNING' ? new Date() : null,
        messageBody: 'P513 body ' + tag,
      },
    });
    const recipient = await addRecipient(execution.id, tag + '-1', o.recipient);
    return { campaign, execution, recipient };
  }

  const executionOf = (id) => prisma.campaignExecution.findUnique({ where: { id } });
  const recipientsOf = (id) => prisma.campaignExecutionRecipient.findMany({ where: { executionId: id } });
  const recipientOf = (executionId, recipientId) =>
    prisma.campaignExecutionRecipient.findUnique({
      where: { executionId_recipientId: { executionId, recipientId } },
    });

  async function reset() {
    await prisma.campaignExecutionRecipient.deleteMany({});
    await prisma.campaignExecution.deleteMany({});
    await prisma.campaign.deleteMany({});
    await prisma.recipient.deleteMany({});
    permanentFailNumbers.clear();
    retryableFailNumbers.clear();
    calls.sendText.length = 0;
  }

  const worker = new ExecutionQueueWorker(60000);
  const futureRetry = () => new Date(Date.now() + 3600000);

  try {
    /* ---------------- Scenario 1: single recipient delivered ---------------- */
    console.log('\n--- Scenario 1: one recipient delivered -> COMPLETED ---');
    await reset();
    const s1 = await newExecution('S1-ok');
    const s1Before = await executionOf(s1.execution.id);
    check('1.1 parent starts PENDING', s1Before.status === 'PENDING', s1Before.status);

    const s1Result = await worker.processCycle();
    const s1Exec = await executionOf(s1.execution.id);
    const s1Recip = await recipientOf(s1.execution.id, s1.recipient.id);
    check('1.2 worker delivered the recipient', s1Result.processed === 1 && s1Result.sent === 1, JSON.stringify(s1Result));
    check('1.3 recipient SENT', s1Recip.status === 'SENT', s1Recip.status);
    check('1.4 parent COMPLETED (not stuck PENDING)', s1Exec.status === 'COMPLETED', s1Exec.status);
    check('1.5 completedAt recorded', !!s1Exec.completedAt);
    check('1.6 PENDING -> RUNNING happened (startedAt set)', !!s1Exec.startedAt);
    check('1.7 failedAt/errorMessage untouched', s1Exec.failedAt === null && s1Exec.errorMessage === null);
    check('1.8 worker counted the completion', s1Result.executionCompleted === 1, s1Result.executionCompleted);

    /* --------------- Scenario 2: two recipients, both delivered ------------ */
    console.log('\n--- Scenario 2: all recipients delivered -> COMPLETED ---');
    await reset();
    const s2 = await newExecution('S2-ok');
    await addRecipient(s2.execution.id, 'S2-ok-2');

    const s2Result = await worker.processCycle();
    const s2Exec = await executionOf(s2.execution.id);
    const s2Recips = await recipientsOf(s2.execution.id);
    check('2.1 both recipients SENT', s2Recips.length === 2 && s2Recips.every((r) => r.status === 'SENT'),
      s2Recips.map((r) => r.status).join(','));
    check('2.2 parent COMPLETED', s2Exec.status === 'COMPLETED', s2Exec.status);
    check('2.3 completion counted once', s2Result.executionCompleted === 1, s2Result.executionCompleted);

    /* ------------------- Scenario 3: mixed success + failure --------------- */
    console.log('\n--- Scenario 3: mixed SENT + FAILED -> FAILED ---');
    await reset();
    const s3 = await newExecution('S3-mixed');
    const s3Second = await addRecipient(s3.execution.id, 'S3-mixed-2');
    permanentFailNumbers.add(s3Second.whatsappNumber);

    const s3Result = await worker.processCycle();
    const s3Exec = await executionOf(s3.execution.id);
    const s3Recips = await recipientsOf(s3.execution.id);
    const s3Statuses = s3Recips.map((r) => r.status).sort().join(',');
    check('3.1 recipients SENT + FAILED', s3Statuses === 'FAILED,SENT', s3Statuses);
    check('3.2 parent FAILED', s3Exec.status === 'FAILED', s3Exec.status);
    check('3.3 failedAt + errorMessage recorded', !!s3Exec.failedAt && !!s3Exec.errorMessage, s3Exec.errorMessage);
    check('3.4 completedAt not set', s3Exec.completedAt === null);
    check('3.5 failure counted once', s3Result.executionFailed === 1, s3Result.executionFailed);

    /* ------------- Scenario 4: retry scheduled -> stays RUNNING ------------ */
    console.log('\n--- Scenario 4: retry scheduled -> parent stays RUNNING ---');
    await reset();
    const s4 = await newExecution('S4-retry');
    const s4Second = await addRecipient(s4.execution.id, 'S4-retry-2');
    retryableFailNumbers.add(s4Second.whatsappNumber);

    await worker.processCycle();
    const s4Exec = await executionOf(s4.execution.id);
    const s4Recips = await recipientsOf(s4.execution.id);
    const s4Ok = s4Recips.find((r) => r.recipientId === s4.recipient.id);
    const s4Pending = s4Recips.find((r) => r.recipientId === s4Second.id);
    check('4.1 first recipient SENT', s4Ok.status === 'SENT', s4Ok.status);
    check('4.2 second recipient PENDING with retry scheduled',
      s4Pending.status === 'PENDING' && !!s4Pending.nextAttemptAt, s4Pending.status);
    check('4.3 parent RUNNING (in progress)', s4Exec.status === 'RUNNING', s4Exec.status);
    check('4.4 parent not finalized', s4Exec.completedAt === null && s4Exec.failedAt === null);

    /* ---------- Scenario 5: retry pending, nothing due -> untouched --------- */
    console.log('\n--- Scenario 5: retry not due yet -> no premature finalize ---');
    await reset();
    const s5 = await newExecution('S5-waiting');
    const s5Second = await addRecipient(s5.execution.id, 'S5-waiting-2');
    // Simulate an execution that already delivered one recipient and left the
    // other one waiting for a scheduled retry.
    await prisma.campaignExecutionRecipient.update({
      where: { executionId_recipientId: { executionId: s5.execution.id, recipientId: s5.recipient.id } },
      data: { status: 'SENT', providerMessageId: 'wamid.PRE', sentAt: new Date() },
    });
    await prisma.campaignExecutionRecipient.update({
      where: { executionId_recipientId: { executionId: s5.execution.id, recipientId: s5Second.id } },
      data: { status: 'PENDING', attemptCount: 1, nextAttemptAt: futureRetry(), errorCode: 'WHATSAPP_PROVIDER_UNAVAILABLE' },
    });

    const s5Result = await worker.processCycle();
    const s5Exec = await executionOf(s5.execution.id);
    const s5Pending = await recipientOf(s5.execution.id, s5Second.id);
    check('5.1 nothing was sent', s5Result.processed === 0 && calls.sendText.length === 0, JSON.stringify(s5Result));
    check('5.2 retry still scheduled', s5Pending.status === 'PENDING' && !!s5Pending.nextAttemptAt);
    check('5.3 parent not COMPLETED/FAILED', s5Exec.status !== 'COMPLETED' && s5Exec.status !== 'FAILED', s5Exec.status);

    /* -------- Scenario 6: repair a parent stuck PENDING, all SENT ---------- */
    console.log('\n--- Scenario 6: repair stuck PENDING parent (all recipients SENT) ---');
    await reset();
    const s6 = await newExecution('S6-repair');
    await addRecipient(s6.execution.id, 'S6-repair-2');
    await prisma.campaignExecutionRecipient.updateMany({
      where: { executionId: s6.execution.id },
      data: { status: 'SENT', providerMessageId: 'wamid.OLD', sentAt: new Date() },
    });

    const s6Result = await worker.processCycle();
    const s6Exec = await executionOf(s6.execution.id);
    check('6.1 nothing re-sent', calls.sendText.length === 0, calls.sendText.length);
    check('6.2 parent COMPLETED', s6Exec.status === 'COMPLETED', s6Exec.status);
    check('6.3 completedAt recorded', !!s6Exec.completedAt);
    check('6.4 repair counted', s6Result.executionCompleted === 1, s6Result.executionCompleted);

    /* ------- Scenario 7: repair a parent stuck PENDING, SENT + FAILED ------ */
    console.log('\n--- Scenario 7: repair stuck PENDING parent (SENT + FAILED) ---');
    await reset();
    const s7 = await newExecution('S7-repair');
    const s7Second = await addRecipient(s7.execution.id, 'S7-repair-2');
    await prisma.campaignExecutionRecipient.update({
      where: { executionId_recipientId: { executionId: s7.execution.id, recipientId: s7.recipient.id } },
      data: { status: 'SENT', providerMessageId: 'wamid.OLD', sentAt: new Date() },
    });
    await prisma.campaignExecutionRecipient.update({
      where: { executionId_recipientId: { executionId: s7.execution.id, recipientId: s7Second.id } },
      data: { status: 'FAILED', errorCode: 'WHATSAPP_CONFIGURATION_INVALID', errorMessage: 'invalid recipient' },
    });

    const s7Result = await worker.processCycle();
    const s7Exec = await executionOf(s7.execution.id);
    check('7.1 parent FAILED', s7Exec.status === 'FAILED', s7Exec.status);
    check('7.2 failedAt + errorMessage recorded', !!s7Exec.failedAt && !!s7Exec.errorMessage);
    check('7.3 failure counted', s7Result.executionFailed === 1, s7Result.executionFailed);

    /* ---- Scenario 8: RUNNING parent with an in-flight recipient -> open --- */
    console.log('\n--- Scenario 8: RUNNING parent + scheduled retry stays open ---');
    await reset();
    const s8 = await newExecution('S8-running', { status: 'RUNNING' });
    const s8Second = await addRecipient(s8.execution.id, 'S8-running-2', {
      status: 'PENDING',
      attemptCount: 1,
      nextAttemptAt: futureRetry(),
      errorCode: 'WHATSAPP_PROVIDER_UNAVAILABLE',
    });
    await prisma.campaignExecutionRecipient.update({
      where: { executionId_recipientId: { executionId: s8.execution.id, recipientId: s8.recipient.id } },
      data: { status: 'SENT', providerMessageId: 'wamid.OLD', sentAt: new Date() },
    });

    await worker.processCycle();
    const s8Exec = await executionOf(s8.execution.id);
    const s8SecondRow = await recipientOf(s8.execution.id, s8Second.id);
    check('8.1 parent still RUNNING', s8Exec.status === 'RUNNING', s8Exec.status);
    check('8.2 retry untouched', s8SecondRow.status === 'PENDING' && !!s8SecondRow.nextAttemptAt);

    /* ---- Scenario 9: execution with no recipients is never finalized ----- */
    console.log('\n--- Scenario 9: recipient-less execution stays PENDING ---');
    await reset();
    seq++;
    const s9Campaign = await prisma.campaign.create({ data: { name: 'P513 S9-empty ' + seq } });
    const s9 = await prisma.campaignExecution.create({
      data: { campaignId: s9Campaign.id, status: 'PENDING', scheduledAt: new Date(), messageBody: 'P513 empty' },
    });
    await worker.processCycle();
    const s9Exec = await executionOf(s9.id);
    check('9.1 recipient-less execution untouched', s9Exec.status === 'PENDING', s9Exec.status);

    /* ---------------- Scenario 10: CANCELLED is never touched ------------- */
    console.log('\n--- Scenario 10: CANCELLED execution stays CANCELLED ---');
    await reset();
    const s10 = await newExecution('S10-cancel', { status: 'CANCELLED' });
    const s10Result = await worker.processCycle();
    const s10Exec = await executionOf(s10.execution.id);
    const s10Recip = await recipientOf(s10.execution.id, s10.recipient.id);
    check('10.1 nothing sent for a cancelled execution', s10Result.processed === 0 && calls.sendText.length === 0);
    check('10.2 parent still CANCELLED', s10Exec.status === 'CANCELLED', s10Exec.status);
    check('10.3 recipient still PENDING (not delivered)', s10Recip.status === 'PENDING', s10Recip.status);

    /* ---- Scenario 11: retries exhausted -> recipient FAILED -> parent ----- */
    console.log('\n--- Scenario 11: retries exhausted -> FAILED ---');
    await reset();
    const s11 = await newExecution('S11-exhausted', { recipient: { attemptCount: 2 } });
    retryableFailNumbers.add(s11.recipient.whatsappNumber);

    await worker.processCycle();
    const s11Exec = await executionOf(s11.execution.id);
    const s11Recip = await recipientOf(s11.execution.id, s11.recipient.id);
    check('11.1 recipient FAILED after max attempts', s11Recip.status === 'FAILED', s11Recip.status);
    check('11.2 parent FAILED', s11Exec.status === 'FAILED', s11Exec.status);

    /* ------------- Scenario 12: terminal parents are never re-opened ------- */
    console.log('\n--- Scenario 12: terminal parent is never re-transitioned ---');
    await reset();
    const s12 = await newExecution('S12-done', { status: 'COMPLETED', recipient: { status: 'SENT', sentAt: new Date() } });
    await worker.processCycle();
    const s12Exec = await executionOf(s12.execution.id);
    check('12.1 COMPLETED parent unchanged', s12Exec.status === 'COMPLETED', s12Exec.status);
    check('12.2 no duplicate sends', calls.sendText.length === 0, calls.sendText.length);
  } catch (error) {
    F++;
    console.error('Error:', error && error.stack ? error.stack : error);
  } finally {
    providerMod.whatsappProviderRegistry.getAdapter = originalGetAdapter;
    await prisma.$disconnect();
    try { fs.unlinkSync(dbPath); } catch { /* best effort */ }
  }

  console.log('\n5.13 Assertions: ' + C + ' | failed: ' + F);
  console.log('=== ' + (F === 0 ? 'All checks passed' : F + ' check(s) FAILED') + ' ===');
  if (F > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('Error:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
