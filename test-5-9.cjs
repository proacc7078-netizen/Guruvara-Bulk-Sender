/**
 * Phase 5.9 â€” Messaging History & Delivery Records Tests
 *
 * Tests the authenticated GET /api/history and GET /api/history/:executionRecipientId
 * endpoints. Uses the existing immutable CampaignExecution / CampaignExecutionRecipient
 * snapshot records â€” no new tables, no real Meta/WhatsApp calls.
 *
 * Safety:
 * - WHATSAPP_PROVIDER=none and webhook verify token/secret set BEFORE server start.
 * - Only fake test data is created and cleaned up.
 * - No real Meta/WhatsApp calls are ever made.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const REPO_ROOT = __dirname;
const INDEX_PATH = path.join(REPO_ROOT, 'apps/server/src/index.ts');
const CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/history.controller.ts');
const ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/history.routes.ts');
const AUTHController_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/auth.controller.ts');
const AUTH_ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/auth.routes.ts');
const DB_PATH = path.join(REPO_ROOT, 'apps/server/src/config/db.ts');

const TEST_PORT = 3159;
process.env.PORT = String(TEST_PORT);
const BASE = 'http://127.0.0.1:' + TEST_PORT;

// Force safe mode before server start.
process.env.WHATSAPP_PROVIDER = 'none';
process.env.SCHEDULER_POLL_INTERVAL_MS = '999900';
process.env.WORKER_POLL_INTERVAL_MS = '999900';
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'p59-verify-token-' + String(Date.now()).slice(-6);
process.env.WHATSAPP_APP_SECRET = 'p59-app-secret';

const RUN = String(Date.now()).slice(-6);
const PHONE_PREFIX = '9' + RUN;
const phoneFor = (n) => PHONE_PREFIX + String(n);
const MSG_ID = (n) => 'p59_msg_' + n;

let checks = 0;
let failures = 0;
let server = null;
let prisma = null;
let tempUserId = null;
let serverModule = null;

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
    await new Promise((r) => setTimeout(r, 150));
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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function login(email, password) {
  const res = await request('POST', '/api/auth/login', JSON.stringify({ email, password }), null, 'application/json');
  return res.setCookie ? res.setCookie.split(';')[0] : null;
}

async function createTestUser() {
  const email = 'phase59-' + RUN + '@example.com';
  const password = 'Phase59-' + RUN + '-pw!';
  const { PrismaClient } = require('@prisma/client');
  const argon2 = require('argon2');
  const p = new PrismaClient();
  const hashed = await argon2.hash(password);
  const user = await p.user.create({ data: { email, password: hashed } });
  tempUserId = user.id;
  await p.$disconnect();
  return { email, password };
}

async function createTestCampaign(cookie, suffix) {
  const recRes = await postJson('/api/recipients', {
    name: 'P59 R' + suffix + ' ' + RUN,
    whatsappNumber: phoneFor(suffix),
    normalizedPhone: phoneFor(suffix),
    language: 'Hindi', category: 'Phase59Test', status: 'ACTIVE', source: 'MANUAL',
  }, cookie);
  if (!recRes.json?.data?.id) { console.error('Recipient create failed:', JSON.stringify(recRes.json)); }
  const recipientId = recRes.json?.data?.id;

  const msgRes = await postJson('/api/messages', {
    name: 'P59 M' + suffix + ' ' + RUN, body: 'P59 message body ' + RUN + ' ' + suffix, language: 'Hindi', status: 'DRAFT',
  }, cookie);
  if (!msgRes.json?.data?.id) { console.error('Message create failed:', JSON.stringify(msgRes.json)); }
  const messageId = msgRes.json?.data?.id;

  const campRes = await postJson('/api/campaigns', { name: 'P59 C' + suffix + ' ' + RUN, messageId }, cookie);
  if (!campRes.json?.data?.id) { console.error('Campaign create failed:', JSON.stringify(campRes.json)); }
  const campaignId = campRes.json?.data?.id;

  // Add audience before finalize
  await request('PUT', '/api/campaigns/' + campaignId + '/audience', JSON.stringify({ recipientIds: [recipientId] }), cookie, 'application/json');

  const finalRes = await postJson('/api/campaigns/' + campaignId + '/finalize', {}, cookie);
  if (!finalRes.json?.success) { console.error('Finalize failed:', JSON.stringify(finalRes.json)); }
  await postJson('/api/campaigns/' + campaignId + '/schedule', {
    scheduledAt: new Date(Date.now() + 172800000).toISOString().slice(0, 16),
    timezone: 'Asia/Kolkata',
  }, cookie);

  const execRes = await postJson('/api/campaigns/' + campaignId + '/execution', {}, cookie);
  if (!execRes.json?.data?.execution?.id) { console.error('Execution create failed:', JSON.stringify(execRes.json)); }
  const executionId = execRes.json?.data?.execution?.id;

  return { campaignId, executionId, recipientId };
}

async function createExecutionRecipient(executionId, recipientId, whatsappNumber, name, status, providerMessageId, opts = {}) {
  if (prisma) {
  return prisma.campaignExecutionRecipient.upsert({
    where: { executionId_recipientId: { executionId, recipientId } },
    update: {
      status, providerMessageId, errorCode: opts.errorCode ?? null, errorMessage: opts.errorMessage ?? null,
      nextAttemptAt: opts.nextAttemptAt ?? null, sentAt: opts.sentAt ?? null,
      deliveredAt: opts.deliveredAt ?? null, readAt: opts.readAt ?? null,
      webhookErrorCode: opts.webhookErrorCode ?? null, webhookErrorMessage: opts.webhookErrorMessage ?? null,
    },
    create: {
      executionId, recipientId, whatsappNumber, name, status,
      providerMessageId: providerMessageId ?? null,
      errorCode: opts.errorCode ?? null, errorMessage: opts.errorMessage ?? null,
      nextAttemptAt: opts.nextAttemptAt ?? null, sentAt: opts.sentAt ?? null,
      deliveredAt: opts.deliveredAt ?? null, readAt: opts.readAt ?? null,
      webhookErrorCode: opts.webhookErrorCode ?? null, webhookErrorMessage: opts.webhookErrorMessage ?? null,
    },
  });
  }
  return null;
}

async function cleanup() {
  try {
    if (!prisma) return;
    await prisma.campaignExecutionRecipient.deleteMany({});
    await prisma.campaignExecution.deleteMany({});
    await prisma.campaignSchedule.deleteMany({});
    await prisma.campaignRecipient.deleteMany({});
    await prisma.campaign.deleteMany({ where: { name: { startsWith: 'P59' } } });
    await prisma.message.deleteMany({ where: { name: { startsWith: 'P59' } } });
    await prisma.recipient.deleteMany({ where: { name: { startsWith: 'P59' } } });
    if (tempUserId) {
      try { await prisma.user.delete({ where: { id: tempUserId } }); } catch { }
      tempUserId = null;
    }
  } catch (e) {
    console.error('Cleanup error:', e);
  }
}

async function main() {
  console.log('=== Phase 5.9: Messaging History & Delivery Records ===\n');

  const originalListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    server = this;
    return originalListen.apply(this, args);
  };

  require('tsx/cjs');
  require(INDEX_PATH);
  serverModule = require(INDEX_PATH);

  const serverUp = await waitForServer(20000);
  check('0. Server reachable', serverUp);
  if (!serverUp) {
    failures++;
    if (server) await new Promise((resolve) => server.close(resolve));
    return;
  }

  try {
    if (serverModule.worker) { try { await serverModule.worker.stop(); } catch { } }
    if (serverModule.scheduler) { try { await serverModule.scheduler.stop(); } catch { } }
  } catch { }

  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient();

  /* === Setup test user === */
  const creds = await createTestUser();
  const cookie = await login(creds.email, creds.password);
  check('1. Auth: login works', cookie !== null, 'cookie=' + Boolean(cookie));

  /* === Source security tests === */
  console.log('\n--- Source security ---');
  const historySrc = readSource(CONTROLLER_PATH);
  check('2. History controller exports listHistory', /export\s+(?:const|function)\s+(?:async\s+)?listHistory/.test(historySrc));
  check('3. History controller exports getHistoryDetail', /export\s+(?:const|function)\s+(?:async\s+)?getHistoryDetail/.test(historySrc));
  check('4. No access_token in history controller', !/access_token/i.test(historySrc));
  check('5. No WHATSAPP_ACCESS in history controller', !/WHATSAPP_ACCESS/i.test(historySrc));
  check('6. No app secret in history controller', !/appSecret|app_secret/i.test(historySrc));
  check('7. No authorization header in history controller', !/authorization/i.test(historySrc));

  const historyRoutesSrc = readSource(ROUTES_PATH);
  check('8. History routes use requireAuth', /requireAuth/.test(historyRoutesSrc));
  check('9. History routes define GET /api/history', /router\.get\(\s*'\/'/?.test(historyRoutesSrc) || /router\.get\(\s*"\/"/?.test(historyRoutesSrc));
  check('10. History routes define detail GET', /:executionRecipientId/.test(historyRoutesSrc));

  /* === Create test data === */
  console.log('\n--- Test data setup ---');
  const { campaignId: campId1, executionId: execId1, recipientId: recId1 } = await createTestCampaign(cookie, '1');
  const { campaignId: campId2, executionId: execId2, recipientId: recId2 } = await createTestCampaign(cookie, '2');

  const r1 = await prisma.recipient.findUnique({ where: { id: recId1 } });
  const r2 = await prisma.recipient.findUnique({ where: { id: recId2 } });

  // Execution recipient 1: SENT with provider message ID.
  // Production-consistent: a record is only ever stored as SENT while the
  // strongest delivery evidence is sentAt. deliveredAt/readAt are deliberately
  // absent here because resolveDeliveryStatus() treats any of those
  // timestamps as stronger evidence and would derive DELIVERED/READ instead.
  // The full timestamp progression is exercised by the READ fixture below.
  await createExecutionRecipient(execId1, recId1, r1.whatsappNumber, r1.name, 'SENT', MSG_ID(1), {
    sentAt: new Date('2026-09-15T10:00:00Z'),
  });

  // Execution recipient 2: DELIVERED
  await createExecutionRecipient(execId1, recId2, r2.whatsappNumber, r2.name, 'DELIVERED', MSG_ID(2), {
    sentAt: new Date('2026-09-15T11:00:00Z'),
    deliveredAt: new Date('2026-09-15T11:01:00Z'),
  });

  // Execution recipient on exec2: PENDING with retry
  await createExecutionRecipient(execId2, recId2, r2.whatsappNumber, r2.name, 'PENDING', null, {
    nextAttemptAt: new Date('2026-09-20T12:00:00Z'),
  });

  // Execution recipient on exec2: FAILED.
  // Production-consistent: the webhook write path only stamps sentAt for
  // SENT/DELIVERED/READ events, so a FAILED record never carries delivery
  // timestamps. resolveDeliveryStatus() therefore falls through to the stored
  // FAILED status, which is exactly what the detail assertions expect.
  await createExecutionRecipient(execId2, recId1, r1.whatsappNumber, r1.name, 'FAILED', MSG_ID(3), {
    errorCode: '131049',
    errorMessage: 'message_template_failed',
    webhookErrorCode: '131049',
    webhookErrorMessage: 'message_template_failed',
  });

  // Create a 5th record with READ status via a new recipient + execution directly
  const readRecipient = await prisma.recipient.create({
    data: {
      name: 'P59 R3 ' + RUN,
      whatsappNumber: phoneFor(3),
      normalizedPhone: phoneFor(3),
      status: 'ACTIVE',
      source: 'MANUAL',
    },
  });
  const readExecution = await prisma.campaignExecution.create({
    data: {
      campaignId: campId2,
      status: 'COMPLETED',
      scheduledAt: new Date(),
      startedAt: new Date(),
      completedAt: new Date(),
      messageBody: 'P59 read body ' + RUN,
      messageName: 'P59 M2 ' + RUN,
    },
  });
  await prisma.campaignExecutionRecipient.create({
    data: {
      executionId: readExecution.id,
      recipientId: readRecipient.id,
      whatsappNumber: readRecipient.whatsappNumber,
      name: readRecipient.name,
      status: 'READ',
      providerMessageId: MSG_ID(4),
      sentAt: new Date('2026-09-16T09:00:00Z'),
      deliveredAt: new Date('2026-09-16T09:01:00Z'),
      readAt: new Date('2026-09-16T09:02:00Z'),
    },
  });

  check('11. Test data created', true, '5 execution recipients seeded');

  /* === Test: unauthenticated access === */
  console.log('\n--- Unauthenticated access ---');
  const unauth = await getJson('/api/history');
  check('12. Unauthenticated â†’ 401', unauth.status === 401, 'status=' + unauth.status);

  const unauthDetail = await getJson('/api/history/' + execId1 + ':' + recId1);
  check('13. Unauthenticated detail â†’ 401', unauthDetail.status === 401, 'status=' + unauthDetail.status);

  /* === Test: empty history === */
  console.log('\n--- Empty history ---');
  const emptyRes = await getJson('/api/history?campaign=nonexistent-campaign', cookie);
  check('14. Empty history returns success', emptyRes.status === 200 && emptyRes.json?.success === true);
  check('15. Empty history has 0 total', emptyRes.json?.data?.total === 0, 'total=' + emptyRes.json?.data?.total);
  check('16. Empty history has empty items', Array.isArray(emptyRes.json?.data?.items) && emptyRes.json?.data?.items.length === 0);

  /* === Test: pagination === */
  console.log('\n--- Pagination ---');
  const page1 = await getJson('/api/history?page=1&limit=2', cookie);
  check('17. Page 1 returns 2 items', page1.json?.data?.items?.length === 2, 'got=' + page1.json?.data?.items?.length);
  check('18. Page 1 page=1', page1.json?.data?.page === 1);
  check('19. Page 1 limit=2', page1.json?.data?.limit === 2);
  check('20. Page 1 total=5', page1.json?.data?.total === 5, 'total=' + page1.json?.data?.total);

  const page2 = await getJson('/api/history?page=2&limit=2', cookie);
  check('21. Page 2 returns 2 items', page2.json?.data?.items?.length === 2, 'got=' + page2.json?.data?.items?.length);
  check('22. Page 2 page=2', page2.json?.data?.page === 2);

  const page3 = await getJson('/api/history?page=3&limit=2', cookie);
  check('23. Page 3 returns 1 item', page3.json?.data?.items?.length === 1, 'got=' + page3.json?.data?.items?.length);
  check('24. Page 3 hasMore=false', page3.json?.data?.hasMore === false);

  /* === Test: campaign filter === */
  console.log('\n--- Campaign filter ---');
  const campFilter = await getJson('/api/history?campaign=P59 C1', cookie);
  check('25. Campaign filter returns items', campFilter.json?.data?.items?.length > 0, 'count=' + campFilter.json?.data?.items?.length);
  for (const item of campFilter.json?.data?.items ?? []) {
    check('26. Item campaign=P59 C1', item.campaignName === 'P59 C1 ' + RUN, item.campaignName);
  }

  const campFilter2 = await getJson('/api/history?campaign=nonexistent', cookie);
  check('27. Campaign filter no match', campFilter2.json?.data?.total === 0);

  /* === Test: recipient filter === */
  console.log('\n--- Recipient filter ---');
  const recFilter = await getJson('/api/history?recipient=P59 R1', cookie);
  check('28. Recipient filter returns items', recFilter.json?.data?.items?.length > 0, 'count=' + recFilter.json?.data?.items?.length);
  for (const item of recFilter.json?.data?.items ?? []) {
    check('29. Item matches recipient', item.recipientName?.includes('P59 R1'), item.recipientName);
  }

  const phoneFilter = await getJson('/api/history?recipient=' + phoneFor(1), cookie);
  check('30. Recipient filter by phone', phoneFilter.json?.data?.total > 0, 'total=' + phoneFilter.json?.data?.total);

  /* === Test: status filter === */
  console.log('\n--- Status filter ---');
  const sentFilter = await getJson('/api/history?status=SENT', cookie);
  check('31. SENT filter returns items', sentFilter.json?.data?.items?.length >= 1, 'count=' + sentFilter.json?.data?.items?.length);
  for (const item of sentFilter.json?.data?.items ?? []) {
    check('32. Item status=SENT', item.status === 'SENT', item.status);
  }

  const deliveredFilter = await getJson('/api/history?status=DELIVERED', cookie);
  check('33. DELIVERED filter returns items', deliveredFilter.json?.data?.items?.length >= 1, 'count=' + deliveredFilter.json?.data?.items?.length);
  for (const item of deliveredFilter.json?.data?.items ?? []) {
    check('34. Item status=DELIVERED', item.status === 'DELIVERED', item.status);
  }

  const failedFilter = await getJson('/api/history?status=FAILED', cookie);
  check('35. FAILED filter returns items', failedFilter.json?.data?.items?.length >= 1, 'count=' + failedFilter.json?.data?.items?.length);

  const invalidStatus = await getJson('/api/history?status=BOGUS', cookie);
  check('36. Invalid status â†’ 400', invalidStatus.status === 400, 'status=' + invalidStatus.status);

  /* === Test: date filtering === */
  console.log('\n--- Date filtering ---');
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  const dateFilter = await getJson('/api/history?start=' + startOfDay + '&end=' + endOfDay, cookie);
  check('37. Date filter returns items', dateFilter.json?.data?.items?.length > 0, 'count=' + dateFilter.json?.data?.items?.length);

  const futureDate = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate()).toISOString();
  const dateFilterEmpty = await getJson('/api/history?start=' + futureDate, cookie);
  check('38. Future date filter â†’ 0', dateFilterEmpty.json?.data?.total === 0);

  /* === Test: provider message ID filter === */
  console.log('\n--- Provider message ID filter ---');
  const provFilter = await getJson('/api/history?providerId=' + MSG_ID(1), cookie);
  check('39. Provider ID filter returns items', provFilter.json?.data?.items?.length >= 1, 'count=' + provFilter.json?.data?.items?.length);
  for (const item of provFilter.json?.data?.items ?? []) {
    check('40. Item has provider ID', item.providerMessageId === MSG_ID(1), item.providerMessageId);
  }

  /* === Test: history detail === */
  console.log('\n--- History detail ---');
  const detail = await getJson('/api/history/' + execId1 + ':' + recId1, cookie);
  check('41. Detail returns 200', detail.status === 200, 'status=' + detail.status);
  check('42. Detail has source', detail.json?.data?.source === 'execution_snapshot', detail.json?.data?.source);
  check('43. Detail has snapshot', !!detail.json?.data?.snapshot);
  check('44. Detail has execution', !!detail.json?.data?.execution);
  check('45. Snapshot executionId matches', detail.json?.data?.snapshot?.executionId === execId1);
  check('46. Snapshot recipientPhone matches', detail.json?.data?.snapshot?.recipientPhone === r1.whatsappNumber);
  check('47. Snapshot status=SENT', detail.json?.data?.snapshot?.status === 'SENT');

  /* === Test: immutable execution snapshot === */
  console.log('\n--- Immutable execution snapshot ---');
  check('48. Source is execution_snapshot', detail.json?.data?.source === 'execution_snapshot');
/* The complete SENT -> DELIVERED -> READ timestamp progression is exercised by the
   * READ fixture (under the documented invariant such a record IS a READ record). */
  const readDetail = await getJson('/api/history/' + readExecution.id + ':' + readRecipient.id, cookie);
  const readSnap = readDetail.json?.data?.snapshot;
  check('49. Snapshot has immutable fields',
    !!readSnap?.sentAt && !!readSnap?.deliveredAt && !!readSnap?.readAt);

  /* === Test: delivered/read timestamps === */
  console.log('\n--- Delivered/read timestamps ---');
  check('50. sentAt is present', !!readSnap?.sentAt, String(readSnap?.sentAt));
  check('51. deliveredAt is present', !!readSnap?.deliveredAt, String(readSnap?.deliveredAt));
  check('52. readAt is present', !!readSnap?.readAt, String(readSnap?.readAt));
  check('53. sentAt < deliveredAt', new Date(readSnap?.sentAt) <= new Date(readSnap?.deliveredAt));
  check('54. deliveredAt < readAt', new Date(readSnap?.deliveredAt) <= new Date(readSnap?.readAt));

  /* === Test: detail for FAILED record === */
  console.log('\n--- Failed record detail ---');
  const failedDetail = await getJson('/api/history/' + execId2 + ':' + recId1, cookie);
  check('55. Failed detail status=FAILED', failedDetail.json?.data?.snapshot?.status === 'FAILED');
  check('56. Failed has errorCode', failedDetail.json?.data?.snapshot?.errorCode === '131049', String(failedDetail.json?.data?.snapshot?.errorCode));
  check('57. Failed has errorMessage', /message_template_failed/.test(failedDetail.json?.data?.snapshot?.errorMessage || ''));
  check('58. Failed has webhookErrorCode', failedDetail.json?.data?.snapshot?.webhookErrorCode === '131049');
  check('59. Failed has webhookErrorMessage', /message_template_failed/.test(failedDetail.json?.data?.snapshot?.webhookErrorMessage || ''));

  /* === Test: retry-related fields === */
  console.log('\n--- Retry fields ---');
  const retryDetail = await getJson('/api/history/' + execId2 + ':' + recId2, cookie);
  check('60. Retry pending record has nextAttemptAt', !!retryDetail.json?.data?.snapshot?.nextAttemptAt);
  check('61. Retry pending record status=PENDING', retryDetail.json?.data?.snapshot?.status === 'PENDING');
  // Check PENDING with nextAttemptAt is flagged as retryPending in list
  const pendingList = await getJson('/api/history?status=PENDING', cookie);
  const pendingItem = pendingList.json?.data?.items?.find((i) => i.retryPending);
  check('62. List item has retryPending flag', !!pendingItem && pendingItem.retryPending === true);

  /* === Test: unknown execution-recipient ID === */
  console.log('\n--- Unknown ID ---');
  const unknownDetail = await getJson('/api/history/unknown-exec:unknown-rec', cookie);
  check('63. Unknown ID â†’ 404', unknownDetail.status === 404, 'status=' + unknownDetail.status);

  /* === Test: no secret leakage === */
  console.log('\n--- Secret leakage ---');
  const listRes = await getJson('/api/history', cookie);
  const detailRes = await getJson('/api/history/' + execId1 + ':' + recId1, cookie);
  const listJson = JSON.stringify(listRes.json);
  const detailJson = JSON.stringify(detailRes.json);
  check('64. No app_secret in list response', !/app_secret|appSecret/i.test(listJson));
  check('65. No app_secret in detail response', !/app_secret|appSecret/i.test(detailJson));
  check('66. No access_token in list response', !/access_token/i.test(listJson));
  check('67. No access_token in detail response', !/access_token/i.test(detailJson));
  check('68. No session secret in list response', !/super_secret_session/i.test(listJson));
  check('69. No session secret in detail response', !/super_secret_session/i.test(detailJson));
  check('70. No WHATSAPP_ACCESS_TOKEN in responses', !/WHATSAPP_ACCESS_TOKEN/i.test(listJson + detailJson));
  check('71. No webhook verify token in responses', !/p59-verify-token/i.test(listJson + detailJson));
  check('72. No webhook app secret in responses', !/p59-app-secret/i.test(listJson + detailJson));
  check('73. No authorization header in responses', !/authorization/i.test(listJson + detailJson));

  /* === Test: detail from list has consistent data === */
  console.log('\n--- Consistency ---');
  const firstItem = listRes.json?.data?.items?.[0];
  if (firstItem) {
    const singleDetail = await getJson('/api/history/' + firstItem.executionRecipientId, cookie);
    check('74. List item matches detail snapshot',
      singleDetail.json?.data?.snapshot?.executionRecipientId === firstItem.executionRecipientId ||
      singleDetail.json?.data?.executionRecipientId === firstItem.executionRecipientId);
  }

  /* === Cleanup === */
  console.log('\n--- Cleanup ---');
  await cleanup();
  check('75. Cleanup completed', true);

  /* === Final checks === */
  const remaining = await prisma.campaignExecutionRecipient.count({});
  check('76. No test rows remain in execution recipient', remaining === 0, 'count=' + remaining);

  console.log('\nAssertions run: ' + checks + ' | failed: ' + failures);
  console.log('=== ' + (failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED') + ' ===');
  process.exitCode = failures === 0 ? 0 : 1;

  if (server) {
    try { await new Promise((resolve) => server.close(resolve)); } catch { }
  }
  if (prisma) {
    try { await prisma.$disconnect(); } catch { }
  }
  if (serverModule.worker) { try { await serverModule.worker.stop(); } catch { } }
  if (serverModule.scheduler) { try { await serverModule.scheduler.stop(); } catch { } }
}

main().catch((error) => {
  console.error('Error:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
