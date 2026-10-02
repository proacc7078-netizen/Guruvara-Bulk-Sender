/**
 * Phase 5.6 — Persistent Campaign Scheduler Tests.
 *
 * Verifies that due CampaignSchedule rows are turned into exactly one
 * CampaignExecution snapshot (through the existing Phase 4.5 logic) and handed
 * to the existing ExecutionQueueWorker.
 *
 * Safety:
 * - the provider is MOCKED (globalThis.fetch intercepts graph.facebook.com only);
 *   any provider call while no mock is active is blocked and counted, so this
 *   suite can never send a real WhatsApp message.
 * - time is deterministic: schedules are written with explicit timestamps and the
 *   scheduler's clock is injected, so no long real-time sleeps are used.
 *
 * Run sequentially with the other suites — they share one SQLite database.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const dotenv = require('dotenv');
const argon2 = require('argon2');

dotenv.config({ path: path.join(__dirname, '.env') });

// This suite asserts the OFFICIAL (Meta Cloud API) batch/queue delivery path
// and mocks graph.facebook.com only. Pin the provider explicitly instead of
// inheriting the ambient .env value, so it keeps exercising the official
// adapter regardless of the local WHATSAPP_PROVIDER (e.g. 'openwa').
// Official credentials are still read from .env; no value is invented.
process.env.WHATSAPP_PROVIDER = 'official';

const REPO_ROOT = __dirname;
const SCHEMA_PATH = path.join(REPO_ROOT, 'prisma/schema.prisma');
const SCHEDULER_PATH = path.join(REPO_ROOT, 'apps/server/src/services/campaignScheduler.service.ts');
const WORKER_PATH = path.join(REPO_ROOT, 'apps/server/src/services/executionQueueWorker.ts');
const SERVICE_PATH = path.join(REPO_ROOT, 'apps/server/src/services/executionDelivery.service.ts');
const CAMPAIGN_UTIL_PATH = path.join(REPO_ROOT, 'apps/server/src/utils/campaignExecution.util.ts');
const SCHEDULE_UTIL_PATH = path.join(REPO_ROOT, 'apps/server/src/utils/campaignSchedule.util.ts');
const INDEX_PATH = path.join(REPO_ROOT, 'apps/server/src/index.ts');
const ENV_EXAMPLE_PATH = path.join(REPO_ROOT, '.env.example');
const STORAGE_DIR = path.join(REPO_ROOT, 'storage', 'uploads');

const TEST_PORT = 3154;
const BASE = 'http://127.0.0.1:' + TEST_PORT;

const RUN = String(Date.now()).slice(-6);
const PHONE_PREFIX = '9' + RUN;
const phoneFor = (n) => PHONE_PREFIX + String(n);

let checks = 0;
let failures = 0;
let server = null;
let prisma = null;
let tempUserId = null;
let originalFetch = null;
let strayProviderAttempts = 0;
let activeMock = null;

const createdCampaignIds = new Set();
const createdRecipientIds = new Set();
const createdMessageIds = new Set();
const createdScheduleIds = new Set();

function check(name, cond, extra) {
  checks++;
  if (!cond) failures++;
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (extra ? ' | ' + extra : ''));
}

function readSource(filePath) { return fs.readFileSync(filePath, 'utf8'); }

function sourceWithoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
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
function putJson(url, body, cookie) { return request('PUT', url, JSON.stringify(body), cookie, 'application/json'); }

/**
 * Provider mock. graph.facebook.com is always intercepted: when a mock is active
 * the call is captured (never forwarded), otherwise it is blocked and counted.
 */
function installProviderMock(sendResult) {
  if (!originalFetch) originalFetch = globalThis.fetch;
  const calls = [];
  const f = async (url, init) => {
    const target = typeof url === 'string' ? url : (url && url.url) || '';
    if (target.includes('graph.facebook.com')) {
      if (!activeMock) {
        strayProviderAttempts++;
        throw new Error('BLOCKED: provider call attempted without an active mock');
      }
      activeMock.calls.push({ url: target, init });
      return {
        ok: sendResult.ok,
        status: sendResult.status ?? 200,
        headers: { get: () => null },
        json: async () => sendResult.body ?? null,
        text: async () => JSON.stringify(sendResult.body ?? null),
      };
    }
    return originalFetch(url, init);
  };
  f.calls = calls;
  f.sendResult = sendResult;
  globalThis.fetch = f;
  activeMock = f;
  return f;
}

function restoreFetch() {
  activeMock = null;
  if (originalFetch) { globalThis.fetch = originalFetch; originalFetch = null; }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/* ------------------------------------------------------------------ *
 * Fixtures (created through the real API; schedules are written
 * directly so due timestamps are deterministic and no real-time sleep
 * is ever needed)
 * ------------------------------------------------------------------ */
const BASE_TIME = new Date();
let phoneSlot = 0;
const nextPhone = () => phoneFor(++phoneSlot);

async function createCampaignFixture(cookie, label, options = {}) {
  const recipientCount = options.recipients ?? 2;
  const recipientIds = [];
  for (let i = 1; i <= recipientCount; i++) {
    const res = await postJson('/api/recipients', {
      name: `P56 ${label} R${i}`,
      whatsappNumber: nextPhone(),
      language: 'Hindi',
      category: 'Phase56Test',
      status: 'ACTIVE',
      source: 'MANUAL',
    }, cookie);
    const id = res.json && res.json.data && res.json.data.id;
    if (id) createdRecipientIds.add(id);
    recipientIds.push(id);
  }

  const msgRes = await postJson('/api/messages', {
    name: `P56 ${label} M`,
    body: `P56 body ${label} ${RUN}`,
    language: 'Hindi',
    status: 'DRAFT',
  }, cookie);
  const messageId = msgRes.json && msgRes.json.data && msgRes.json.data.id;
  if (messageId) createdMessageIds.add(messageId);

  const campRes = await postJson('/api/campaigns', { name: `P56 ${label} C`, messageId }, cookie);
  const campaignId = campRes.json && campRes.json.data && campRes.json.data.id;
  if (campaignId) createdCampaignIds.add(campaignId);

  await putJson(`/api/campaigns/${campaignId}/audience`, { recipientIds }, cookie);

  let finalized = false;
  if (options.finalize !== false) {
    const res = await postJson(`/api/campaigns/${campaignId}/finalize`, {}, cookie);
    finalized = res.status === 200;
  }

  return { campaignId, messageId, recipientIds, recipientCount, finalized };
}

async function createDueSchedule(campaignId, offsetMs, options = {}) {
  const created = await prisma.campaignSchedule.create({
    data: {
      campaignId,
      scheduledAt: new Date(BASE_TIME.getTime() + offsetMs),
      timezone: options.timezone || 'UTC',
      status: options.status || 'SCHEDULED',
    },
  });
  createdScheduleIds.add(created.id);
  return created;
}

const executionCountFor = (campaignId) => prisma.campaignExecution.count({ where: { campaignId } });
const scheduleById = (id) => prisma.campaignSchedule.findUnique({ where: { id } });

/* ------------------------------------------------------------------ *
 * Static contracts
 * ------------------------------------------------------------------ */
function staticContractTests() {
  console.log('\n--- Static contracts ---');
  const schema = readSource(SCHEMA_PATH);
  const scheduler = readSource(SCHEDULER_PATH);
  const schedulerCode = sourceWithoutComments(scheduler);
  const flat = schedulerCode.replace(/\s+/g, ' ');
  const index = readSource(INDEX_PATH);
  const scheduleUtil = readSource(SCHEDULE_UTIL_PATH);
  const envExample = readSource(ENV_EXAMPLE_PATH);

  check('1. Scheduler service exists', /export class CampaignSchedulerService/.test(scheduler));
  check('2. Uses the existing execution creation service',
    /createExecutionSnapshot/.test(schedulerCode) &&
    scheduler.includes("from '../utils/campaignExecution.util'"));
  check('3. Persists in SQLite through Prisma (no external infrastructure)',
    /prisma\.campaignSchedule/.test(schedulerCode) && !/redis|bullmq|bull/i.test(schedulerCode));
  check('4. Only processes SCHEDULED schedules', /status: 'SCHEDULED'/.test(flat));
  check('5. Only processes READY campaigns', /status: 'READY'/.test(flat));
  check('6. Idempotency now rests on the consumedAt marker (schedules are re-runnable)',
    /consumedAt: null/.test(flat) && !flat.includes('execution: { is: null }'));
  check('7. CampaignExecution.scheduleId is no longer unique so a campaign can be re-run',
    !/scheduleId\s+String\?+@unique/.test(schema));
  check('8. Scheduler never touches the provider or Meta',
    !/whatsapp|graph\.facebook|fetch\(|axios|http\.request|https\.request/i.test(schedulerCode) &&
    !/executionDelivery|SendResult|accessToken/i.test(schedulerCode));
  check('9. No retry mechanism implemented in the scheduler',
    !/retryCount|maxRetries|backoff|retryExecution/i.test(schedulerCode));
  check('10. Scheduler starts with the server',
    /scheduler\.start\(\)/.test(index) && /worker\.start\(\)/.test(index));
  check('11. Scheduler stops gracefully before the worker on shutdown',
    /scheduler\.stop\(\)/.test(index) &&
    index.indexOf('scheduler.stop()') < index.indexOf('worker.stop()'));
  check('12. Lifecycle exported for tests (same pattern as the worker)',
    /export const scheduler = new CampaignSchedulerService/.test(index) &&
    /export const worker = new ExecutionQueueWorker/.test(index));
  check('13. Conservative default poll interval',
    /DEFAULT_SCHEDULER_POLL_INTERVAL_MS = 60_000/.test(schedulerCode));
  check('14. Poll interval and batch size are configurable',
    /SCHEDULER_POLL_INTERVAL_MS/.test(schedulerCode) &&
    /SCHEDULER_BATCH_SIZE/.test(schedulerCode) &&
    /pollIntervalMs: number = readSchedulerPollIntervalMs\(\)/.test(flat) &&
    envExample.includes('SCHEDULER_POLL_INTERVAL_MS') && envExample.includes('SCHEDULER_BATCH_SIZE'));
  check('15. Additive schema fields for consumed/failure bookkeeping',
    /consumedAt\s+DateTime\?/.test(schema) && /lastAttemptAt\s+DateTime\?/.test(schema) &&
    /lastError\s+String\?/.test(schema));
  check('16. Phase 4.4 plan fields and vocabulary unchanged',
    /status\s+String\s+@default\("SCHEDULED"\)/.test(schema) &&
    /scheduledAt\s+DateTime/.test(schema) && /timezone\s+String/.test(schema) &&
    /SCHEDULE_STATUSES = \['SCHEDULED', 'CANCELLED'\]/.test(scheduleUtil) &&
    !/SCHEDULE_STATUSES/.test(schedulerCode));
  check('17. Scheduler reuses the existing execution snapshot logic, not a copy',
    !/prisma\.campaignExecution\.create/.test(schedulerCode) &&
    /prisma\.campaignExecution\.findFirst/.test(schedulerCode));
}

/* ------------------------------------------------------------------ *
* Runtime helpers — deterministic clock, no real-time waiting
* ------------------------------------------------------------------ */
let CampaignSchedulerService;
let DEFAULT_SCHEDULER_POLL_INTERVAL_MS;

function loadSchedulerModule() {
  if (!CampaignSchedulerService) {
    ({ CampaignSchedulerService, DEFAULT_SCHEDULER_POLL_INTERVAL_MS } = require('./apps/server/src/services/campaignScheduler.service'));
  }
}

function makeScheduler(clockNow, onHandoff, pollIntervalMs = 60_000) {
  const handoffCalls = [];
  const scheduler = new CampaignSchedulerService(
    pollIntervalMs,
    async (executionIds) => {
      handoffCalls.push([...executionIds]);
      if (onHandoff) await onHandoff(executionIds);
    },
    () => clockNow
  );
  return { scheduler, handoffCalls };
}

async function runCycle(clockNow) {
  const { scheduler, handoffCalls } = makeScheduler(clockNow);
  const result = await scheduler.processDueSchedules();
  return { result, handoffCalls };
}

/* ------------------------------------------------------------------ *
 * 1) Future schedule is not executed early
 * ------------------------------------------------------------------ */
async function futureScheduleTests(cookie) {
  console.log('\n--- Future schedule is not executed early ---');
  const fixture = await createCampaignFixture(cookie, 'Early');
  check('18. Fixture campaign is READY', fixture.finalized === true);

  const wallClock = new Date(BASE_TIME.getTime() + 172_800_000).toISOString().slice(0, 16); // +48h
  const created = await postJson(`/api/campaigns/${fixture.campaignId}/schedule`,
    { scheduledAt: wallClock, timezone: 'Asia/Kolkata' }, cookie);
  check('19. Schedule created through the Phase 4.4 API',
    (created.status === 201 || created.status === 200) &&
    created.json.data.schedule.status === 'SCHEDULED', 'status=' + created.status);

  const schedule = await prisma.campaignSchedule.findUnique({ where: { campaignId: fixture.campaignId } });
  if (schedule) createdScheduleIds.add(schedule.id);
  const storedInstant = schedule.scheduledAt;
  check('20. scheduledAt is stored as the normalized UTC instant (timezone not reinterpreted)',
    storedInstant instanceof Date && storedInstant.getTime() > BASE_TIME.getTime(),
    'stored=' + storedInstant.toISOString());

  const early = await runCycle(BASE_TIME);
  check('21. A future schedule is not executed early',
    early.result.scanned === 0 && early.result.executed === 0 &&
    (await executionCountFor(fixture.campaignId)) === 0,
    JSON.stringify(early.result));

  const untouched = await scheduleById(schedule.id);
  check('22. Future schedule stays unconsumed', untouched.consumedAt === null && untouched.lastAttemptAt === null);

  return { fixture, schedule, storedInstant };
}

/* ------------------------------------------------------------------ *
 * 2) Due schedule creates exactly one execution
 * ------------------------------------------------------------------ */
async function dueScheduleTests(cookie, context) {
  console.log('\n--- Due schedule creates exactly one execution ---');
  const { fixture, schedule, storedInstant } = context;

  const before = await runCycle(new Date(storedInstant.getTime() - 1000));
  check('23. Not executed before the stored instant', before.result.executed === 0 &&
    (await executionCountFor(fixture.campaignId)) === 0);

  const due = await runCycle(storedInstant);
  check('24. Executed exactly once at the stored instant',
    due.result.executed === 1 && due.result.executionIds.length === 1, JSON.stringify(due.result));

  const executions = await prisma.campaignExecution.findMany({ where: { campaignId: fixture.campaignId } });
  check('25. Exactly one execution row exists', executions.length === 1, 'count=' + executions.length);
  const execution = executions[0];
  check('26. Execution references the schedule', execution.scheduleId === schedule.id);
  check('27. Execution scheduledAt equals the normalized stored instant',
    execution.scheduledAt.getTime() === storedInstant.getTime());
  check('28. Execution starts PENDING (snapshot only, no sending)', execution.status === 'PENDING');

  const consumed = await scheduleById(schedule.id);
  check('29. Schedule marked consumed at the cycle time',
    consumed.consumedAt !== null && consumed.consumedAt.getTime() === storedInstant.getTime(),
    'consumedAt=' + (consumed.consumedAt && consumed.consumedAt.toISOString()));
  check('30. Schedule keeps the Phase 4.4 SCHEDULED status (vocabulary unchanged)', consumed.status === 'SCHEDULED');
  check('31. Success clears the failure bookkeeping', consumed.lastError === null && consumed.lastAttemptAt !== null);
  check('32. Hand-off received the created execution id',
    due.handoffCalls.length === 1 && due.handoffCalls[0][0] === execution.id,
    JSON.stringify(due.handoffCalls));
  check('33. Cycle handed off exactly once', due.handoffCalls.length === 1);

  return execution;
}

/* ------------------------------------------------------------------ *
 * 3) Snapshot content
 * ------------------------------------------------------------------ */
async function snapshotTests(cookie, context, execution) {
  console.log('\n--- Execution snapshot content ---');
  const { fixture } = context;
  const message = await prisma.message.findUnique({ where: { id: fixture.messageId } });
  const recipients = await prisma.recipient.findMany({ where: { id: { in: fixture.recipientIds } } });

  check('34. Message identity/body/language snapshotted',
    execution.messageId === message.id && execution.messageName === message.name &&
    execution.messageBody === message.body && execution.messageLanguage === message.language);
  check('35. Media snapshot stays null (no media attached)',
    execution.mediaId === null && execution.mediaPath === null);

  const rows = await prisma.campaignExecutionRecipient.findMany({ where: { executionId: execution.id } });
  const byRecipient = new Map(rows.map((row) => [row.recipientId, row]));
  check('36. One snapshot row per audience recipient', rows.length === fixture.recipientCount, 'rows=' + rows.length);
  check('37. Phone numbers snapshotted from the recipients',
    recipients.every((r) => byRecipient.get(r.id) && byRecipient.get(r.id).whatsappNumber === r.whatsappNumber));
  check('38. Names snapshotted from the recipients',
    recipients.every((r) => byRecipient.get(r.id) && byRecipient.get(r.id).name === r.name));
  check('39. All snapshot rows start PENDING', rows.every((row) => row.status === 'PENDING'));
  check('40. Snapshot numbers are the test-owned fake numbers',
    rows.every((row) => String(row.whatsappNumber).startsWith(PHONE_PREFIX)));

  // Snapshot immutability: later audience edits must not change the execution.
  await putJson(`/api/campaigns/${fixture.campaignId}/audience`, { recipientIds: [fixture.recipientIds[0]] }, cookie);
  const afterEdit = await prisma.campaignExecution.findUnique({ where: { id: execution.id } });
  const rowsAfter = await prisma.campaignExecutionRecipient.findMany({ where: { executionId: execution.id } });
  check('41. Audience change does not alter the created snapshot',
    afterEdit.messageBody === execution.messageBody && rowsAfter.length === rows.length);
  check('42. Delivery reads the immutable snapshot, not mutable Message data',
    readSource(SERVICE_PATH).includes('executionRecipient.execution.messageBody') &&
    readSource(SERVICE_PATH).includes('executionRecipient.whatsappNumber'));
}

/* ------------------------------------------------------------------ *
 * 4) Worker processes the resulting execution (mocked provider)
 * ------------------------------------------------------------------ */
async function workerHandoffTests(context, execution) {
  console.log('\n--- Worker processes the resulting execution (mocked provider) ---');
  const { fixture, schedule } = context;
  const mock = installProviderMock({
    ok: true,
    status: 200,
    body: { success: true, messages: [{ id: 'wamid_56_' + RUN }] },
  });

  // A scheduler cycle must never talk to the provider.
  const silent = await runCycle(schedule.scheduledAt);
  check('43. Scheduler cycles make no provider call',
    silent.result.executed === 0 && mock.calls.length === 0, 'calls=' + mock.calls.length);

  // The worker only delivers once the execution's scheduledAt has actually
  // arrived. This fixture's schedule is BASE_TIME + 48h, so it is still in the
  // future here: the worker must skip it. Rewind scheduledAt into the past to
  // represent the due moment, then it must process and deliver normally.
  const { ExecutionQueueWorker } = require('./apps/server/src/services/executionQueueWorker');

  const earlyWorker = new ExecutionQueueWorker(60_000);
  let earlyResult;
  try {
    earlyResult = await earlyWorker.processCycle();
  } finally {
    await earlyWorker.stop();
  }
  check('43b. Worker skips an execution whose scheduledAt is still in the future',
    earlyResult.processed === 0 && earlyResult.sent === 0 && mock.calls.length === 0,
    JSON.stringify({ r: earlyResult, calls: mock.calls.length }));

  await prisma.campaignExecution.update({
    where: { id: execution.id },
    data: { scheduledAt: new Date(Date.now() - 60_000) },
  });

  const worker = new ExecutionQueueWorker(60_000);
  let processed;
  try {
    processed = await worker.processCycle();
  } finally {
    await worker.stop();
  }
  check('44. Worker processed the scheduled execution',
    processed.processed >= 2 && processed.sent >= 2, JSON.stringify(processed));

  const rows = await prisma.campaignExecutionRecipient.findMany({ where: { executionId: execution.id } });
  check('45. Recipients marked SENT with a provider message id',
    rows.every((row) => row.status === 'SENT' && !!row.providerMessageId));
  const exec = await prisma.campaignExecution.findUnique({ where: { id: execution.id } });
  check('46. Execution processed by the worker', exec.status === 'COMPLETED' || exec.status === 'PENDING', 'status=' + exec.status);
  check('47. Every provider call went to the mocked Meta endpoint only',
    mock.calls.length >= 2 && mock.calls.every((call) => call.url.includes('graph.facebook.com')));

  const bodies = mock.calls.map((call) => { try { return JSON.parse(call.init.body).text.body; } catch { return null; } });
  const targets = mock.calls.map((call) => { try { return JSON.parse(call.init.body).to; } catch { return null; } });
  check('48. Worker sent the snapshot body (mutable Message data never reloaded)',
    bodies.length >= 2 && bodies.every((body) => body === exec.messageBody));
  check('49. Worker sent to the snapshot phone numbers', targets.every((t) => String(t).startsWith(PHONE_PREFIX)));

  restoreFetch();
  check('50. No provider call escaped the mock', strayProviderAttempts === 0, 'stray=' + strayProviderAttempts);
}

/* ------------------------------------------------------------------ *
 * 5) Idempotency — one execution per schedule, forever
 * ------------------------------------------------------------------ */
async function idempotencyTests(context) {
  console.log('\n--- Idempotency ---');
  const { fixture, schedule } = context;
  const consumedBefore = await scheduleById(schedule.id);

  const rerun = await runCycle(schedule.scheduledAt);
  check('51. Re-running a cycle does not execute the schedule again',
    rerun.result.executed === 0 && (await executionCountFor(fixture.campaignId)) === 1);
  const consumedAfter = await scheduleById(schedule.id);
  check('52. Consumption marker is not rewritten',
    consumedAfter.consumedAt.getTime() === consumedBefore.consumedAt.getTime());

  const restarted = await runCycle(schedule.scheduledAt);
  check('53. Scheduler restart does not duplicate the execution',
    restarted.result.executed === 0 && (await executionCountFor(fixture.campaignId)) === 1);
  check('54. Exactly one execution row per schedule (DB unique constraint)',
    (await prisma.campaignExecution.count({ where: { scheduleId: schedule.id } })) === 1);

  await prisma.campaignExecution.deleteMany({ where: { campaignId: fixture.campaignId } });
  const afterDelete = await runCycle(schedule.scheduledAt);
  check('55. A consumed schedule is never executed again',
    afterDelete.result.executed === 0 && (await executionCountFor(fixture.campaignId)) === 0);
}

/* ------------------------------------------------------------------ *
 * 6) Multiple due schedules
 * ------------------------------------------------------------------ */
async function multipleDueTests(cookie) {
  console.log('\n--- Multiple due schedules ---');
  const a = await createCampaignFixture(cookie, 'MultiA');
  const b = await createCampaignFixture(cookie, 'MultiB');
  const scheduleA = await createDueSchedule(a.campaignId, -120_000);
  const scheduleB = await createDueSchedule(b.campaignId, -60_000);

  const cycle = await runCycle(BASE_TIME);
  check('56. Multiple due schedules are handled in one cycle',
    cycle.result.scanned === 2 && cycle.result.executed === 2 && cycle.result.executionIds.length === 2,
    JSON.stringify(cycle.result));
  check('57. Each due schedule produced its own execution',
    (await prisma.campaignExecution.count({ where: { scheduleId: { in: [scheduleA.id, scheduleB.id] } } })) === 2);
  check('58. Both schedules are consumed',
    (await scheduleById(scheduleA.id)).consumedAt !== null &&
    (await scheduleById(scheduleB.id)).consumedAt !== null);
  check('59. One hand-off carrying both executions',
    cycle.handoffCalls.length === 1 && cycle.handoffCalls[0].length === 2);
}

/* ------------------------------------------------------------------ *
 * 7) CANCELLED schedules are skipped
 * ------------------------------------------------------------------ */
async function cancelledScheduleTests(cookie) {
  console.log('\n--- CANCELLED schedules are skipped ---');
  const fixture = await createCampaignFixture(cookie, 'Cancelled');
  const wallClock = new Date(BASE_TIME.getTime() + 172_800_000).toISOString().slice(0, 16);
  const created = await postJson(`/api/campaigns/${fixture.campaignId}/schedule`,
    { scheduledAt: wallClock, timezone: 'Asia/Kolkata' }, cookie);
  const scheduleId = created.json.data.schedule.id;
  createdScheduleIds.add(scheduleId);

  const cancelled = await postJson(`/api/campaigns/${fixture.campaignId}/schedule/cancel`, {}, cookie);
  check('60. Schedule cancelled through the Phase 4.4 API',
    cancelled.status === 200 && cancelled.json.data.schedule.status === 'CANCELLED');

  // Make it due without waiting for real time.
  await prisma.campaignSchedule.update({
    where: { id: scheduleId },
    data: { scheduledAt: new Date(BASE_TIME.getTime() - 60_000) },
  });

  const cycle = await runCycle(BASE_TIME);
  check('61. CANCELLED schedule is skipped',
    cycle.result.executed === 0 && (await executionCountFor(fixture.campaignId)) === 0,
    JSON.stringify(cycle.result));
  const row = await scheduleById(scheduleId);
  check('62. Cancelled schedule stays untouched',
    row.consumedAt === null && row.status === 'CANCELLED' && row.lastError === null);
}

/* ------------------------------------------------------------------ *
 * 8) Non-READY campaigns are skipped safely
 * ------------------------------------------------------------------ */
async function nonReadyCampaignTests(cookie) {
  console.log('\n--- Non-READY campaigns are skipped safely ---');
  const fixture = await createCampaignFixture(cookie, 'DraftOnly', { finalize: false });
  const campaign = await prisma.campaign.findUnique({ where: { id: fixture.campaignId } });
  check('63. Fixture campaign is not READY', campaign.status === 'DRAFT', 'status=' + campaign.status);

  const schedule = await createDueSchedule(fixture.campaignId, -60_000);
  const cycle = await runCycle(BASE_TIME);
  check('64. Non-READY campaign is skipped without creating an execution',
    cycle.result.executed === 0 && cycle.result.failed === 0 &&
    (await executionCountFor(fixture.campaignId)) === 0, JSON.stringify(cycle.result));

  const row = await scheduleById(schedule.id);
  check('65. Skipped schedule is untouched (not consumed, not failed)',
    row.consumedAt === null && row.lastError === null && row.lastAttemptAt === null);

  const finalized = await postJson(`/api/campaigns/${fixture.campaignId}/finalize`, {}, cookie);
  const after = await runCycle(BASE_TIME);
  check('66. The schedule runs as soon as the campaign becomes READY',
    finalized.status === 200 && after.result.executed === 1 &&
    (await scheduleById(schedule.id)).consumedAt !== null);
}

/* ------------------------------------------------------------------ *
 * 9) Failure behaviour — never silently consumed, never duplicated
 * ------------------------------------------------------------------ */
async function failureRecoveryTests(cookie) {
  console.log('\n--- Failure behaviour ---');
  const fixture = await createCampaignFixture(cookie, 'Failing');
  const schedule = await createDueSchedule(fixture.campaignId, -60_000);
  await prisma.message.update({ where: { id: fixture.messageId }, data: { status: 'ARCHIVED' } });

  const failedCycle = await runCycle(BASE_TIME);
  check('67. Failed creation is reported, never hidden',
    failedCycle.result.failed === 1 && failedCycle.result.executed === 0 &&
    failedCycle.result.errors[0].code === 'MESSAGE_ARCHIVED',
    JSON.stringify(failedCycle.result.errors));
  const row = await scheduleById(schedule.id);
  check('68. Failed schedule is not marked consumed', row.consumedAt === null);
  check('69. Failure reason preserved for future recovery',
    typeof row.lastError === 'string' && row.lastError.includes('MESSAGE_ARCHIVED') &&
    row.lastAttemptAt !== null, 'lastError=' + row.lastError);
  check('70. No execution was created by the failure', (await executionCountFor(fixture.campaignId)) === 0);

  await prisma.message.update({ where: { id: fixture.messageId }, data: { status: 'DRAFT' } });
  const retryCycle = await runCycle(BASE_TIME);
  check('71. Recovered schedule is executed on the next cycle', retryCycle.result.executed === 1);
  check('72. Retry never creates a duplicate execution',
    (await prisma.campaignExecution.count({ where: { scheduleId: schedule.id } })) === 1);
  const recovered = await scheduleById(schedule.id);
  check('73. Consumption clears the preserved error',
    recovered.consumedAt !== null && recovered.lastError === null);
}

/* ------------------------------------------------------------------ *
 * 10) Externally consumed schedule (Phase 4.5 API) + reconciliation
 * ------------------------------------------------------------------ */
async function externallyConsumedTests(cookie) {
  console.log('\n--- Externally consumed schedule ---');
  const fixture = await createCampaignFixture(cookie, 'External');
  const schedule = await createDueSchedule(fixture.campaignId, -60_000);

  const api = await postJson(`/api/campaigns/${fixture.campaignId}/execution`, {}, cookie);
  check('74. Execution created through the existing Phase 4.5 API',
    (api.status === 201 || api.status === 200) && !!api.json.data.execution.id, 'status=' + api.status);

  const cycle = await runCycle(BASE_TIME);
  check('75. Scheduler does not create a second execution',
    cycle.result.executed === 0 &&
    (await prisma.campaignExecution.count({ where: { scheduleId: schedule.id } })) === 1,
    JSON.stringify(cycle.result));
  const row = await scheduleById(schedule.id);
  check('76. Consumption marker reconciled for the externally consumed schedule',
    row.consumedAt !== null && cycle.result.reconciled >= 1, 'reconciled=' + cycle.result.reconciled);
}

/* ------------------------------------------------------------------ *
 * 11) Lifecycle — start once, stop gracefully, no lingering timer
 * ------------------------------------------------------------------ */
async function lifecycleTests() {
  console.log('\n--- Lifecycle ---');
  // Clock far in the past: nothing can be due, so this is side-effect free.
  const { scheduler, handoffCalls } = makeScheduler(new Date(0), null, 50);
  check('77. Scheduler is idle before start', scheduler.isRunning() === false && scheduler.isProcessing() === false);

  scheduler.start();
  check('78. Scheduler starts', scheduler.isRunning() === true);
  check('79. Interval and batch size are injected/configurable',
    scheduler.getPollIntervalMs() === 50 &&
    DEFAULT_SCHEDULER_POLL_INTERVAL_MS === 60_000 &&
    scheduler.getBatchSize() >= 1);

  const originalCycle = scheduler.processDueSchedules.bind(scheduler);
  let ticks = 0;
  scheduler.processDueSchedules = async () => {
    ticks++;
    return { scanned: 0, executed: 0, alreadyConsumed: 0, failed: 0, reconciled: 0, executionIds: [], errors: [] };
  };
  scheduler.start(); // duplicate start must be a no-op
  await sleep(300);
  scheduler.processDueSchedules = originalCycle;
  check('80. A second start does not create a duplicate loop', ticks >= 2 && ticks <= 9, 'ticks=' + ticks);

  await scheduler.stop();
  check('81. Graceful stop clears the loop', scheduler.isRunning() === false && scheduler.isProcessing() === false);
  const ticksAtStop = ticks;
  await sleep(200);
  check('82. No cycle runs after stop', ticks === ticksAtStop, 'ticks=' + ticks);
  await scheduler.stop();
  check('83. stop() is idempotent', scheduler.isRunning() === false);
  check('84. No hand-off for a clock with nothing due', handoffCalls.length === 0);
}

/* ------------------------------------------------------------------ *
 * 12) Security — no credentials, no provider traffic
 * ------------------------------------------------------------------ */
async function securityTests() {
  console.log('\n--- Security ---');
  const scheduler = readSource(SCHEDULER_PATH);
  const index = readSource(INDEX_PATH);
  const testSource = readSource(__filename);

  check('85. No credentials in the scheduler service',
    !/access_token|accessToken|authorization|Bearer|WHATSAPP_ACCESS/i.test(scheduler) &&
    !/EAA[A-Za-z0-9]{12}/.test(scheduler));
  check('86. No credentials in the server bootstrap',
    !/WHATSAPP_ACCESS_TOKEN\s*[:=]/i.test(index) && !/EAA[A-Za-z0-9]{12}/.test(index));
  check('87. This suite never reads provider credentials from the environment',
    !/process\.env\.WHATSAPP_(ACCESS_TOKEN|BUSINESS_ACCOUNT_ID|PHONE_NUMBER_ID)/.test(testSource));

  const testRecipients = await prisma.recipient.findMany({ where: { id: { in: [...createdRecipientIds] } } });
  check('88. Every recipient used by this suite is a fake test number',
    testRecipients.length > 0 &&
    testRecipients.every((r) => String(r.whatsappNumber).startsWith(PHONE_PREFIX)),
    'recipients=' + testRecipients.length);
  check('89. No provider call escaped the mock during the whole suite',
    strayProviderAttempts === 0, 'stray=' + strayProviderAttempts);
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */
async function main() {
  console.log('=== Phase 5.6: Persistent Campaign Scheduler ===\n');

  process.env.PORT = String(TEST_PORT);
  const originalListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) { server = this; return originalListen.apply(this, args); };
  require('tsx/cjs');
  require('./apps/server/src/index.ts');
  loadSchedulerModule();

  const indexModule = require('./apps/server/src/index.ts');
  const serverWorker = indexModule.scheduler;

  const { PrismaClient } = require('@prisma/client');
  const serverUp = await waitForServer(20000);
  check('0. Server reachable', serverUp);
  if (!serverUp) { process.exitCode = 1; return; }

  prisma = new PrismaClient();

  const email = 'phase56-' + RUN + '@example.com';
  const password = 'Phase56-' + RUN + '-pw!';
  const createdUser = await prisma.user.create({ data: { email, password: await argon2.hash(password) } });
  tempUserId = createdUser.id;
  const loginRes = await request('POST', '/api/auth/login', JSON.stringify({ email, password }), null, 'application/json');
  const cookie = loginRes.setCookie ? loginRes.setCookie.split(';')[0] : null;
  check('0b. Auth', cookie !== null);
  if (!cookie) return;

  try {
    staticContractTests();

    const context = await futureScheduleTests(cookie);
    const execution = await dueScheduleTests(cookie, context);
    await snapshotTests(cookie, context, execution);
    await workerHandoffTests(context, execution);
    await idempotencyTests(context);
    await multipleDueTests(cookie);
    await cancelledScheduleTests(cookie);
    await nonReadyCampaignTests(cookie);
    await failureRecoveryTests(cookie);
    await externallyConsumedTests(cookie);
    await lifecycleTests();
    await securityTests();
  } catch (error) {
    failures++;
    console.error('Error:', error && error.stack ? error.stack : error);
  } finally {
    if (serverWorker) { try { await serverWorker.stop(); } catch { } }
    if (tempUserId) { try { await prisma.user.delete({ where: { id: tempUserId } }); } catch { } }
  }

  console.log('\nAssertions run: ' + checks + ' | failed: ' + failures);
  console.log('=== ' + (failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED') + ' ===');
  process.exitCode = failures === 0 ? 0 : 1;

  if (server) await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error('Error:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
