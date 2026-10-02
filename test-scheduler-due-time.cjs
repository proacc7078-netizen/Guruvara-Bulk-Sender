/*
 * Scheduler / queue correctness regression — "no delivery before scheduledAt".
 *
 * Bug: a campaign scheduled for 12:20 was delivered at 12:17.
 * Root cause: the queue worker selected PENDING execution-recipient rows
 * without ever comparing execution.scheduledAt to the clock, so an execution
 * prepared in advance was delivered immediately.
 *
 * Safety:
 * - Throwaway SQLite DB in the OS temp dir (prisma db push).
 * - The WhatsApp adapter is always a mock: no real message is ever sent.
 * - The clock is injected; nothing waits on real time. Tests run sequentially.
 */
const h = require('./test-5-3-helpers.cjs');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

let C = 0, F = 0;
const check = (n, c, e) => { C++; if (!c) F++; console.log((c ? 'PASS' : 'FAIL') + ': ' + n + (e ? ' | ' + e : '')); };

const TZ = 'Asia/Calcutta';
// A wall clock comfortably in the future, used only for timezone-resolution checks.
const TZ_DATE = '2027-06-15';
const TZ_EXPECT = Date.UTC(2027, 5, 14, 18, 50, 0); // 2027-06-15 00:20 IST
// 00:20 IST wall clock, expressed as the UTC instant the system stores.
const DUE_AT = Date.UTC(2026, 0, 15, 18, 50, 0);

let prisma, workerMod, providerDist, dbMod, dbPath;
const calls = { sendText: [], sendMedia: [] };

function mockAdapter() {
  const inst = {
    getStatus: async () => 'CONNECTED',
    connect: async () => {}, disconnect: async () => {},
    sendText: async (to, msg) => { calls.sendText.push({ to, msg }); return { success: true, providerMessageId: 'wamid.SCHED' }; },
    sendMedia: async (to, media, caption) => { calls.sendMedia.push({ to, media, caption }); return { success: true, providerMessageId: 'wamid.SCHED' }; },
    getMessageStatus: async () => 'UNKNOWN',
  };
  Object.defineProperty(inst, 'constructor', { value: { name: 'OpenWAWhatsAppAdapter' }, configurable: true });
  return inst;
}

async function seedCampaign({ scheduledAt, scheduleStatus = 'SCHEDULED', consumedAt = null }) {
  const message = await prisma.message.create({ data: { name: 'Msg ' + Date.now(), body: 'Scheduled body', status: 'READY' } });
  const campaign = await prisma.campaign.create({ data: { name: 'C ' + Date.now(), status: 'READY', messageId: message.id } });
  const recipient = await prisma.recipient.create({ data: { name: 'R', whatsappNumber: '+1555000' + Math.floor(Math.random() * 1e6), normalizedPhone: '1555' + Date.now() + Math.floor(Math.random() * 1e6), status: 'ACTIVE', source: 'MANUAL' } });
  await prisma.campaignRecipient.create({ data: { campaignId: campaign.id, recipientId: recipient.id } });
  const schedule = await prisma.campaignSchedule.create({ data: { campaignId: campaign.id, scheduledAt: new Date(scheduledAt), timezone: TZ, status: scheduleStatus, consumedAt } });
  return { message, campaign, recipient, schedule };
}

/** Creates the PENDING execution + recipient rows the scheduler/manual path would create. */
async function seedExecution(fx, status = 'PENDING') {
  const exec = await prisma.campaignExecution.create({
    data: {
      campaignId: fx.campaign.id, scheduleId: fx.schedule.id, status,
      scheduledAt: fx.schedule.scheduledAt, messageId: fx.message.id,
      messageName: fx.message.name, messageBody: fx.message.body,
    },
  });
  const er = await prisma.campaignExecutionRecipient.create({
    data: { executionId: exec.id, recipientId: fx.recipient.id, whatsappNumber: fx.recipient.whatsappNumber, name: fx.recipient.name, status: 'PENDING' },
  });
  return { exec, er };
}

const rowOf = (exec, er) => prisma.campaignExecutionRecipient.findUnique({
  where: { executionId_recipientId: { executionId: exec.id, recipientId: er.recipientId } },
});
const execOf = (id) => prisma.campaignExecution.findUnique({ where: { id } });

/** Pins Date.now()/new Date() to `nowMs` and runs one worker cycle. */
async function cycleAt(nowMs) {
  const RealDate = Date;
  global.Date = class extends RealDate {
    constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(nowMs); }
    static now() { return nowMs; }
  };
  try {
    return await new workerMod.ExecutionQueueWorker(60000).processCycle();
  } finally {
    global.Date = RealDate;
  }
}

async function main() {
  console.log('=== Scheduler due-time enforcement ===\n');
  await setup();
  const fiveMinEarly = DUE_AT - 5 * 60 * 1000;

  /* 1. Scheduled 5 minutes in the future: the worker must not send. */
  {
    const fx = await seedCampaign({ scheduledAt: DUE_AT });
    const s = await seedExecution(fx);
    const r = await cycleAt(fiveMinEarly);
    const row = await rowOf(s.exec, s.er);
    check('1. Future schedule (+5 min): no WhatsApp adapter call', calls.sendText.length === 0 && calls.sendMedia.length === 0, JSON.stringify({ r }));
    check('2. Future schedule: recipient stays PENDING', row.status === 'PENDING', row.status);
    check('3. Future schedule: no retry consumed (attemptCount stays 0)', row.attemptCount === 0, String(row.attemptCount));
    check('4. Future schedule: no nextAttemptAt (not treated as a failure)', row.nextAttemptAt === null, String(row.nextAttemptAt));
    check('5. Future schedule: execution not started', (await execOf(s.exec.id)).startedAt === null);
  }

  /* 2. Once scheduledAt is reached, the worker delivers. */
  {
    const pending = await prisma.campaignExecutionRecipient.findMany({ where: { status: 'PENDING' }, select: { executionId: true } });
    const r = await cycleAt(DUE_AT);
    const rows = await prisma.campaignExecutionRecipient.findMany({ where: { executionId: { in: pending.map(p => p.executionId) } } });
    check('6. At scheduledAt: worker delivers exactly once', calls.sendText.length === 1 && calls.sendMedia.length === 0, JSON.stringify({ sendText: calls.sendText.length, sent: r.sent }));
    check('7. At scheduledAt: recipient is SENT', rows.every(x => x.status === 'SENT'), JSON.stringify(rows.map(x => x.status)));
  }

  /* 3. Restart/recovery must not deliver a future campaign early. */
  {
    calls.sendText.length = 0; calls.sendMedia.length = 0;
    const fx = await seedCampaign({ scheduledAt: DUE_AT + 60 * 60 * 1000 });
    const s = await seedExecution(fx);
    await cycleAt(DUE_AT + 30 * 60 * 1000);
    await cycleAt(DUE_AT + 59 * 60 * 1000);
    check('8. Restart before due time does not send early', calls.sendText.length === 0, JSON.stringify({ sendText: calls.sendText.length }));
    const ex = await execOf(s.exec.id);
    check('9. Restart before due time leaves execution PENDING/unstarted', ex.status === 'PENDING' && ex.startedAt === null, ex.status);
    const r = await cycleAt(DUE_AT + 61 * 60 * 1000);
    check('10. Restart after due time still delivers', calls.sendText.length === 1 && r.sent === 1, JSON.stringify({ sendText: calls.sendText.length, sent: r.sent }));
  }

  /* 4. Cancelling a future schedule prevents delivery. */
  {
    calls.sendText.length = 0; calls.sendMedia.length = 0;
    const fx = await seedCampaign({ scheduledAt: DUE_AT + 3 * 60 * 60 * 1000 });
    const s = await seedExecution(fx);
    await prisma.campaignExecution.update({ where: { id: s.exec.id }, data: { status: 'CANCELLED' } });
    await cycleAt(DUE_AT + 4 * 60 * 60 * 1000);
    check('11. Cancelled future execution is never sent', calls.sendText.length === 0, JSON.stringify({ sendText: calls.sendText.length }));
  }

  /* 5. Editing a future schedule moves the actual execution timing. */
  {
    calls.sendText.length = 0; calls.sendMedia.length = 0;
    const fx = await seedCampaign({ scheduledAt: DUE_AT + 5 * 60 * 60 * 1000 });
    const s = await seedExecution(fx);
    const newDue = DUE_AT + 6 * 60 * 60 * 1000;
    await prisma.campaignExecution.update({ where: { id: s.exec.id }, data: { scheduledAt: new Date(newDue) } });
    await prisma.campaignSchedule.update({ where: { id: fx.schedule.id }, data: { scheduledAt: new Date(newDue) } });
    await cycleAt(newDue - 60 * 1000);
    check('12. Edited (moved later) schedule does not send at the old time', calls.sendText.length === 0 && (await rowOf(s.exec, s.er)).status === 'PENDING');
    await cycleAt(newDue);
    check('13. Edited schedule sends at the new time', calls.sendText.length === 1, JSON.stringify({ sendText: calls.sendText.length }));
  }

  /* 6. Manual send remains immediate even for a future schedule. */
  {
    calls.sendText.length = 0; calls.sendMedia.length = 0;
    const fx = await seedCampaign({ scheduledAt: DUE_AT + 10 * 60 * 60 * 1000 });
    const s = await seedExecution(fx);
    const svc = h.fresh('services/executionDelivery.service.js');
    const RealDate = Date;
    global.Date = class extends RealDate {
      constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(DUE_AT); }
      static now() { return DUE_AT; }
    };
    let out;
    try {
      out = await new svc.ExecutionDeliveryService().sendExecutionRecipient(s.exec.id + ':' + fx.recipient.id);
    } finally { global.Date = RealDate; }
    check('14. Manual send sends immediately despite a future schedule', out.success === true && calls.sendText.length === 1, JSON.stringify({ ok: out && out.success, sendText: calls.sendText.length }));
    check('15. Manual send marks the recipient SENT', (await rowOf(s.exec, s.er)).status === 'SENT');
  }

  /* 7. Repeated cycles on a future execution consume no retries. */
  {
    calls.sendText.length = 0;
    const fx = await seedCampaign({ scheduledAt: DUE_AT + 20 * 60 * 60 * 1000 });
    const s = await seedExecution(fx);
    for (let i = 0; i < 5; i++) await cycleAt(DUE_AT + i * 60 * 1000);
    const row = await rowOf(s.exec, s.er);
    const ex = await execOf(s.exec.id);
    check('16. Repeated cycles on a future execution consume no retries', row.attemptCount === 0 && row.status === 'PENDING' && ex.attemptCount === 0, JSON.stringify({ a: row.attemptCount, s: row.status, ea: ex.attemptCount }));
  }

  /* 8. Timezone handling for Asia/Calcutta / Asia/Kolkata. */
  {
    const util = h.fresh('utils/campaignSchedule.util.js');
    const res = util.validateScheduleInput({ scheduledAt: TZ_DATE + 'T00:20', timezone: TZ });
    check('17. 00:20 Asia/Calcutta resolves to the correct UTC instant', res.valid === true && res.value.scheduledAt.getTime() === TZ_EXPECT, res.valid ? new Date(res.value.scheduledAt).toISOString() : JSON.stringify(res.issues));
    const kolkata = util.validateScheduleInput({ scheduledAt: TZ_DATE + 'T00:20', timezone: 'Asia/Kolkata' });
    check('18. Asia/Kolkata is equivalent to Asia/Calcutta for this instant', kolkata.valid === true && kolkata.value.scheduledAt.getTime() === TZ_EXPECT, kolkata.valid ? new Date(kolkata.value.scheduledAt).toISOString() : JSON.stringify(kolkata.issues));
    const past = util.validateScheduleInput({ scheduledAt: '2020-01-16T00:20', timezone: TZ });
    check('19. A past schedule is still rejected by existing validation', past.valid === false && past.issues[0].code === 'SCHEDULE_IN_PAST');
  }

  /* 9. The scheduler's own due query remains due-only. */
  {
    const fx = await seedCampaign({ scheduledAt: DUE_AT + 40 * 60 * 60 * 1000, consumedAt: null });
    const schedMod = h.fresh('services/campaignScheduler.service.js');
    const future = new schedMod.CampaignSchedulerService(60000, async () => {}, () => new Date(DUE_AT));
    const r1 = await future.processDueSchedules();
    check('20. Scheduler ignores a future schedule', r1.executed === 0, JSON.stringify({ e: r1.executed, s: r1.scanned }));
    const past = new schedMod.CampaignSchedulerService(60000, async () => {}, () => new Date(fx.schedule.scheduledAt.getTime() + 1000));
    const r2 = await past.processDueSchedules();
    check('21. Scheduler consumes a due schedule', r2.executed === 1, JSON.stringify({ e: r2.executed, s: r2.scanned }));
  }

  await teardown();
  console.log('\nAssertions: ' + C + ' | failed: ' + F);
  if (F > 0) process.exitCode = 1;
}

main().catch(async (e) => { console.error(e.stack || e); try { await teardown(); } catch {} process.exitCode = 1; });

async function setup() {
  dbPath = path.join(os.tmpdir(), 'sched-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.db');
  process.env.DATABASE_URL = 'file:' + dbPath;
  const { execSync } = require('child_process');
  execSync('npx prisma db push --schema=prisma/schema.prisma --skip-generate', { cwd: h.REPO_ROOT, env: { ...process.env }, stdio: 'pipe' });
  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient({ datasources: { db: { url: 'file:' + dbPath } } });
  dbMod = h.fresh('config/db.js');
  workerMod = h.fresh('services/executionQueueWorker.js');
  providerDist = require(path.join(h.DIST, 'services/whatsapp/WhatsAppAdapter.js'));
  providerDist.whatsappProviderRegistry.getAdapter = () => mockAdapter();
}

async function teardown() {
  try { await prisma.$disconnect(); } catch {}
  try { await dbMod.prisma.$disconnect(); } catch {}
  for (const f of [dbPath, dbPath + '-journal']) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} }
}
