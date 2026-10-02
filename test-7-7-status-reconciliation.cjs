/*
 * Phase 7.7 — Execution status reconciliation + recipient refresh regressions.
 *
 * Covers the real defects found:
 *  - Parent execution stayed PENDING after a manual send.
 *  - PENDING/RUNNING -> SENT -> DELIVERED -> READ progression.
 *  - FAILED must remain supported; older status must not overwrite newer.
 *  - History reflects the reconciled state.
 *  - Safe test-recipient cleanup (campaign-referenced recipients stay protected).
 *  - Recipients page exposes a Refresh action.
 *
 * Safety: throwaway SQLite DB, no real send, no reset. Runs sequentially.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const dotenv = require('dotenv');
const argon2 = require('argon2');

const REPO_ROOT = __dirname;
dotenv.config({ path: path.join(REPO_ROOT, '.env') });

const TEST_PORT = 3161;
const BASE = 'http://127.0.0.1:' + TEST_PORT;
const RUN = String(Date.now()).slice(-6);

process.env.PORT = String(TEST_PORT);
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'phase77-verify';
process.env.WHATSAPP_APP_SECRET = 'phase77-appsecret';
process.env.WHATSAPP_PROVIDER = 'none';
process.env.WHATSAPP_OPENWA_WEBHOOK_SECRET = 'phase77-openwa-secret';
process.env.SCHEDULER_POLL_INTERVAL_MS = '999900';
process.env.WORKER_POLL_INTERVAL_MS = '999900';

let checks = 0;
let failures = 0;
let server = null;
let prisma = null;
let cookie = '';
const createdUserIds = [];

function check(name, cond, extra) {
  checks++;
  if (!cond) failures++;
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (extra ? ' | ' + extra : ''));
}

function readSource(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

async function waitForServer(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function request(method, url, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text();
  let j = null;
  try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, json: j };
}

async function login() {
  const email = 'phase77-' + RUN + '@example.com';
  const password = 'Phase77-' + RUN + '-pw!';
  const created = await prisma.user.create({ data: { email, password: await argon2.hash(password) } });
  createdUserIds.push(created.id);
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return !!cookie;
}

const pmid = (n) => 'wamid.phase77.' + n;
const phone = (n) => '9' + RUN + String(1000 + n);

async function seedCampaign(label, phones) {
  const msg = await prisma.message.create({ data: { name: 'P77 msg ' + label, body: 'P77 body ' + label, status: 'DRAFT' } });
  const camp = await prisma.campaign.create({ data: { name: 'P77 ' + label, messageId: msg.id, status: 'DRAFT' } });
  for (const p of phones) {
    const r = await prisma.recipient.create({ data: { name: 'P77 R ' + label, whatsappNumber: p, normalizedPhone: p, status: 'ACTIVE', source: 'MANUAL' } });
    await prisma.campaignRecipient.create({ data: { campaignId: camp.id, recipientId: r.id } });
  }
  await prisma.campaign.update({ where: { id: camp.id }, data: { status: 'READY' } });
  await prisma.campaignSchedule.create({ data: { campaignId: camp.id, scheduledAt: new Date(), timezone: 'Asia/Kolkata', status: 'SCHEDULED' } });
  return { campaignId: camp.id };
}

async function seedExecution(campaignId, initialExecStatus, initialRecipStatus, seq) {
  const p = phone(100 + seq);
  return prisma.campaignExecution.create({
    data: {
      campaignId,
      status: initialExecStatus,
      scheduledAt: new Date(),
      startedAt: initialExecStatus === 'RUNNING' ? new Date() : null,
      messageBody: 'P77 body',
      recipients: {
        create: {
          recipient: { create: { name: 'P77 exec R ' + seq, whatsappNumber: p, normalizedPhone: p, status: 'ACTIVE', source: 'MANUAL' } },
          whatsappNumber: p,
          name: 'P77 exec R ' + seq,
          status: initialRecipStatus,
        },
      },
    },
    include: { recipients: true },
  });
}

async function main() {
  console.log('=== Phase 7.7: execution status reconciliation + recipient refresh ===\n');
  const dbPath = path.join(os.tmpdir(), 'exec77-' + Date.now() + '.db');
  process.env.DATABASE_URL = 'file:' + dbPath;

  const { execSync } = require('child_process');
  execSync('npx prisma db push --schema=prisma/schema.prisma --skip-generate', {
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdio: 'pipe',
  });
  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient({ datasources: { db: { url: 'file:' + dbPath } } });

  const originalListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    server = this;
    return originalListen.apply(this, args);
  };
  require('tsx/cjs');
  const indexModule = require('./apps/server/src/index.ts');
  const up = await waitForServer(25000);
  check('S0. Server reachable on an isolated DB', up, BASE);
  if (!up) { process.exitCode = 1; return; }

  try {
    check('S0b. Admin can authenticate', await login());

    const svc = require('./apps/server/dist/services/whatsapp/whatsappWebhook.service.js');
    const recipientSrc = readSource('apps/web/src/pages/Recipients.tsx');
    const controllerSrc = readSource('apps/server/src/controllers/campaignExecution.controller.ts');
    const webhookSvcSrc = readSource('apps/server/src/services/whatsapp/whatsappWebhook.service.ts');

    /* ---------- Recipients Refresh button ---------- */
    check('F1. Recipients page renders a Refresh button', /handleRefresh/.test(recipientSrc) && /Refresh/.test(recipientSrc));
    check('F2. Refresh refetches through the existing data path (no full reload)',
      /const handleRefresh[\s\S]{0,400}fetchRecipients\(/.test(recipientSrc) && !/window\.location\.reload/.test(recipientSrc));
    check('F3. Refresh preserves search/filter state',
      /handleRefresh[\s\S]{0,500}status:\s*statusFilter[\s\S]{0,200}language:\s*languageFilter[\s\S]{0,200}tagId:\s*tagFilter/.test(recipientSrc));
    check('F4. Refresh shows loading feedback and disables while loading',
      /disabled=\{loading\}/.test(recipientSrc) && /Refreshing/.test(recipientSrc) && /animate-spin/.test(recipientSrc));
    check('F5. No polling was introduced on the Recipients page', !/setInterval/.test(recipientSrc));

    /* ---------- Safe test-recipient cleanup ---------- */
    await seedCampaign('cleanup', [phone(10)]);
    const referenced = (await prisma.recipient.findMany({ where: { normalizedPhone: phone(10) } }))[0];
    const delReferenced = await request('DELETE', '/api/recipients/' + referenced.id);
    check('C1. Recipient in a campaign audience is protected from deletion',
      delReferenced.status === 409 && delReferenced.json?.error?.code === 'RECIPIENT_IN_CAMPAIGN',
      delReferenced.status + ' ' + JSON.stringify(delReferenced.json?.error?.code));
    check('C2. Protected recipient is NOT removed by the failed delete',
      !!(await prisma.recipient.findUnique({ where: { id: referenced.id } })));

    const orphan = await prisma.recipient.create({
      data: { name: 'P77 orphan', whatsappNumber: phone(11), normalizedPhone: phone(11), status: 'ACTIVE', source: 'MANUAL', category: 'Phase77Test' },
    });
    const delOrphan = await request('DELETE', '/api/recipients/' + orphan.id);
    const goneAfter = await prisma.recipient.findUnique({ where: { id: orphan.id } });
    check('C3. Unreferenced test recipient CAN be deleted', delOrphan.status === 200 && goneAfter === null, delOrphan.status);

    /* ---------- Status progression via the webhook service ---------- */
    const { campaignId: c1 } = await seedCampaign('progress', [phone(20)]);
    const ex1 = await seedExecution(c1, 'RUNNING', 'PENDING', 1);
    const key1 = { executionId: ex1.id, recipientId: ex1.recipients[0].recipientId };
    const getRow = () => prisma.campaignExecutionRecipient.findUnique({ where: { executionId_recipientId: key1 } });

    let res = await svc.updateRecipientStatus(ex1.id, key1.recipientId, { providerMessageId: pmid(1), status: 'SENT' });
    let row = await getRow();
    check('W1. PENDING/RUNNING -> SENT', res.updated === true && row.status === 'SENT', row.status);

    res = await svc.updateRecipientStatus(ex1.id, key1.recipientId, { providerMessageId: pmid(1), status: 'DELIVERED', timestamp: new Date() });
    row = await getRow();
    check('W2. SENT -> DELIVERED records deliveredAt', res.updated === true && row.status === 'DELIVERED' && !!row.deliveredAt, row.status);

    res = await svc.updateRecipientStatus(ex1.id, key1.recipientId, { providerMessageId: pmid(1), status: 'READ', timestamp: new Date() });
    row = await getRow();
    check('W3. DELIVERED -> READ records readAt', res.updated === true && row.status === 'READ' && !!row.readAt, row.status);

    const firstDelivered = row.deliveredAt.getTime();
    res = await svc.updateRecipientStatus(ex1.id, key1.recipientId, { providerMessageId: pmid(1), status: 'DELIVERED', timestamp: new Date(Date.now() + 60000) });
    row = await getRow();
    check('W4. Older DELIVERED cannot overwrite newer READ', res.updated === false && row.status === 'READ', row.status);
    check('W5. First-wins timestamps are not rewritten', row.deliveredAt.getTime() === firstDelivered && !!row.readAt, 'deliveredAt preserved');

    /* ---------- Parent execution recalculation ---------- */
    let newStatus = await svc.recalculateExecutionStatus(ex1.id);
    let exRow = await prisma.campaignExecution.findUnique({ where: { id: ex1.id } });
    check('P1. Parent RUNNING + terminal recipient -> COMPLETED', newStatus === 'COMPLETED' && exRow.status === 'COMPLETED', exRow.status);

    // THE BUG: parent still PENDING while the recipient is already terminal.
    const { campaignId: c2 } = await seedCampaign('stale', [phone(30)]);
    const ex2 = await seedExecution(c2, 'PENDING', 'SENT', 2);
    newStatus = await svc.recalculateExecutionStatus(ex2.id);
    exRow = await prisma.campaignExecution.findUnique({ where: { id: ex2.id } });
    check('P2. Parent PENDING + terminal recipient is finalized (was stuck PENDING)',
      newStatus === 'COMPLETED' && exRow.status === 'COMPLETED', newStatus + '/' + exRow.status);
    check('P3. Promoted parent gets startedAt set', !!exRow.startedAt, String(exRow.startedAt));

    const { campaignId: c3 } = await seedCampaign('failed', [phone(40)]);
    const ex3 = await seedExecution(c3, 'PENDING', 'FAILED', 3);
    newStatus = await svc.recalculateExecutionStatus(ex3.id);
    exRow = await prisma.campaignExecution.findUnique({ where: { id: ex3.id } });
    check('P4. PENDING parent + FAILED recipient -> FAILED (FAILED still supported)',
      newStatus === 'FAILED' && exRow.status === 'FAILED', newStatus + '/' + exRow.status);

    const { campaignId: c4 } = await seedCampaign('inflight', [phone(50)]);
    const ex4 = await seedExecution(c4, 'RUNNING', 'PENDING', 4);
    newStatus = await svc.recalculateExecutionStatus(ex4.id);
    exRow = await prisma.campaignExecution.findUnique({ where: { id: ex4.id } });
    check('P5. Non-terminal recipient leaves the parent RUNNING', newStatus === null && exRow.status === 'RUNNING', exRow.status);

    /* ---------- History reflects the reconciled state ---------- */
    const hist = await request('GET', '/api/history?limit=50');
    const items = hist.json?.data?.items || [];
    const hEx1 = items.find((i) => i.executionId === ex1.id);
    const hEx2 = items.find((i) => i.executionId === ex2.id);
    check('H1. History list reflects READ for the webhook-updated recipient', !!hEx1 && hEx1.status === 'READ', hEx1?.status);
    check('H2. History exposes webhookErrorCode (null on success)', !!hEx1 && 'webhookErrorCode' in hEx1 && hEx1.webhookErrorCode === null);
    const detail = await request('GET', '/api/history/' + ex1.id + ':' + key1.recipientId);
    check('H3. History detail reflects the reconciled execution',
      detail.json?.data?.snapshot?.status === 'READ' && detail.json?.data?.execution?.status === 'COMPLETED',
      detail.json?.data?.snapshot?.status + '/' + detail.json?.data?.execution?.status);
    check('H4. Previously-stale execution appears finalized in History', !!hEx2 && hEx2.status === 'SENT');

    /* ---------- Manual send path reconciles the parent ---------- */
    check('S1. Manual send endpoint calls recalculateExecutionStatus', /recalculateExecutionStatus\(executionId\)/.test(controllerSrc));
    check('S2. Manual send returns the reconciled executionStatus', /executionStatus/.test(controllerSrc));
    check('S3. recalculate handles PENDING (not only RUNNING)', /currentExecStatus === 'PENDING'/.test(webhookSvcSrc));
  } catch (error) {
    failures++;
    console.error('Unexpected test error:', error && error.stack ? error.stack : error);
  } finally {
    for (const id of createdUserIds) {
      try { await prisma.user.delete({ where: { id } }); } catch {}
    }
    try {
      await prisma.campaignExecutionRecipient.deleteMany({});
      await prisma.campaignExecution.deleteMany({});
      await prisma.campaignSchedule.deleteMany({});
      await prisma.campaignRecipient.deleteMany({});
      await prisma.campaign.deleteMany({});
      await prisma.message.deleteMany({ where: { name: { startsWith: 'P77' } } });
      await prisma.recipient.deleteMany({ where: { name: { startsWith: 'P77' } } });
    } catch {}
  }

  console.log('\nAssertions run: ' + checks + ' | failed: ' + failures);
  console.log('=== ' + (failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED') + ' ===');
  process.exitCode = failures === 0 ? 0 : 1;

  if (server) await new Promise((r) => server.close(r));
  if (indexModule.worker) { try { await indexModule.worker.stop(); } catch {} }
  if (indexModule.scheduler) { try { await indexModule.scheduler.stop(); } catch {} }
  try { await prisma.$disconnect(); } catch {}
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + '-journal'); } catch {}
}

main().catch((error) => {
  console.error('Error:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
