/*
 * Dashboard regression: "Scheduled Campaigns" must mean genuinely upcoming.
 *
 * Bug: the count included stale development/test schedules whose scheduledAt
 * was already in the past, so the dashboard reported 29 scheduled campaigns
 * while "Next Scheduled" correctly showed none.
 *
 * Safety: throwaway SQLite DB, no provider involved, runs sequentially.
 */
const h = require('./test-5-3-helpers.cjs');
const path = require('path');
const fs = require('fs');
const os = require('os');

let C = 0, F = 0;
const check = (n, c, e) => { C++; if (!c) F++; console.log((c ? 'PASS' : 'FAIL') + ': ' + n + (e ? ' | ' + e : '')); };

let prisma, dbMod, dashboardCtrl, dbPath;
const MIN = 60 * 1000;

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function loadSummary() {
  const res = mockRes();
  await dashboardCtrl.getDashboardSummary({}, res);
  return res.body.data;
}

let seq = 0;
async function campaign() {
  const msg = await prisma.message.create({ data: { name: 'M' + (++seq), body: 'b', status: 'READY' } });
  return prisma.campaign.create({ data: { name: 'C' + (++seq), status: 'READY', messageId: msg.id } });
}
async function scheduleAt(campId, whenMs) {
  return prisma.campaignSchedule.create({
    data: { campaignId: campId, scheduledAt: new Date(whenMs), timezone: 'Asia/Kolkata', status: 'SCHEDULED' },
  });
}

async function setup() {
  dbPath = path.join(os.tmpdir(), 'dash-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.db');
  process.env.DATABASE_URL = 'file:' + dbPath;
  const { execSync } = require('child_process');
  execSync('npx prisma db push --schema=prisma/schema.prisma --skip-generate', { cwd: h.REPO_ROOT, env: { ...process.env }, stdio: 'pipe' });
  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient({ datasources: { db: { url: 'file:' + dbPath } } });
  dbMod = h.fresh('config/db.js');
  dashboardCtrl = h.fresh('controllers/dashboard.controller.js');
}

async function teardown() {
  try { await prisma.$disconnect(); } catch {}
  try { await dbMod.prisma.$disconnect(); } catch {}
  for (const f of [dbPath, dbPath + '-journal']) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} }
}

async function main() {
  console.log('=== Dashboard scheduled-count regression ===\n');
  await setup();
  const now = Date.now();

  // 1. Past / stale schedules only -> nothing is "scheduled".
  {
    await scheduleAt((await campaign()).id, now - 10 * MIN);
    await scheduleAt((await campaign()).id, now - 60 * MIN);
    const d = await loadSummary();
    check('D1. Past scheduled campaign is NOT counted as scheduled', d.totals.scheduledCampaigns === 0, String(d.totals.scheduledCampaigns));
    check('D2. No future schedule -> nextScheduledCampaign is null', d.nextScheduledCampaign === null, JSON.stringify(d.nextScheduledCampaign));
  }

  // 2. A future schedule IS counted.
  {
    const c2 = await campaign();
    await scheduleAt(c2.id, now + 5 * MIN);
    const d = await loadSummary();
    check('D3. Future scheduled campaign IS counted', d.totals.scheduledCampaigns === 1, String(d.totals.scheduledCampaigns));
    check('D4. Next scheduled reports the future campaign', d.nextScheduledCampaign !== null && d.nextScheduledCampaign.campaignId === c2.id, JSON.stringify(d.nextScheduledCampaign));
  }

  // 3. Next scheduled is the EARLIEST future schedule, past ones never win.
  {
    // Start from a clean slate so this block asserts only its own fixtures.
    await prisma.campaignSchedule.deleteMany({});
    const later = await campaign();
    const earlier = await campaign();
    const stale = await campaign();
    await scheduleAt(later.id, now + 90 * MIN);
    await scheduleAt(earlier.id, now + 20 * MIN);
    await scheduleAt(stale.id, now - 5 * MIN); // past: must never be 'next'
    const d = await loadSummary();
    check('D5. Next scheduled is the earliest FUTURE schedule', d.nextScheduledCampaign !== null && d.nextScheduledCampaign.campaignId === earlier.id, JSON.stringify({ got: d.nextScheduledCampaign && d.nextScheduledCampaign.campaignId, want: earlier.id }));
    check('D5b. A past schedule is never chosen as next', d.nextScheduledCampaign.campaignId !== stale.id);
    check('D6. Only future schedules are counted', d.totals.scheduledCampaigns === 2, String(d.totals.scheduledCampaigns));
  }

  // 4. CANCELLED schedules are never counted.
  {
    const c5 = await campaign();
    await prisma.campaignSchedule.create({ data: { campaignId: c5.id, scheduledAt: new Date(now + 30 * MIN), timezone: 'Asia/Kolkata', status: 'CANCELLED' } });
    const d = await loadSummary();
    check('D7. Cancelled schedule is not counted as scheduled', d.totals.scheduledCampaigns === 2, String(d.totals.scheduledCampaigns));
  }

  // 5. Source-level guard so the stale-count bug cannot return.
  {
    const src = h.src(path.join(h.REPO_ROOT, 'apps/server/src/controllers/dashboard.controller.ts'));
    check('D8. Scheduled count is filtered on a future scheduledAt', /campaignSchedule\.count\(\{ where: \{ status: 'SCHEDULED', scheduledAt: \{ gt: now \} \} \}\)/.test(src));
    check('D9. Unfiltered scheduled count is gone', !/count\(\{ where: \{ status: 'SCHEDULED' \} \}\)/.test(src));
  }

  await teardown();
  console.log('\nAssertions: ' + C + ' | failed: ' + F);
  if (F > 0) process.exitCode = 1;
}

main().catch(async (e) => { console.error(e.stack || e); try { await teardown(); } catch {} process.exitCode = 1; });
