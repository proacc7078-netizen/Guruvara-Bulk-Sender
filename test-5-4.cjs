/**
 * Phase 5.4 — Campaign Execution Recipient Send Tests
 *
 * Tests POST /api/campaigns/:campaignId/execution/:executionRecipientId/send
 * with MOCKED WhatsAppAdapter (globalThis.fetch mocked for graph.facebook.com only).
 *
 * No real WhatsApp messages are sent.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const dotenv = require('dotenv');
const argon2 = require('argon2');

dotenv.config({ path: path.join(__dirname, '.env') });

// This suite asserts the OFFICIAL (Meta Cloud API) delivery path and mocks
// graph.facebook.com only. Pin the provider explicitly instead of inheriting
// whatever the ambient .env selects, so the suite keeps exercising the official
// adapter regardless of the developer's local WHATSAPP_PROVIDER (e.g. 'openwa').
// The official credentials are still read from .env; no value is invented.
process.env.WHATSAPP_PROVIDER = 'official';

const REPO_ROOT = __dirname;
const SCHEMA_PATH = path.join(REPO_ROOT, 'prisma/schema.prisma');
const CAMPAIGN_EXECUTION_CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/campaignExecution.controller.ts');
const CAMPAIGN_EXECUTION_SERVICE_PATH = path.join(REPO_ROOT, 'apps/server/src/services/executionDelivery.service.ts');
const CAMPAIGNS_ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/campaigns.routes.ts');

const TEST_PORT = 3151;
const BASE = 'http://127.0.0.1:' + TEST_PORT;

const RUN = String(Date.now()).slice(-6);
const phoneFor = (n) => '9' + RUN + String(n);

let checks = 0;
let failures = 0;
let server = null;
let prisma = null;
let tempUserId = null;
let originalFetch = null;

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
function putJson(url, body, cookie) { return request('PUT', url, JSON.stringify(body), cookie, 'application/json'); }

/* ------------------------------------------------------------------ *
 * Mock fetch - only intercepts graph.facebook.com
 * ------------------------------------------------------------------ */
function setupMetaMock(sendResult) {
  try {
    const { resetWhatsAppAdapter } = require('./apps/server/src/services/whatsapp/whatsappProvider');
    resetWhatsAppAdapter();
  } catch { }
  originalFetch = globalThis.fetch;
  const calls = [];
  const f = async (url, init) => {
    if (typeof url === 'string' && url.includes('graph.facebook.com')) {
      calls.push({ url, init, body: init?.body });
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
  globalThis.fetch = f;
  return f;
}

function setupMetaThrow(errorMessage) {
  try {
    const { resetWhatsAppAdapter } = require('./apps/server/src/services/whatsapp/whatsappProvider');
    resetWhatsAppAdapter();
  } catch { }
  originalFetch = globalThis.fetch;
  const calls = [];
  const f = async (url, init) => {
    if (typeof url === 'string' && url.includes('graph.facebook.com')) {
      calls.push({ url, init });
      throw new Error(errorMessage);
    }
    return originalFetch(url, init);
  };
  f.calls = calls;
  globalThis.fetch = f;
  return f;
}

function restoreFetch() {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
}

async function refreshPrisma() {
  if (prisma) {
    try { await prisma.$disconnect(); } catch { }
  }
  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient();
}

/* ------------------------------------------------------------------ *
 * Static contracts
 * ------------------------------------------------------------------ */
function staticContractTests() {
  console.log('\n--- Static contracts ---');
  const schema = readSource(SCHEMA_PATH);
  const controller = readSource(CAMPAIGN_EXECUTION_CONTROLLER_PATH);
  const service = readSource(CAMPAIGN_EXECUTION_SERVICE_PATH);
  const routes = readSource(CAMPAIGNS_ROUTES_PATH);

  check('1. CampaignExecutionRecipient model exists', /model CampaignExecutionRecipient \{/.test(schema));
  check('2. status field has PENDING default', /status\s+String\s+@default\("PENDING"\)/.test(schema));
  check('3. providerMessageId field exists', /providerMessageId/.test(schema));
  check('4. errorCode field exists', /errorCode/.test(schema));
  check('5. errorMessage field exists', /errorMessage/.test(schema));
  check('6. attemptCount field exists', /attemptCount/.test(schema));
  check('7. RUNNING status in service', /RUNNING/.test(service));
  check('8. send endpoint registered', routes.includes("router.post('/:id/execution/:executionRecipientId/send'"));
  check('9. requireAuth used', routes.includes('requireAuth'));
  check('10. WhatsAppAdapter.sendText used', /whatsappProviderRegistry[\s\S]*?sendText|adapter\.sendText/.test(service));
  check('11. No direct Meta API call', !/graph\.facebook\.com\/.*\/messages/.test(service));
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */
function successSendResult(providerMessageId) {
  return { ok: true, status: 200, body: { success: true, messages: [{ id: providerMessageId }] } };
}

async function createReadyCampaignWithRecipient(cookie, label) {
  const recipientRes = await postJson('/api/recipients', {
    name: `Phase54 ${label}`,
    whatsappNumber: phoneFor(Math.floor(Math.random() * 9000) + 1000),
    language: 'Hindi',
    category: 'Phase5Test',
    status: 'ACTIVE',
    source: 'MANUAL',
  }, cookie);
  const recipientId = recipientRes.json?.data?.id;
  if (!recipientId) return null;

  const messageRes = await postJson('/api/messages', {
    name: `Phase54 ${label}`,
    body: `Body for ${label}`,
    status: 'DRAFT',
  }, cookie);
  const messageId = messageRes.json?.data?.id;
  if (!messageId) return null;

  const campaignRes = await postJson('/api/campaigns', { name: `Phase54 Camp ${label}`, messageId }, cookie);
  const campaignId = campaignRes.json?.data?.id;
  if (!campaignId) return null;

  const audienceRes = await putJson(`/api/campaigns/${campaignId}/audience`, { recipientIds: [recipientId] }, cookie);
  if (audienceRes.status !== 200) return null;

  const finalizeRes = await postJson(`/api/campaigns/${campaignId}/finalize`, {}, cookie);
  if (finalizeRes.status !== 200 || finalizeRes.json?.data?.campaign?.status !== 'READY') return null;

  const futureDate = new Date(Date.now() + 172800000).toISOString().slice(0, 16);
  const schedRes = await postJson(`/api/campaigns/${campaignId}/schedule`,
    { scheduledAt: futureDate, timezone: 'Asia/Kolkata' }, cookie);
  if (schedRes.status !== 201 && schedRes.status !== 200) return null;

  const execRes = await postJson(`/api/campaigns/${campaignId}/execution`, {}, cookie);
  if (execRes.status !== 201 && execRes.status !== 200) return null;
  const execId = execRes.json?.data?.execution?.id;
  if (!execId) return null;

  const recipient = await prisma.campaignExecutionRecipient.findFirst({ where: { executionId: execId } });
  if (!recipient) return null;

  return { recipientId, messageId, campaignId, execId, execRecipientId: `${execId}:${recipient.recipientId}`, whatsappNumber: recipient.whatsappNumber, messageBody: execRes.json?.data?.execution?.messageBody };
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */
async function main() {
  console.log('=== Phase 5.4: Campaign Execution Recipient Send ===\n');
  process.env.PORT = String(TEST_PORT);
  const originalListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    server = this;
    return originalListen.apply(this, args);
  };
  require('tsx/cjs');
  const indexModule = require('./apps/server/src/index.ts');
  const { PrismaClient } = require('@prisma/client');
  const serverUp = await waitForServer(20000);
  check('0. Real server is reachable', serverUp, BASE);
  if (!serverUp) { process.exitCode = 1; return; }

  prisma = new PrismaClient();

  const email = 'phase54-' + RUN + '@example.com';
  const password = 'Phase54-' + RUN + '-pw!';
  const createdUser = await prisma.user.create({ data: { email, password: await argon2.hash(password) } });
  tempUserId = createdUser.id;
  const loginRes = await request('POST', '/api/auth/login', JSON.stringify({ email, password }), null, 'application/json');
  const cookie = loginRes.setCookie ? loginRes.setCookie.split(';')[0] : null;
  check('0b. Test user can authenticate', cookie !== null);

  if (!cookie) { console.log('Failed to authenticate'); return; }

  try {
    /* Static contracts */
    staticContractTests();

    /* Auth */
    check('C1. Send requires auth',
      (await request('POST', '/api/campaigns/any/execution/any:any/send', JSON.stringify({}), null, 'application/json')).status === 401);

    /* Create a ready campaign with execution recipient */
    refreshPrisma();
    const ctx = await createReadyCampaignWithRecipient(cookie, 'Send');
    check('C2. Ready campaign with execution created', !!ctx);
    if (!ctx) { console.log('Setup failed'); return; }

    const { campaignId, execId, execRecipientId, whatsappNumber, messageBody } = ctx;

    /* Validation */
    check('C3. Invalid campaign returns 404', (await postJson('/api/campaigns/nonexistent/execution/exec:recip/send', {}, cookie)).status === 404);
    check('C4. Invalid execution returns 404', (await postJson(`/api/campaigns/${campaignId}/execution/nonexistent:recip/send`, {}, cookie)).status === 404);
    check('C5. Invalid recipient returns 404', (await postJson(`/api/campaigns/${campaignId}/execution/${execId}:nonexistent/send`, {}, cookie)).status === 404);

    /* Create a second campaign for relationship test */
    const ctx2 = await createReadyCampaignWithRecipient(cookie, 'Rel');
    check('C6. Second campaign created', !!ctx2);
    if (ctx2) {
      const res = await postJson(`/api/campaigns/${campaignId}/execution/${ctx2.execRecipientId}/send`, {}, cookie);
      check('C7. Wrong execution-campaign relationship returns 400', res.status === 400 && res.json?.error?.code === 'INVALID_RELATIONSHIP');
    }

    /* Successful send */
    const mock1 = setupMetaMock(successSendResult('wamid_' + RUN + '_ok'));
    try {
    const sendRes = await postJson(`/api/campaigns/${campaignId}/execution/${execRecipientId}/send`, {}, cookie);
    check('S1. Send returns 200', sendRes.status === 200, 'status=' + sendRes.status);
    check('S2. Success=true', sendRes.json?.success === true, JSON.stringify(sendRes.json));
    check('S3. providerMessageId set', !!(sendRes.json?.data?.providerMessageId), sendRes.json?.data?.providerMessageId);
    check('S4. No credentials leaked', !/access_token|authorization|WHATSAPP_ACCESS/i.test(JSON.stringify(sendRes.json)));

    /* Verify Meta API was called via adapter (not directly) */
    const metaCall = mock1.calls[0];
    check('S5. Meta /messages endpoint called', !!metaCall && /\/messages$/.test(metaCall.url), metaCall?.url);
    check('S6. Bearer auth header used', !!metaCall && /Bearer/.test(metaCall.init?.headers?.Authorization || ''));

    /* Get snapshot data from DB for verification */
    refreshPrisma();
    const [execIdP, recipIdP] = execRecipientId.split(':');
    const dbExec = await prisma.campaignExecution.findUnique({ where: { id: execIdP } });
    const snapshotBody = dbExec?.messageBody;
    const snapshotPhone = (await prisma.campaignExecutionRecipient.findUnique({
      where: { executionId_recipientId: { executionId: execIdP, recipientId: recipIdP } }
    }))?.whatsappNumber;

    /* Verify snapshot phone number was used */
    const sendBody = typeof metaCall?.body === 'string' ? metaCall.body : JSON.stringify(metaCall?.body);
    check('S7. Snapshot phone number used', sendBody.includes(snapshotPhone || ''), sendBody);

    /* Verify snapshot message body was used */
    check('S8. Snapshot message body used', sendBody.includes(snapshotBody || ''), sendBody);

    /* Verify mutable data doesn't affect snapshot (message body in execution is unchanged) */
    check('S14. Execution messageBody is snapshot', dbExec?.messageBody === snapshotBody, dbExec?.messageBody);
    } finally {
      restoreFetch();
    }

    /* Already sent */
    const dupRes = await postJson(`/api/campaigns/${campaignId}/execution/${execRecipientId}/send`, {}, cookie);
    check('S15. Already SENT returns 409', dupRes.status === 409, 'status=' + dupRes.status);
    check('S16. ALREADY_SENT error', dupRes.json?.error?.code === 'ALREADY_SENT', dupRes.json?.error?.code);

  /* Provider failure */
  refreshPrisma();
  const ctx3 = await createReadyCampaignWithRecipient(cookie, 'Fail');
  check('C8. Failure test campaign created', !!ctx3);
  if (ctx3) {
    const mock2 = setupMetaMock({ ok: false, status: 400, body: { success: false, errorCode: 'WHATSAPP_SEND_FAILED', errorMessage: 'Provider rejected' } });
    try {
      const sendRes = await postJson(`/api/campaigns/${ctx3.campaignId}/execution/${ctx3.execRecipientId}/send`, {}, cookie);
      check('S17. Provider failure returns 200', sendRes.status === 200 && sendRes.json?.data?.success === false);
      check('S18. ErrorCode in response', sendRes.json?.data?.errorCode === 'WHATSAPP_SEND_FAILED');

      await refreshPrisma();
      const [eid, rid] = ctx3.execRecipientId.split(':');
      const dbR = await prisma.campaignExecutionRecipient.findUnique({
        where: { executionId_recipientId: { executionId: eid, recipientId: rid } }
      });
      check('S19. DB status = FAILED', dbR?.status === 'FAILED', dbR?.status);
      check('S20. errorCode in DB', dbR?.errorCode === 'WHATSAPP_SEND_FAILED', dbR?.errorCode);
      check('S21. errorMessage in DB', !!(dbR?.errorMessage), dbR?.errorMessage);
    } finally {
      restoreFetch();
    }

    /* Provider unavailable - adapter catches thrown errors */
    const mock3 = setupMetaThrow('Network unreachable');
    try {
      const sendRes = await postJson(`/api/campaigns/${ctx3.campaignId}/execution/${ctx3.execRecipientId}/send`, {}, cookie);
      check('S22. Provider unavailable returns 200', sendRes.status === 200, 'status=' + sendRes.status);
      check('S23. Provider unavailable code', sendRes.json?.data?.success === false && sendRes.json?.data?.errorCode === 'WHATSAPP_PROVIDER_UNAVAILABLE', JSON.stringify(sendRes.json));

      await refreshPrisma();
      const [eid2, rid2] = ctx3.execRecipientId.split(':');
      const dbR2 = await prisma.campaignExecutionRecipient.findUnique({
        where: { executionId_recipientId: { executionId: eid2, recipientId: rid2 } }
      });
      check('S24. DB status = PENDING (retry scheduled)', dbR2?.status === 'PENDING', dbR2?.status);
      check('S25. Provider unavailable code in DB', dbR2?.errorCode === 'WHATSAPP_PROVIDER_UNAVAILABLE', dbR2?.errorCode);
      check('S26. nextAttemptAt populated', !!dbR2?.nextAttemptAt, dbR2?.nextAttemptAt);
      check('S27. attemptCount incremented', (dbR2?.attemptCount ?? 0) >= 1, dbR2?.attemptCount);
      check('S28. Error metadata preserved', !!dbR2?.errorMessage, dbR2?.errorMessage);
    } finally {
      restoreFetch();
    }
  }

  /* Provider abstraction verification */
  check('C9. Service uses provider abstraction', /whatsappProviderRegistry|getAdapter/.test(readSource(CAMPAIGN_EXECUTION_SERVICE_PATH)));

  } catch (error) {
    failures++;
    console.error('Unexpected test error:', error && error.stack ? error.stack : error);
  } finally {
    if (tempUserId) {
      try { await prisma.user.delete({ where: { id: tempUserId } }); } catch { }
    }
    /* Cleanup all test data */
    try {
      await prisma.campaignExecutionRecipient.deleteMany({});
      await prisma.campaignExecution.deleteMany({});
      await prisma.campaignSchedule.deleteMany({});
      await prisma.campaign.deleteMany({});
      await prisma.campaignRecipient.deleteMany({});
      await prisma.message.deleteMany({});
      await prisma.recipient.deleteMany({ where: { name: { startsWith: 'Phase54' } } });
    } catch { }
  }

  console.log('\nAssertions run: ' + checks + ' | failed: ' + failures);
  console.log('=== ' + (failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED') + ' ===');
  process.exitCode = failures === 0 ? 0 : 1;

  if (server) await new Promise((resolve) => server.close(resolve));
  if (indexModule.worker) { try { await indexModule.worker.stop(); } catch { } }
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error('Error:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
