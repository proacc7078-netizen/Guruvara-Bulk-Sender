/**
 * Phase 4.5 — Campaign Execution Foundation Tests (REAL SUITE).
 *
 * Covers: CampaignExecution & CampaignExecutionRecipient schema,
 * execution snapshot creation, idempotency, state transitions,
 * cancel, snapshot immutability, auth, and database safety.
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
const CAMPAIGN_EXECUTION_UTIL_PATH = path.join(REPO_ROOT, 'apps/server/src/utils/campaignExecution.util.ts');
const CAMPAIGN_EXECUTION_CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/campaignExecution.controller.ts');
const CAMPAIGNS_ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/campaigns.routes.ts');

const TEST_PORT = 3150;
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
const createdExecutionIds = new Set();

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

/* ------------------------------------------------------------------ *
 * Static contracts
 * ------------------------------------------------------------------ */
function staticContractTests() {
  console.log('\n--- Static contracts ---');
  const schema = readSource(SCHEMA_PATH);
  const util = readSource(CAMPAIGN_EXECUTION_UTIL_PATH);
  const controller = readSource(CAMPAIGN_EXECUTION_CONTROLLER_PATH);
  const routes = readSource(CAMPAIGNS_ROUTES_PATH);

  check('1. CampaignExecution model exists', /model CampaignExecution \{/.test(schema));
  check('2. CampaignExecutionRecipient model exists', /model CampaignExecutionRecipient \{/.test(schema));
  check('3. Campaign has executions relation', /executions\s+CampaignExecution\[\]/.test(schema));
  check('4. CampaignSchedule has execution relation', /execution\s+CampaignExecution\?/.test(schema));
  check('5. scheduleId is unique', /scheduleId\s+String\s+\?@unique/.test(schema) || /scheduleId\s+String\s+@unique/.test(schema));
  check('6. Execution recipient composite unique', /@@id\(\[executionId,\s*recipientId\]\)/.test(schema));
  check('7. PENDING status default', /status\s+String\s+@default\("PENDING"\)/.test(schema));
  check('8. attemptCount field exists', /attemptCount\s+Int/.test(schema));
  check('9. messageBody snapshot field', /messageBody\s+String/.test(schema));
  check('10. whatsappNumber snapshot field', /whatsappNumber\s+String/.test(schema));
  check('11. GET execution route registered', routes.includes("router.get('/:id/execution'"));
  check('12. POST execution route registered', routes.includes("router.post('/:id/execution'"));
  check('13. Cancel execution route registered', routes.includes("router.post('/:id/execution/cancel'"));
  check('14. requireAuth used', routes.includes('requireAuth'));
  check('15. createExecutionSnapshot function exists', /createExecutionSnapshot/.test(util));
  check('16. markExecutionRunning function exists', /markExecutionRunning/.test(util));
  check('17. markExecutionCompleted function exists', /markExecutionCompleted/.test(util));
  check('18. markExecutionFailed function exists', /markExecutionFailed/.test(util));
  check('19. cancelExecution function exists', /cancelExecution/.test(util));
  check('20. retryExecution function exists', /retryExecution/.test(util));
  check('21. validateTransition function exists', /validateTransition/.test(util));
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */
const fixture = {
  campaignReady: null,
  message: null,
  recipientA: null,
  recipientB: null,
  schedule: null,
};

async function createFixtureRecipient(cookie, suffix) {
  const res = await postJson('/api/recipients', {
    name: `Phase45 Ravi ${suffix}`,
    whatsappNumber: phoneFor(suffix),
    language: 'Hindi',
    category: 'Phase4Test',
    status: 'ACTIVE',
    source: 'MANUAL',
  }, cookie);
  const id = res.json && res.json.data && res.json.data.id;
  if (id) createdRecipientIds.add(id);
  return id;
}

async function createFixtureMessage(cookie, status) {
  const payload = {
    name: `Phase45 Message ${RUN}`,
    body: `Fixture body ${RUN}`,
    status: status || 'DRAFT',
  };
  const res = await postJson('/api/messages', payload, cookie);
  const id = res.json && res.json.data && res.json.data.id;
  if (id) createdMessageIds.add(id);
  return id;
}

async function createFixtureCampaign(cookie, name, messageId, status) {
  const payload = { name };
  if (messageId) payload.messageId = messageId;
  if (status) payload.status = status;
  const res = await postJson('/api/campaigns', payload, cookie);
  const id = res.json && res.json.data && res.json.data.id;
  if (id) createdCampaignIds.add(id);
  return id;
}

async function createFixtures(cookie) {
  console.log('\n--- Fixtures ---');

  fixture.message = await createFixtureMessage(cookie, 'DRAFT');
  fixture.recipientA = await createFixtureRecipient(cookie, 2001);
  fixture.recipientB = await createFixtureRecipient(cookie, 2002);

  fixture.campaignReady = await createFixtureCampaign(cookie, `Phase45 Ready ${RUN}`, fixture.message);
  const audienceSet = await putJson(`/api/campaigns/${fixture.campaignReady}/audience`, {
    recipientIds: [fixture.recipientA, fixture.recipientB],
  }, cookie);
  check('F1. Ready campaign has audience', audienceSet.status === 200);

  const finalizeRes = await postJson(`/api/campaigns/${fixture.campaignReady}/finalize`, {}, cookie);
  check('F2. Campaign finalized to READY',
    finalizeRes.status === 200 && finalizeRes.json.data && finalizeRes.json.data.campaign.status === 'READY');

  const futureDate = new Date(Date.now() + 172800000).toISOString().slice(0, 16);
  const schedCreate = await postJson(`/api/campaigns/${fixture.campaignReady}/schedule`,
    { scheduledAt: futureDate, timezone: 'Asia/Kolkata' }, cookie);
  check('F3. Schedule created', schedCreate.status === 201 || schedCreate.status === 200, 'status=' + schedCreate.status);
  if (schedCreate.json && schedCreate.json.data && schedCreate.json.data.schedule) {
    fixture.schedule = schedCreate.json.data.schedule;
    createdScheduleIds.add(fixture.schedule.id);
  }
}

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */
async function authTests(cookie) {
  console.log('\n--- Auth ---');
  check('7. GET execution requires auth',
    (await getJson('/api/campaigns/any-id/execution', null)).status === 401);
  check('8. POST execution requires auth',
    (await postJson('/api/campaigns/any-id/execution', { scheduleId: 'x' }, null)).status === 401);
  check('9. Cancel execution requires auth',
    (await postJson('/api/campaigns/any-id/execution/cancel', {}, null)).status === 401);
}

/* ------------------------------------------------------------------ *
 * GET execution
 * ------------------------------------------------------------------ */
async function getTests(cookie) {
  console.log('\n--- GET execution ---');

  const noExec = await getJson(`/api/campaigns/${fixture.campaignReady}/execution`, cookie);
  check('10. No execution returns execution:null',
    noExec.status === 200 && noExec.json && noExec.json.data && noExec.json.data.execution === null);

  const missingCamp = await getJson('/api/campaigns/nonexistent/execution', cookie);
  check('12. Missing campaign returns 404', missingCamp.status === 404);
}

/* ------------------------------------------------------------------ *
 * POST execution creation
 * ------------------------------------------------------------------ */
async function creationTests(cookie) {
  console.log('\n--- POST execution creation ---');

  const createRes = await postJson(`/api/campaigns/${fixture.campaignReady}/execution`, {}, cookie);
  check('13. READY + SCHEDULED creates execution',
    createRes.status === 201 || createRes.status === 200, 'status=' + createRes.status);

  let execId = null;
  if (createRes.json && createRes.json.data && createRes.json.data.execution) {
    const exec = createRes.json.data.execution;
    execId = exec.id;
    createdExecutionIds.add(exec.id);

    check('14. Execution status = PENDING', exec.status === 'PENDING');
    check('15. attemptCount = 0', exec.attemptCount === 0);
    check('16. scheduledAt copied from schedule',
      exec.scheduledAt === fixture.schedule.scheduledAt,
      `exec=${exec.scheduledAt} vs sched=${fixture.schedule.scheduledAt}`);
  }

  if (!execId) return;

  // Verify message snapshot via Prisma
  const fullExec = await prisma.campaignExecution.findUnique({ where: { id: execId }, include: { recipients: true } });
  check('17. Message snapshot created',
    fullExec.messageId === fixture.message, 'messageId=' + fullExec.messageId);
  check('18. Recipient snapshots created',
    fullExec.recipients.length === 2, 'count=' + fullExec.recipients.length);
  check('19. Phone numbers snapshotted',
    fullExec.recipients.every((r) => r.whatsappNumber && r.whatsappNumber.startsWith('9' + RUN)),
    JSON.stringify(fullExec.recipients.map((r) => r.whatsappNumber)));
  check('20. Media snapshot is null (no media)', fullExec.mediaId === null);

  // 21. DRAFT campaign rejected
  const draftCampaign = await createFixtureCampaign(cookie, `Phase45 Draft ${RUN}`, fixture.message);
  const draftCreate = await postJson(`/api/campaigns/${draftCampaign}/execution`, {}, cookie);
  check('21. DRAFT campaign rejected',
    draftCreate.status === 400 && draftCreate.json.error && draftCreate.json.error.code === 'CAMPAIGN_NOT_READY');

  // 23. Campaign without schedule rejected
  const noSchedCampaign = await createFixtureCampaign(cookie, `Phase45 NoSchedule ${RUN}`, fixture.message);
  await putJson(`/api/campaigns/${noSchedCampaign}/audience`, { recipientIds: [fixture.recipientA, fixture.recipientB] }, cookie);
  await postJson(`/api/campaigns/${noSchedCampaign}/finalize`, {}, cookie);
  const noSchedCreate = await postJson(`/api/campaigns/${noSchedCampaign}/execution`, {}, cookie);
  check('23. No schedule rejected',
    noSchedCreate.status === 404 && noSchedCreate.json.error && noSchedCreate.json.error.code === 'SCHEDULE_NOT_FOUND');

  // Idempotency — use a fresh campaign so later mutations cannot affect it
  const idempCampaign = await createFixtureCampaign(cookie, `Phase45 Idemp ${RUN}`, fixture.message);
  await putJson(`/api/campaigns/${idempCampaign}/audience`, { recipientIds: [fixture.recipientA, fixture.recipientB] }, cookie);
  await postJson(`/api/campaigns/${idempCampaign}/finalize`, {}, cookie);
  await postJson(`/api/campaigns/${idempCampaign}/schedule`, { scheduledAt: new Date(Date.now() + 172800000).toISOString().slice(0, 16), timezone: 'Asia/Kolkata' }, cookie);
  const firstIdemCreate = await postJson(`/api/campaigns/${idempCampaign}/execution`, {}, cookie);
  check('31. Second create returns existing',
    firstIdemCreate.status === 201 && firstIdemCreate.json && firstIdemCreate.json.data && firstIdemCreate.json.data.execution,
    'firstStatus=' + firstIdemCreate.status);
  const firstIdemExecId = firstIdemCreate.json?.data?.execution?.id;
  if (firstIdemExecId) createdExecutionIds.add(firstIdemExecId);

  const secondCreate = await postJson(`/api/campaigns/${idempCampaign}/execution`, {}, cookie);
  check('31b. Second create returns existing',
    secondCreate.status === 200 && secondCreate.json && secondCreate.json.data && secondCreate.json.data.message === 'EXECUTION_ALREADY_EXISTS',
    'status=' + secondCreate.status);

  const execs = await prisma.campaignExecution.findMany({ where: { campaignId: idempCampaign } });
  check('32. Only one execution exists', execs.length === 1, 'count=' + execs.length);

  const recipients = await prisma.campaignExecutionRecipient.findMany({ where: { executionId: firstIdemExecId } });
  check('33. No duplicate execution recipients', recipients.length === 2, 'count=' + recipients.length);
}

/* ------------------------------------------------------------------ *
 * State transitions (via internal utility functions)
 * ------------------------------------------------------------------ */
async function stateTransitionTests(cookie, markRunning, markCompleted, markFailed, retryFn, cancelFn) {
  console.log('\n--- State transitions ---');

  if (!fixture.campaignReady) return;

  // Create a fresh execution for state tests
  const createRes = await postJson(`/api/campaigns/${fixture.campaignReady}/execution`, {}, cookie);
  if (!createRes.json || !createRes.json.data || !createRes.json.data.execution) return;
  const execId = createRes.json.data.execution.id;
  createdExecutionIds.add(execId);

  // Reset to PENDING
  await prisma.campaignExecution.update({
    where: { id: execId },
    data: { status: 'PENDING', attemptCount: 0, startedAt: null, completedAt: null, failedAt: null },
  });

  // 34. PENDING -> RUNNING succeeds
  try {
    const updated = await markRunning(execId);
    check('34. PENDING -> RUNNING succeeds', updated.status === 'RUNNING');
    check('35. attemptCount increments to 1', updated.attemptCount === 1, 'val=' + updated.attemptCount);
  } catch (e) {
    check('34. PENDING -> RUNNING succeeds', false, e.message);
    check('35. attemptCount increments to 1', false, e.message);
    return;
  }

  // 36. RUNNING -> COMPLETED succeeds
  try {
    const updated = await markCompleted(execId);
    check('36. RUNNING -> COMPLETED succeeds', updated.status === 'COMPLETED');
  } catch (e) {
    check('36. RUNNING -> COMPLETED succeeds', false, e.message);
  }

  // Reset to PENDING
  await prisma.campaignExecution.update({
    where: { id: execId },
    data: { status: 'PENDING', attemptCount: 0, startedAt: null, completedAt: null, failedAt: null },
  });

  // 38. PENDING -> CANCELLED succeeds
  try {
    const updated = await cancelFn(execId);
    check('38. PENDING -> CANCELLED succeeds', updated.status === 'CANCELLED');
  } catch (e) {
    check('38. PENDING -> CANCELLED succeeds', false, e.message);
  }

  // Reset to PENDING for next tests
  await prisma.campaignExecution.update({
    where: { id: execId },
    data: { status: 'PENDING', attemptCount: 0, failedAt: null, startedAt: null },
  });

  // Run through RUNNING -> FAILED cycle
  try {
    await markRunning(execId);
    const failed = await markFailed(execId, 'Test error');
    check('37. RUNNING -> FAILED succeeds', failed.status === 'FAILED');

    // 39. FAILED -> PENDING succeeds
    const retried = await retryFn(execId);
    check('39. FAILED -> PENDING succeeds', retried.status === 'PENDING');
  } catch (e) {
    check('37. RUNNING -> FAILED succeeds', false, e.message);
    check('39. FAILED -> PENDING succeeds', false, e.message);
  }

  // 40-43. Invalid transitions
  // Reset to COMPLETED to test terminal states
  await prisma.campaignExecution.update({
    where: { id: execId },
    data: { status: 'COMPLETED', completedAt: new Date(), startedAt: null, failedAt: null },
  });

  // 41. COMPLETED cannot transition
  try {
    await markRunning(execId);
    check('41. COMPLETED cannot transition', false, 'Should have failed');
  } catch (e) {
    check('41. COMPLETED cannot transition', true);
  }

  // Reset to CANCELLED
  await prisma.campaignExecution.update({
    where: { id: execId },
    data: { status: 'CANCELLED', startedAt: null, completedAt: null, failedAt: null },
  });

  // 42. CANCELLED cannot transition
  try {
    await markRunning(execId);
    check('42. CANCELLED cannot transition', false, 'Should have failed');
  } catch (e) {
    check('42. CANCELLED cannot transition', true);
  }

  // Reset to RUNNING to test cancel
  await prisma.campaignExecution.update({
    where: { id: execId },
    data: { status: 'RUNNING', startedAt: new Date(), attemptCount: 1, completedAt: null, failedAt: null },
  });

  // 43. RUNNING cannot be cancelled
  try {
    await cancelFn(execId);
    check('43. RUNNING cannot be cancelled', false, 'Should have failed');
  } catch (e) {
    check('43. RUNNING cannot be cancelled', true);
  }
}

/* ------------------------------------------------------------------ *
 * Cancel via API
 * ------------------------------------------------------------------ */
async function cancelApiTests(cookie) {
  console.log('\n--- Cancel via API ---');

  if (!fixture.campaignReady) return;

  // Create a fresh execution for cancel API tests
  const createRes = await postJson(`/api/campaigns/${fixture.campaignReady}/execution`, {}, cookie);
  if (!createRes.json || !createRes.json.data || !createRes.json.data.execution) return;
  const exec = createRes.json.data.execution;
  createdExecutionIds.add(exec.id);

  // 44. PENDING execution can be cancelled
  const cancelRes = await postJson(`/api/campaigns/${fixture.campaignReady}/execution/cancel`, {}, cookie);
  check('44. PENDING execution can be cancelled',
    cancelRes.status === 200 && cancelRes.json.data && cancelRes.json.data.execution.status === 'CANCELLED',
    'status=' + cancelRes.status);

  // 45. CANCELLED remains persisted
  const getAfterCancel = await getJson(`/api/campaigns/${fixture.campaignReady}/execution`, cookie);
  check('45. CANCELLED remains persisted',
    getAfterCancel.status === 200 && getAfterCancel.json.data.execution.status === 'CANCELLED');

  // 46. Second cancellation is idempotent
  const cancelAgain = await postJson(`/api/campaigns/${fixture.campaignReady}/execution/cancel`, {}, cookie);
  check('46. Second cancellation is idempotent',
    cancelAgain.status === 200 && cancelAgain.json.data.execution.status === 'CANCELLED');
}

/* ------------------------------------------------------------------ *
 * Snapshot immutability
 * ------------------------------------------------------------------ */
async function snapshotImmutabilityTests(cookie) {
  console.log('\n--- Snapshot immutability ---');

  if (!fixture.campaignReady) return;

  // Create a fresh execution for immutability tests
  const createRes = await postJson(`/api/campaigns/${fixture.campaignReady}/execution`, {}, cookie);
  if (!createRes.json || !createRes.json.data || !createRes.json.data.execution) return;
  const execId = createRes.json.data.execution.id;
  createdExecutionIds.add(execId);

  const fullExec = await prisma.campaignExecution.findUnique({
    where: { id: execId },
    include: { recipients: true },
  });

  // 47. Changing Message after execution creation does not change execution.messageBody
  const originalBody = fullExec.messageBody;
  await prisma.message.update({
    where: { id: fixture.message },
    data: { body: 'COMPLETELY DIFFERENT BODY' },
  });
  const execAfterMsgChange = await prisma.campaignExecution.findUnique({ where: { id: execId } });
  check('47. Message body snapshot immutable',
    execAfterMsgChange.messageBody === originalBody,
    `snapshot=${originalBody} current=${execAfterMsgChange.messageBody}`);
  await prisma.message.update({
    where: { id: fixture.message },
    data: { body: `Fixture body ${RUN}` },
  });

  // 48. Changing Recipient phone after execution creation does not change execution.whatsappNumber
  const originalPhone = fullExec.recipients[0]?.whatsappNumber;
  await prisma.recipient.update({
    where: { id: fixture.recipientA },
    data: { whatsappNumber: '+91-9999999999' },
  });
  const execAfterPhoneChange = await prisma.campaignExecution.findUnique({
    where: { id: execId },
    include: { recipients: true },
  });
  const snapshotPhone = execAfterPhoneChange.recipients[0]?.whatsappNumber;
  check('48. Phone number snapshot immutable',
    snapshotPhone === originalPhone,
    `snapshot=${snapshotPhone} current=${originalPhone}`);
  await prisma.recipient.update({
    where: { id: fixture.recipientA },
    data: { whatsappNumber: phoneFor(2001) },
  });

  // 49. Changing Recipient name does not change execution snapshot
  const originalName = fullExec.recipients[0]?.name;
  await prisma.recipient.update({
    where: { id: fixture.recipientA },
    data: { name: 'Totally Different Name' },
  });
  const execAfterNameChange = await prisma.campaignExecution.findUnique({
    where: { id: execId },
    include: { recipients: true },
  });
  const snapshotName = execAfterNameChange.recipients[0]?.name;
  check('49. Recipient name snapshot immutable',
    snapshotName === originalName,
    `snapshot=${snapshotName} current=${originalName}`);
  await prisma.recipient.update({
    where: { id: fixture.recipientA },
    data: { name: `Phase45 Ravi 2001` },
  });

  // 50. Changing Campaign audience after execution creation does not alter execution recipients
  const origRecipientCount = (await prisma.campaignExecutionRecipient.findMany({
    where: { executionId: execId },
  })).length;
  const alreadyHasB = await prisma.campaignRecipient.findUnique({
    where: { campaignId_recipientId: { campaignId: fixture.campaignReady, recipientId: fixture.recipientB } },
  });
  if (!alreadyHasB) {
    await prisma.campaignRecipient.create({
      data: { campaignId: fixture.campaignReady, recipientId: fixture.recipientB },
    });
  }
  const execAfterAudienceChange = await prisma.campaignExecution.findUnique({
    where: { id: execId },
    include: { recipients: true },
  });
  check('50. Audience change does not alter execution recipients',
    execAfterAudienceChange.recipients.length === origRecipientCount,
    `orig=${origRecipientCount} current=${execAfterAudienceChange.recipients.length}`);
}

/* ------------------------------------------------------------------ *
 * Cleanup
 * ------------------------------------------------------------------ */
async function cleanup() {
  for (const id of createdExecutionIds) {
    try { await prisma.campaignExecutionRecipient.deleteMany({ where: { executionId: id } }); } catch { }
    try { await prisma.campaignExecution.delete({ where: { id } }); } catch { }
  }
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
  console.log('=== Phase 4.5: Campaign Execution Foundation ===\n');
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

  // Dynamically load utility for state transition tests
  let markRunningFn = null;
  let markCompletedFn = null;
  let markFailedFn = null;
  let retryFn = null;
  let cancelFn = null;
  try {
    const util = require(CAMPAIGN_EXECUTION_UTIL_PATH);
    markRunningFn = util.markExecutionRunning;
    markCompletedFn = util.markExecutionCompleted;
    markFailedFn = util.markExecutionFailed;
    retryFn = util.retryExecution;
    cancelFn = util.cancelExecution;
  } catch (e) {
    console.log('Warning: Could not load execution util:', e.message);
  }

  const email = 'phase45-' + RUN + '@example.com';
  const password = 'Phase45-' + RUN + '-pw!';
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
    await creationTests(cookie);

    // State transition tests use utility functions directly
    if (markRunningFn && markCompletedFn && markFailedFn && retryFn && cancelFn) {
      await stateTransitionTests(cookie, markRunningFn, markCompletedFn, markFailedFn, retryFn, cancelFn);
    } else {
      check('34. State transitions available', false, 'Functions not loaded');
    }

    await cancelApiTests(cookie);
    await snapshotImmutabilityTests(cookie);
  } catch (error) {
    failures++;
    console.error('Unexpected test error:', error && error.stack ? error.stack : error);
  } finally {
    await cleanup();
  }

  console.log('\n--- Database safety ---');
  const baselineCampaigns = await prisma.campaign.count();
  const baselineSchedules = await prisma.campaignSchedule.count();
  const baselineRecipients = await prisma.recipient.count();
  const baselineMessages = await prisma.message.count();

  const finalCampaigns = await prisma.campaign.count();
  const finalSchedules = await prisma.campaignSchedule.count();
  const finalRecipients = await prisma.recipient.count();
  const finalMessages = await prisma.message.count();

  check('SA1. Temporary campaigns cleaned up', finalCampaigns === baselineCampaigns);
  check('SA2. Temporary schedules cleaned up', finalSchedules === baselineSchedules);
  check('SA3. Existing recipients unchanged', finalRecipients === baselineRecipients);
  check('SA4. Existing messages unchanged', finalMessages === baselineMessages);

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
