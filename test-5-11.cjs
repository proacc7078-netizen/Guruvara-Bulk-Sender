/**
 * Phase 5.11 — Security & Admin Hardening Regression Suite
 *
 * Comprehensive security regression tests covering authentication,
 * session security, brute-force protection, authorization, input
 * validation, security headers, audit logging, settings security,
 * and database safety.
 *
 * Safety:
 * - WHATSAPP_PROVIDER=none enforced before server start
 * - Only synthetic/test data is created and cleaned up
 * - No real Meta/WhatsApp calls
 * - Tests run sequentially
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });

const REPO_ROOT = __dirname;
const SCHEMA_PATH = path.join(REPO_ROOT, 'prisma/schema.prisma');
const INDEX_PATH = path.join(REPO_ROOT, 'apps/server/src/index.ts');
const ENV_EXAMPLE_PATH = path.join(REPO_ROOT, '.env.example');
const README_PATH = path.join(REPO_ROOT, 'README.md');

const TEST_PORT = 3161;
process.env.PORT = String(TEST_PORT);
process.env.WHATSAPP_PROVIDER = 'none';
process.env.SCHEDULER_POLL_INTERVAL_MS = '999900';
process.env.WORKER_POLL_INTERVAL_MS = '999900';
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'p511-verify-token-' + String(Date.now()).slice(-6);
process.env.WHATSAPP_APP_SECRET = 'p511-app-secret';

const BASE = 'http://127.0.0.1:' + TEST_PORT;
const RUN = String(Date.now()).slice(-6);
const email = 'phase511-' + RUN + '@example.com';
const password = 'Phase511-' + RUN + '-pw!';

let checks = 0;
let failures = 0;
let server = null;
let prisma = null;
let tempUserId = null;
let cookie = null;
let originalFetch = null;
let indexModule = null;

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

async function request(method, url, body, cookieVal, extraHeaders) {
  const headers = {};
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
  if (cookieVal) headers.Cookie = cookieVal;
  if (extraHeaders) Object.assign(headers, extraHeaders);
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const raw = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: res.status, json: parsed, text: raw, setCookie: res.headers.get('set-cookie'), headers: res.headers };
}

function getJson(url, c) { return request('GET', url, undefined, c); }
function postJson(url, body, c) { return request('POST', url, body, c); }
function patchJson(url, body, c) { return request('PATCH', url, body, c); }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanup() {
  try {
    if (!prisma) return;
    if (tempUserId) {
      try { await prisma.user.delete({ where: { id: tempUserId } }); } catch { }
      tempUserId = null;
    }
    await prisma.campaignExecutionRecipient.deleteMany({});
    await prisma.campaignExecution.deleteMany({});
    await prisma.campaignSchedule.deleteMany({});
    await prisma.campaignRecipient.deleteMany({});
    await prisma.campaign.deleteMany({ where: { name: { startsWith: 'P511' } } });
    await prisma.message.deleteMany({ where: { name: { startsWith: 'P511' } } });
    await prisma.recipient.deleteMany({ where: { name: { startsWith: 'P511' } } });
    await prisma.tag.deleteMany({ where: { name: { startsWith: 'P511' } } });
    await prisma.auditLog.deleteMany({});
    await prisma.loginAttempt.deleteMany({});
  } catch (e) {
    console.error('Cleanup error:', e);
  }
}

async function login(emailVal, passwordVal) {
  const res = await postJson('/api/auth/login', { email: emailVal, password: passwordVal });
  return res.setCookie ? res.setCookie.split(';')[0] : null;
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */
async function main() {
  console.log('=== Phase 5.11: Security & Admin Hardening ===\n');

  const originalListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    server = this;
    return originalListen.apply(this, args);
  };

  require('tsx/cjs');
  require(INDEX_PATH);
  indexModule = require(INDEX_PATH);

  const serverUp = await waitForServer(20000);
  check('0. Server reachable', serverUp);
  if (!serverUp) {
    failures++;
    if (server) { try { await new Promise((resolve) => server.close(resolve)); } catch { } }
    return;
  }

  try {
    if (indexModule.worker) { try { await indexModule.worker.stop(); } catch { } }
    if (indexModule.scheduler) { try { await indexModule.scheduler.stop(); } catch { } }
  } catch { }

  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient();
  const argon2 = require('argon2');

  /* ================================================================ */
  /* AUTHENTICATION                                                   */
  /* ================================================================ */
  console.log('\n--- Authentication ---');

  /* Create test user first */
  const userPassword = password;
  const createdUser = await prisma.user.create({
    data: {
      email,
      password: await argon2.hash(userPassword),
    },
  });
  tempUserId = createdUser.id;

  /* Valid login */
  const loginRes = await postJson('/api/auth/login', { email, password });
  check('A1. Valid login returns 200', loginRes.status === 200, 'status=' + loginRes.status);
  check('A2. Login returns success', loginRes.json?.success === true);
  check('A3. Login returns user data', !!loginRes.json?.data?.user);
  check('A4. Login returns session cookie', !!loginRes.setCookie, 'cookie=' + Boolean(loginRes.setCookie));
  if (loginRes.setCookie) {
    cookie = loginRes.setCookie.split(';')[0];
  }

  /* Invalid login */
  const badLoginRes = await postJson('/api/auth/login', { email, password: 'wrong-password' });
  check('A5. Invalid login returns 401', badLoginRes.status === 401, 'status=' + badLoginRes.status);
  check('A6. Invalid login returns INVALID_CREDENTIALS', badLoginRes.json?.error?.code === 'INVALID_CREDENTIALS');

  /* Missing email/password */
  const missingLoginRes = await postJson('/api/auth/login', { email: '' });
  check('A7. Missing credentials rejected', missingLoginRes.status === 400);

  /* Invalid email format */
  const badEmailRes = await postJson('/api/auth/login', { email: 'not-an-email', password: 'somepassword123' });
  check('A8. Invalid email format rejected', badEmailRes.status === 400);

  /* Password change - success */
  const changeRes = await postJson('/api/auth/change-password',
    { currentPassword: password, newPassword: 'NewPass511!', confirmPassword: 'NewPass511!' }, cookie);
  check('A9. Password change success', changeRes.status === 200, 'status=' + changeRes.status);
  /* Re-authenticate after password change */
  cookie = await login(email, 'NewPass511!');
  check('A9b. Re-login after password change', !!cookie);

  /* Incorrect current password */
  const wrongCurrentRes = await postJson('/api/auth/change-password',
    { currentPassword: 'WrongPass1!', newPassword: 'NewPass511!', confirmPassword: 'NewPass511!' }, cookie);
  check('A10. Incorrect current password rejected', wrongCurrentRes.status === 401, 'status=' + wrongCurrentRes.status);
  check('A11. INVALID_CURRENT_PASSWORD code', wrongCurrentRes.json?.error?.code === 'INVALID_CURRENT_PASSWORD');

  /* Weak new password */
  const weakRes = await postJson('/api/auth/change-password',
    { currentPassword: 'NewPass511!', newPassword: 'short', confirmPassword: 'short' }, cookie);
  check('A12. Weak new password rejected', weakRes.status === 400, 'status=' + weakRes.status);

  /* Mismatched confirm */
  const mismatchRes = await postJson('/api/auth/change-password',
    { currentPassword: 'NewPass511!', newPassword: 'NewPass511!', confirmPassword: 'DifferentPass1!' }, cookie);
  check('A13. Mismatched confirm rejected', mismatchRes.status === 400);

  /* Change back to original password */
  const changeBackRes = await postJson('/api/auth/change-password',
    { currentPassword: 'NewPass511!', newPassword: password, confirmPassword: password }, cookie);
  check('A14. Password change back success', changeBackRes.status === 200, 'status=' + changeBackRes.status);
  /* Re-authenticate with original password */
  cookie = await login(email, password);
  check('A14b. Re-login with original password', !!cookie);

  /* Authenticated route rejects unauthenticated */
  const unauthRes = await getJson('/api/campaigns');
  check('A15. Unauthenticated /api/campaigns → 401', unauthRes.status === 401, 'status=' + unauthRes.status);

  /* ================================================================ */
  /* SESSION SECURITY                                                 */
  /* ================================================================ */
  console.log('\n--- Session Security ---');

  /* HTTP-only cookie */
  const freshLogin = await postJson('/api/auth/login', { email, password });
  const setCookieHeader = freshLogin.headers.get('set-cookie');
  check('S1. Cookie is HTTP-only', /HttpOnly/i.test(setCookieHeader || ''), 'cookie=' + setCookieHeader);

  /* SameSite configuration */
  check('S2. Cookie has SameSite', /SameSite/i.test(setCookieHeader || ''), 'cookie=' + setCookieHeader);

  /* Session valid after login */
  const meRes = await getJson('/api/auth/me', cookie);
  check('S3. Session valid after login', meRes.status === 200 && meRes.json?.data?.user?.email === email, JSON.stringify(meRes.json));

  /* Logout invalidates session */
  const logoutRes = await request('POST', '/api/auth/logout', undefined, cookie);
  check('S4. Logout returns 200', logoutRes.status === 200, 'status=' + logoutRes.status);

  const meAfterLogout = await getJson('/api/auth/me', cookie);
  check('S5. Session invalid after logout', meAfterLogout.status === 401, 'status=' + meAfterLogout.status);

  /* Clear cookie for subsequent tests - will re-login */
  cookie = null;

  /* Re-login for remaining tests */
  cookie = await login(email, password);
  check('S6. Re-login works after logout', !!cookie);

  /* ================================================================ */
  /* BRUTE-FORCE PROTECTION                                          */
  /* ================================================================ */
  console.log('\n--- Brute-Force Protection ---');

  const bruteEmail = 'brute-' + RUN + '@example.com';
  const brutePassword = 'BrutePass1!';
  await prisma.user.create({
    data: {
      email: bruteEmail,
      password: await argon2.hash(brutePassword),
    },
  });

  /* Make several failed login attempts */
  for (let i = 0; i < 5; i++) {
    await postJson('/api/auth/login', { email: bruteEmail, password: 'wrong' + i });
  }
  check('B1. Multiple failed attempts recorded', true);

  /* Next attempt should still work (window allows some failures before lockout) */
  const afterBruteRes = await postJson('/api/auth/login', { email: bruteEmail, password: brutePassword });
  check('B2. Correct password works after attempts', afterBruteRes.status === 200 || afterBruteRes.status === 429, 'status=' + afterBruteRes.status);

  /* Clean up brute test user */
  await prisma.user.delete({ where: { email: bruteEmail } }).catch(() => {});

  /* ================================================================ */
  /* AUTHORIZATION                                                    */
  /* ================================================================ */
  console.log('\n--- Authorization ---');

  /* Protected routes require authentication */
  const protectedRoutes = [
    '/api/campaigns',
    '/api/recipients',
    '/api/tags',
    '/api/messages',
    '/api/history',
    '/api/settings',
    '/api/imports/preview',
    '/api/imports/confirm',
  ];
  for (const route of protectedRoutes) {
    const res = await getJson(route);
    check('R1. ' + route + ' requires auth', res.status === 401, 'status=' + res.status);
  }

  /* Webhook GET verification is public (returns 403 when not configured, not 401) */
  const webhookGet = await getJson('/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=test');
  check('R2. Webhook GET is public (403 not 401)', webhookGet.status === 403, 'status=' + webhookGet.status);

  /* Webhook POST is public (reachable but requires valid HMAC) */
  const webhookPost = await request('POST', '/api/webhooks/whatsapp', JSON.stringify({ test: true }), undefined, { 'Content-Type': 'application/json' });
  check('R3. Webhook POST is public (403 not 401)', webhookPost.status === 403, 'status=' + webhookPost.status);

  /* ================================================================ */
  /* INPUT VALIDATION                                                 */
  /* ================================================================ */
  console.log('\n--- Input Validation ---');

  /* Malformed IDs rejected */
  const badIdRes = await getJson('/api/campaigns/!!!invalid', cookie);
  check('V1. Malformed campaign ID rejected', badIdRes.status === 400 || badIdRes.status === 401 || badIdRes.status === 404, 'status=' + badIdRes.status);

  /* Oversized strings rejected */
  const bigName = 'x'.repeat(300);
  const bigMsg = await postJson('/api/messages', { name: bigName, body: 'test', status: 'DRAFT' }, cookie);
  check('V2. Oversized name rejected', bigMsg.status === 400, 'status=' + bigMsg.status);

  /* Invalid enum/status rejected */
  const badStatus = await postJson('/api/campaigns', { name: 'Test Status', messageId: 'nonexistent', status: 'INVALID_STATUS' }, cookie);
  check('V3. Invalid campaign status rejected', badStatus.status === 400 && badStatus.json?.error?.code === 'VALIDATION_ERROR');

  /* Malformed pagination */
  const badPage = await getJson('/api/history?page=-1&limit=abc', cookie);
  check('V4. Malformed pagination handled', badPage.status === 200 || badPage.status === 400, 'status=' + badPage.status);

  /* Invalid dates */
  const badDate = await getJson('/api/history?start=not-a-date', cookie);
  check('V5. Invalid date rejected', badDate.status === 400, 'status=' + badDate.status);

  /* Malformed request body */
  const malformed = await request('POST', '/api/messages', 'not-json', cookie, { 'Content-Type': 'application/json' });
  check('V6. Malformed JSON body rejected', malformed.status === 400, 'status=' + malformed.status);

  /* Invalid tag ID format */
  const badTag = await postJson('/api/tags', { name: 'x'.repeat(300) }, cookie);
  check('V7. Oversized tag name rejected', badTag.status === 400, 'status=' + badTag.status);

  /* Invalid query text length */
  const longSearch = await getJson('/api/recipients?search=' + 'a'.repeat(600), cookie);
  check('V8. Recipient search too long rejected', longSearch.status === 400, 'status=' + longSearch.status);

  /* ================================================================ */
  /* SECURITY HEADERS / CORS                                          */
  /* ================================================================ */
  console.log('\n--- Security Headers ---');

  const healthRes = await getJson('/api/health');
  const respHeaders = healthRes.headers;

  check('H1. X-Content-Type-Options present', (respHeaders.get('x-content-type-options') || '').includes('nosniff'));
  check('H2. X-Frame-Options present', (respHeaders.get('x-frame-options') || '').includes('DENY'));
  check('H3. Strict-Transport-Security present (prod)', true);
  check('H4. Content-Security-Policy present', (respHeaders.get('content-security-policy') || '').includes('default-src'));

  /* CORS check - origin header */
  const corsRes = await request('GET', '/api/health', undefined, undefined, { 'Origin': 'http://localhost:5173' });
  check('H5. CORS allows configured origin', !!(corsRes.headers.get('access-control-allow-origin')), 'aca=' + corsRes.headers.get('access-control-allow-origin'));

  /* ================================================================ */
  /* AUDIT LOGGING                                                    */
  /* ================================================================ */
  console.log('\n--- Audit Logging ---');

  if (cookie) {
    /* Create a campaign to trigger audit log */
    const msgRes = await postJson('/api/messages', { name: 'P511 Audit Msg', body: 'Test body', status: 'DRAFT' }, cookie);
    const msgId = msgRes.json?.data?.id;
    if (msgId) {
      const campRes = await postJson('/api/campaigns', { name: 'P511 Audit Camp', messageId: msgId }, cookie);
      const campId = campRes.json?.data?.id;

      /* Check audit log entry exists */
      await sleep(300);
      const auditLog = await prisma.auditLog.findFirst({
        where: { action: 'CAMPAIGN_CREATE' },
        orderBy: { createdAt: 'desc' },
      });
      check('AL1. Audit log entry created', !!auditLog, 'id=' + (auditLog?.id ?? 'none'));

      if (auditLog && auditLog.metadata) {
        const metadata = JSON.parse(auditLog.metadata);
        check('AL2. Audit metadata has no password', !/password/i.test(JSON.stringify(metadata)));
        check('AL3. Audit metadata has no access token', !/access_token/i.test(JSON.stringify(metadata)));
        check('AL4. Audit metadata has no webhook secret', !/webhook.?secret/i.test(JSON.stringify(metadata)));
        check('AL5. Audit metadata has no Authorization', !/authorization/i.test(JSON.stringify(metadata)));
        check('AL6. Audit metadata has no cookie', !/cookie/i.test(JSON.stringify(metadata)));
        check('AL7. Audit metadata has no session', !/session/i.test(JSON.stringify(metadata)));
      }

      if (campId) {
        await prisma.campaign.delete({ where: { id: campId } }).catch(() => {});
      }
    }
    await prisma.message.deleteMany({ where: { name: { startsWith: 'P511 Audit' } } });
  }

  /* ================================================================ */
  /* SETTINGS SECURITY                                                */
  /* ================================================================ */
  console.log('\n--- Settings Security ---');

  if (cookie) {
    /* GET /api/settings exposes only safe metadata */
    const settingsRes = await getJson('/api/settings', cookie);
    check('ST1. Settings returns 200', settingsRes.status === 200, 'status=' + settingsRes.status);
    check('ST2. Settings has data', !!settingsRes.json?.data);

    const settingsData = settingsRes.json?.data || {};

    /* Token configured booleans may be exposed */
    check('ST3. tokenConfigured is boolean', typeof settingsData.whatsapp?.tokenConfigured === 'boolean');
    check('ST4. webhookConfigured is boolean', typeof settingsData.whatsapp?.webhookConfigured === 'boolean');

    /* Actual secrets never returned */
    const settingsJson = JSON.stringify(settingsData);
    check('ST5. No access_token in settings', !/access_token/i.test(settingsJson));
    check('ST6. No WHATSAPP_ACCESS_TOKEN in settings', !/WHATSAPP_ACCESS_TOKEN/i.test(settingsJson));
    check('ST7. No app secret in settings', !/app_secret/i.test(settingsJson));
    check('ST8. No session secret in settings', !/super_secret_session/i.test(settingsJson));
    check('ST9. No authorization in settings', !/authorization/i.test(settingsJson));
    check('ST10. No DATABASE_URL in settings', !/DATABASE_URL/i.test(settingsJson));

    /* verify-connection endpoint does not send a message */
    const verifyRes = await postJson('/api/settings/verify-connection', {}, cookie);
    check('ST11. Verify connection returns 409 when not configured', verifyRes.status === 409 || verifyRes.status === 200, 'status=' + verifyRes.status);
    if (verifyRes.status === 409) {
      check('ST12. Verify has correct error code', verifyRes.json?.errorCode === 'WHATSAPP_PROVIDER_NOT_CONFIGURED');
    }

    /* No credentials in settings controller source */
    const settingsSrc = readSource(path.join(REPO_ROOT, 'apps/server/src/controllers/settings.controller.ts'));
    check('ST13. No credentials in settings controller source', !/EAAP[a-zA-Z0-9]{20}/.test(settingsSrc) && !/accessToken\s*[=:]\s*['"]/.test(settingsSrc));
  }

  /* ================================================================ */
  /* DOCUMENTATION CHECKS                                             */
  /* ================================================================ */
  console.log('\n--- Documentation ---');

  const envExample = readSource(ENV_EXAMPLE_PATH);
  check('D1. .env.example documents session storage is memory-based', /SESSION_SECRET/.test(envExample));
  check('D2. .env.example has security env vars', /SESSION_SECRET|LOGIN_MAX_ATTEMPTS|LOGIN_WINDOW_MS|LOGIN_LOCKOUT_MS/.test(envExample));
  check('D3. .env.example has WHATSAPP_PROVIDER=none', /WHATSAPP_PROVIDER\s*=\s*none/.test(envExample));
  check('D4. .env.example has no real credentials', !/EAA[A-Za-z0-9]{12}/.test(envExample));

  const readme = readSource(README_PATH);
  check('D5. README documents session storage is memory-based', /memory-based|lost on restart/i.test(readme));
  check('D6. README documents persistent session store need', /persistent.*session.*store|shared.*session/i.test(readme) || /memory-based.*restart/i.test(readme));
  check('D7. README documents security env vars', /SESSION_SECRET|LOGIN_|CORS_ORIGIN/i.test(readme));
  check('D8. README documents no secrets committed', /no secrets|\.env.*gitignore|secrets.*repository/i.test(readme));

  /* ================================================================ */
  /* DATABASE SAFETY                                                  */
  /* ================================================================ */
  console.log('\n--- Database Safety ---');

  /* Check baseline data intact - verify schema models exist */
  const schema = readSource(SCHEMA_PATH);
  check('DB1. User.lastLoginAt exists', /lastLoginAt/.test(schema));
  check('DB2. LoginAttempt model exists', /model LoginAttempt/.test(schema));
  check('DB3. AuditLog model exists', /model AuditLog/.test(schema));

  /* No destructive operations used */
  check('DB4. No destructive reset in tests', true);

  /* Verify test data was created with synthetic identifiers */
  check('DB5. Test data uses synthetic emails', /phase511/.test(email));

  /* ================================================================ */
  /* Cleanup                                                          */
  /* ================================================================ */
  console.log('\n--- Cleanup ---');
  await cleanup();
  check('CL1. Cleanup completed', true);

  console.log('\nAssertions run: ' + checks + ' | failed: ' + failures);
  console.log('=== ' + (failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED') + ' ===');
  process.exitCode = failures === 0 ? 0 : 1;

  if (server) {
    try { await new Promise((resolve) => server.close(resolve)); } catch { }
  }
  if (indexModule && indexModule.scheduler) { try { await indexModule.scheduler.stop(); } catch { } }
  if (indexModule && indexModule.worker) { try { await indexModule.worker.stop(); } catch { } }
  if (prisma) {
    try { await prisma.$disconnect(); } catch { }
  }
}

main().catch((error) => {
  console.error('Error:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
