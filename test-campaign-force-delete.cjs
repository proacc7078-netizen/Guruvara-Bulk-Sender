/*
 * Campaign force-delete ("Delete permanently") focused tests.
 *
 * Safety: throwaway SQLite DB in os.tmpdir() via `prisma db push`. No
 * migrate/reset, the development database is never touched. Sequential.
 */
const h = require('./test-5-3-helpers.cjs');
const path = require('path');
const fs = require('fs');
const os = require('os');

let C = 0, F = 0;
const check = (n, c, e) => { C++; if (!c) F++; console.log((c ? 'PASS' : 'FAIL') + ': ' + n + (e ? ' | ' + e : '')); };

const CAMPAIGN_CTRL = 'controllers/campaigns.controller.js';
const CAMPAIGN_DEL_SVC = 'services/campaignDelete.service.js';
const CAMPAIGNS_PAGE = path.join(h.REPO_ROOT, 'apps/web/src/pages/Campaigns.tsx');

let prisma, dbPath, campaignsCtrl;

function mockReq(o) {
  return Object.assign({ params: {}, query: {}, body: {}, ip: '127.0.0.1', session: {} }, o || {});
}
function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function setup() {
  dbPath = path.join(os.tmpdir(), 'cdel-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.db');
  process.env.DATABASE_URL = 'file:' + dbPath;
  const { execSync } = require('child_process');
  execSync('npx prisma db push --schema=prisma/schema.prisma --skip-generate', {
    cwd: h.REPO_ROOT, env: { ...process.env }, stdio: 'pipe',
  });
  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient({ datasources: { db: { url: 'file:' + dbPath } } });
  dbMod = h.fresh('config/db.js');
  campaignsCtrl = h.fresh(CAMPAIGN_CTRL);
}
/** Campaign + message + media + audience + schedule + one execution per status. */
async function seed(statuses) {
  const s = Math.random().toString(36).slice(2, 8);
  const message = await prisma.message.create({
    data: { name: 'MSG ' + s, body: 'hello ' + s, status: 'READY' },
  });
  const media = await prisma.media.create({
    data: { messageId: message.id, filename: s + '.png', mimeType: 'image/png', size: 10, storagePath: path.join(os.tmpdir(), s + '.png') },
  });
  const campaign = await prisma.campaign.create({
    data: { name: 'CAMP ' + s, messageId: message.id, status: 'READY' },
  });
  const r1 = await prisma.recipient.create({ data: { name: 'R1 ' + s, whatsappNumber: '90' + Math.floor(Math.random() * 1e9), normalizedPhone: '8' + Math.floor(Math.random() * 1e10), source: 'TEST' } });
  const r2 = await prisma.recipient.create({ data: { name: 'R2 ' + s, whatsappNumber: '90' + Math.floor(Math.random() * 1e9), normalizedPhone: '7' + Math.floor(Math.random() * 1e10), source: 'TEST' } });
  await prisma.campaignRecipient.createMany({
    data: [{ campaignId: campaign.id, recipientId: r1.id }, { campaignId: campaign.id, recipientId: r2.id }],
  });
  const schedule = await prisma.campaignSchedule.create({
    data: { campaignId: campaign.id, scheduledAt: new Date(Date.now() + 86400000), timezone: 'Asia/Kolkata', status: 'SCHEDULED' },
  });
  const executions = [];
  for (const status of statuses) {
    const ex = await prisma.campaignExecution.create({
      data: {
        campaignId: campaign.id, scheduleId: schedule.id, status, scheduledAt: new Date(),
        messageId: message.id, messageName: message.name, messageBody: message.body,
        mediaId: media.id, mediaPath: media.storagePath,
      },
    });
    for (const r of [r1, r2]) {
      await prisma.campaignExecutionRecipient.create({
        data: {
          executionId: ex.id, recipientId: r.id, whatsappNumber: r.whatsappNumber, name: r.name,
          status: status === 'CANCELLED' ? 'CANCELLED' : 'DELIVERED',
          providerMessageId: 'wamid-' + s, deliveredAt: new Date(), readAt: new Date(),
        },
      });
    }
    executions.push(ex);
  }
  return { campaign, message, media, schedule, r1, r2, executions };
}

async function teardown() {
  try { await prisma.$disconnect(); } catch {}
  try { fs.unlinkSync(dbPath); } catch {}
}
(async () => {
  await setup();

  // ---------- A. Default guard unchanged without ?confirm ----------
  {
    const f = await seed(['COMPLETED']);
    const res = mockRes();
    await campaignsCtrl.deleteCampaign(mockReq({ params: { id: f.campaign.id } }), res);
    check('A1. No confirm -> 409 guard', res.statusCode === 409, String(res.statusCode));
    check('A2. Guard code is CAMPAIGN_HAS_EXECUTION_HISTORY',
      res.body && res.body.error && res.body.error.code === 'CAMPAIGN_HAS_EXECUTION_HISTORY');
    check('A3. Campaign survives a refused delete',
      (await prisma.campaign.findUnique({ where: { id: f.campaign.id } })) !== null);
    check('A4. Execution history survives a refused delete',
      (await prisma.campaignExecution.count({ where: { campaignId: f.campaign.id } })) === 1);

    for (const bad of ['1', 'yes', 'TRUE', 'True', 'false', '']) {
      const r2 = mockRes();
      await campaignsCtrl.deleteCampaign(mockReq({ params: { id: f.campaign.id }, query: { confirm: bad } }), r2);
      check('A5. confirm=' + JSON.stringify(bad) + ' does not unlock force delete',
        r2.statusCode === 409 && r2.body && r2.body.error && r2.body.error.code === 'CAMPAIGN_HAS_EXECUTION_HISTORY',
        String(r2.statusCode));
    }
    check('A6. Campaign still intact after all rejected confirm values',
      (await prisma.campaign.findUnique({ where: { id: f.campaign.id } })) !== null);
  }

  // ---------- B..J. Confirmed force delete ----------
  {
    const f = await seed(['COMPLETED', 'FAILED', 'CANCELLED']);
    const res = mockRes();
    await campaignsCtrl.deleteCampaign(mockReq({ params: { id: f.campaign.id }, query: { confirm: 'true' } }), res);
    check('B1. Force delete succeeds with ?confirm=true',
      res.statusCode === 200 && res.body && res.body.success === true, String(res.statusCode));
    check('C. CampaignExecutionRecipient rows removed',
      (await prisma.campaignExecutionRecipient.count({ where: { executionId: { in: f.executions.map((e) => e.id) } } })) === 0);
    check('D. CampaignExecution rows removed',
      (await prisma.campaignExecution.count({ where: { campaignId: f.campaign.id } })) === 0);
    check('E. Campaign removed',
      (await prisma.campaign.findUnique({ where: { id: f.campaign.id } })) === null);
    check('F. CampaignSchedule removed via existing cascade',
      (await prisma.campaignSchedule.findUnique({ where: { id: f.schedule.id } })) === null);
    check('G. CampaignRecipient rows removed via existing cascade',
      (await prisma.campaignRecipient.count({ where: { campaignId: f.campaign.id } })) === 0);
    check('H. Message remains', (await prisma.message.findUnique({ where: { id: f.message.id } })) !== null);
    check('I. Media remains', (await prisma.media.findUnique({ where: { id: f.media.id } })) !== null);
    check('J. Recipients remain',
      (await prisma.recipient.findUnique({ where: { id: f.r1.id } })) !== null &&
      (await prisma.recipient.findUnique({ where: { id: f.r2.id } })) !== null);
  }

  // ---------- K. PENDING blocks ----------
  {
    const f = await seed(['COMPLETED', 'PENDING']);
    const res = mockRes();
    await campaignsCtrl.deleteCampaign(mockReq({ params: { id: f.campaign.id }, query: { confirm: 'true' } }), res);
    check('K1. PENDING execution -> 409', res.statusCode === 409, String(res.statusCode));
    check('K2. Code is CAMPAIGN_DELIVERY_IN_PROGRESS',
      res.body && res.body.error && res.body.error.code === 'CAMPAIGN_DELIVERY_IN_PROGRESS');
    check('K3. Error explains delivery is active',
      /pending or running/i.test((res.body && res.body.error && res.body.error.message) || ''));
    check('K4. Campaign untouched', (await prisma.campaign.findUnique({ where: { id: f.campaign.id } })) !== null);
    check('K5. Executions untouched (nothing cancelled)',
      (await prisma.campaignExecution.count({ where: { campaignId: f.campaign.id } })) === 2);
    check('K6. Delivery history untouched',
      (await prisma.campaignExecutionRecipient.count({ where: { executionId: { in: f.executions.map((e) => e.id) } } })) === 4);
    check('K7. Audience untouched',
      (await prisma.campaignRecipient.count({ where: { campaignId: f.campaign.id } })) === 2);
  }

  // ---------- L. RUNNING blocks ----------
  {
    const f = await seed(['RUNNING']);
    const res = mockRes();
    await campaignsCtrl.deleteCampaign(mockReq({ params: { id: f.campaign.id }, query: { confirm: 'true' } }), res);
    check('L1. RUNNING execution -> 409', res.statusCode === 409, String(res.statusCode));
    check('L2. Code is CAMPAIGN_DELIVERY_IN_PROGRESS',
      res.body && res.body.error && res.body.error.code === 'CAMPAIGN_DELIVERY_IN_PROGRESS');
    check('L3. Campaign untouched', (await prisma.campaign.findUnique({ where: { id: f.campaign.id } })) !== null);
    check('L4. Execution history untouched',
      (await prisma.campaignExecutionRecipient.count({ where: { executionId: { in: f.executions.map((e) => e.id) } } })) === 2);
  }

  // ---------- M. Transaction atomicity ----------
  {
    const f = await seed(['COMPLETED']);
    const svc = h.fresh(CAMPAIGN_DEL_SVC);
    // Genuine fault injection, not a monkey-patch: `tx` inside $transaction is a
    // separate interactive client, so patching a delegate would never fire.
    // Instead a raw table with a RESTRICT FK to Campaign makes the final
    // campaign.delete fail for real, after history has already been removed
    // inside the transaction. If the transaction is correct, everything rolls back.
    await prisma.$executeRawUnsafe(
      'CREATE TABLE IF NOT EXISTS ForceDeleteGuard (id TEXT PRIMARY KEY, campaignId TEXT NOT NULL REFERENCES Campaign(id) ON DELETE RESTRICT)'
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO ForceDeleteGuard (id, campaignId) VALUES ('guard1', '${f.campaign.id}')`
    );
    let threw = false;
    try { await svc.deleteCampaignForce(f.campaign.id); } catch (e) { threw = true; }
    await prisma.$executeRawUnsafe('DROP TABLE ForceDeleteGuard');
    check('M1a. Campaign delete failure propagates', threw);
    check('M2. Campaign still exists after rollback',
      (await prisma.campaign.findUnique({ where: { id: f.campaign.id } })) !== null);
    check('M3. Execution history rolled back (no partial deletion)',
      (await prisma.campaignExecutionRecipient.count({ where: { executionId: { in: f.executions.map((e) => e.id) } } })) === 2);
    check('M4. Executions rolled back',
      (await prisma.campaignExecution.count({ where: { campaignId: f.campaign.id } })) === 1);
    check('M5. Audience rolled back',
      (await prisma.campaignRecipient.count({ where: { campaignId: f.campaign.id } })) === 2);
    check('M6. Schedule rolled back',
      (await prisma.campaignSchedule.findUnique({ where: { id: f.schedule.id } })) !== null);
  }

  // ---------- N. Audit record ----------
  {
    const f = await seed(['COMPLETED', 'FAILED']);
    const res = mockRes();
    await campaignsCtrl.deleteCampaign(mockReq({ params: { id: f.campaign.id }, query: { confirm: 'true' } }), res);
    await new Promise((r) => setTimeout(r, 150)); // recordAuditSafe is fire-and-forget
    const entry = await prisma.auditLog.findFirst({
      where: { action: 'CAMPAIGN_DELETE_FORCE' }, orderBy: { createdAt: 'desc' },
    });
    check('N1. CAMPAIGN_DELETE_FORCE audit created', entry !== null);
    if (entry) {
      const meta = JSON.parse(entry.metadata || '{}');
      check('N2. Audit captures campaignId', meta.campaignId === f.campaign.id, JSON.stringify(meta));
      check('N3. Audit captures executionCount = 2', meta.executionCount === 2, JSON.stringify(meta));
      check('N4. Audit captures executionRecipientCount = 4', meta.executionRecipientCount === 4, JSON.stringify(meta));
      check('N5. Audit captures audienceCount = 2', meta.audienceCount === 2, JSON.stringify(meta));
      check('N6. Audit captures scheduleCount = 1', meta.scheduleCount === 1, JSON.stringify(meta));
    }
  }

  // ---------- O. Frontend offers permanent deletion ----------
  {
    const src = fs.readFileSync(CAMPAIGNS_PAGE, 'utf8');
    check('O1. Frontend no longer forces Archive-only',
      !/Archive Campaign/.test(src) && !/deleteTarget\.executions\?\.length \? 'Archive'/.test(src));
    check('O2. Frontend sends ?confirm=true', /\$\{deleteTarget\.id\}\?confirm=true/.test(src));
    check('O3. Frontend offers both Archive and Delete permanently',
      /Archive \(keeps all history\)/.test(src) && /Delete permanently\.\.\./.test(src));
    check('O4. Confirmation warns history is permanently deleted',
      /delivery and read history/.test(src) && /cannot be undone/i.test(src));
    check('O5. Archive still offered as the non-destructive path',
      /axios\.patch\(`\/api\/campaigns\/\$\{deleteTarget\.id\}`, \{ status: 'ARCHIVED' \}\)/.test(src));
    check('O6. Backend error message surfaced, not a generic string',
      /err\.response\?\.data\?\.error\?\.message/.test(src));
  }

  // ---------- Service contract ----------
  {
    const svc = h.fresh(CAMPAIGN_DEL_SVC);
    let nf = null;
    try { await svc.deleteCampaignForce('missing-' + Date.now()); } catch (e) { nf = e; }
    check('S1. Missing campaign -> NOT_FOUND',
      nf !== null && nf.code === 'NOT_FOUND' && nf.statusCode === 404);
    const f = await seed(['COMPLETED']);
    const r = await svc.deleteCampaignForce(f.campaign.id);
    check('S2. Service returns dependency counts',
      r.counts.executions === 1 && r.counts.executionRecipients === 2 &&
      r.counts.audience === 2 && r.counts.schedule === 1, JSON.stringify(r.counts));
  }

  await teardown();
  console.log('\nCampaign force-delete: ' + C + ' passed, ' + F + ' failed');
  process.exit(F ? 1 : 0);
})().catch(async (e) => { console.error('TEST CRASH:', e); await teardown(); process.exit(1); });

