/*
 * Focused regression tests for the four product issues:
 *   1. Bulk selection / bulk actions (recipients, campaigns, messages)
 *   2. History status invariant (READ without DELIVERED)
 *   3. Dashboard real counts
 *   4. Reusable campaigns / Run Again (multiple executions per campaign)
 *
 * Safety: throwaway SQLite DB, mocked provider, no real WhatsApp send.
 * Runs sequentially.
 */
const h = require('./test-5-3-helpers.cjs');
const path = require('path');
const fs = require('fs');
const os = require('os');

let C = 0, F = 0;
const check = (n, c, e) => { C++; if (!c) F++; console.log((c ? 'PASS' : 'FAIL') + ': ' + n + (e ? ' | ' + e : '')); };

let prisma, dbMod, controllerDir, dbPath;
const RECIPIENT_CTRL = 'controllers/recipients.controller.js';
const CAMPAIGN_CTRL = 'controllers/campaigns.controller.js';
const MESSAGE_CTRL = 'controllers/messages.controller.js';
const DASH_CTRL = 'controllers/dashboard.controller.js';
const HOOK_SVC = 'services/whatsapp/whatsappWebhook.service.js';

/** Minimal express req/res double. */
function mockRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function setup() {
  dbPath = path.join(os.tmpdir(), 'prod-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.db');
  process.env.DATABASE_URL = 'file:' + dbPath;
  const { execSync } = require('child_process');
  execSync('npx prisma db push --schema=prisma/schema.prisma --skip-generate', { cwd: h.REPO_ROOT, env: { ...process.env }, stdio: 'pipe' });
  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient({ datasources: { db: { url: 'file:' + dbPath } } });
  dbMod = h.fresh('config/db.js');
  controllerDir = path.join(h.DIST, 'controllers');
}

async function teardown() {
  try { await prisma.$disconnect(); } catch {}
  try { await dbMod.prisma.$disconnect(); } catch {}
  for (const f of [dbPath, dbPath + '-journal']) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} }
}

let seq = 0;
async function seedMessage(status = 'READY') {
  return prisma.message.create({ data: { name: 'M' + (++seq), body: 'body ' + seq, status } });
}
async function seedRecipient(name = 'R') {
  const n = String(Date.now()).slice(-9) + seq;
  return prisma.recipient.create({ data: { name: name + seq, whatsappNumber: '+91' + n, normalizedPhone: '91' + n, status: 'ACTIVE', source: 'MANUAL' } });
}
async function seedCampaign(over = {}) {
  const msg = await seedMessage('READY');
  return prisma.campaign.create({ data: { name: 'C' + (++seq), status: 'READY', messageId: msg.id, ...over } });
}

async function main() {
  console.log('=== Product issues regression ===\n');
  await setup();

  /* ---------------- Issue 2: status invariant ---------------- */
  console.log('--- 2. History status reconciliation ---');
  {
    const svc = h.fresh(HOOK_SVC);
    const resolve = svc.resolveDeliveryStatus;
    check('R1. SENT only -> SENT', resolve({ status: 'SENT', sentAt: new Date(), deliveredAt: null, readAt: null }).status === 'SENT');
    check('R2. DELIVERED -> DELIVERED', resolve({ status: 'SENT', sentAt: new Date(), deliveredAt: new Date(), readAt: null }).status === 'DELIVERED');
    check('R3. READ without DELIVERED -> READ', resolve({ status: 'SENT', sentAt: new Date(), deliveredAt: null, readAt: new Date() }).status === 'READ');
    check('R4. READ after DELIVERED -> READ', resolve({ status: 'DELIVERED', sentAt: new Date(), deliveredAt: new Date(), readAt: new Date() }).status === 'READ');
    check('R5. no evidence keeps current status', resolve({ status: 'PENDING', sentAt: null, deliveredAt: null, readAt: null }).status === 'PENDING');

    // READ without a preceding DELIVERED, through the real webhook path.
    const camp = await seedCampaign();
    const exec = await prisma.campaignExecution.create({ data: { campaignId: camp.id, status: 'RUNNING', scheduledAt: new Date(), messageBody: 'x' } });
    const rec = await seedRecipient();
    await prisma.campaignExecutionRecipient.create({ data: { executionId: exec.id, recipientId: rec.id, whatsappNumber: rec.whatsappNumber, status: 'SENT', providerMessageId: 'wamid.R6', sentAt: new Date() } });

    const readAt = new Date();
    const upd = await svc.updateRecipientStatus(exec.id, rec.id, { providerMessageId: 'wamid.R6', status: 'READ', timestamp: readAt });
    const afterRead = await prisma.campaignExecutionRecipient.findUnique({ where: { executionId_recipientId: { executionId: exec.id, recipientId: rec.id } } });
    check('R6. READ webhook without DELIVERED sets status READ', upd.updated === true && afterRead.status === 'READ' && afterRead.readAt !== null && afterRead.deliveredAt === null, JSON.stringify({ s: afterRead.status, d: afterRead.deliveredAt }));
    const readAtMs = afterRead.readAt.getTime();

    // A stale DELIVERED must not overwrite READ.
    await svc.updateRecipientStatus(exec.id, rec.id, { providerMessageId: 'wamid.R6', status: 'DELIVERED', timestamp: new Date(readAtMs - 5000) });
    const afterStale = await prisma.campaignExecutionRecipient.findUnique({ where: { executionId_recipientId: { executionId: exec.id, recipientId: rec.id } } });
    check('R7. Older DELIVERED cannot overwrite READ', afterStale.status === 'READ', afterStale.status);
    check('R8. readAt is not rewritten by a later event', afterStale.readAt.getTime() === readAtMs);

    // Parent execution reconciliation still works.
    const parentStatus = await svc.recalculateExecutionStatus(exec.id);
    const parent = await prisma.campaignExecution.findUnique({ where: { id: exec.id } });
    check('R9. Parent execution reconciles to COMPLETED', parentStatus === 'COMPLETED' && parent.status === 'COMPLETED', String(parent.status));

    // The delivery path must not downgrade READ to SENT.
    const deliveryMod = h.fresh('services/executionDelivery.service.js');
    const deliverySrc = fs.readFileSync(path.join(h.DIST, 'services/executionDelivery.service.js'), 'utf8');
    check('R10. Delivery path resolves the status instead of writing SENT unconditionally', /resolveDeliveryStatus/.test(deliverySrc) && !/status:\s*'SENT',/.test(deliverySrc));
  }

  /* ---------------- Issue 3: dashboard real counts ---------------- */
  console.log('\n--- 3. Dashboard ---');
  {
    const ctrl = require(path.join(controllerDir, 'dashboard.controller.js'));
    const before = await prisma.recipient.count();
    const res = mockRes();
    await ctrl.getDashboardSummary({} , res);
    check('R11. Dashboard returns real recipient count', res.statusCode === 200 && res.body.data.totals.totalRecipients === before, JSON.stringify({ got: res.body?.data?.totals?.totalRecipients, want: before }));
    check('R12. Dashboard exposes every required metric', ['totalRecipients','activeRecipients','scheduledCampaigns'].every(k => k in res.body.data.totals) && ['sentToday','deliveredToday','readToday','failedToday'].every(k => k in res.body.data.todayCounts) && 'nextScheduledCampaign' in res.body.data);
    check('R13. Dashboard recent activity uses real rows', Array.isArray(res.body.data.recentActivity) && res.body.data.recentActivity.length === 1 && res.body.data.recentActivity[0].status === 'READ', JSON.stringify(res.body.data.recentActivity.map(x => x.status)));
  }

  /* ---------------- Issue 1: bulk actions ---------------- */
  console.log('\n--- 1. Bulk actions ---');
  {
    const recipientsCtrl = require(path.join(controllerDir, 'recipients.controller.js'));
    const a = await seedRecipient('Free');
    const b = await seedRecipient('Ref');
    const camp = await seedCampaign();
    await prisma.campaignRecipient.create({ data: { campaignId: camp.id, recipientId: b.id } });

    const res = mockRes();
    await recipientsCtrl.bulkDeleteRecipients({ body: { ids: [a.id, b.id] } }, res);
    const d = res.body.data;
    check('R14. Bulk delete removes the unprotected recipient', d.deleted.includes(a.id));
    check('R15. Bulk delete refuses a campaign-referenced recipient', d.failed.length === 1 && d.failed[0].id === b.id && d.failed[0].code === 'RECIPIENT_IN_CAMPAIGN', JSON.stringify(d.failed));
    check('R16. Bulk delete reports the exact reason, nothing hidden', /campaign audience/.test(d.failed[0].message) && d.partial === true);
    check('R17. Protected recipient still exists (guard not bypassed)', (await prisma.recipient.findUnique({ where: { id: b.id } })) !== null);
    check('R18. Deleted recipient is gone', (await prisma.recipient.findUnique({ where: { id: a.id } })) === null);

    const empty = mockRes();
    await recipientsCtrl.bulkDeleteRecipients({ body: { ids: [] } }, empty);
    check('R19. Empty selection is rejected', empty.statusCode === 400);
  }
  {
    const campaignsCtrl = require(path.join(controllerDir, 'campaigns.controller.js'));
    const draft = await seedCampaign({ status: 'DRAFT' });
    const used = await seedCampaign();
    const exec = await prisma.campaignExecution.create({ data: { campaignId: used.id, status: 'COMPLETED', scheduledAt: new Date(), messageBody: 'x' } });

    const del = mockRes();
    await campaignsCtrl.bulkDeleteCampaigns({ body: { ids: [draft.id, used.id] } }, del);
    check('R20. Bulk delete removes a campaign with no execution history', del.body.data.succeeded.includes(draft.id));
    check('R21. Bulk delete refuses a campaign with execution history', del.body.data.failed.some(f => f.id === used.id && f.code === 'CAMPAIGN_HAS_EXECUTION_HISTORY'), JSON.stringify(del.body.data.failed.map(f => f.code)));
    check('R22. Execution history is never destroyed by a refused delete', (await prisma.campaignExecution.findUnique({ where: { id: exec.id } })) !== null);

    const arch = mockRes();
    await campaignsCtrl.bulkArchiveCampaigns({ body: { ids: [used.id] } }, arch);
    const after = await prisma.campaign.findUnique({ where: { id: used.id } });
    check('R23. Archive is the safe action for a campaign with history', arch.body.data.succeeded.includes(used.id) && after.status === 'ARCHIVED', after.status);
  }
  {
    const messagesCtrl = require(path.join(controllerDir, 'messages.controller.js'));
    const free = await seedMessage('DRAFT');
    const busy = await seedMessage('READY');
    await prisma.campaign.create({ data: { name: 'UsesMsg' + (++seq), status: 'READY', messageId: busy.id } });

    const del = mockRes();
    await messagesCtrl.bulkDeleteMessages({ body: { ids: [free.id, busy.id] } }, del);
    check('R24. Message bulk delete removes an unused message', del.body.data.succeeded.includes(free.id));
    check('R25. Message bulk delete refuses a message used by a live campaign', del.body.data.failed.some(f => f.id === busy.id && f.code === 'MESSAGE_IN_CAMPAIGN'), JSON.stringify(del.body.data.failed.map(f => f.code)));
    check('R26. Refused message survives', (await prisma.message.findUnique({ where: { id: busy.id } })) !== null);

    const arch = mockRes();
    await messagesCtrl.bulkArchiveMessages({ body: { ids: [busy.id] } }, arch);
    check('R27. Message archive is safe', arch.body.data.succeeded.includes(busy.id) && (await prisma.message.findUnique({ where: { id: busy.id } })).status === 'ARCHIVED');
  }

  /* ---------------- Issue 4: reusable campaigns ---------------- */
  console.log('\n--- 4. Reusable campaigns / Run Again ---');
  {
    const util = h.fresh('utils/campaignExecution.util.js');
    const camp = await seedCampaign();
    const rec = await seedRecipient('Run');
    await prisma.campaignRecipient.create({ data: { campaignId: camp.id, recipientId: rec.id } });
    const sched = await prisma.campaignSchedule.create({ data: { campaignId: camp.id, scheduledAt: new Date(), timezone: 'Asia/Kolkata', status: 'SCHEDULED' } });

    const first = await util.createExecutionSnapshot(camp.id);
    check('R28. First run creates an execution', first.ok === true && first.execution.id, JSON.stringify(first.ok === false ? first.error : {}));
    const firstId = first.execution.id;
    const firstRecipients = await prisma.campaignExecutionRecipient.findMany({ where: { executionId: firstId } });
    const firstBody = first.execution.messageBody;

    const second = await util.createExecutionSnapshot(camp.id, { allowRerun: true });
    check('R29. Run Again creates a SECOND execution for the same campaign', second.ok === true && second.execution.id !== firstId, JSON.stringify({ ok: second.ok === true, same: second.ok === true && second.execution.id === firstId }));
    const secondId = second.execution.id;
    check('R30. Both executions belong to the same campaign', (await prisma.campaignExecution.count({ where: { campaignId: camp.id } })) === 2);

    const firstAfter = await prisma.campaignExecution.findUnique({ where: { id: firstId } });
    const firstRecipientsAfter = await prisma.campaignExecutionRecipient.findMany({ where: { executionId: firstId } });
    check('R31. Previous execution remains immutable', firstAfter.status === first.execution.status && firstAfter.messageBody === firstBody && firstRecipientsAfter.length === firstRecipients.length);
    check('R32. New execution has its own recipient snapshot', (await prisma.campaignExecutionRecipient.count({ where: { executionId: secondId } })) === 1);
    check('R33. The campaign record itself was not cloned', (await prisma.campaign.count({ where: { name: camp.name } })) === 1);
    check('R34. Default (non-rerun) path is still idempotent', (await util.createExecutionSnapshot(camp.id)).ok === true && (await prisma.campaignExecution.count({ where: { campaignId: camp.id } })) === 2);
  }

  await teardown();
  console.log('\nAssertions: ' + C + ' | failed: ' + F);
  if (F > 0) process.exitCode = 1;
}

main().catch(async (e) => { console.error(e.stack || e); try { await teardown(); } catch {} process.exitCode = 1; });
