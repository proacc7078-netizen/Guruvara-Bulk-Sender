/**
 * Phase 5.10 — Settings & System Configuration Tests
 *
 * Tests the authenticated GET /api/settings endpoint, security properties,
 * and the POST /api/settings/verify-connection action. No real WhatsApp
 * or Meta calls are made.
 *
 * Safety:
 * - WHATSAPP_PROVIDER=none and webhook verify token/secret set BEFORE server start.
 * - Only test data is created and cleaned up.
 * - No real Meta/WhatsApp calls are ever made.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const REPO_ROOT = __dirname;
const INDEX_PATH = path.join(REPO_ROOT, 'apps/server/src/index.ts');
const AUTH_ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/auth.routes.ts');

const TEST_PORT = 3160;
process.env.PORT = String(TEST_PORT);
const BASE = 'http://127.0.0.1:' + TEST_PORT;

// Force safe mode before server start.
process.env.WHATSAPP_PROVIDER = 'none';
process.env.SCHEDULER_POLL_INTERVAL_MS = '999900';
process.env.WORKER_POLL_INTERVAL_MS = '999900';
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'p510-verify-token-' + String(Date.now()).slice(-6);
process.env.WHATSAPP_APP_SECRET = 'p510-app-secret';

const RUN = String(Date.now()).slice(-6);
const phoneFor = (n) => '9' + RUN + String(n);

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
  const email = 'phase510-' + RUN + '@example.com';
  const password = 'Phase510-' + RUN + '-pw!';
  const { PrismaClient } = require('@prisma/client');
  const argon2 = require('argon2');
  const p = new PrismaClient();
  const hashed = await argon2.hash(password);
  const user = await p.user.create({ data: { email, password: hashed } });
  tempUserId = user.id;
  await p.$disconnect();
  return { email, password };
}

async function cleanup() {
  try {
    if (!prisma) return;
    if (tempUserId) {
      try { await prisma.user.delete({ where: { id: tempUserId } }); } catch { }
      tempUserId = null;
    }
  } catch (e) {
    console.error('Cleanup error:', e);
  }
}

async function main() {
  console.log('=== Phase 5.10: Settings & System Configuration ===\n');

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
  if (!cookie) return;

  /* === Source security tests === */
  console.log('\n--- Source security ---');
  const settingsSrc = readSource(path.join(REPO_ROOT, 'apps/server/src/controllers/settings.controller.ts'));
  check('2. Settings controller exports getSettings', /export\s+(?:const|function)\s+(?:async\s+)?getSettings/.test(settingsSrc));
  check('3. Settings controller exports verifyConnection', /export\s+(?:const|function)\s+(?:async\s+)?verifyConnection/.test(settingsSrc));
  check('4. No raw credentials in settings controller', !/EAAP[a-zA-Z0-9]{20}/.test(settingsSrc));
  check('5. No hardcoded tokens in settings controller', !/access_token:\s*['"]/.test(settingsSrc) && !/WHATSAPP_ACCESS_TOKEN:\s*['"]/.test(settingsSrc));
  check('6. No hardcoded secrets in settings controller', !/appSecret:\s*['"]/.test(settingsSrc) && !/WHATSAPP_APP_SECRET:\s*['"]/.test(settingsSrc));
  check('7. No authorization in settings controller', !/authorization/i.test(settingsSrc));
  check('8. No session secret in settings controller', !/session_secret|super_secret_session/i.test(settingsSrc));

  const settingsRoutesSrc = readSource(path.join(REPO_ROOT, 'apps/server/src/routes/settings.routes.ts'));
  check('9. Settings routes use requireAuth', /requireAuth/.test(settingsRoutesSrc));
  check('10. Settings routes define GET /api/settings', /router\.get\(['"]\/['"]/.test(settingsRoutesSrc) || /router\.get\(['"]\/['"]/.test(settingsRoutesSrc));
  check('11. Settings routes define POST verify-connection', /router\.post\(['"]\/verify-connection['"]/.test(settingsRoutesSrc));

  /* === Test: unauthenticated settings GET === */
  console.log('\n--- Unauthenticated access ---');
  const unauth = await getJson('/api/settings');
  check('12. Unauthenticated GET → 401', unauth.status === 401, 'status=' + unauth.status);

  const unauthVerify = await request('POST', '/api/settings/verify-connection', undefined, null, 'application/json');
  check('13. Unauthenticated verify → 401', unauthVerify.status === 401, 'status=' + unauthVerify.status);

  /* === Test: authenticated settings GET === */
  console.log('\n--- Authenticated GET /api/settings ---');
  const settingsRes = await getJson('/api/settings', cookie);
  check('14. Authenticated GET → 200', settingsRes.status === 200, 'status=' + settingsRes.status);
  check('15. Response has success', settingsRes.json?.success === true);
  check('16. Response has data', !!settingsRes.json?.data);

  const data = settingsRes.json?.data;

  /* === Test: WhatsApp section === */
  console.log('\n--- WhatsApp settings ---');
  check('17. WhatsApp section present', !!data.whatsapp);
  check('18. Provider is none', data.whatsapp.provider === 'none', 'provider=' + data.whatsapp.provider);
  check('19. Configured is false', data.whatsapp.configured === false, 'configured=' + data.whatsapp.configured);
  check('20. Connection status present', typeof data.whatsapp.connectionStatus === 'string', data.whatsapp.connectionStatus);
  check('21. Token configured is boolean', typeof data.whatsapp.tokenConfigured === 'boolean', data.whatsapp.tokenConfigured);
  check('22. Webhook configured is boolean', typeof data.whatsapp.webhookConfigured === 'boolean', data.whatsapp.webhookConfigured);
  check('23. Webhook verification status present', !!data.whatsapp.webhookVerificationStatus);
  check('24. Webhook verification configured is boolean', typeof data.whatsapp.webhookVerificationStatus.configured === 'boolean');
  check('25. API version is string or null', typeof data.whatsapp.apiVersion === 'string' || data.whatsapp.apiVersion === null || data.whatsapp.apiVersion === undefined);

  /* === Test: Sending section === */
  console.log('\n--- Sending settings ---');
  check('26. Sending section present', !!data.sending);
  check('27. Max retries is number', typeof data.sending.maxRetries === 'number', 'maxRetries=' + data.sending.maxRetries);
  check('28. Retry backoff present', !!data.sending.retryBackoff);
  check('29. Retry backoff has baseDelay', typeof data.sending.retryBackoff.baseDelayMs === 'number');

  /* === Test: Scheduler & Worker section === */
  console.log('\n--- Scheduler/Worker settings ---');
  check('30. Scheduler section present', !!data.scheduler);
  check('31. Scheduler state is string', typeof data.scheduler.state === 'string', data.scheduler.state);
  check('32. Worker state is string', typeof data.scheduler.workerState === 'string', data.scheduler.workerState);
  check('33. Poll interval is number', typeof data.scheduler.pollIntervalMs === 'number', 'pollIntervalMs=' + data.scheduler.pollIntervalMs);
  check('34. Batch size is number', typeof data.scheduler.batchSize === 'number', 'batchSize=' + data.scheduler.batchSize);

  /* === Test: Storage section === */
  console.log('\n--- Storage settings ---');
  check('35. Storage section present', !!data.storage);
  check('36. Upload path is string', typeof data.storage.uploadPath === 'string', data.storage.uploadPath);
  check('37. Media limits present', !!data.storage.mediaLimits);
  check('38. Max file size is number', typeof data.storage.mediaLimits.maxFileSizeBytes === 'number');
  check('39. Allowed mime types is array', Array.isArray(data.storage.mediaLimits.allowedMimeTypes));

  /* === Test: System section === */
  console.log('\n--- System settings ---');
  check('40. System section present', !!data.system);
  check('41. Version is string', typeof data.system.version === 'string', data.system.version);
  check('42. Database status present', typeof data.system.database === 'string', data.system.database);
  check('43. Health status present', typeof data.system.health === 'string', data.system.health);

  /* === Test: No secret leakage in settings response === */
  console.log('\n--- Secret leakage ---');
  const settingsJson = JSON.stringify(settingsRes.json);
  check('44. No access_token in settings', !/access_token/i.test(settingsJson));
  check('45. No WHATSAPP_ACCESS_TOKEN in settings', !/WHATSAPP_ACCESS_TOKEN/i.test(settingsJson));
  check('46. No app secret in settings', !/app_secret|appSecret/i.test(settingsJson));
  check('47. No session secret in settings', !/super_secret_session/i.test(settingsJson));
  check('48. No authorization header in settings', !/authorization/i.test(settingsJson));
  check('49. No webhook verify token in settings', !/p510-verify-token/i.test(settingsJson));
  check('50. No webhook app secret in settings', !/p510-app-secret/i.test(settingsJson));
  check('51. No raw .env in settings', !/DATABASE_URL/i.test(settingsJson));

  /* === Test: Verification action (provider not configured) === */
  console.log('\n--- Verify connection (not configured) ---');
  const verifyRes = await postJson('/api/settings/verify-connection', {}, cookie);
  check('52. Verify returns 409 when not configured', verifyRes.status === 409, 'status=' + verifyRes.status);
  check('53. Verify has correct error code', verifyRes.json?.errorCode === 'WHATSAPP_PROVIDER_NOT_CONFIGURED', JSON.stringify(verifyRes.json));

  /* === Test: Verify endpoint source check === */
  console.log('\n--- Verify connection source ---');
  const verifySrc = readSource(path.join(REPO_ROOT, 'apps/server/src/controllers/settings.controller.ts'));
  check('54. Verify uses adapter.verifyConnection', /verifyConnection/.test(verifySrc));
  check('55. Verify does not send message', !/sendText|sendMedia/.test(verifySrc));

  /* === Test: Arbitrary env var modification blocked === */
  console.log('\n--- Arbitrary env modification blocked ---');
  const settingsSrc2 = readSource(path.join(REPO_ROOT, 'apps/server/src/controllers/settings.controller.ts'));
  check('56. No process.env write in controller', !/process\.env\.\w+\s*=/.test(settingsSrc2));
  check('57. No app.set for env vars in controller', !/app\.set\(|req\.app\.set\(/i.test(settingsSrc2));

  /* === Test: Full settings object shape === */
  console.log('\n--- Settings shape ---');
  const requiredSections = ['whatsapp', 'sending', 'scheduler', 'storage', 'system'];
  for (const section of requiredSections) {
    check(`58. ${section} section exists`, section in data, `${section}: ${section in data}`);
  }

  /* === Cleanup === */
  console.log('\n--- Cleanup ---');
  await cleanup();
  check('59. Cleanup completed', true);

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
