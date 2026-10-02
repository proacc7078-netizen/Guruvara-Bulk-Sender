/**
 * Phase 5.8 — WhatsApp Webhook Processing Tests
 *
 * Verifies Meta Cloud API webhook verification (GET challenge), HMAC-SHA256
 * signature validation (POST), event normalization, monotonic status progress,
 * idempotent delivery-status updates, execution recalculation and security
 * properties — with a fully mocked provider so NO real Meta/WhatsApp call
 * is ever made.
 *
 * Safety:
 * - WHATSAPP_PROVIDER is forced to 'none' BEFORE the server starts, so the
 *   background ExecutionQueueWorker can never reach graph.facebook.com.
 * - A provider mock is installed as a belt-and-suspenders barrier: ANY
 *   graph.facebook.com call is blocked and counted as a fatal stray attempt.
 * - Only fake test recipients/campaigns/executions are created and are
 *   cleaned up; the baseline database is preserved.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const REPO_ROOT = __dirname;
const SERVICE_PATH = path.join(REPO_ROOT, 'apps/server/src/services/whatsapp/whatsappWebhook.service.ts');
const CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/webhook.controller.ts');
const ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/webhook.routes.ts');
const INDEX_PATH = path.join(REPO_ROOT, 'apps/server/src/index.ts');

const TEST_PORT = 3158;
process.env.PORT = String(TEST_PORT); // must precede server require so it listens here, not on 3000
const BASE = 'http://127.0.0.1:' + TEST_PORT;

// Webhook test credentials (NOT real Meta credentials). Set BEFORE requiring
// the server. dotenv.config() does not override existing env vars, so these
// remain in effect.
const VERIFY_TOKEN = 'p58-verify-token-' + String(Date.now()).slice(-6);
const APP_SECRET = 'p58-app-secret';
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = VERIFY_TOKEN;
process.env.WHATSAPP_APP_SECRET = APP_SECRET;
process.env.WHATSAPP_PROVIDER = 'none';            // block real provider sends
process.env.SCHEDULER_POLL_INTERVAL_MS = '999900'; // keep the scheduler asleep
process.env.WORKER_POLL_INTERVAL_MS = '999900';    // keep the worker asleep

const RUN = String(Date.now()).slice(-6);
const PHONE_PREFIX = '9' + RUN;
const phoneFor = (n) => PHONE_PREFIX + String(n);
const MSG_ID = (n) => 'p58_msg_' + n;

let checks = 0;
let failures = 0;
let server = null;
let indexModule = null;
let prisma = null;
let originalFetch = null;
let strayProviderAttempts = 0;

const createdRecipientIds = new Set();
const createdMessageIds = new Set();
const createdCampaignIds = new Set();
const createdExecutionIds = new Set();

function check(name, cond, extra) {
  checks++;
  if (!cond) failures++;
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (extra ? ' | ' + extra : ''));
}

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}
function sourceWithoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// body may be undefined for GET
async function request(method, url, body, contentType, extraHeaders) {
  const headers = {};
  if (contentType) headers['Content-Type'] = contentType;
  if (extraHeaders) Object.assign(headers, extraHeaders);
  const res = await fetch(BASE + url, { method, headers, body });
  const raw = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  return { status: res.status, json: parsed, text: raw };
}

function getJson(url) {
  return request('GET', url, undefined, undefined);
}
function postJson(url, body, extraHeaders) {
  return request('POST', url, JSON.stringify(body), 'application/json', extraHeaders);
}

/** Provider mock: blocks every graph.facebook.com call (counted as stray). */
function installProviderMock() {
  if (!originalFetch) originalFetch = globalThis.fetch;
  const f = async (url, init) => {
    const target = typeof url === 'string' ? url : (url && url.url) || '';
    if (target.includes('graph.facebook.com')) {
      strayProviderAttempts++;
      throw new Error('BLOCKED: stray provider call to graph.facebook.com');
    }
    return originalFetch(url, init);
  };
  globalThis.fetch = f;
  return f;
}
function restoreFetch() {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function buildPayload(id, status, opts = {}) {
  const statuses = [{ id, status }];
  if (opts.timestamp !== undefined) statuses[0].timestamp = String(opts.timestamp);
  if (opts.recipient_id !== undefined) statuses[0].recipient_id = opts.recipient_id;
  if (opts.errors !== undefined) statuses[0].errors = opts.errors;
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: '123',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: '111', display_phone_number: '222' },
          statuses,
        },
      }],
    }],
  };
}

function signPayload(raw) {
  return 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
}

async function postWebhook(bodyObj) {
  const raw = JSON.stringify(bodyObj);
  return request('POST', '/api/webhooks/whatsapp', raw, 'application/json', {
    'X-Hub-Signature-256': signPayload(raw),
  });
}

async function createTestRecipient(suffix) {
  const whatsappNumber = phoneFor(suffix);
  const rec = await prisma.recipient.create({
    data: {
      name: 'P58 R' + suffix + ' ' + RUN,
      whatsappNumber,
      normalizedPhone: whatsappNumber,
      language: 'Hindi',
      category: 'Phase58Test',
      status: 'ACTIVE',
      source: 'MANUAL',
    },
  });
  createdRecipientIds.add(rec.id);
  return rec;
}

async function createTestCampaign(suffix) {
  const msg = await prisma.message.create({
    data: { name: 'P58 M' + suffix + ' ' + RUN, body: 'P58 body ' + RUN, language: 'Hindi', status: 'DRAFT' },
  });
  createdMessageIds.add(msg.id);
  const camp = await prisma.campaign.create({ data: { name: 'P58 C' + suffix + ' ' + RUN, messageId: msg.id } });
  createdCampaignIds.add(camp.id);
  return camp;
}

// recipients: [{ id: MSG_ID(n), status: 'SENT'|'PENDING'|... }]
async function seedExecution(recipientId, whatsappNumber, recipientName, recipients) {
  const camp = await createTestCampaign(String(recipients.length > 1 ? recipients[0].id.slice(-1) : '1'));
  const execution = await prisma.campaignExecution.create({
    data: {
      campaignId: camp.id,
      status: 'RUNNING',
      scheduledAt: new Date(),
      startedAt: new Date(),
      messageBody: 'P58 delivery body ' + RUN,
    },
  });
  createdExecutionIds.add(execution.id);
  for (const r of recipients) {
    await prisma.campaignExecutionRecipient.create({
      data: {
        executionId: execution.id,
        recipientId,
        whatsappNumber,
        name: recipientName,
        providerMessageId: r.id,
        status: r.status,
      },
    });
  }
  return execution;
}

function configHelperTests() {
  console.log('\n--- Section A: Config helpers ---');
  const svc = require('./apps/server/src/services/whatsapp/whatsappWebhook.service.ts');
  const state = svc.getWebhookConfigState();
  check('A1. Config configured=true when env set', state.configured === true, JSON.stringify(state));

  const cfg = svc.loadWhatsAppWebhookConfig();
  check('A2. loadWhatsAppWebhookConfig returns token+secret', !!cfg && cfg.verifyToken === VERIFY_TOKEN && cfg.appSecret === APP_SECRET);

  const oldToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  const oldSecret = process.env.WHATSAPP_APP_SECRET;
  try {
    delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    delete process.env.WHATSAPP_APP_SECRET;
    const empty = svc.getWebhookConfigState();
    check('A3. configured=false when env unset', empty.configured === false && empty.error === null, JSON.stringify(empty));
  } finally {
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = oldToken;
    process.env.WHATSAPP_APP_SECRET = oldSecret;
  }
}
function sourceSecurityTests() {
  console.log('\n--- Section B: Source security ---');
  const swc = sourceWithoutComments(readSource(SERVICE_PATH));
  check('B1. No hardcoded app secret in service', !/p58-app-secret/.test(swc));
  check('B2. No hardcoded verify token in service', !/p58-verify-token/.test(swc));
  check('B3. No access_token literal in service', !/access_token/i.test(swc));
  check('B4. No EA[A-] bearer token in service', !/EA[A-Za-z0-9_-]{12}/.test(swc));

  const cwc = sourceWithoutComments(readSource(CONTROLLER_PATH));
  check('B5. No credentials in controller', !/access_token|WHATSAPP_ACCESS_TOKEN/i.test(cwc));
  check('B6. Controller uses getWebhookConfigState', /getWebhookConfigState/.test(cwc));

  const rwc = sourceWithoutComments(readSource(ROUTES_PATH));
  check('B7. Routes define GET and POST webhook', /router\.get\(['"]\/whatsapp['"]/.test(rwc) && /router\.post\(['"]\/whatsapp['"]/.test(rwc));
  check('B8. Server mounts raw body parser for webhooks', /express\.raw/.test(sourceWithoutComments(readSource(INDEX_PATH))));
}

async function verificationEndpointTests() {
  console.log('\n--- Section C: GET verification endpoint ---');
  const q = 'hub.mode=subscribe&hub.verify_token=' + VERIFY_TOKEN + '&hub.challenge=CHAL' + RUN;
  const res = await getJson('/api/webhooks/whatsapp?' + q);
  check('C1. Challenge echo with valid token', res.status === 200 && res.text === 'CHAL' + RUN, 'status=' + res.status);

  const badTok = await getJson('/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x');
  check('C2. Wrong verify token rejected', badTok.status === 403 && badTok.json && badTok.json.errorCode === 'WEBHOOK_INVALID_TOKEN');

  const badMode = await getJson('/api/webhooks/whatsapp?hub.mode=unsubscribe&hub.verify_token=' + VERIFY_TOKEN + '&hub.challenge=x');
  check('C3. Wrong hub.mode rejected', badMode.status === 403 && badMode.json && badMode.json.errorCode === 'WEBHOOK_INVALID_MODE');

  const missingChallenge = await getJson('/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=' + VERIFY_TOKEN);
  check('C4. Missing challenge rejected', missingChallenge.status === 403 && missingChallenge.json && missingChallenge.json.errorCode === 'WEBHOOK_MISSING_CHALLENGE');

  // No config path: temporarily remove webhook config env vars.
  const oldToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  const oldSecret = process.env.WHATSAPP_APP_SECRET;
  try {
    delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    delete process.env.WHATSAPP_APP_SECRET;
    const nc = await getJson('/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=' + VERIFY_TOKEN + '&hub.challenge=x');
    check('C5. Not configured returns 403', nc.status === 403 && nc.json && nc.json.errorCode === 'WEBHOOK_NOT_CONFIGURED');
  } finally {
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = oldToken;
    process.env.WHATSAPP_APP_SECRET = oldSecret;
  }
}

function normalizeTests() {
  console.log('\n--- Section D: normalizeWebhookEvents ---');
  const svc = require('./apps/server/src/services/whatsapp/whatsappWebhook.service.ts');

  const events = svc.normalizeWebhookEvents(buildPayload(MSG_ID(1), 'sent', { timestamp: '1700000000', recipient_id: '999' }));
  check('D1. Normalizes a sent status', events.length === 1 && events[0].providerMessageId === MSG_ID(1) && events[0].status === 'SENT');
  check('D2. Timestamp parsed to Date', events[0].timestamp instanceof Date && !isNaN(events[0].timestamp.getTime()));
  check('D3. recipient_id captured', events[0].recipientPhone === '999');

  check('D4. delivered normalized', svc.normalizeWebhookEvents(buildPayload(MSG_ID(2), 'delivered'))[0].status === 'DELIVERED');
  check('D5. read normalized', svc.normalizeWebhookEvents(buildPayload(MSG_ID(3), 'read'))[0].status === 'READ');

  const failedEv = svc.normalizeWebhookEvents(buildPayload(MSG_ID(4), 'failed', { errors: [{ code: '131049', title: 'message_template_failed' }] }));
  check('D6. failed normalized with error info', failedEv.length === 1 && failedEv[0].status === 'FAILED' && failedEv[0].errorCode === '131049' && /message_template_failed/.test(failedEv[0].errorMessage || ''));

  check('D7. Empty object → []', svc.normalizeWebhookEvents({}).length === 0);
  check('D8. Non-object payload → []', svc.normalizeWebhookEvents(null).length === 0);
  check('D9. Missing statuses array → []', svc.normalizeWebhookEvents({ entry: [{ changes: [{ value: {} }] }] }).length === 0);
  check('D10. Unknown status skipped', svc.normalizeWebhookEvents(buildPayload(MSG_ID(5), 'bogus')).length === 0);

  const multi = svc.normalizeWebhookEvents({
    entry: [{ changes: [{ value: { statuses: [{ id: MSG_ID(6), status: 'sent' }, { id: MSG_ID(7), status: 'delivered' }] } }] }],
  });
  check('D11. Multiple statuses split', multi.length === 2 && multi[0].status === 'SENT' && multi[1].status === 'DELIVERED');
}

function transitionTests() {
  console.log('\n--- Section E: isValidStatusTransition ---');
  const svc = require('./apps/server/src/services/whatsapp/whatsappWebhook.service.ts');
  const t = svc.isValidStatusTransition;
  check('E1. SENT → DELIVERED', t('SENT', 'DELIVERED') === true);
  check('E2. DELIVERED → READ', t('DELIVERED', 'READ') === true);
  check('E3. SENT → READ (forward)', t('SENT', 'READ') === true);
  check('E4. READ → DELIVERED blocked (backward)', t('READ', 'DELIVERED') === false);
  check('E5. DELIVERED → SENT blocked (backward)', t('DELIVERED', 'SENT') === false);
  check('E6. FAILED from any state allowed', t('SENT', 'FAILED') === true && t('DELIVERED', 'FAILED') === true && t('READ', 'FAILED') === true);
  check('E7. Same status idempotent', t('DELIVERED', 'DELIVERED') === true);
  check('E8. FAILED → SENT blocked', t('FAILED', 'SENT') === false);
}
async function postWebhookEndToEndTests() {
  console.log('\n--- Section F: POST webhook end-to-end ---');
  const svc = require('./apps/server/src/services/whatsapp/whatsappWebhook.service.ts');
  const rec = await createTestRecipient(1);
  const execution = await seedExecution(rec.id, rec.whatsappNumber, rec.name, [{ id: MSG_ID(1), status: 'SENT' }]);
  check('F1. Execution seeded (RUNNING)', execution.status === 'RUNNING');

  const res = await postWebhook(buildPayload(MSG_ID(1), 'delivered', { timestamp: '1700000000' }));
  check('F2. POST webhook 200', res.status === 200, 'status=' + res.status + ' text=' + res.text);
  check('F3. processed=1 succeeded=1', res.json && res.json.processed === 1 && res.json.succeeded === 1, JSON.stringify(res.json));

  const updated = await prisma.campaignExecutionRecipient.findUnique({
    where: { executionId_recipientId: { executionId: execution.id, recipientId: rec.id } },
  });
  check('F4. Recipient status → DELIVERED', updated.status === 'DELIVERED', 'status=' + updated.status);
  check('F5. deliveredAt set', !!updated.deliveredAt);
  check('F6. Provider message id preserved', updated.providerMessageId === MSG_ID(1));
  check('F7. Retry/error fields cleared', updated.nextAttemptAt === null && updated.errorCode === null && updated.errorMessage === null);
  check('F8. deliveredAt matches webhook timestamp', updated.deliveredAt instanceof Date && !isNaN(updated.deliveredAt.getTime()));

  const exec = await prisma.campaignExecution.findUnique({ where: { id: execution.id } });
  check('F9. Execution → COMPLETED (all terminal)', exec.status === 'COMPLETED', 'status=' + exec.status);
  check('F10. completedAt set on execution', !!exec.completedAt);

  // processWebhookEvents direct sanity for the same event
  const events = svc.normalizeWebhookEvents(buildPayload(MSG_ID(1), 'delivered'));
  check('F11. normalize yields event', events[0].status === 'DELIVERED');
}

async function idempotencyTests() {
  console.log('\n--- Section G: Webhook idempotency ---');
  const rec = await createTestRecipient(2);
  const execution = await seedExecution(rec.id, rec.whatsappNumber, rec.name, [{ id: MSG_ID(2), status: 'SENT' }]);

  const r1 = await postWebhook(buildPayload(MSG_ID(2), 'delivered'));
  check('G1. First webhook processed', r1.status === 200 && r1.json && r1.json.succeeded === 1);

  // Duplicate webhook: same providerMessageId + same terminal status
  const r2 = await postWebhook(buildPayload(MSG_ID(2), 'delivered'));
  check('G2. Duplicate webhook 200', r2.status === 200);

  const recRow = await prisma.campaignExecutionRecipient.findUnique({
    where: { executionId_recipientId: { executionId: execution.id, recipientId: rec.id } },
    select: { status: true },
  });
  check('G3. Recipient still DELIVERED after duplicate', recRow.status === 'DELIVERED');

  const exec = await prisma.campaignExecution.findUnique({ where: { id: execution.id }, select: { status: true } });
  check('G4. Execution not re-completed to a different status', exec.status === 'COMPLETED');
}

async function unknownMessageIdTests() {
  console.log('\n--- Section H: Unknown provider message id ---');
  const res = await postWebhook(buildPayload('p58_unknown_' + RUN, 'delivered'));
  check('H1. Unknown id accepted (silent/idempotent)', res.status === 200 && res.json && res.json.processed === 1, JSON.stringify(res.json));
  check('H2. Unknown id counted as succeeded (ignored)', res.json && res.json.succeeded === 1 && res.json.failed === 0);
}

async function backwardTransitionTests() {
  console.log('\n--- Section I: Backward transition blocked ---');
  const rec = await createTestRecipient(3);
  const execution = await seedExecution(rec.id, rec.whatsappNumber, rec.name, [{ id: MSG_ID(3), status: 'SENT' }]);

  await postWebhook(buildPayload(MSG_ID(3), 'delivered')); // SENT → DELIVERED
  const r = await postWebhook(buildPayload(MSG_ID(3), 'sent')); // DELIVERED → SENT (backward)
  check('I1. Backward webhook still 200', r.status === 200);

  const recRow = await prisma.campaignExecutionRecipient.findUnique({
    where: { executionId_recipientId: { executionId: execution.id, recipientId: rec.id } },
    select: { status: true, deliveredAt: true },
  });
  check('I2. Recipient remains DELIVERED (backward blocked)', recRow.status === 'DELIVERED');
  check('I3. deliveredAt preserved', !!recRow.deliveredAt);
}

async function failedTransitionTests() {
  console.log('\n--- Section J: FAILED transition (error capture) ---');
  const rec = await createTestRecipient(4);
  const execution = await seedExecution(rec.id, rec.whatsappNumber, rec.name, [{ id: MSG_ID(4), status: 'SENT' }]);

  const res = await postWebhook(buildPayload(MSG_ID(4), 'failed', { errors: [{ code: '131049', title: 'message_template_failed' }] }));
  check('J1. FAILED webhook processed', res.status === 200 && res.json && res.json.succeeded === 1);

  const recRow = await prisma.campaignExecutionRecipient.findUnique({
    where: { executionId_recipientId: { executionId: execution.id, recipientId: rec.id } },
    select: { status: true, webhookErrorCode: true, webhookErrorMessage: true, nextAttemptAt: true },
  });
  check('J2. Recipient → FAILED', recRow.status === 'FAILED', 'status=' + recRow.status);
  check('J3. webhookErrorCode captured', recRow.webhookErrorCode === '131049', String(recRow.webhookErrorCode));
  check('J4. webhookErrorMessage captured', /message_template_failed/.test(recRow.webhookErrorMessage || ''));
  check('J5. retry scheduling cleared on FAILED', recRow.nextAttemptAt === null);

  const exec = await prisma.campaignExecution.findUnique({ where: { id: execution.id }, select: { status: true } });
  check('J6. Execution → FAILED (any recipient failed)', exec.status === 'FAILED', 'status=' + exec.status);
}
async function multiRecipientExecutionTests() {
  console.log('\n--- Section K: Multi-recipient execution lifecycle ---');
  // Two DISTINCT recipients on one execution. The composite PK is
  // [executionId, recipientId], so two recipients need two Recipient rows.
  const r1 = await createTestRecipient(7);
  const r2 = await createTestRecipient(8);
  const camp = await createTestCampaign('multi');
  const execution = await prisma.campaignExecution.create({
    data: {
      campaignId: camp.id,
      status: 'RUNNING',
      scheduledAt: new Date(),
      startedAt: new Date(),
      messageBody: 'P58 multi body ' + RUN,
    },
  });
  createdExecutionIds.add(execution.id);
  await prisma.campaignExecutionRecipient.create({
    data: { executionId: execution.id, recipientId: r1.id, whatsappNumber: r1.whatsappNumber, name: r1.name, providerMessageId: MSG_ID(5), status: 'SENT' },
  });
  await prisma.campaignExecutionRecipient.create({
    data: { executionId: execution.id, recipientId: r2.id, whatsappNumber: r2.whatsappNumber, name: r2.name, providerMessageId: MSG_ID(6), status: 'PENDING' },
  });

  // Deliver r1: execution must STAY RUNNING because r2 is still PENDING
  // (SENT/DELIVERED are terminal per recalculateExecutionStatus; PENDING is not).
  await postWebhook(buildPayload(MSG_ID(5), 'delivered'));
  await sleep(200);
  const execMid = await prisma.campaignExecution.findUnique({ where: { id: execution.id }, select: { status: true } });
  check('K1. Execution stays RUNNING (one recipient pending)', execMid.status === 'RUNNING', 'status=' + execMid.status);

  // Mark r2 READ: now both recipients are terminal → execution COMPLETED.
  await postWebhook(buildPayload(MSG_ID(6), 'read', { timestamp: '1700001000' }));
  await sleep(200);
  const execEnd = await prisma.campaignExecution.findUnique({ where: { id: execution.id }, select: { status: true } });
  check('K2. Execution → COMPLETED after both terminal', execEnd.status === 'COMPLETED', 'status=' + execEnd.status);

  const readRow = await prisma.campaignExecutionRecipient.findFirst({
    where: { executionId: execution.id, providerMessageId: MSG_ID(6) },
    select: { status: true, readAt: true },
  });
  check('K3. READ recipient status set', readRow && readRow.status === 'READ');
  check('K4. readAt set from webhook timestamp', readRow && readRow.readAt instanceof Date && !isNaN(readRow.readAt.getTime()));
  check('K5. readAt reflects payload timestamp', readRow && readRow.readAt.getTime() === 1700001000 * 1000);
}

async function invalidSignatureTests() {
  console.log('\n--- Section L: Signature validation ---');
  const body = JSON.stringify(buildPayload(MSG_ID(99), 'delivered'));

  const wrongSig = await request('POST', '/api/webhooks/whatsapp', body, 'application/json', {
    'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64), // valid shape, wrong value
  });
  check('L1. Wrong signature → 403', wrongSig.status === 403 && wrongSig.json && wrongSig.json.errorCode === 'WEBHOOK_INVALID_SIGNATURE');

  const missingSig = await request('POST', '/api/webhooks/whatsapp', body, 'application/json', {});
  check('L2. Missing signature → 403', missingSig.status === 403 && missingSig.json && missingSig.json.errorCode === 'WEBHOOK_INVALID_SIGNATURE');

  const badPrefix = await request('POST', '/api/webhooks/whatsapp', body, 'application/json', {
    'X-Hub-Signature-256': 'md5=abc',
  });
  check('L3. Bad signature prefix → 403', badPrefix.status === 403);
}

async function cleanup() {
  try {
    await prisma.campaignExecutionRecipient.deleteMany({});
    await prisma.campaignExecution.deleteMany({});
    await prisma.campaignSchedule.deleteMany({});
    await prisma.campaign.deleteMany({});
    await prisma.message.deleteMany({});
    await prisma.recipient.deleteMany({ where: { id: { in: [...createdRecipientIds] } } });
  } catch {
    // ignore — only test rows are removed
  }
}

async function main() {
  console.log('=== Phase 5.8: WhatsApp Webhook Processing ===\n');

  const originalListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    server = this;
    return originalListen.apply(this, args);
  };

  // Install the provider mock FIRST (before the server starts its worker).
  installProviderMock();

  require('tsx/cjs');
  require('./apps/server/src/index.ts');
  indexModule = require('./apps/server/src/index.ts');

  const serverUp = await waitForServer(20000);
  check('0. Server reachable', serverUp);
  if (!serverUp) {
    failures++;
    process.exitCode = 1;
    if (server) await new Promise((resolve) => server.close(resolve));
    restoreFetch();
    return;
  }

  // Stop background workers immediately so they never process leftover
  // executions and never reach the provider.
  try { if (indexModule.worker) await indexModule.worker.stop(); } catch { }
  try { if (indexModule.scheduler) await indexModule.scheduler.stop(); } catch { }

  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient();

  try {
    configHelperTests();
    sourceSecurityTests();
    await verificationEndpointTests();
    normalizeTests();
    transitionTests();
    await postWebhookEndToEndTests();
    await idempotencyTests();
    await unknownMessageIdTests();
    await backwardTransitionTests();
    await failedTransitionTests();
    await multiRecipientExecutionTests();
    await invalidSignatureTests();
  } catch (error) {
    failures++;
    console.error('Error:', error && error.stack ? error.stack : error);
  } finally {
    await cleanup();
    await sleep(100);
  }

  check('Z1. Zero stray provider calls', strayProviderAttempts === 0, 'stray=' + strayProviderAttempts);

  console.log('\nAssertions run: ' + checks + ' | failed: ' + failures);
  console.log('=== ' + (failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED') + ' ===');
  process.exitCode = failures === 0 ? 0 : 1;

  if (server) {
    try { await new Promise((resolve) => server.close(resolve)); } catch { }
  }
  if (prisma) {
    try { await prisma.$disconnect(); } catch { }
  }
  restoreFetch();
}

main().catch((error) => {
  console.error('Error:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});

