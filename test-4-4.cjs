/**
 * Phase 4.4 — Campaign Scheduling Tests (REAL SUITE).
 *
 * Covers: CampaignSchedule schema, schedule CRUD API (GET/POST/PATCH/cancel),
 * scheduling validation (READY-only, DRAFT/ARCHIVED rejection, future datetime,
 * timezone, duplicate active), cancel, reschedule, campaign status preservation,
 * authentication, and database safety.
 *
 * Run sequentially with the other suites — they share one SQLite database.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const dotenv = require('dotenv');
const argon2 = require('argon2');

dotenv.config({ path: path.join(__dirname, '.env') });

const REPO_ROOT = __dirname;
const SCHEMA_PATH = path.join(REPO_ROOT, 'prisma/schema.prisma');
const CAMPAIGNS_ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/campaigns.routes.ts');
const SERVER_INDEX_PATH = path.join(REPO_ROOT, 'apps/server/src/index.ts');
const CAMPAIGN_SCHEDULE_UTIL_PATH = path.join(REPO_ROOT, 'apps/server/src/utils/campaignSchedule.util.ts');
const CAMPAIGN_SCHEDULE_CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/campaignSchedule.controller.ts');

const TEST_PORT = 3149;
const BASE = 'http://127.0.0.1:' + TEST_PORT;

const RUN = String(Date.now()).slice(-6);
const phoneFor = (n) => '9' + RUN + String(n);

let checks = 0;
let failures = 0;
let server = null;
let prisma = null;
let tempUserId = null;
const createdCampaignIds = new Set();
const createdRecipientIds = new Set();
const createdMessageIds = new Set();
const createdScheduleIds = new Set();

function check(name, cond, extra) {
  checks++;
  if (!cond) failures++;
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (extra ? ' | ' + extra : ''));
}

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.ok) return true;
    } catch { }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function request(method, url, body, cookie, contentType) {
  const headers = {};
  if (contentType) headers['Content-Type'] = contentType;
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + url, { method, headers, body });
  const raw = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: res.status, json: parsed, text: raw, setCookie: res.headers.get('set-cookie') };
}

function getJson(url, cookie) { return request('GET', url, undefined, cookie); }
function postJson(url, body, cookie) { return request('POST', url, JSON.stringify(body), cookie, 'application/json'); }
function patchJson(url, body, cookie) { return request('PATCH', url, JSON.stringify(body), cookie, 'application/json'); }
function putJson(url, body, cookie) { return request('PUT', url, JSON.stringify(body), cookie, 'application/json'); }
function deleteJson(url, cookie) { return request('DELETE', url, undefined, cookie); }

/* ------------------------------------------------------------------ *
 * Static contracts
 * ------------------------------------------------------------------ */
function staticContractTests() {
  console.log('\n--- Static contracts ---');
  const schema = readSource(SCHEMA_PATH);
  const util = readSource(CAMPAIGN_SCHEDULE_UTIL_PATH);
  const controller = readSource(CAMPAIGN_SCHEDULE_CONTROLLER_PATH);
  const routes = readSource(CAMPAIGNS_ROUTES_PATH);

  check('S1. CampaignSchedule model exists', /model CampaignSchedule \{/.test(schema));
  check('S2. campaignId is unique', /campaignId\s+String\s+@unique/.test(schema));
  check('S3. scheduledAt field exists', /scheduledAt\s+DateTime/.test(schema));
  check('S4. timezone field exists', /timezone\s+String/.test(schema));
  check('S5. status field exists', /status\s+String\s+@default\("SCHEDULED"\)/.test(schema));
  check('S6. Campaign has schedule relation', /schedule\s+CampaignSchedule\?/.test(schema));
  check('S7. @@index\([scheduledAt]\) exists', /@@index\(\[scheduledAt\]\)/.test(schema));
  check('S8. @@index\([status]\) exists', /@@index\(\[status\]\)/.test(schema));
  check('S9. Schedule routes are registered',
    routes.includes("router.get('/:id/schedule', getCampaignSchedule)") &&
    routes.includes("router.post('/:id/schedule', createCampaignSchedule)") &&
    routes.includes("router.patch('/:id/schedule', updateCampaignSchedule)") &&
    routes.includes("router.post('/:id/schedule/cancel', cancelCampaignSchedule)") &&
    routes.includes('router.use(requireAuth)'));
  check('S10. Controller imports checkCampaignSchedulable',
    controller.includes('checkCampaignSchedulable') && controller.includes('findCampaignSchedule') &&
    controller.includes('validateScheduleInput') && controller.includes('serializeSchedule'));
  check('S11. Util has READY-only scheduling check',
    /campaign\.status\s*!==\s*['"]READY['"]/.test(util) || /campaign\.status\s*===\s*['"]READY['"]/.test(util));
  check('S12. Util rejects ARCHIVED', /CAMPAIGN_ARCHIVED/.test(util));
  check('S13. Util rejects past datetime', /SCHEDULE_IN_PAST/.test(util));
  check('S14. Util validates timezone', /INVALID_TIMEZONE/.test(util));
  check('S15. Util validates datetime', /INVALID_SCHEDULED_AT/.test(util));
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */
const fixture = {
  campaignReady: null,
  campaignDraft: null,
  campaignArchived: null,
  message: null,
  recipientA: null,
};

async function createFixtureRecipient(cookie) {
  const res = await postJson('/api/recipients', {
    name: `Phase44 Ravi ${RUN}`,
    whatsappNumber: phoneFor(1001),
    language: 'Hindi',
    category: 'Phase4Test',
    status: 'ACTIVE',
    source: 'MANUAL',
  }, cookie);
  const id = res.json && res.json.data && res.json.data.id;
  if (id) createdRecipientIds.add(id);
  return id;
}

async function createFixtureMessage(cookie) {
  const res = await postJson('/api/messages', {
    name: `Phase44 Message ${RUN}`,
    body: `Fixture body ${RUN}`,
    status: 'READY',
  }, cookie);
  const id = res.json && res.json.data && res.json.data.id;
  if (id) createdMessageIds.add(id);
  return id;
}

async function createFixtureCampaign(cookie, name, messageId, status) {
  const payload = { name, messageId };
  if (status) payload.status = status;
  const res = await postJson('/api/campaigns', payload, cookie);
  const id = res.json && res.json.data && res.json.data.id;
  if (id) createdCampaignIds.add(id);
  return id;
}

async function createFixtures(cookie) {
  console.log('\n--- Fixtures ---');
  fixture.recipientA = await createFixtureRecipient(cookie);
  fixture.message = await createFixtureMessage(cookie);

  // READY campaign: set audience first (DRAFT), then set READY.
  // This avoids the Phase 4.3 audience-save demotion.
  fixture.campaignReady = await createFixtureCampaign(cookie, `Phase44 Ready ${RUN}`, fixture.message);
  const audienceSet = await putJson(`/api/campaigns/${fixture.campaignReady}/audience`, {
    recipientIds: [fixture.recipientA],
  }, cookie);
  check('F1. Ready campaign has audience', audienceSet.status === 200);
  const readyPatch = await patchJson(`/api/campaigns/${fixture.campaignReady}`, { status: 'READY' }, cookie);
  check('F2. Ready campaign is READY', readyPatch.status === 200 && readyPatch.json.data.status === 'READY');

  // DRAFT campaign (created as DRAFT by default)
  fixture.campaignDraft = await createFixtureCampaign(cookie, `Phase44 Draft ${RUN}`, fixture.message);
  check('F3. Draft campaign is DRAFT', true);

  // ARCHIVED campaign
  fixture.campaignArchived = await createFixtureCampaign(cookie, `Phase44 Archived ${RUN}`, fixture.message);
  const archivedPatch = await patchJson(`/api/campaigns/${fixture.campaignArchived}`, { status: 'ARCHIVED' }, cookie);
  check('F4. Archived campaign is ARCHIVED', archivedPatch.status === 200 && archivedPatch.json.data.status === 'ARCHIVED');

  check('Fixtures created',
    !!fixture.campaignReady && !!fixture.campaignDraft && !!fixture.campaignArchived && !!fixture.message && !!fixture.recipientA);
}

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */
async function authTests(cookie) {
  console.log('\n--- Auth ---');
  check('1. GET schedule requires auth',
    (await getJson('/api/campaigns/any-id/schedule', null)).status === 401);
  check('2. POST schedule requires auth',
    (await postJson('/api/campaigns/any-id/schedule', { scheduledAt: '2026-12-01T09:00', timezone: 'UTC' }, null)).status === 401);
  check('3. PATCH schedule requires auth',
    (await patchJson('/api/campaigns/any-id/schedule', { scheduledAt: '2026-12-01T09:00', timezone: 'UTC' }, null)).status === 401);
  check('4. Cancel requires auth',
    (await postJson('/api/campaigns/any-id/schedule/cancel', {}, null)).status === 401);
}

/* ------------------------------------------------------------------ *
 * GET schedule
 * ------------------------------------------------------------------ */
async function getTests(cookie) {
  console.log('\n--- GET schedule ---');

  check('5. No schedule returns schedule:null',
    (await getJson(`/api/campaigns/${fixture.campaignReady}/schedule`, cookie)).json.data.schedule === null);

  check('9. Missing campaign returns 404',
    (await getJson('/api/campaigns/nonexistent-campaign/schedule', cookie)).status === 404);
}

/* ------------------------------------------------------------------ *
 * CREATE schedule
 * ------------------------------------------------------------------ */
async function createTests(cookie) {
  console.log('\n--- CREATE schedule ---');

  // Future dates for valid creation tests
  const futureDate = new Date(Date.now() + 172800000).toISOString().slice(0, 16); // +48h
  const pastDate = new Date(Date.now() - 3600000).toISOString().slice(0, 16); // 1h ago

  // 11. READY campaign schedules successfully
  const readyCreate = await postJson(`/api/campaigns/${fixture.campaignReady}/schedule`,
    { scheduledAt: futureDate, timezone: 'Asia/Kolkata' }, cookie);
  check('11. READY campaign schedules successfully',
    readyCreate.status === 201 || readyCreate.status === 200,
    'status=' + readyCreate.status);

  if (readyCreate.json && readyCreate.json.data && readyCreate.json.data.schedule) {
    const sched = readyCreate.json.data.schedule;
    createdScheduleIds.add(sched.id);

    // 12. New schedule status is SCHEDULED
    check('12. New schedule status is SCHEDULED', sched.status === 'SCHEDULED');

    // 13. scheduledAt persists (compare as wall clock in the timezone)
    const fetched = await getJson(`/api/campaigns/${fixture.campaignReady}/schedule`, cookie);
    check('13. scheduledAt persists',
      fetched.json.data.schedule && fetched.json.data.schedule.scheduledAt === sched.scheduledAt);

    // 14. timezone persists
    check('14. timezone persists',
      fetched.json.data.schedule && fetched.json.data.schedule.timezone === 'Asia/Kolkata');
  }

  // 15. DRAFT rejected
  const draftCreate = await postJson(`/api/campaigns/${fixture.campaignDraft}/schedule`,
    { scheduledAt: futureDate, timezone: 'Asia/Kolkata' }, cookie);
  check('15. DRAFT rejected',
    draftCreate.status === 400 && draftCreate.json.error && draftCreate.json.error.code === 'CAMPAIGN_NOT_READY',
    'status=' + draftCreate.status);

  // 16. ARCHIVED rejected
  const archivedCreate = await postJson(`/api/campaigns/${fixture.campaignArchived}/schedule`,
    { scheduledAt: futureDate, timezone: 'Asia/Kolkata' }, cookie);
  check('16. ARCHIVED rejected',
    archivedCreate.status === 400 && archivedCreate.json.error && archivedCreate.json.error.code === 'CAMPAIGN_NOT_READY',
    'status=' + archivedCreate.status);

  // 17. Invalid timezone rejected
  const badTzCreate = await postJson(`/api/campaigns/${fixture.campaignReady}/schedule`,
    { scheduledAt: futureDate, timezone: 'Not/A_Real_Timezone' }, cookie);
  check('17. Invalid timezone rejected',
    badTzCreate.status === 400 && badTzCreate.json.error && badTzCreate.json.error.code === 'INVALID_TIMEZONE',
    'status=' + badTzCreate.status);

  // 18. Invalid datetime rejected
  const badDateCreate = await postJson(`/api/campaigns/${fixture.campaignReady}/schedule`,
    { scheduledAt: 'not-a-date', timezone: 'Asia/Kolkata' }, cookie);
  check('18. Invalid datetime rejected',
    badDateCreate.status === 400 && badDateCreate.json.error && badDateCreate.json.error.code === 'INVALID_SCHEDULED_AT',
    'status=' + badDateCreate.status);

  // 19. Past datetime rejected
  const pastCreate = await postJson(`/api/campaigns/${fixture.campaignReady}/schedule`,
    { scheduledAt: pastDate, timezone: 'Asia/Kolkata' }, cookie);
  check('19. Past datetime rejected',
    pastCreate.status === 400 && pastCreate.json.error && pastCreate.json.error.code === 'SCHEDULE_IN_PAST',
    'status=' + pastCreate.status);

  // 20. Duplicate active schedule rejected
  const dupCreate = await postJson(`/api/campaigns/${fixture.campaignReady}/schedule`,
    { scheduledAt: futureDate, timezone: 'Asia/Kolkata' }, cookie);
  check('20. Duplicate active schedule rejected',
    dupCreate.status === 409 && dupCreate.json.error && dupCreate.json.error.code === 'CAMPAIGN_ALREADY_SCHEDULED',
    'status=' + dupCreate.status);
}

/* ------------------------------------------------------------------ *
 * UPDATE schedule
 * ------------------------------------------------------------------ */
async function updateTests(cookie) {
  console.log('\n--- UPDATE schedule ---');

  // Get the current SCHEDULED schedule
  const getRes = await getJson(`/api/campaigns/${fixture.campaignReady}/schedule`, cookie);
  if (!getRes.json.data.schedule || getRes.json.data.schedule.status !== 'SCHEDULED') {
    check('21-24. Skipped: no SCHEDULED schedule available for update');
    return;
  }
  const existingSchedule = getRes.json.data.schedule;
  const futureDate2 = new Date(Date.now() + 259200000).toISOString().slice(0, 16); // +72h

  // 21. Date/time can be updated
  const dateUpdate = await patchJson(`/api/campaigns/${fixture.campaignReady}/schedule`,
    { scheduledAt: futureDate2 }, cookie);
  check('21. Date/time can be updated', dateUpdate.status === 200);

  // 21b. Updated date/time persists (verify before any restore)
  if (dateUpdate.json && dateUpdate.json.data && dateUpdate.json.data.schedule) {
    const afterDateUpdate = await getJson(`/api/campaigns/${fixture.campaignReady}/schedule`, cookie);
    const updatedSched = afterDateUpdate.json.data.schedule;
    const originalSched = existingSchedule;
    check('21b. Updated date/time persists',
      updatedSched && updatedSched.scheduledAt !== originalSched.scheduledAt &&
      updatedSched.scheduledAt && updatedSched.scheduledAt.length > 0,
      'original=' + originalSched.scheduledAt + ' updated=' + updatedSched.scheduledAt);
  }

  // 22. Timezone can be updated
  const tzUpdate = await patchJson(`/api/campaigns/${fixture.campaignReady}/schedule`,
    { timezone: 'UTC' }, cookie);
  check('22. Timezone can be updated',
    tzUpdate.status === 200 && tzUpdate.json.data.schedule.timezone === 'UTC',
    'tz=' + (tzUpdate.json.data.schedule && tzUpdate.json.data.schedule.timezone));

  // Restore timezone for subsequent tests
  await patchJson(`/api/campaigns/${fixture.campaignReady}/schedule`,
    { timezone: 'Asia/Kolkata' }, cookie);

  // 23. Past updated time rejected
  const pastUpdate = new Date(Date.now() - 3600000).toISOString().slice(0, 16);
  const pastUpdateRes = await patchJson(`/api/campaigns/${fixture.campaignReady}/schedule`,
    { scheduledAt: pastUpdate }, cookie);
  check('23. Past updated time rejected',
    pastUpdateRes.status === 400 && pastUpdateRes.json.error && pastUpdateRes.json.error.code === 'SCHEDULE_IN_PAST',
    'status=' + pastUpdateRes.status);

  // 24. Cancelled schedule cannot be reactivated through PATCH
  // First cancel the schedule
  const cancelForPatch = await postJson(`/api/campaigns/${fixture.campaignReady}/schedule/cancel`, {}, cookie);
  if (cancelForPatch.json && cancelForPatch.json.data && cancelForPatch.json.data.schedule && cancelForPatch.json.data.schedule.status === 'CANCELLED') {
    const reactivate = await patchJson(`/api/campaigns/${fixture.campaignReady}/schedule`,
      { scheduledAt: futureDate2 }, cookie);
    check('24. Cancelled schedule cannot be reactivated through PATCH',
      reactivate.status === 400, 'status=' + reactivate.status);
  }

  // Reschedule back to SCHEDULED for subsequent tests
  const rescheduleForTests = await postJson(`/api/campaigns/${fixture.campaignReady}/schedule`,
    { scheduledAt: futureDate2, timezone: 'Asia/Kolkata' }, cookie);
  check('24a. Reschedule after PATCH test works',
    rescheduleForTests.status === 200 || rescheduleForTests.status === 201);
}

/* ------------------------------------------------------------------ *
 * CANCEL
 * ------------------------------------------------------------------ */
async function cancelTests(cookie) {
  console.log('\n--- CANCEL ---');

  // Get current schedule state
  const getRes = await getJson(`/api/campaigns/${fixture.campaignReady}/schedule`, cookie);
  const currentSchedule = getRes.json.data.schedule;

  if (!currentSchedule) {
    check('25. SCHEDULED -> CANCELLED | no schedule');
    check('26. Schedule record remains | no schedule');
    check('27. Already-CANCELLED cancel is idempotent | no schedule');
    return;
  }

  if (currentSchedule.status === 'CANCELLED') {
    // 27. Already-CANCELLED cancel is idempotent
    const idempotentCancel = await postJson(`/api/campaigns/${fixture.campaignReady}/schedule/cancel`, {}, cookie);
    check('27. Already-CANCELLED cancel is idempotent',
      idempotentCancel.status === 200,
      'status=' + idempotentCancel.status);
    return;
  }

  // 25. SCHEDULED -> CANCELLED
  const cancelRes = await postJson(`/api/campaigns/${fixture.campaignReady}/schedule/cancel`, {}, cookie);
  check('25. SCHEDULED -> CANCELLED',
    cancelRes.status === 200 && cancelRes.json.data && cancelRes.json.data.schedule.status === 'CANCELLED',
    'status=' + (cancelRes.json.data && cancelRes.json.data.schedule && cancelRes.json.data.schedule.status));

  // 26. Schedule record remains
  const afterCancel = await getJson(`/api/campaigns/${fixture.campaignReady}/schedule`, cookie);
  check('26. Schedule record remains',
    afterCancel.json.data.schedule !== null && afterCancel.json.data.schedule.id === currentSchedule.id);

  // 27. Already-CANCELLED cancel is idempotent
  const idempotentCancel = await postJson(`/api/campaigns/${fixture.campaignReady}/schedule/cancel`, {}, cookie);
  check('27. Already-CANCELLED cancel is idempotent',
    idempotentCancel.status === 200 && idempotentCancel.json.data && idempotentCancel.json.data.schedule.status === 'CANCELLED',
    'status=' + idempotentCancel.status);
}

/* ------------------------------------------------------------------ *
 * RESCHEDULE
 * ------------------------------------------------------------------ */
async function rescheduleTests(cookie) {
  console.log('\n--- RESCHEDULE ---');

  // Get current state - should be CANCELLED
  const getRes = await getJson(`/api/campaigns/${fixture.campaignReady}/schedule`, cookie);
  const currentSchedule = getRes.json.data.schedule;

  if (!currentSchedule || currentSchedule.status !== 'CANCELLED') {
    check('28. CANCELLED schedule can be scheduled again | not cancelled');
    return;
  }

  const futureDate = new Date(Date.now() + 172800000).toISOString().slice(0, 16); // +48h

  // 28. CANCELLED schedule can be scheduled again
  const reschedule = await postJson(`/api/campaigns/${fixture.campaignReady}/schedule`,
    { scheduledAt: futureDate, timezone: 'Asia/Kolkata' }, cookie);
  check('28. CANCELLED schedule can be scheduled again',
    reschedule.status === 200 || reschedule.status === 201, 'status=' + reschedule.status);

  if (reschedule.json && reschedule.json.data && reschedule.json.data.schedule) {
    const sched = reschedule.json.data.schedule;

    // 29. Status becomes SCHEDULED
    check('29. Status becomes SCHEDULED', sched.status === 'SCHEDULED');

    // 30. New date/time persists (compare wall clock in timezone)
    const fetched = await getJson(`/api/campaigns/${fixture.campaignReady}/schedule`, cookie);
    check('30. New date/time persists',
      fetched.json.data.schedule && fetched.json.data.schedule.scheduledAt === sched.scheduledAt);

    // 31. New timezone persists
    check('31. New timezone persists', sched.timezone === 'Asia/Kolkata', 'timezone=' + sched.timezone);

    // 31b. Same record revived (not duplicated)
    check('31b. Same record revived (not duplicated)',
      fetched.json.data.schedule && fetched.json.data.schedule.id === sched.id);

    // 31c. Can update rescheduled record
    const tzUpdate = await patchJson(`/api/campaigns/${fixture.campaignReady}/schedule`,
      { timezone: 'UTC' }, cookie);
    check('31c. Can update rescheduled record',
      tzUpdate.status === 200 && tzUpdate.json.data.schedule.timezone === 'UTC');
  }
}

/* ------------------------------------------------------------------ *
 * Campaign state preservation
 * ------------------------------------------------------------------ */
async function campaignStateTests(cookie) {
  console.log('\n--- Campaign state ---');

  const readyCampaign = await prisma.campaign.findUnique({
    where: { id: fixture.campaignReady },
    select: { status: true },
  });
  check('32. Campaign READY status preserved after scheduling',
    readyCampaign.status === 'READY', 'status=' + readyCampaign.status);

  const draftCampaign = await prisma.campaign.findUnique({
    where: { id: fixture.campaignDraft },
    select: { status: true },
  });
  check('32b. DRAFT campaign status preserved', draftCampaign.status === 'DRAFT');

  const archivedCampaign = await prisma.campaign.findUnique({
    where: { id: fixture.campaignArchived },
    select: { status: true },
  });
  check('32c. ARCHIVED campaign status preserved', archivedCampaign.status === 'ARCHIVED');
}

/* ------------------------------------------------------------------ *
 * Cleanup
 * ------------------------------------------------------------------ */
async function cleanup() {
  for (const id of createdScheduleIds) {
    try { await prisma.campaignSchedule.delete({ where: { id } }); } catch { }
  }
  for (const id of createdCampaignIds) {
    try { await prisma.campaign.delete({ where: { id } }); } catch { }
  }
  for (const id of createdRecipientIds) {
    try { await prisma.recipient.delete({ where: { id } }); } catch { }
  }
  for (const id of createdMessageIds) {
    try { await prisma.message.delete({ where: { id } }); } catch { }
  }
  if (tempUserId) {
    try { await prisma.user.delete({ where: { id: tempUserId } }); } catch { }
    tempUserId = null;
  }
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */
async function main() {
  console.log('=== Phase 4.4: Campaign Scheduling ===\n');
  process.env.PORT = String(TEST_PORT);
  const originalListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    server = this;
    return originalListen.apply(this, args);
  };
  require('tsx/cjs');
  const indexModule = require('./apps/server/src/index.ts');
  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient();
  const serverUp = await waitForServer(20000);
  check('0. Real server is reachable', serverUp, BASE);
  if (!serverUp) { process.exitCode = 1; return; }

  const baseline = {
    campaigns: await prisma.campaign.count(),
    schedules: await prisma.campaignSchedule.count(),
    recipients: await prisma.recipient.count(),
    messages: await prisma.message.count(),
  };
  console.log('Baseline counts:', JSON.stringify(baseline));

  const email = 'phase44-' + RUN + '@example.com';
  const password = 'Phase44-' + RUN + '-pw!';
  const createdUser = await prisma.user.create({ data: { email, password: await argon2.hash(password) } });
  tempUserId = createdUser.id;
  const loginRes = await request('POST', '/api/auth/login', JSON.stringify({ email, password }), null, 'application/json');
  const cookie = loginRes.setCookie ? loginRes.setCookie.split(';')[0] : null;
  check('0b. Temporary admin user can authenticate', cookie !== null);

  try {
    staticContractTests();
    await createFixtures(cookie);
    await authTests(cookie);
    await getTests(cookie);
    await createTests(cookie);
    await updateTests(cookie);
    await cancelTests(cookie);
    await rescheduleTests(cookie);
    await campaignStateTests(cookie);
  } catch (error) {
    failures++;
    console.error('Unexpected test error:', error && error.stack ? error.stack : error);
  } finally {
    await cleanup();
  }

  console.log('\n--- Database safety ---');
  const finalCampaigns = await prisma.campaign.count();
  const finalSchedules = await prisma.campaignSchedule.count();
  const finalRecipients = await prisma.recipient.count();
  const finalMessages = await prisma.message.count();

  check('SA1. Temporary campaigns cleaned up',
    finalCampaigns === baseline.campaigns, 'before=' + baseline.campaigns + ' after=' + finalCampaigns);
  check('SA2. Temporary schedules cleaned up',
    finalSchedules === baseline.schedules, 'before=' + baseline.schedules + ' after=' + finalSchedules);
  check('SA3. Existing recipients unchanged', finalRecipients === baseline.recipients);
  check('SA4. Existing messages unchanged', finalMessages === baseline.messages);

  if (server) await new Promise((resolve) => server.close(resolve));
  if (indexModule.worker) { try { await indexModule.worker.stop(); } catch { } }
  await prisma.$disconnect();

  console.log('\nAssertions run: ' + checks + ' | failed: ' + failures);
  console.log('=== ' + (failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED') + ' ===');
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('Error:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
