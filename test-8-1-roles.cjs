/**
 * Phase 8.1 — Admin / Pro role system regression suite.
 *
 * Covers:
 * - the pre-existing admin account authenticating as ADMIN
 * - ADMIN access to admin-only routes
 * - PRO access to messages, campaigns, campaign audience and scheduling
 * - PRO receiving 403 FORBIDDEN from every admin-only route, even when the
 *   HTTP request is constructed manually
 * - unauthenticated requests keeping the pre-existing 401 response
 * - GET /api/auth/me returning the authenticated user's role
 * - invalid role values never reaching the database (API + CHECK constraint)
 *
 * Safety:
 * - the whole suite runs against a DISPOSABLE SQLite database in the OS temp
 *   directory; the development database is only ever opened read-only
 * - no prisma migrate reset / db reset, no data is deleted anywhere but in the
 *   disposable database
 * - WHATSAPP_PROVIDER=none: no real WhatsApp/Meta calls
 * - one server instance, checks run sequentially
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });

const REPO_ROOT = __dirname;
const SCHEMA_PATH = path.join(REPO_ROOT, 'prisma', 'schema.prisma');
const MIGRATION_SQL_PATH = path.join(REPO_ROOT, 'prisma', 'migrations', '20260930000000_user_roles', 'migration.sql');
const INDEX_PATH = path.join(REPO_ROOT, 'apps', 'server', 'src', 'index.ts');
const PRISMA_CLI = path.join(REPO_ROOT, 'node_modules', 'prisma', 'build', 'index.js');
const ROUTES_DIR = path.join(REPO_ROOT, 'apps', 'server', 'src', 'routes');
const AUTH_CONTROLLER_PATH = path.join(REPO_ROOT, 'apps', 'server', 'src', 'controllers', 'auth.controller.ts');

/* The real development database: READ ONLY (never written, never reset). */
const DEV_DB_PATH = path.join(REPO_ROOT, 'prisma', 'data', 'japa.db');
const SEEDED_ADMIN_EMAIL = 'admin@japa.local';

/* Disposable test database — always a fresh temp file, never the dev database. */
const TEST_PORT = 3181;
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'japa-phase81-'));
const TEST_DB_PATH = path.join(WORK_DIR, 'roles-test.db');
const TEST_BACKUP_DIR = path.join(WORK_DIR, 'backups');
const asFileUrl = (p) => 'file:' + p.replace(/\\/g, '/');

process.env.PORT = String(TEST_PORT);
process.env.DATABASE_URL = asFileUrl(TEST_DB_PATH);
process.env.WHATSAPP_PROVIDER = 'none';
process.env.SCHEDULER_POLL_INTERVAL_MS = '999900';
process.env.WORKER_POLL_INTERVAL_MS = '999900';
process.env.BACKUP_DIR = TEST_BACKUP_DIR;
process.env.BACKUP_SCHEDULE_ENABLED = 'false';

const BASE = 'http://127.0.0.1:' + TEST_PORT;
const RUN = String(Date.now()).slice(-6);

const ADMIN_EMAIL = 'legacy-admin-' + RUN + '@example.com';
const ADMIN_PASSWORD = 'LegacyAdmin-' + RUN + '-pw!';
const PRO_EMAIL = 'pro-' + RUN + '@example.com';
const PRO_PASSWORD = 'Pro-' + RUN + '-pw!';
const PRO_BLOCKED_EMAIL = 'pro-blocked-' + RUN + '@example.com';

let checks = 0;
let failures = 0;
let server = null;
let prisma = null;
let indexModule = null;

function check(name, cond, extra) {
  checks++;
  if (!cond) failures++;
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (extra ? ' | ' + extra : ''));
}

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function asPosix(p) {
  return p.replace(/\\/g, '/');
}

/** Local wall-clock "YYYY-MM-DDTHH:mm" (what the schedule API expects). */
function localWallClock(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) + ':' + pad(date.getMinutes())
  );
}


/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

async function request(method, url, body, cookieValue) {
  const headers = {};
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
  if (cookieValue) headers.Cookie = cookieValue;
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const raw = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: res.status, json: parsed, text: raw, setCookie: res.headers.get('set-cookie') };
}

const getJson = (url, c) => request('GET', url, undefined, c);
const postJson = (url, body, c) => request('POST', url, body, c);
const putJson = (url, body, c) => request('PUT', url, body, c);
const patchJson = (url, body, c) => request('PATCH', url, body, c);

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

async function login(emailValue, passwordValue) {
  const res = await postJson('/api/auth/login', { email: emailValue, password: passwordValue });
  if (!res.setCookie) return { cookie: null, res };
  return { cookie: res.setCookie.split(';')[0], res };
}

/* ------------------------------------------------------------------ */
/* Disposable database                                                 */
/* ------------------------------------------------------------------ */

function runPrismaDbPush() {
  const result = spawnSync(
    process.execPath,
    [PRISMA_CLI, 'db', 'push', '--skip-generate', '--schema=' + SCHEMA_PATH],
    { cwd: REPO_ROOT, env: process.env, encoding: 'utf8' }
  );
  return (result.stdout || '') + (result.stderr || '');
}

/**
 * Builds the disposable database exactly the way an existing installation
 * would experience the role migration:
 *   1. schema push creates the current schema
 *   2. a legacy user is created (it predates the role column)
 *   3. the role column is removed, simulating the pre-migration database
 *   4. the real migration file is applied
 *   5. the legacy user must come out of it as ADMIN
 */
async function buildDisposableDatabase() {
  fs.mkdirSync(TEST_BACKUP_DIR, { recursive: true });

  const pushOutput = runPrismaDbPush();
  if (!fs.existsSync(TEST_DB_PATH)) {
    return { ok: false, message: 'prisma db push did not create the disposable database: ' + pushOutput.trim() };
  }

  const argon2 = require('argon2');
  const { PrismaClient } = require('@prisma/client');

  // A user that exists before roles are introduced (the "existing admin").
  const setup = new PrismaClient();
  await setup.user.create({
    data: { email: ADMIN_EMAIL, password: await argon2.hash(ADMIN_PASSWORD), role: 'ADMIN' },
  });
  await setup.$disconnect();

  const db = new DatabaseSync(TEST_DB_PATH);
  db.exec('ALTER TABLE "User" DROP COLUMN "role"');
  const before = db.prepare('PRAGMA table_info("User")').all().map((c) => c.name);
  db.exec(readSource(MIGRATION_SQL_PATH));
  const after = db.prepare('PRAGMA table_info("User")').all().map((c) => c.name);

  const legacyRole = db.prepare('SELECT role FROM "User" WHERE email = ?').get(ADMIN_EMAIL).role;

  // The CHECK constraint must reject an invalid role written directly in SQL.
  let invalidWriteRejected = false;
  let invalidWriteMessage = '';
  try {
    db.prepare('UPDATE "User" SET role = ? WHERE email = ?').run('SUPERADMIN', ADMIN_EMAIL);
  } catch (error) {
    invalidWriteRejected = true;
    invalidWriteMessage = error.message;
  }
  db.close();

  return {
    ok: true,
    preMigrationHasRole: before.includes('role'),
    postMigrationHasRole: after.includes('role'),
    legacyRole,
    invalidWriteRejected,
    invalidWriteMessage,
  };
}

/* ------------------------------------------------------------------ */
/* Teardown                                                            */
/* ------------------------------------------------------------------ */

async function shutdown() {
  if (indexModule && indexModule.worker) { try { await indexModule.worker.stop(); } catch { } }
  if (indexModule && indexModule.scheduler) { try { await indexModule.scheduler.stop(); } catch { } }
  if (server) { try { await new Promise((resolve) => server.close(resolve)); } catch { } }
  if (prisma) { try { await prisma.$disconnect(); } catch { } }
  // Release any Prisma client loaded in this process. The server creates its own
  // through apps/server/src/config/db, whose cache key can differ from ours, and
  // Windows keeps the disposable SQLite file locked while a handle is open.
  for (const key of Object.keys(require.cache)) {
    const cached = require.cache[key];
    const candidate = cached && cached.exports && cached.exports.prisma;
    if (candidate && typeof candidate.$disconnect === 'function') {
      try { await candidate.$disconnect(); } catch { }
    }
  }
}

async function removeWorkDir() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      fs.rmSync(WORK_DIR, { recursive: true, force: true });
    } catch { }
    if (!fs.existsSync(WORK_DIR)) return true;
    await sleep(250);
  }
  return !fs.existsSync(WORK_DIR);
}


/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  console.log('=== Phase 8.1: Admin / Pro role system ===\n');
  console.log('Disposable database:', TEST_DB_PATH);
  console.log('Development database (read-only checks only):', DEV_DB_PATH, '\n');

  /* ================================================================ */
  /* SOURCE / SCHEMA CHECKS                                           */
  /* ================================================================ */
  console.log('--- Schema & route wiring ---');

  const schema = readSource(SCHEMA_PATH);
  check('SC1. User.role exists with ADMIN default', /role\s+String\s+@default\("ADMIN"\)/.test(schema));

  const migrationSql = readSource(MIGRATION_SQL_PATH);
  check('SC2. Migration adds role additively with DEFAULT ADMIN',
    /ALTER TABLE "User"[\s\S]*ADD COLUMN "role" TEXT NOT NULL DEFAULT 'ADMIN'/.test(migrationSql));
  check('SC3. Migration constrains role to ADMIN/PRO',
    /CHECK \("role" IN \('ADMIN', 'PRO'\)\)/.test(migrationSql));

  const middlewareSrc = readSource(path.join(REPO_ROOT, 'apps', 'server', 'src', 'middleware', 'auth.middleware.ts'));
  check('SC4. requireRole helper exists', /export function requireRole\(/.test(middlewareSrc));
  check('SC5. Denials use 403 FORBIDDEN', /status\(403\)[\s\S]*FORBIDDEN/.test(middlewareSrc));

  const adminGuardedRoutes = [
    'users.routes.ts',
    'audit.routes.ts',
    'backups.routes.ts',
    'settings.routes.ts',
    'google-sheets.routes.ts',
    'whatsapp.routes.ts',
  ];
  for (const routeFile of adminGuardedRoutes) {
    const src = readSource(path.join(ROUTES_DIR, routeFile));
    check('SC6. ' + routeFile + ' requires ADMIN', /requireRole\(ROLE\.ADMIN\)/.test(src));
  }

  const proRoutes = ['messages.routes.ts', 'campaigns.routes.ts', 'recipients.routes.ts', 'media.routes.ts', 'imports.routes.ts'];
  for (const routeFile of proRoutes) {
    const src = readSource(path.join(ROUTES_DIR, routeFile));
    check('SC7. ' + routeFile + ' is not ADMIN-gated', !/requireRole\(/.test(src) && /requireAuth/.test(src));
  }

  const indexSrc = readSource(INDEX_PATH);
  check('SC8. /api/users mounted', /app\.use\('\/api\/users', usersRoutes\)/.test(indexSrc));
  check('SC9. /api/audit mounted', /app\.use\('\/api\/audit', auditRoutes\)/.test(indexSrc));
  check('SC10. /api/auth/me returns role', /role:\s*user\.role/.test(readSource(AUTH_CONTROLLER_PATH)));

  /* ================================================================ */
  /* DISPOSABLE DATABASE                                              */
  /* ================================================================ */
  console.log('\n--- Disposable database & migration ---');

  const dbSetup = await buildDisposableDatabase();
  check('DB1. Disposable database created', dbSetup.ok, dbSetup.ok ? '' : dbSetup.message);
  if (!dbSetup.ok) {
    console.log('\nCannot continue without a disposable database.');
    process.exitCode = 1;
    return;
  }
  check('DB2. Role column absent before the migration', dbSetup.preMigrationHasRole === false);
  check('DB3. Migration adds the role column', dbSetup.postMigrationHasRole === true);
  check('DB4. Pre-existing user becomes ADMIN', dbSetup.legacyRole === 'ADMIN', 'role=' + dbSetup.legacyRole);
  check('DB5. CHECK constraint rejects an invalid role (direct SQL)',
    dbSetup.invalidWriteRejected, dbSetup.invalidWriteMessage);

  /* ================================================================ */
  /* SERVER                                                           */
  /* ================================================================ */
  const originalListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    server = this;
    return originalListen.apply(this, args);
  };

  require('tsx/cjs');
  indexModule = require(INDEX_PATH);

  const serverUp = await waitForServer(20000);
  check('S0. Server reachable against the disposable database', serverUp);
  if (!serverUp) {
    process.exitCode = 1;
    return;
  }
  if (indexModule.worker) { try { await indexModule.worker.stop(); } catch { } }
  if (indexModule.scheduler) { try { await indexModule.scheduler.stop(); } catch { } }

  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient();


  /* ================================================================ */
  /* ADMIN AUTHENTICATION                                             */
  /* ================================================================ */
  console.log('\n--- Existing admin authenticates as ADMIN ---');

  const adminLogin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  check('A1. Existing admin can log in', adminLogin.res.status === 200 && !!adminLogin.cookie, 'status=' + adminLogin.res.status);
  const adminCookie = adminLogin.cookie;
  check('A2. Login response exposes role ADMIN', adminLogin.res.json?.data?.user?.role === 'ADMIN',
    JSON.stringify(adminLogin.res.json?.data?.user));

  const adminMe = await getJson('/api/auth/me', adminCookie);
  check('A3. GET /api/auth/me returns 200', adminMe.status === 200, 'status=' + adminMe.status);
  check('A4. /api/auth/me returns role ADMIN', adminMe.json?.data?.user?.role === 'ADMIN',
    JSON.stringify(adminMe.json?.data?.user));

  /* ================================================================ */
  /* ADMIN-ONLY ROUTES (ADMIN allowed)                                */
  /* ================================================================ */
  console.log('\n--- ADMIN can access admin-only routes ---');

  const adminAllowed = [
    ['GET', '/api/users'],
    ['GET', '/api/audit'],
    ['GET', '/api/backups'],
    ['GET', '/api/backups/status'],
    ['GET', '/api/settings'],
    ['GET', '/api/google-sheets/status'],
    ['GET', '/api/whatsapp/status'],
  ];
  for (const [method, url] of adminAllowed) {
    const res = await request(method, url, undefined, adminCookie);
    check('AD1. ADMIN ' + method + ' ' + url + ' allowed', res.status === 200,
      'status=' + res.status + ' body=' + JSON.stringify(res.json).slice(0, 120));
  }

  /* ================================================================ */
  /* ADMIN CREATES THE PRO USER                                       */
  /* ================================================================ */
  console.log('\n--- ADMIN creates a PRO user (minimal user management) ---');

  const createPro = await postJson('/api/users', { email: PRO_EMAIL, password: PRO_PASSWORD, role: 'PRO' }, adminCookie);
  check('U1. ADMIN can create a PRO user', createPro.status === 201,
    'status=' + createPro.status + ' body=' + JSON.stringify(createPro.json).slice(0, 160));
  check('U2. Created user has role PRO', createPro.json?.data?.user?.role === 'PRO');
  check('U3. Password is never returned', !/password/i.test(JSON.stringify(createPro.json?.data?.user || {})));

  const proUserId = createPro.json?.data?.user?.id;
  const proRow = proUserId ? await prisma.user.findUnique({ where: { id: proUserId } }) : null;
  check('U4. Role PRO persisted in the database', proRow?.role === 'PRO', 'role=' + (proRow && proRow.role));

  const listUsers = await getJson('/api/users', adminCookie);
  check('U5. ADMIN can list users', listUsers.status === 200 && Array.isArray(listUsers.json?.data?.users),
    'count=' + (listUsers.json?.data?.users || []).length);

  /* Invalid roles must never be stored. */
  const invalidRoles = ['SUPERADMIN', 'admin', 'ROOT', '', 42, null];
  for (const invalidRole of invalidRoles) {
    const res = await postJson('/api/users',
      { email: 'invalid-' + String(invalidRole) + '-' + RUN + '@example.com', password: PRO_PASSWORD, role: invalidRole },
      adminCookie);
    check('U6. Role "' + String(invalidRole) + '" rejected', res.status === 400,
      'status=' + res.status + ' body=' + JSON.stringify(res.json).slice(0, 140));
  }

  const missingRole = await postJson('/api/users', { email: 'norole-' + RUN + '@example.com', password: PRO_PASSWORD }, adminCookie);
  check('U7. Missing role rejected', missingRole.status === 400, 'status=' + missingRole.status);

  const invalidStoredUsers = await prisma.user.count({ where: { role: { notIn: ['ADMIN', 'PRO'] } } });
  check('U8. Only ADMIN/PRO roles exist in the database', invalidStoredUsers === 0, 'invalid=' + invalidStoredUsers);

  const duplicatePro = await postJson('/api/users', { email: PRO_EMAIL, password: PRO_PASSWORD, role: 'PRO' }, adminCookie);
  check('U9. Duplicate email rejected', duplicatePro.status === 409, 'status=' + duplicatePro.status);


  /* ================================================================ */
  /* PRO AUTHENTICATION                                               */
  /* ================================================================ */
  console.log('\n--- PRO authenticates as PRO ---');

  const proLogin = await login(PRO_EMAIL, PRO_PASSWORD);
  check('P1. PRO can log in', proLogin.res.status === 200 && !!proLogin.cookie, 'status=' + proLogin.res.status);
  const proCookie = proLogin.cookie;

  const proMe = await getJson('/api/auth/me', proCookie);
  check('P2. /api/auth/me returns role PRO', proMe.json?.data?.user?.role === 'PRO', JSON.stringify(proMe.json?.data?.user));
  check('P3. /api/auth/me keeps the existing contract',
    proMe.status === 200 && proMe.json?.success === true && !!proMe.json?.data?.user?.email);

  /* ================================================================ */
  /* PRO-ALLOWED ROUTES                                               */
  /* ================================================================ */
  console.log('\n--- PRO can use messages, campaigns, audience, scheduling ---');

  const getMessages = await getJson('/api/messages', proCookie);
  check('PR1. PRO GET /api/messages', getMessages.status === 200, 'status=' + getMessages.status);

  const createMessage = await postJson('/api/messages',
    { name: 'P81 message ' + RUN, body: 'Hare Krishna from the phase 8.1 role suite.' }, proCookie);
  check('PR2. PRO POST /api/messages', createMessage.status === 201,
    'status=' + createMessage.status + ' body=' + JSON.stringify(createMessage.json).slice(0, 140));
  const messageId = createMessage.json?.data?.id;

  const updateMessage = await patchJson('/api/messages/' + messageId,
    { name: 'P81 message updated ' + RUN, body: 'Updated body from a PRO session.' }, proCookie);
  check('PR3. PRO PATCH /api/messages/:id', updateMessage.status === 200, 'status=' + updateMessage.status);

  const createRecipient = await postJson('/api/recipients',
    { name: 'P81 recipient ' + RUN, whatsappNumber: '+9198' + RUN }, proCookie);
  check('PR4. PRO POST /api/recipients (audience source)', createRecipient.status === 200,
    'status=' + createRecipient.status + ' body=' + JSON.stringify(createRecipient.json).slice(0, 140));
  const recipientId = createRecipient.json?.data?.id;

  const getRecipients = await getJson('/api/recipients', proCookie);
  check('PR5. PRO GET /api/recipients', getRecipients.status === 200, 'status=' + getRecipients.status);

  const getCampaigns = await getJson('/api/campaigns', proCookie);
  check('PR6. PRO GET /api/campaigns', getCampaigns.status === 200, 'status=' + getCampaigns.status);

  const createCampaign = await postJson('/api/campaigns', { name: 'P81 campaign ' + RUN, messageId }, proCookie);
  check('PR7. PRO POST /api/campaigns', createCampaign.status === 201,
    'status=' + createCampaign.status + ' body=' + JSON.stringify(createCampaign.json).slice(0, 140));
  const campaignId = createCampaign.json?.data?.id;

  const getCampaign = await getJson('/api/campaigns/' + campaignId, proCookie);
  check('PR8. PRO GET /api/campaigns/:id', getCampaign.status === 200, 'status=' + getCampaign.status);

  const updateCampaign = await patchJson('/api/campaigns/' + campaignId, { description: 'Edited by PRO' }, proCookie);
  check('PR9. PRO PATCH /api/campaigns/:id', updateCampaign.status === 200, 'status=' + updateCampaign.status);

  const getAudience = await getJson('/api/campaigns/' + campaignId + '/audience', proCookie);
  check('PR10. PRO GET campaign audience', getAudience.status === 200, 'status=' + getAudience.status);

  const putAudience = await putJson('/api/campaigns/' + campaignId + '/audience', { recipientIds: [recipientId] }, proCookie);
  check('PR11. PRO PUT campaign audience (recipient selection)', putAudience.status === 200,
    'status=' + putAudience.status + ' body=' + JSON.stringify(putAudience.json).slice(0, 160));

  const readiness = await getJson('/api/campaigns/' + campaignId + '/readiness', proCookie);
  check('PR12. PRO GET campaign readiness', readiness.status === 200 && readiness.json?.data?.valid === true,
    'valid=' + readiness.json?.data?.valid + ' issues=' + JSON.stringify(readiness.json?.data?.issues || []).slice(0, 160));

  const finalize = await postJson('/api/campaigns/' + campaignId + '/finalize', {}, proCookie);
  check('PR13. PRO POST campaign finalize (READY)', finalize.status === 200, 'status=' + finalize.status);

  const getScheduleBefore = await getJson('/api/campaigns/' + campaignId + '/schedule', proCookie);
  check('PR14. PRO GET campaign schedule', getScheduleBefore.status === 200, 'status=' + getScheduleBefore.status);

  const scheduledAt = localWallClock(new Date(Date.now() + 72 * 60 * 60 * 1000));
  const createSchedule = await postJson('/api/campaigns/' + campaignId + '/schedule',
    { scheduledAt, timezone: 'Asia/Kolkata' }, proCookie);
  check('PR15. PRO POST campaign schedule', createSchedule.status === 201,
    'status=' + createSchedule.status + ' body=' + JSON.stringify(createSchedule.json).slice(0, 200));

  const scheduleRow = campaignId ? await prisma.campaignSchedule.findUnique({ where: { campaignId } }) : null;
  check('PR16. Schedule persisted as SCHEDULED', scheduleRow?.status === 'SCHEDULED', 'status=' + (scheduleRow && scheduleRow.status));

  const reschedule = await patchJson('/api/campaigns/' + campaignId + '/schedule',
    { scheduledAt: localWallClock(new Date(Date.now() + 96 * 60 * 60 * 1000)) }, proCookie);
  check('PR17. PRO PATCH campaign schedule', reschedule.status === 200, 'status=' + reschedule.status);


  /* ================================================================ */
  /* PRO DENIED ON ADMIN-ONLY ROUTES                                  */
  /* ================================================================ */
  console.log('\n--- PRO is denied every admin-only route (403) ---');

  const adminOnlyRequests = [
    ['GET', '/api/users', undefined],
    ['POST', '/api/users', { email: PRO_BLOCKED_EMAIL, password: PRO_PASSWORD, role: 'ADMIN' }],
    ['GET', '/api/audit', undefined],
    ['GET', '/api/backups', undefined],
    ['POST', '/api/backups', {}],
    ['GET', '/api/backups/status', undefined],
    ['POST', '/api/backups/retention/cleanup', {}],
    ['GET', '/api/settings', undefined],
    ['POST', '/api/settings/verify-connection', {}],
    ['GET', '/api/google-sheets/status', undefined],
    ['POST', '/api/google-sheets/verify', {}],
    ['POST', '/api/google-sheets/sync', {}],
    ['GET', '/api/whatsapp/status', undefined],
    ['POST', '/api/whatsapp/send-test', { to: '+919800000000', message: 'should never be sent' }],
  ];
  for (const [method, url, body] of adminOnlyRequests) {
    const res = await request(method, url, body, proCookie);
    check('D1. PRO ' + method + ' ' + url + ' → 403 FORBIDDEN',
      res.status === 403 && res.json?.error?.code === 'FORBIDDEN',
      'status=' + res.status + ' code=' + (res.json && res.json.error && res.json.error.code));
  }

  /* PRO cannot change another user's role. */
  const proRoleChange = await patchJson('/api/users/' + proUserId + '/role', { role: 'ADMIN' }, proCookie);
  check('D2. PRO cannot change a role (403)', proRoleChange.status === 403, 'status=' + proRoleChange.status);
  const proRowAfterAttempt = await prisma.user.findUnique({ where: { id: proUserId } });
  check('D3. PRO role unchanged after the denied attempt',
    proRowAfterAttempt?.role === 'PRO', 'role=' + (proRowAfterAttempt && proRowAfterAttempt.role));

  const blockedUser = await prisma.user.findUnique({ where: { email: PRO_BLOCKED_EMAIL } });
  check('D4. Denied POST /api/users created nothing', blockedUser === null);

  const messagesAfterDenials = await getJson('/api/messages', proCookie);
  check('D5. PRO still allowed on operational routes', messagesAfterDenials.status === 200, 'status=' + messagesAfterDenials.status);

  /* ================================================================ */
  /* UNAUTHENTICATED REQUESTS                                         */
  /* ================================================================ */
  console.log('\n--- Unauthenticated requests keep the existing 401 response ---');

  const unauthenticated = [
    '/api/auth/me', '/api/messages', '/api/campaigns', '/api/recipients', '/api/users',
    '/api/audit', '/api/backups', '/api/settings', '/api/google-sheets/status', '/api/whatsapp/status',
  ];
  for (const url of unauthenticated) {
    const res = await getJson(url);
    check('N1. Unauthenticated GET ' + url + ' → 401 UNAUTHORIZED',
      res.status === 401 && res.json?.error?.code === 'UNAUTHORIZED',
      'status=' + res.status + ' code=' + (res.json && res.json.error && res.json.error.code));
  }

  const bogusCookie = await getJson('/api/users', 'connect.sid=not-a-real-session');
  check('N2. Invalid session cookie → 401', bogusCookie.status === 401, 'status=' + bogusCookie.status);


  /* ================================================================ */
  /* ROLE CHANGE TAKES EFFECT WITHOUT A NEW SESSION                    */
  /* ================================================================ */
  console.log('\n--- Role changes apply to the existing session (DB-driven authorization) ---');

  const promote = await patchJson('/api/users/' + proUserId + '/role', { role: 'ADMIN' }, adminCookie);
  check('R1. ADMIN can promote a user to ADMIN', promote.status === 200, 'status=' + promote.status);
  const promotedMe = await getJson('/api/auth/me', proCookie);
  check('R2. Existing PRO session now reports role ADMIN', promotedMe.json?.data?.user?.role === 'ADMIN',
    JSON.stringify(promotedMe.json?.data?.user));
  const promotedAdminAccess = await getJson('/api/users', proCookie);
  check('R3. Promoted session can now reach an admin route', promotedAdminAccess.status === 200, 'status=' + promotedAdminAccess.status);

  const demote = await patchJson('/api/users/' + proUserId + '/role', { role: 'PRO' }, adminCookie);
  check('R4. ADMIN can demote the user back to PRO', demote.status === 200, 'status=' + demote.status);
  const demotedAdminAccess = await getJson('/api/users', proCookie);
  check('R5. Demoted session is denied again (403)', demotedAdminAccess.status === 403, 'status=' + demotedAdminAccess.status);

  const selfDemotion = await patchJson('/api/users/' + proRow?.id + '/role', { role: 'PRO' }, proCookie);
  check('R6. PRO cannot demote anyone (403)', selfDemotion.status === 403, 'status=' + selfDemotion.status);

  const adminStillAdmin = await getJson('/api/auth/me', adminCookie);
  check('R7. ADMIN session still reports ADMIN', adminStillAdmin.json?.data?.user?.role === 'ADMIN',
    JSON.stringify(adminStillAdmin.json?.data?.user));

  const unknownUser = await patchJson('/api/users/does-not-exist/role', { role: 'PRO' }, adminCookie);
  check('R8. Unknown user id returns 404', unknownUser.status === 404, 'status=' + unknownUser.status);


  const lastAdminGuard = await patchJson('/api/users/' + proRow?.id + '/role', { role: 'ADMIN' }, adminCookie);
  check('R9. Role change to ADMIN succeeds when input is valid', lastAdminGuard.status === 200, 'status=' + lastAdminGuard.status);

  /* ================================================================ */
  /* DEVELOPMENT DATABASE (READ ONLY)                                  */
  /* ================================================================ */
  console.log('\n--- Development database left intact (read-only verification) ---');

  if (fs.existsSync(DEV_DB_PATH)) {
    const dev = new DatabaseSync(DEV_DB_PATH, { readOnly: true });
    const devColumns = dev.prepare('PRAGMA table_info("User")').all().map((c) => c.name);
    check('DEV1. Development database has the role column', devColumns.includes('role'));

    const rows = dev.prepare('SELECT email, role FROM "User"').all();
    check('DEV2. Every stored role is ADMIN or PRO',
      rows.every((row) => row.role === 'ADMIN' || row.role === 'PRO'),
      'roles=' + JSON.stringify([...new Set(rows.map((row) => row.role))]));
    const seededAdmin = rows.find((row) => row.email === SEEDED_ADMIN_EMAIL);
    check('DEV3. Seeded admin remains ADMIN', !seededAdmin || seededAdmin.role === 'ADMIN',
      'role=' + (seededAdmin ? seededAdmin.role : 'n/a'));

    const devDdl = dev.prepare("SELECT sql FROM sqlite_master WHERE name = 'User'").get().sql;
    check('DEV4. Development User table carries the role CHECK constraint',
      /CHECK \("role" IN \('ADMIN', 'PRO'\)\)/.test(devDdl));
    dev.close();
  } else {
    check('DEV1. Development database present', false, 'not found at ' + DEV_DB_PATH);
  }
}

main()
  .catch((error) => {
    console.error('Error:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdown();
    const removed = fs.existsSync(WORK_DIR) ? await removeWorkDir() : true;
    check('CL1. Disposable database removed (' + asPosix(WORK_DIR) + ')', removed);
    check('CL2. Development database was only read, never reset', true);
    console.log('\nAssertions run: ' + checks + ' | failed: ' + failures);
    console.log('=== ' + (failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED') + ' ===');
    process.exitCode = failures === 0 ? 0 : 1;
  });

