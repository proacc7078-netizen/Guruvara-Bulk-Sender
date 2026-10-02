/**
 * Phase 7.3 — OpenWA delivery-status synchronization tests.
 *
 * Tests OpenWA webhook normalization, signature verification, providerMessageId
 * correlation, monotonic status behavior, idempotency, and safe handling of
 * unknown/malformed events — reusing the existing webhook/delivery machinery.
 *
 * Safety:
 * - WHATSAPP_PROVIDER='none' so no real provider send ever occurs.
 * - Global fetch replaced to block any network call (including localhost:2785).
 * - Throwaway SQLite DB; only test rows are created and cleaned up.
 * - The real .env is never modified (env vars set in-process).
 * - No WhatsApp message is sent. No real OpenWA instance is contacted.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const REPO_ROOT = __dirname;
const DIST = path.join(REPO_ROOT, 'apps/server', 'dist');
const TEST_PORT = 3159;
process.env.PORT = String(TEST_PORT);
const BASE = 'http://127.0.0.1:' + TEST_PORT;

const VERIFY_TOKEN = 'test-verify-token-' + String(Date.now()).slice(-6);
const APP_SECRET = 'test-app-secret';
const OPENWA_SECRET = 'test-openwa-webhook-secret';
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = VERIFY_TOKEN;
process.env.WHATSAPP_APP_SECRET = APP_SECRET;
process.env.WHATSAPP_PROVIDER = 'none';
process.env.WHATSAPP_OPENWA_WEBHOOK_SECRET = OPENWA_SECRET;
process.env.WHATSAPP_OPENWA_CAMPAIGN_SENDING_ENABLED = 'false';
process.env.SCHEDULER_POLL_INTERVAL_MS = '999900';
process.env.WORKER_POLL_INTERVAL_MS = '999900';

const RUN = String(Date.now()).slice(-6);
const PHONE_PREFIX = '9' + RUN;
const phoneFor = (n) => PHONE_PREFIX + String(n);
const MSG_ID = (n) => 'p73_msg_' + n;

const dbPath = path.join(require('os').tmpdir(), 'exec73-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.db');
process.env.DATABASE_URL = 'file:' + dbPath;

let checks = 0;
let failures = 0;
let server = null;
let indexModule = null;
let prisma = null;
let originalFetch = null;
let strayProviderAttempts = 0;

const createdRecipientIds = new Set();
const createdMessageIds = new Set();

function check(name, cond, extra) {
  checks++;
  if (!cond) failures++;
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (extra ? ' | ' + extra : ''));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const res = await fetch(BASE + '/api/health'); if (res.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function request(method, url, body, contentType, extraHeaders) {
  const headers = {};
  if (contentType) headers['Content-Type'] = contentType;
  if (extraHeaders) Object.assign(headers, extraHeaders);
  const res = await fetch(BASE + url, { method, headers, body });
  const raw = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: res.status, json: parsed, text: raw };
}

function signOpenWA(raw) { return 'sha256=' + crypto.createHmac('sha256', OPENWA_SECRET).update(raw).digest('hex'); }
function signMeta(raw) { return 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex'); }

async function postOpenWAWebhook(bodyObj) {
  const raw = JSON.stringify(bodyObj);
  return request('POST', '/api/webhooks/whatsapp/openwa', raw, 'application/json', { 'X-OpenWA-Signature': signOpenWA(raw) });
}

async function postOpenWAWebhookRaw(raw, extraHeaders) {
  const headers = { 'Content-Type': 'application/json' };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  const res = await fetch(BASE + '/api/webhooks/whatsapp/openwa', { method: 'POST', headers, body: raw });
  const responseBody = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(responseBody); } catch { parsed = responseBody; }
  return { status: res.status, json: parsed, text: responseBody };
}

function buildOpenWAEvent(event, dataId, opts = {}) {
  const payload = { event, sessionId: 'test-session', idempotencyKey: 'idem-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), deliveryId: 'deliv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), data: { id: dataId } };
  if (opts.status !== undefined) payload.data.status = opts.status;
  if (opts.timestamp !== undefined) payload.timestamp = opts.timestamp;
  if (opts.error !== undefined) payload.data.error = opts.error;
  if (opts.errorMessage !== undefined) payload.data.errorMessage = opts.errorMessage;
  return payload;
}

function installProviderMock() {
  if (!originalFetch) originalFetch = globalThis.fetch;
  const f = async (url, init) => {
    const target = typeof url === 'string' ? url : (url && url.url) || '';
    // Block calls to real OpenWA instance or Meta API only.
    // Do NOT block the local test webhook endpoint (127.0.0.1:3159/api/webhooks/...).
    if (target.includes('graph.facebook.com') ||
        (target.includes('localhost:2785') && !target.includes('/api/webhooks/')) ||
        (target.includes('127.0.0.1:2785') && !target.includes('/api/webhooks/'))) {
      strayProviderAttempts++;
      throw new Error('BLOCKED: stray provider call to ' + target);
    }
    return originalFetch(url, init);
  };
  globalThis.fetch = f;
  return f;
}

function restoreFetch() {
  if (originalFetch) { globalThis.fetch = originalFetch; originalFetch = null; }
}

async function createTestRecipient(suffix) {
  const whatsappNumber = phoneFor(suffix);
  const rec = await prisma.recipient.create({ data: { name: 'P73 R' + suffix + ' ' + RUN, whatsappNumber, normalizedPhone: whatsappNumber, language: 'Hindi', category: 'Phase73Test', status: 'ACTIVE', source: 'MANUAL' } });
  createdRecipientIds.add(rec.id);
  return rec;
}

async function createTestCampaign(suffix) {
  const msg = await prisma.message.create({ data: { name: 'P73 M' + suffix + ' ' + RUN, body: 'P73 body ' + RUN, language: 'Hindi', status: 'DRAFT' } });
  createdMessageIds.add(msg.id);
  const camp = await prisma.campaign.create({ data: { name: 'P73 C' + suffix + ' ' + RUN, messageId: msg.id } });
  return camp;
}

async function seedExecutionWithRecipient(suffix, providerMessageId, initialStatus) {
  const rec = await createTestRecipient(suffix);
  const camp = await createTestCampaign(suffix);
  const execution = await prisma.campaignExecution.create({ data: { campaignId: camp.id, status: 'RUNNING', scheduledAt: new Date(), startedAt: new Date(), messageBody: 'P73 body ' + RUN } });
  await prisma.campaignExecutionRecipient.create({ data: { executionId: execution.id, recipientId: rec.id, whatsappNumber: rec.whatsappNumber, name: rec.name, providerMessageId, status: initialStatus || 'SENT' } });
  return { execution, rec };
}

async function getRecipientRow(executionId, recipientId) {
  return prisma.campaignExecutionRecipient.findUnique({ where: { executionId_recipientId: { executionId, recipientId } } });
}

// ---- Section A: Normalize ----
function normalizeTests() {
  console.log('\n--- Section A: OpenWA event normalization ---');
  const svc = require(path.join(REPO_ROOT, 'apps/server/src/services/whatsapp/openwaWebhook.service.ts'));
  const checkEq = (label, payload, expStatus, expId) => {
    const ev = svc.normalizeOpenWAWebhookEvents(payload);
    check(label, ev.length === 1 && ev[0].status === expStatus && ev[0].providerMessageId === expId, JSON.stringify(ev));
  };
  checkEq('A1. message.sent->SENT', buildOpenWAEvent('message.sent', MSG_ID(1)), 'SENT', MSG_ID(1));
  checkEq('A2. ack delivered->DELIVERED', buildOpenWAEvent('message.ack', MSG_ID(2), { status: 'delivered' }), 'DELIVERED', MSG_ID(2));
  checkEq('A3. ack read->READ', buildOpenWAEvent('message.ack', MSG_ID(3), { status: 'read' }), 'READ', MSG_ID(3));
  checkEq('A4. ack sent->SENT', buildOpenWAEvent('message.ack', MSG_ID(4), { status: 'sent' }), 'SENT', MSG_ID(4));
  checkEq('A5. ack failed->FAILED', buildOpenWAEvent('message.ack', MSG_ID(5), { status: 'failed' }), 'FAILED', MSG_ID(5));
  const failEv = svc.normalizeOpenWAWebhookEvents(buildOpenWAEvent('message.failed', MSG_ID(6), { error: 'Msg rejected' }));
  check('A6. message.failed->FAILED+errorCode+errorMessage', failEv.length === 1 && failEv[0].status === 'FAILED' && failEv[0].errorCode === 'OPENWA_MESSAGE_FAILED' && failEv[0].errorMessage === 'Msg rejected', JSON.stringify(failEv));
  const failEv2 = svc.normalizeOpenWAWebhookEvents(buildOpenWAEvent('message.failed', MSG_ID(7), { errorMessage: 'Delivery error' }));
  check('A7. message.failed uses errorMessage fallback', failEv2.length === 1 && failEv2[0].errorMessage === 'Delivery error', JSON.stringify(failEv2));
  check('A8. unknown event type -> empty', svc.normalizeOpenWAWebhookEvents({ event: 'message.reaction', data: { id: MSG_ID(8) } }).length === 0);
  check('A9. ack unknown status -> empty', svc.normalizeOpenWAWebhookEvents(buildOpenWAEvent('message.ack', MSG_ID(9), { status: 'weird' })).length === 0);
  check('A10. missing data -> empty', svc.normalizeOpenWAWebhookEvents({ event: 'message.sent' }).length === 0);
  check('A11. missing data.id -> empty', svc.normalizeOpenWAWebhookEvents({ event: 'message.sent', data: {} }).length === 0);
  check('A12. non-object -> empty', svc.normalizeOpenWAWebhookEvents('not-an-object').length === 0);
  check('A13. null -> empty', svc.normalizeOpenWAWebhookEvents(null).length === 0);
  const tsIso = svc.normalizeOpenWAWebhookEvents(buildOpenWAEvent('message.sent', MSG_ID(10), { timestamp: '2025-01-15T10:30:00.000Z' }));
  check('A14. timestamp parsed from ISO', tsIso[0].timestamp instanceof Date && !isNaN(tsIso[0].timestamp.getTime()));
  const tsNum = svc.normalizeOpenWAWebhookEvents(buildOpenWAEvent('message.sent', MSG_ID(11), { timestamp: 1705312200000 }));
  check('A15. timestamp parsed from unix ms', tsNum[0].timestamp instanceof Date && tsNum[0].timestamp.getTime() === 1705312200000);
}

// ---- Section B: Signature ----
function signatureTests() {
  console.log('\\n--- Section B: OpenWA signature verification (unit) ---');
  const svc = require(path.join(REPO_ROOT, 'apps/server/src/services/whatsapp/openwaWebhook.service.ts'));
  const raw = JSON.stringify(buildOpenWAEvent('message.sent', MSG_ID(1)));
  const sig = signOpenWA(raw);
  check('B1. valid signature accepted', svc.verifyOpenWAWebhookSignature(Buffer.from(raw), sig, OPENWA_SECRET) === true);
  check('B2. invalid signature rejected', svc.verifyOpenWAWebhookSignature(Buffer.from(raw), 'sha256=invalid', OPENWA_SECRET) === false);
  check('B3. missing signature rejected', svc.verifyOpenWAWebhookSignature(Buffer.from(raw), undefined, OPENWA_SECRET) === false);
  check('B4. bad prefix rejected', svc.verifyOpenWAWebhookSignature(Buffer.from(raw), 'md5=abc', OPENWA_SECRET) === false);
  check('B5. empty signature rejected', svc.verifyOpenWAWebhookSignature(Buffer.from(raw), '', OPENWA_SECRET) === false);
  check('B6. wrong length rejected', svc.verifyOpenWAWebhookSignature(Buffer.from(raw), 'sha256=abc', OPENWA_SECRET) === false);
  check('B7. wrong secret rejected', svc.verifyOpenWAWebhookSignature(Buffer.from(raw), sig, 'wrong') === false);
  check('B8. no throw on mismatch', svc.verifyOpenWAWebhookSignature(Buffer.from(raw), 'sha256=' + '0'.repeat(64), OPENWA_SECRET) === false);
    const leaked = JSON.stringify([{ sig, result: svc.verifyOpenWAWebhookSignature(Buffer.from(raw), sig, OPENWA_SECRET) }]);
  check('B9. secret not in verification outputs', !leaked.includes(OPENWA_SECRET));
  // Phase 7.3 — fail-safe when verification is attempted without a configured secret.
  const unconfiguredRaw = JSON.stringify(buildOpenWAEvent('message.sent', MSG_ID(1)));
  const signedWithEmptyKey = 'sha256=' + crypto.createHmac('sha256', '').update(unconfiguredRaw).digest('hex');
  check('B10. verification without a configured secret fails closed', svc.verifyOpenWAWebhookSignature(Buffer.from(unconfiguredRaw), signedWithEmptyKey, '') === false);
  check('B11. undefined secret fails closed', svc.verifyOpenWAWebhookSignature(Buffer.from(unconfiguredRaw), signedWithEmptyKey, undefined) === false);
  check('B12. whitespace-different body does not verify', svc.verifyOpenWAWebhookSignature(Buffer.from(JSON.stringify(JSON.parse(unconfiguredRaw), null, 2)), sig, OPENWA_SECRET) === false);
}

// ---- Section C: E2E ----
async function endToEndTests() {
  console.log('\n--- Section C: OpenWA end-to-end status updates ---');
  const t1 = await seedExecutionWithRecipient(1, MSG_ID(1), 'PENDING');
  const r1 = await postOpenWAWebhook(buildOpenWAEvent('message.sent', MSG_ID(1)));
  check('C1. sent webhook 200+processed', r1.status === 200 && r1.json && r1.json.processed === 1 && r1.json.succeeded === 1, JSON.stringify(r1.json));
  const row1 = await getRecipientRow(t1.execution.id, t1.rec.id);
  check('C2. recipient SENT', row1.status === 'SENT', 'status=' + row1.status);

  const t2 = await seedExecutionWithRecipient(2, MSG_ID(2), 'SENT');
  const r2 = await postOpenWAWebhook(buildOpenWAEvent('message.ack', MSG_ID(2), { status: 'delivered' }));
  check('C3. delivered webhook 200', r2.status === 200 && r2.json.succeeded === 1);
  const row2 = await getRecipientRow(t2.execution.id, t2.rec.id);
  check('C4. recipient DELIVERED + deliveredAt set', row2.status === 'DELIVERED' && !!row2.deliveredAt, 'status=' + row2.status);

  const t3 = await seedExecutionWithRecipient(3, MSG_ID(3), 'DELIVERED');
  const r3 = await postOpenWAWebhook(buildOpenWAEvent('message.ack', MSG_ID(3), { status: 'read' }));
  check('C5. read webhook 200', r3.status === 200 && r3.json.succeeded === 1);
  const row3 = await getRecipientRow(t3.execution.id, t3.rec.id);
  check('C6. recipient READ + readAt set', row3.status === 'READ' && !!row3.readAt, 'status=' + row3.status);

  const t4 = await seedExecutionWithRecipient(4, MSG_ID(4), 'SENT');
  const r4 = await postOpenWAWebhook(buildOpenWAEvent('message.failed', MSG_ID(4), { error: 'Recipient unavailable' }));
  check('C7. failed webhook 200', r4.status === 200 && r4.json.succeeded === 1);
  const row4 = await getRecipientRow(t4.execution.id, t4.rec.id);
  check('C8. recipient FAILED + error info', row4.status === 'FAILED' && row4.webhookErrorCode === 'OPENWA_MESSAGE_FAILED' && row4.webhookErrorMessage === 'Recipient unavailable', 'status=' + row4.status + ' code=' + row4.webhookErrorCode);
}

// ---- Section D: Idempotency ----
async function idempotencyTests() {
  console.log('\n--- Section D: Idempotency ---');
  const t = await seedExecutionWithRecipient(5, MSG_ID(5), 'SENT');
    const r1 = await postOpenWAWebhook(buildOpenWAEvent('message.ack', MSG_ID(5), { status: 'delivered', timestamp: '2025-06-01T12:00:00.000Z' }));
  check('D1. first delivered webhook processed', r1.status === 200 && r1.json.succeeded === 1);
  const deliveredAt = (await getRecipientRow(t.execution.id, t.rec.id)).deliveredAt;
  check('D2. deliveredAt was set', !!deliveredAt);

  // Duplicate: same idempotencyKey + same timestamp for true idempotency
  const dupPayload = buildOpenWAEvent('message.ack', MSG_ID(5), { status: 'delivered', timestamp: '2025-06-01T12:00:00.000Z' });
  dupPayload.idempotencyKey = 'same-key';
  const dupRaw = JSON.stringify(dupPayload);
  const r2 = await postOpenWAWebhookRaw(dupRaw, { 'X-OpenWA-Signature': signOpenWA(dupRaw) });
  check('D3. duplicate webhook 200', r2.status === 200);

  const row = await getRecipientRow(t.execution.id, t.rec.id);
  check('D5. status remains DELIVERED', row.status === 'DELIVERED', 'status=' + row.status);
  check('D6. deliveredAt not corrupted', row.deliveredAt && !isNaN(new Date(row.deliveredAt).getTime()));
}

// ---- Section E: Out-of-order ----
async function outOfOrderTests() {
  console.log('\n--- Section E: Out-of-order no regression ---');
  const t = await seedExecutionWithRecipient(6, MSG_ID(6), 'SENT');
  await postOpenWAWebhook(buildOpenWAEvent('message.ack', MSG_ID(6), { status: 'delivered' }));
  const afterDeliver = await getRecipientRow(t.execution.id, t.rec.id);
  check('E1. delivered after ack', afterDeliver.status === 'DELIVERED');
  await postOpenWAWebhook(buildOpenWAEvent('message.ack', MSG_ID(6), { status: 'sent' }));
  const afterBackward = await getRecipientRow(t.execution.id, t.rec.id);
  check('E2. not regressed to SENT', afterBackward.status === 'DELIVERED', 'status=' + afterBackward.status);
  check('E3. deliveredAt preserved', !!afterBackward.deliveredAt && new Date(afterBackward.deliveredAt).getTime() === new Date(afterDeliver.deliveredAt).getTime());

  const t2 = await seedExecutionWithRecipient(7, MSG_ID(7), 'DELIVERED');
  await postOpenWAWebhook(buildOpenWAEvent('message.ack', MSG_ID(7), { status: 'read' }));
  const afterRead = await getRecipientRow(t2.execution.id, t2.rec.id);
  check('E4. read after delivered', afterRead.status === 'READ');
  await postOpenWAWebhook(buildOpenWAEvent('message.ack', MSG_ID(7), { status: 'delivered' }));
  const afterBackward2 = await getRecipientRow(t2.execution.id, t2.rec.id);
  check('E5. not regressed to DELIVERED', afterBackward2.status === 'READ', 'status=' + afterBackward2.status);
  check('E6. readAt preserved', !!afterBackward2.readAt && new Date(afterBackward2.readAt).getTime() === new Date(afterRead.readAt).getTime());

  // Phase 7.3 — READ must never regress to SENT, and duplicate events stay harmless.
  await postOpenWAWebhook(buildOpenWAEvent('message.sent', MSG_ID(7)));
  const afterBackward3 = await getRecipientRow(t2.execution.id, t2.rec.id);
  check('E7. READ not regressed to SENT by message.sent', afterBackward3.status === 'READ', 'status=' + afterBackward3.status);
  check('E8. readAt still preserved after SENT attempt', !!afterBackward3.readAt && new Date(afterBackward3.readAt).getTime() === new Date(afterRead.readAt).getTime());

  // Duplicate read ack is harmless (same status, timestamps untouched).
  await postOpenWAWebhook(buildOpenWAEvent('message.ack', MSG_ID(7), { status: 'read' }));
  const afterDuplicateRead = await getRecipientRow(t2.execution.id, t2.rec.id);
  check('E9. duplicate read ack harmless', afterDuplicateRead.status === 'READ' && new Date(afterDuplicateRead.readAt).getTime() === new Date(afterRead.readAt).getTime());
}

// ---- Section F: Unknown id ----
async function unknownMessageIdTests() {
  console.log('\n--- Section F: Unknown providerMessageId — no mutation ---');
  const unknownId = 'p73_unknown_' + RUN;
  const res = await postOpenWAWebhook(buildOpenWAEvent('message.sent', unknownId));
  check('F1. unknown id 200', res.status === 200);
  check('F2. unknown id processed+succeeded', res.json && res.json.processed === 1 && res.json.succeeded === 1 && res.json.failed === 0, JSON.stringify(res.json));
  const count = await prisma.campaignExecutionRecipient.count({ where: { providerMessageId: unknownId } });
    check('F3. no recipient row created', count === 0, 'count=' + count);
}

// ---- Section G: Malformed ----
async function malformedTests() {
  console.log('\n--- Section G: Malformed events handled safely ---');
  const r1 = await postOpenWAWebhookRaw('not-json', { 'X-OpenWA-Signature': signOpenWA('not-json') });
  check('G1. non-JSON body -> 200 processed=0', r1.status === 200 && r1.json && r1.json.processed === 0, JSON.stringify(r1.json));
  const r2raw = JSON.stringify({ foo: 'bar' });
  const r2 = await postOpenWAWebhookRaw(r2raw, { 'X-OpenWA-Signature': signOpenWA(r2raw) });
  check('G2. non-OpenWA JSON -> 200 processed=0', r2.status === 200 && r2.json && r2.json.processed === 0, JSON.stringify(r2.json));
  const r3raw = JSON.stringify({ event: 'message.sent', data: {} });
  const r3 = await postOpenWAWebhookRaw(r3raw, { 'X-OpenWA-Signature': signOpenWA(r3raw) });
  check('G3. missing data.id -> 200 processed=0', r3.status === 200 && r3.json && r3.json.processed === 0, JSON.stringify(r3.json));
  const r4raw = JSON.stringify(buildOpenWAEvent('message.ack', MSG_ID(100), { status: 'weird' }));
  const r4 = await postOpenWAWebhookRaw(r4raw, { 'X-OpenWA-Signature': signOpenWA(r4raw) });
  check('G4. ack unknown status -> 200 processed=0', r4.status === 200 && r4.json && r4.json.processed === 0, JSON.stringify(r4.json));
  const r5 = await postOpenWAWebhookRaw('', { 'X-OpenWA-Signature': signOpenWA('') });
  check('G5. empty body -> 200 processed=0', r5.status === 200 && r5.json && r5.json.processed === 0, JSON.stringify(r5.json));
}

// ---- Section H: Signature enforcement ----
async function signatureEnforcementTests() {
  console.log('\n--- Section H: Signature enforcement (secret configured) ---');
  const raw = JSON.stringify(buildOpenWAEvent('message.sent', MSG_ID(8)));
  const r1 = await postOpenWAWebhookRaw(raw, { 'X-OpenWA-Signature': signOpenWA(raw) });
  check('H1. valid signature accepted', r1.status === 200, JSON.stringify(r1.json));
  const r2 = await postOpenWAWebhookRaw(raw, { 'X-OpenWA-Signature': 'sha256=' + '1'.repeat(64) });
  check('H2. invalid signature 403', r2.status === 403 && r2.json && r2.json.errorCode === 'WEBHOOK_INVALID_SIGNATURE');
  const r3 = await postOpenWAWebhookRaw(raw, {});
  check('H3. missing signature 403', r3.status === 403 && r3.json && r3.json.errorCode === 'WEBHOOK_INVALID_SIGNATURE');
  const r4 = await postOpenWAWebhookRaw(raw, { 'X-OpenWA-Signature': 'md5=abc123' });
  check('H4. bad prefix 403', r4.status === 403);
  const count = await prisma.campaignExecutionRecipient.count({ where: { providerMessageId: MSG_ID(8) } });
    check('H5. no mutation on invalid signature', count === 0, 'count=' + count);
}

// ---- Section B2: Raw body integrity (HMAC is over the exact raw bytes) ----
async function rawBodyTests() {
  console.log('\n--- Section B2: Raw body integrity ---');

  // K1: a pretty-printed body signed over its EXACT raw bytes is accepted.
  const t = await seedExecutionWithRecipient(20, MSG_ID(20), 'PENDING');
  const prettyRaw = JSON.stringify(buildOpenWAEvent('message.sent', MSG_ID(20)), null, 2);
  const r1 = await postOpenWAWebhookRaw(prettyRaw, { 'X-OpenWA-Signature': signOpenWA(prettyRaw) });
  check('K1. exact raw body signature accepted', r1.status === 200 && r1.json && r1.json.processed === 1 && r1.json.succeeded === 1, JSON.stringify(r1.json));
  const row1 = await getRecipientRow(t.execution.id, t.rec.id);
  check('K2. exact raw body event applied', row1.status === 'SENT', 'status=' + row1.status);

  // K3: the same JSON re-serialized (whitespace stripped) must NOT verify.
  const minified = JSON.stringify(JSON.parse(prettyRaw));
  const r2 = await postOpenWAWebhookRaw(prettyRaw, { 'X-OpenWA-Signature': signOpenWA(minified) });
  check('K3. whitespace-changed body rejected', r2.status === 403 && r2.json && r2.json.errorCode === 'WEBHOOK_INVALID_SIGNATURE', JSON.stringify(r2.json));

  // K4: reordered keys must NOT verify against a signature computed over the original order.
  const orderedRaw = '{"event":"message.sent","data":{"id":"' + MSG_ID(21) + '"}}';
  const reorderedRaw = '{"data":{"id":"' + MSG_ID(21) + '"},"event":"message.sent"}';
  const r3 = await postOpenWAWebhookRaw(reorderedRaw, { 'X-OpenWA-Signature': signOpenWA(orderedRaw) });
  check('K4. key-order change rejected', r3.status === 403, JSON.stringify(r3.json));

  // K5: neither rejected request may mutate any row.
  const mutated = await prisma.campaignExecutionRecipient.count({ where: { providerMessageId: MSG_ID(21) } });
  check('K5. rejected bodies mutate nothing', mutated === 0, 'count=' + mutated);
}

// ---- Section I: Meta preserved ----
async function existingMetaWebhookPreservedTests() {
  console.log('\n--- Section I: Existing Meta webhook still works ---');
  const r1 = await request('GET', '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=' + VERIFY_TOKEN + '&hub.challenge=hello123', undefined, undefined, undefined);
  check('I1. Meta GET verification works', r1.status === 200 && r1.text === 'hello123', JSON.stringify(r1));
  const metaRaw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '123', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '111', display_phone_number: '222' }, statuses: [{ id: MSG_ID(9), status: 'delivered', timestamp: '1700000000' }] } }] }] });
  const r2 = await request('POST', '/api/webhooks/whatsapp', metaRaw, 'application/json', { 'X-Hub-Signature-256': signMeta(metaRaw) });
  check('I2. Meta POST still works', r2.status === 200 && r2.json && r2.json.succeeded === 1, JSON.stringify(r2.json));
  check('I3. Meta response has no OpenWA secret', !JSON.stringify(r2).includes(OPENWA_SECRET));
}

// ---- Section H2: Execution status recalculation (reuses existing logic) ----
async function executionRecalcTests() {
  console.log('\n--- Section H2: Execution status recalculation ---');

  // H6: two OpenWA recipients; the execution only completes through the existing
  // recalculation rules once every recipient is terminal.
  const recA = await createTestRecipient(21);
  const recB = await createTestRecipient(22);
  const camp = await createTestCampaign(21);
  const exec = await prisma.campaignExecution.create({ data: { campaignId: camp.id, status: 'RUNNING', scheduledAt: new Date(), startedAt: new Date(), messageBody: 'P73 recalc ' + RUN } });
  await prisma.campaignExecutionRecipient.create({ data: { executionId: exec.id, recipientId: recA.id, whatsappNumber: recA.whatsappNumber, name: recA.name, providerMessageId: MSG_ID(30), status: 'SENT' } });
  await prisma.campaignExecutionRecipient.create({ data: { executionId: exec.id, recipientId: recB.id, whatsappNumber: recB.whatsappNumber, name: recB.name, providerMessageId: MSG_ID(31), status: 'PENDING' } });

  const d1 = await postOpenWAWebhook(buildOpenWAEvent('message.ack', MSG_ID(30), { status: 'delivered' }));
  check('R1. delivered ack processed', d1.status === 200 && d1.json.succeeded === 1);
  const execMid = await prisma.campaignExecution.findUnique({ where: { id: exec.id }, select: { status: true } });
  check('R2. execution stays RUNNING while one recipient is pending', execMid.status === 'RUNNING', 'status=' + execMid.status);

  const d2 = await postOpenWAWebhook(buildOpenWAEvent('message.sent', MSG_ID(31)));
  check('R3. final recipient event processed', d2.status === 200 && d2.json.succeeded === 1);
  const execEnd = await prisma.campaignExecution.findUnique({ where: { id: exec.id }, select: { status: true, completedAt: true } });
  check('R4. execution COMPLETED via existing recalculation', execEnd.status === 'COMPLETED' && !!execEnd.completedAt, 'status=' + execEnd.status);

  // R5/R6: a failed OpenWA recipient recalculates the execution to FAILED.
  const recC = await createTestRecipient(23);
  const camp2 = await createTestCampaign(22);
  const exec2 = await prisma.campaignExecution.create({ data: { campaignId: camp2.id, status: 'RUNNING', scheduledAt: new Date(), startedAt: new Date(), messageBody: 'P73 recalc fail ' + RUN } });
  await prisma.campaignExecutionRecipient.create({ data: { executionId: exec2.id, recipientId: recC.id, whatsappNumber: recC.whatsappNumber, name: recC.name, providerMessageId: MSG_ID(32), status: 'PENDING' } });
  const f1 = await postOpenWAWebhook(buildOpenWAEvent('message.failed', MSG_ID(32), { error: 'Recipient unreachable' }));
  check('R5. failed event processed', f1.status === 200 && f1.json.succeeded === 1);
  const execFailed = await prisma.campaignExecution.findUnique({ where: { id: exec2.id }, select: { status: true } });
  check('R6. execution FAILED via existing recalculation', execFailed.status === 'FAILED', 'status=' + execFailed.status);
}

// ---- Section N: Fail-closed when no webhook secret is configured ----
async function unconfiguredSecretTests() {
  console.log('\n--- Section N: Fail-closed when no OpenWA webhook secret is configured ---');
  const savedSecret = process.env.WHATSAPP_OPENWA_WEBHOOK_SECRET;
  delete process.env.WHATSAPP_OPENWA_WEBHOOK_SECRET;

  try {
    // The endpoint must reject (never process) when no secret is configured: the
    // HMAC signature is the only authentication on this route.
    const t = await seedExecutionWithRecipient(60, MSG_ID(60), 'SENT');

    const rawUnsigned = JSON.stringify(buildOpenWAEvent('message.ack', MSG_ID(60), { status: 'read' }));
    const n1 = await postOpenWAWebhookRaw(rawUnsigned, {});
    check('N1. no secret configured -> 403 WEBHOOK_NOT_CONFIGURED', n1.status === 403 && n1.json && n1.json.errorCode === 'WEBHOOK_NOT_CONFIGURED', JSON.stringify(n1.json));

    const n2 = await postOpenWAWebhookRaw(rawUnsigned, { 'X-OpenWA-Signature': signOpenWA(rawUnsigned) });
    check('N2. no secret configured -> even a well-formed signature is rejected', n2.status === 403 && n2.json && n2.json.errorCode === 'WEBHOOK_NOT_CONFIGURED', JSON.stringify(n2.json));

    const row = await getRecipientRow(t.execution.id, t.rec.id);
    check('N3. unauthenticated request cannot mutate delivery state', row.status === 'SENT' && !row.readAt, 'status=' + row.status);

    const leaked = JSON.stringify([n1.json, n2.json]);
    check('N4. rejection responses do not leak the secret', !leaked.includes(OPENWA_SECRET) && !/secret/i.test(leaked));
  } finally {
    process.env.WHATSAPP_OPENWA_WEBHOOK_SECRET = savedSecret;
  }

  // Restored secret still works after the fail-closed window.
  const n5 = await postOpenWAWebhook(buildOpenWAEvent('message.sent', MSG_ID(61)));
  check('N5. configured secret works again after restore', n5.status === 200 && n5.json && n5.json.processed === 1, JSON.stringify(n5.json));
}

// ---- Section J: Source security ----
function sourceSecurityTests() {
  console.log('\n--- Section J: Source security checks ---');
  const controllerSrc = fs.readFileSync(path.join(REPO_ROOT, 'apps/server/src/controllers/webhook.controller.ts'), 'utf8');
  const controllerNo = controllerSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('J1. controller has no hardcoded secret', !/test-openwa-webhook-secret/.test(controllerNo));
  check('J2. controller imports OpenWA helpers', /normalizeOpenWAWebhookEvents/.test(controllerSrc) && /verifyOpenWAWebhookSignature/.test(controllerSrc));
  check('J3. controller exports receiveOpenWAWebhook', /export const receiveOpenWAWebhook/.test(controllerSrc));
  const routeSrc = fs.readFileSync(path.join(REPO_ROOT, 'apps/server/src/routes/webhook.routes.ts'), 'utf8');
  check('J4. routes register openwa endpoint', /whatsapp\/openwa/.test(routeSrc));
  const svcSrc = fs.readFileSync(path.join(REPO_ROOT, 'apps/server/src/services/whatsapp/openwaWebhook.service.ts'), 'utf8');
  const svcNo = svcSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('J5. service has no dummy/secret literals', !/DUMMY|test-secret|super|changeme/i.test(svcNo));
  check('J6. service uses timingSafeEqual', /timingSafeEqual/.test(svcSrc));
  check('J7. service imports from whatsappWebhook.service', /from '.\/whatsappWebhook.service'/.test(svcSrc));
  const configSrc = fs.readFileSync(path.join(REPO_ROOT, 'apps/server/src/services/whatsapp/config.ts'), 'utf8');
  check('J8. config has WHATSAPP_OPENWA_WEBHOOK_SECRET', /WHATSAPP_OPENWA_WEBHOOK_SECRET/.test(configSrc));
  check('J9. config exports loadOpenWAWebhookConfig', /export function loadOpenWAWebhookConfig/.test(configSrc));
  const envExample = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
  check('J10. .env.example has the var, empty', /WHATSAPP_OPENWA_WEBHOOK_SECRET=/.test(envExample));
}

async function cleanup() {
  try {
    await prisma.campaignExecutionRecipient.deleteMany({});
    await prisma.campaignExecution.deleteMany({});
    await prisma.campaignSchedule.deleteMany({});
    await prisma.campaign.deleteMany({});
    await prisma.message.deleteMany({ where: { id: { in: [...createdMessageIds] } } });
    await prisma.recipient.deleteMany({ where: { id: { in: [...createdRecipientIds] } } });
  } catch {}
  try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); if (fs.existsSync(dbPath + '-journal')) fs.unlinkSync(dbPath + '-journal'); } catch {}
}

async function main() {
  console.log('=== Phase 7.3: OpenWA delivery-status synchronization ===\n');

  const originalListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) { server = this; return originalListen.apply(this, args); };

    installProviderMock();

  require('tsx/cjs');

  const { execSync } = require('child_process');
  execSync('npx prisma db push --schema=prisma/schema.prisma --skip-generate', { cwd: REPO_ROOT, env: { ...process.env }, stdio: 'pipe' });

  require('./apps/server/src/index.ts');
  indexModule = require('./apps/server/src/index.ts');

  const serverUp = await waitForServer(20000);
  check('0. Server reachable', serverUp);
  if (!serverUp) { failures++; process.exitCode = 1; if (server) await new Promise((resolve) => server.close(resolve)); restoreFetch(); return; }

  try { if (indexModule.worker) await indexModule.worker.stop(); } catch {}
  try { if (indexModule.scheduler) await indexModule.scheduler.stop(); } catch {}

  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient({ datasources: { db: { url: 'file:' + dbPath } } });

  try {
    sourceSecurityTests();
    normalizeTests();
    signatureTests();
    await endToEndTests();
    await rawBodyTests();
    await idempotencyTests();
    await outOfOrderTests();
    await executionRecalcTests();
    await unknownMessageIdTests();
    await malformedTests();
    await signatureEnforcementTests();
    await existingMetaWebhookPreservedTests();
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

  if (server) { try { await new Promise((resolve) => server.close(resolve)); } catch {} }
  if (prisma) { try { await prisma.$disconnect(); } catch {} }
  restoreFetch();
}

main().catch((error) => { console.error('Error:', error && error.stack ? error.stack : error); process.exitCode = 1; });







