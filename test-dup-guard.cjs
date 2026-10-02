/**
 * Regression: duplicate-send guard for CampaignExecutionRecipient.
 *
 * Guards the live defect found during the OpenWA E2E test: a recipient whose
 * status had advanced SENT -> READ (via a provider webhook) was accepted for a
 * second send, producing a duplicate WhatsApp message and overwriting
 * providerMessageId.
 *
 * NO real WhatsApp / Meta / OpenWA call is made: globalThis.fetch is mocked and
 * only intercepts graph.facebook.com, and the credentials are local dummies.
 * The suite runs against a disposable SQLite database supplied by the runner
 * (DATABASE_URL), so the application database is never touched.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

process.env.WHATSAPP_PROVIDER = 'official';
process.env.WHATSAPP_ACCESS_TOKEN = 'DUMMY_GUARD_TOKEN';
process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = 'DUMMY_WABA_ID';
process.env.WHATSAPP_PHONE_NUMBER_ID = 'DUMMY_PN_ID';
process.env.SCHEDULER_POLL_INTERVAL_MS = '999900';
process.env.WORKER_POLL_INTERVAL_MS = '999900';

const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '.env') });

const TEST_PORT = 3187;
const BASE = 'http://127.0.0.1:' + TEST_PORT;
const RUN = String(Date.now()).slice(-6);

let checks = 0, failures = 0, server = null, prisma = null, tempUserId = null;
let originalFetch = null, metaCalls = [];

function check(name, cond, extra) {
  checks++;
  if (!cond) failures++;
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (extra ? ' | ' + String(extra).slice(0, 200) : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(method, url, body, cookie, contentType) {
  const headers = {};
  if (contentType) headers['Content-Type'] = contentType;
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + url, { method, headers, body });
  const raw = await res.text();
  let parsed = null; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: res.status, json: parsed, setCookie: res.headers.get('set-cookie') };
}
const postJson = (u, b, c) => request('POST', u, JSON.stringify(b), c, 'application/json');
const putJson = (u, b, c) => request('PUT', u, JSON.stringify(b), c, 'application/json');

/** The pristine fetch, captured once so re-installing never chains mocks. */
const PRISTINE_FETCH = globalThis.fetch;
let metaCallSeq = 0;

/** Intercepts ONLY graph.facebook.com. Nothing else reaches the network. */
function installMetaMock() {
  try { require('./apps/server/src/services/whatsapp/whatsappProvider').resetWhatsAppAdapter(); } catch { }
  originalFetch = PRISTINE_FETCH;
  metaCalls = [];
  const f = async (url, init) => {
    if (typeof url === 'string' && url.includes('graph.facebook.com')) {
      // A UNIQUE id per provider call: if a duplicate send ever slipped through
      // the guard it would write a different providerMessageId, so the
      // "providerMessageId preserved" assertions are genuinely meaningful.
      const id = 'wamid_guard_' + (++metaCallSeq);
      metaCalls.push({ url: String(url), providerMessageId: id });
      const body = { success: true, messages: [{ id }] };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
    }
    return PRISTINE_FETCH(url, init);
  };
  globalThis.fetch = f;
}
function restoreFetch() { if (originalFetch) { globalThis.fetch = PRISTINE_FETCH; originalFetch = null; } }


async function waitForServer(timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch { }
    await sleep(150);
  }
  return false;
}

async function makeFixture(cookie, label) {
  const rid = (await postJson('/api/recipients', {
    name: 'GuardTest ' + label, whatsappNumber: '9' + RUN + String(Math.floor(Math.random() * 900) + 100),
    language: 'Hindi', category: 'GuardTest', status: 'ACTIVE', source: 'MANUAL',
  }, cookie)).json?.data?.id;
  if (!rid) return null;
  const mid = (await postJson('/api/messages', { name: 'GuardTest ' + label, body: 'Body ' + label, status: 'DRAFT' }, cookie)).json?.data?.id;
  const cid = (await postJson('/api/campaigns', { name: 'GuardTest Camp ' + label, messageId: mid }, cookie)).json?.data?.id;
  const aud = await putJson(`/api/campaigns/${cid}/audience`, { recipientIds: [rid] }, cookie);
  if (aud.status !== 200) return null;
  const fin = await postJson(`/api/campaigns/${cid}/finalize`, {}, cookie);
  if (fin.json?.data?.campaign?.status !== 'READY') return null;
  const sched = await postJson(`/api/campaigns/${cid}/schedule`, { scheduledAt: new Date(Date.now() + 172800000).toISOString().slice(0, 16), timezone: 'Asia/Kolkata' }, cookie);
  if (sched.status !== 200 && sched.status !== 201) return null;
  const execId = (await postJson(`/api/campaigns/${cid}/execution`, {}, cookie)).json?.data?.execution?.id;
  if (!execId) return null;
  const row = await prisma.campaignExecutionRecipient.findFirst({ where: { executionId: execId } });
  return { campaignId: cid, execId, recipientId: row.recipientId, erId: `${execId}:${row.recipientId}` };
}

async function readRow(erId) {
  const [e, r] = erId.split(':');
  return prisma.campaignExecutionRecipient.findUnique({ where: { executionId_recipientId: { executionId: e, recipientId: r } } });
}
const setStatus = (execId, recipientId, data) =>
  prisma.campaignExecutionRecipient.update({ where: { executionId_recipientId: { executionId: execId, recipientId } }, data });

async function main() {
  console.log('=== Duplicate-send guard regression ===\n');
  process.env.PORT = String(TEST_PORT);
  const origListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...a) { server = this; return origListen.apply(this, a); };
  require('tsx/cjs');
  require('./apps/server/src/index.ts');

  const up = await waitForServer(20000);
  check('0. Server reachable', up, BASE);
  if (!up) { process.exitCode = 1; return; }

  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient();
  const argon2 = require('argon2');
  const email = 'dupguard-' + RUN + '@example.com';
  const password = 'DupGuard-' + RUN + '-pw!';
  tempUserId = (await prisma.user.create({ data: { email, password: await argon2.hash(password) } })).id;
  const login = await request('POST', '/api/auth/login', JSON.stringify({ email, password }), null, 'application/json');
  const cookie = login.setCookie ? login.setCookie.split(';')[0] : null;
  check('0b. Test user can authenticate', !!cookie);
  if (!cookie) { process.exitCode = 1; return; }

  console.log('\n--- 1. normal first send (PENDING) ---');
  const A = await makeFixture(cookie, 'A');
  installMetaMock();
  const first = await postJson(`/api/campaigns/${A.campaignId}/execution/${A.erId}/send`, {}, cookie);
  check('1a. First send succeeds', first.status === 200 && first.json?.data?.success === true, JSON.stringify(first.json?.data));
  check('1b. Provider called exactly once', metaCalls.length === 1, 'calls=' + metaCalls.length);
  const aRow = await readRow(A.erId);
  check('1c. Status is SENT', aRow?.status === 'SENT', aRow?.status);
  check('1d. providerMessageId recorded', aRow?.providerMessageId === 'wamid_guard_1', aRow?.providerMessageId);
  check('1e. attemptCount is 1', aRow?.attemptCount === 1, aRow?.attemptCount);
  const aSnap = { pmid: aRow.providerMessageId, at: aRow.attemptCount, sentAt: String(aRow.sentAt) };

  console.log('\n--- 2. SENT -> duplicate refused ---');
  let calls = metaCalls.length;
  const d2 = await postJson(`/api/campaigns/${A.campaignId}/execution/${A.erId}/send`, {}, cookie);
  check('2a. Returns 409', d2.status === 409, 'status=' + d2.status);
  check('2b. Code ALREADY_SENT', d2.json?.error?.code === 'ALREADY_SENT', d2.json?.error?.code);
  check('2c. Provider NOT called again', metaCalls.length === calls, 'calls=' + metaCalls.length);
  const a2 = await readRow(A.erId);
  check('2d. providerMessageId preserved', a2?.providerMessageId === aSnap.pmid, a2?.providerMessageId);
  check('2e. attemptCount unchanged', a2?.attemptCount === aSnap.at, a2?.attemptCount);
  check('2f. sentAt unchanged', String(a2?.sentAt) === aSnap.sentAt);
  check('2g. status still SENT', a2?.status === 'SENT', a2?.status);

  console.log('\n--- 3. DELIVERED -> duplicate refused ---');
  const B = await makeFixture(cookie, 'B');
  await postJson(`/api/campaigns/${B.campaignId}/execution/${B.erId}/send`, {}, cookie);
  await setStatus(B.execId, B.recipientId, { status: 'DELIVERED', deliveredAt: new Date() });
  const bBefore = await readRow(B.erId);
  calls = metaCalls.length;
  const d3 = await postJson(`/api/campaigns/${B.campaignId}/execution/${B.erId}/send`, {}, cookie);
  check('3a. Returns 409', d3.status === 409, 'status=' + d3.status);
  check('3b. Provider NOT called', metaCalls.length === calls, 'calls=' + metaCalls.length);
  const b2 = await readRow(B.erId);
  check('3c. providerMessageId preserved', b2?.providerMessageId === bBefore?.providerMessageId, b2?.providerMessageId);
  check('3d. attemptCount unchanged', b2?.attemptCount === bBefore?.attemptCount, b2?.attemptCount);
  check('3e. deliveredAt unchanged', String(b2?.deliveredAt) === String(bBefore?.deliveredAt));
  check('3f. status still DELIVERED', b2?.status === 'DELIVERED', b2?.status);

  console.log('\n--- 4. READ -> duplicate refused (the live defect) ---');
  const C = await makeFixture(cookie, 'C');
  await postJson(`/api/campaigns/${C.campaignId}/execution/${C.erId}/send`, {}, cookie);
  await setStatus(C.execId, C.recipientId, { status: 'READ', deliveredAt: new Date(), readAt: new Date() });
  const cBefore = await readRow(C.erId);
  calls = metaCalls.length;
  const d4 = await postJson(`/api/campaigns/${C.campaignId}/execution/${C.erId}/send`, {}, cookie);
  check('4a. Returns 409 (regression)', d4.status === 409, 'status=' + d4.status);
  check('4b. Code ALREADY_SENT', d4.json?.error?.code === 'ALREADY_SENT', d4.json?.error?.code);
  check('4c. Provider NOT called', metaCalls.length === calls, 'calls=' + metaCalls.length);
  const c2 = await readRow(C.erId);
  check('4d. providerMessageId preserved', c2?.providerMessageId === cBefore?.providerMessageId, c2?.providerMessageId);
  check('4e. attemptCount unchanged', c2?.attemptCount === cBefore?.attemptCount, c2?.attemptCount);
  check('4f. readAt unchanged', String(c2?.readAt) === String(cBefore?.readAt));
  check('4g. status still READ', c2?.status === 'READ', c2?.status);

  console.log('\n--- 5. FAILED remains re-sendable (retry not broken) ---');
  const D = await makeFixture(cookie, 'D');
  await setStatus(D.execId, D.recipientId, { status: 'FAILED', errorCode: 'WHATSAPP_SEND_FAILED', errorMessage: 'seeded', nextAttemptAt: null });
  installMetaMock();
  calls = metaCalls.length;
  const d5 = await postJson(`/api/campaigns/${D.campaignId}/execution/${D.erId}/send`, {}, cookie);
  check('5a. FAILED re-send allowed', d5.status === 200 && d5.json?.data?.success === true, JSON.stringify(d5.json?.data));
  check('5b. Provider WAS called', metaCalls.length === calls + 1, 'calls=' + metaCalls.length);
  const d2row = await readRow(D.erId);
  check('5c. New providerMessageId stored', d2row?.providerMessageId === metaCalls[0].providerMessageId, d2row?.providerMessageId);
  check('5d. Status advanced out of FAILED', d2row?.status === 'SENT', d2row?.status);
  check('5e. Provider id is a fresh unique guard id', /^wamid_guard_\d+$/.test(String(metaCalls[0].providerMessageId)), metaCalls[0].providerMessageId);

  restoreFetch();
  console.log('\nAssertions run: ' + checks + ' | failed: ' + failures);
  console.log('=== ' + (failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED') + ' ===');
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error('Error:', e && e.stack ? e.stack : e); process.exitCode = 1; })
  .finally(async () => {
    try { if (prisma) { if (tempUserId) await prisma.user.delete({ where: { id: tempUserId } }).catch(() => {}); await prisma.$disconnect(); } } catch { }
    if (server) await new Promise((r) => server.close(r));
    try { const idx = require('./apps/server/src/index.ts'); if (idx.worker) await idx.worker.stop(); } catch { }
  });

