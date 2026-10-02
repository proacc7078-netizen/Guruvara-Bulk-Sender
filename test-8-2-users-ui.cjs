/**
 * Phase 8.2 — Admin User Management UI (focused frontend/API suite).
 *
 * Covers:
 * - frontend wiring: /users route, ADMIN-only sidebar entry, page guard,
 *   create form (POST /api/users), role change (PATCH /api/users/:id/role)
 *   gated behind an explicit confirmation modal, backend errors surfaced via
 *   error.message, no password ever rendered
 * - ADMIN can load users (GET /api/users, safe fields only)
 * - PRO cannot access the users API (403 on GET/POST/PATCH) and the page
 *   source hides the surface for non-ADMIN sessions
 * - ADMIN creates a PRO user
 * - ADMIN changes a role both directions
 * - last-admin protection: 409 LAST_ADMIN with a human-readable message
 *   (the exact message the UI displays)
 *
 * Safety:
 * - disposable SQLite database in the OS temp directory; the development
 *   database is never opened for writing
 * - WHATSAPP_PROVIDER=none, scheduler/worker polling disabled
 * - one server instance, checks run sequentially
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });

const REPO_ROOT = __dirname;
const WEB_SRC = path.join(REPO_ROOT, 'apps', 'web', 'src');
const APP_PATH = path.join(WEB_SRC, 'App.tsx');
const SIDEBAR_PATH = path.join(WEB_SRC, 'components', 'Sidebar.tsx');
const USERS_PAGE_PATH = path.join(WEB_SRC, 'pages', 'Users.tsx');
const AUTH_HOOK_PATH = path.join(WEB_SRC, 'hooks', 'useAuth.ts');
const USERS_ROUTES_PATH = path.join(REPO_ROOT, 'apps', 'server', 'src', 'routes', 'users.routes.ts');
const PRISMA_CLI = path.join(REPO_ROOT, 'node_modules', 'prisma', 'build', 'index.js');
const SCHEMA_PATH = path.join(REPO_ROOT, 'prisma', 'schema.prisma');

const TEST_PORT = 3182;
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'japa-phase82-'));
const TEST_DB_PATH = path.join(WORK_DIR, 'users-ui-test.db');
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

const ADMIN_EMAIL = 'admin-ui-' + RUN + '@example.com';
const ADMIN_PASSWORD = 'AdminUi-' + RUN + '-pw!';
const PRO_EMAIL = 'pro-ui-' + RUN + '@example.com';
const PRO_PASSWORD = 'ProUi-' + RUN + '-pw!';
const PRO_EMAIL_2 = 'pro-ui-2-' + RUN + '@example.com';

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
/* Disposable database & server                                        */
/* ------------------------------------------------------------------ */

function runPrismaDbPush() {
  const result = spawnSync(
    process.execPath,
    [PRISMA_CLI, 'db', 'push', '--skip-generate', '--schema=' + SCHEMA_PATH],
    { cwd: REPO_ROOT, env: process.env, encoding: 'utf8' }
  );
  return (result.stdout || '') + (result.stderr || '');
}

async function buildDisposableDatabase() {
  fs.mkdirSync(TEST_BACKUP_DIR, { recursive: true });
  const output = runPrismaDbPush();
  if (!fs.existsSync(TEST_DB_PATH)) {
    return { ok: false, message: 'prisma db push did not create the disposable database: ' + output.trim() };
  }

  const argon2 = require('argon2');
  const { PrismaClient } = require('@prisma/client');
  const setup = new PrismaClient();
  await setup.user.create({ data: { email: ADMIN_EMAIL, password: await argon2.hash(ADMIN_PASSWORD), role: 'ADMIN' } });
  await setup.$disconnect();
  return { ok: true };
}

async function shutdown() {
  if (indexModule && indexModule.worker) { try { await indexModule.worker.stop(); } catch { } }
  if (indexModule && indexModule.scheduler) { try { await indexModule.scheduler.stop(); } catch { } }
  if (server) { try { await new Promise((resolve) => server.close(resolve)); } catch { } }
  if (prisma) { try { await prisma.$disconnect(); } catch { } }
  // Release every cached Prisma client (Windows keeps SQLite locked otherwise).
  for (const key of Object.keys(require.cache)) {
    const cached = require.cache[key];
    const candidate = cached && cached.exports && cached.exports.prisma;
    if (candidate && typeof candidate.$disconnect === 'function') {
      try { await candidate.$disconnect(); } catch { }
    }
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let attempt = 0; attempt < 6; attempt++) {
    try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); } catch { }
    if (!fs.existsSync(WORK_DIR)) return true;
    await sleep(250);
  }
  return !fs.existsSync(WORK_DIR);
}

/* ------------------------------------------------------------------ */
/* Source checks (frontend wiring)                                     */
/* ------------------------------------------------------------------ */

function sourceChecks() {
  console.log('--- Frontend source wiring ---');

  const app = readSource(APP_PATH);
  // The /users route must still map to the Users page. It is now additionally
  // wrapped in the AdminOnly guard (ADMIN-only route boundary), so the assertion
  // accepts the guarded form and additionally requires that guard to be present.
  const usersRouteRegistered = /<Route path="\/users" element=\{<AdminOnly><Users \/><\/AdminOnly>\} \/>/.test(app);
  check('F1. App registers the /users route', usersRouteRegistered);
  check('F1b. /users route is wrapped in the AdminOnly guard', usersRouteRegistered);
  check('F1c. /settings route is wrapped in the AdminOnly guard',
    /<Route path="\/settings" element=\{<AdminOnly><Settings \/><\/AdminOnly>\} \/>/.test(app));
  check('F2. App imports the Users page', app.includes("import Users from './pages/Users'"));

  const sidebar = readSource(SIDEBAR_PATH);
  check('F3. Sidebar declares a Users entry', sidebar.includes("href: '/users'"));
  check('F4. Users entry is flagged adminOnly', /name: 'Users',\s*href: '\/users',[^}]*adminOnly: true/.test(sidebar));
  check('F5. Sidebar filters admin-only entries by isAdmin',
    sidebar.includes('!item.adminOnly || isAdmin'));
  check('F6. Sidebar derives isAdmin from auth/me-backed hook',
    sidebar.includes("useCurrentUser") && readSource(AUTH_HOOK_PATH).includes("'/api/auth/me'"));

  const page = readSource(USERS_PAGE_PATH);
  check('F7. Page loads users from GET /api/users', page.includes("axios.get('/api/users')"));
  check('F8. Create form posts to POST /api/users', page.includes("axios.post('/api/users'"));
  check('F9. Role change patches /api/users/:id/role',
    /axios\.patch\(`\/api\/users\/\$\{[^}]+\}\/role`/.test(page));
  check('F10. Role PATCH only fires from the confirmation modal',
    page.includes('handleRoleChange') && /onClick=\{handleRoleChange\}/.test(page) &&
    !/onClick=\{\(\) => openRoleChange[^}]*\}\s*\n\s*onClick=\{handleRoleChange/.test(page) === true &&
    page.includes('roleTarget && ('));
  check('F11. Confirmation modal is required before PATCH',
    /openRoleChange\(u\)/.test(page) && /Change role/.test(page) && /Change to \$\{roleTargetRole\}/.test(page));
  check('F12. Backend error message is surfaced verbatim',
    page.includes('getApiErrorMessage') && page.includes("body?.error?.message") &&
    page.includes('setRoleError(getApiErrorMessage'));
  check('F13. Page guard hides content from PRO (UI hiding only)',
    page.includes('if (!isAdmin)') && page.includes('authLoading'));
  check('F14. Password input exists for creation only',
    page.includes('type="password"') && page.includes('autoComplete="new-password"'));
  check('F15. Page never renders stored passwords',
    !/u\.password/.test(page) && !/\{u\.password\}/.test(page) && !/user\.password\}/.test(page));
  check('F16. Table shows Email, Role, Created, Actions',
    page.includes('>Email</th>') && page.includes('>Role</th>') &&
    page.includes('>Created</th>') && page.includes('>Actions</th>'));
  check('F17. Role select offers PRO and ADMIN',
    page.includes('<option value="PRO">PRO</option>') && page.includes('<option value="ADMIN">ADMIN</option>'));
  check('F18. Backend users route still requires ADMIN (unchanged)',
    /requireRole\(ROLE\.ADMIN\)/.test(readSource(USERS_ROUTES_PATH)));
}


/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  console.log('=== Phase 8.2: Admin User Management UI ===\n');
  console.log('Disposable database:', TEST_DB_PATH, '\n');

  sourceChecks();

  console.log('\n--- Disposable database ---');
  const dbSetup = await buildDisposableDatabase();
  check('DB1. Disposable database created', dbSetup.ok, dbSetup.ok ? '' : dbSetup.message);
  if (!dbSetup.ok) {
    process.exitCode = 1;
    return;
  }

  const originalListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    server = this;
    return originalListen.apply(this, args);
  };

  require('tsx/cjs');
  indexModule = require(path.join(REPO_ROOT, 'apps', 'server', 'src', 'index.ts'));

  const serverUp = await waitForServer(20000);
  check('DB2. Server reachable', serverUp);
  if (!serverUp) {
    process.exitCode = 1;
    return;
  }
  if (indexModule.worker) { try { await indexModule.worker.stop(); } catch { } }
  if (indexModule.scheduler) { try { await indexModule.scheduler.stop(); } catch { } }

  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient();

  /* ================================================================ */
  /* ADMIN CAN LOAD USERS                                             */
  /* ================================================================ */
  console.log('\n--- ADMIN loads users ---');

  const adminLogin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  check('A1. Admin can log in', adminLogin.res.status === 200 && !!adminLogin.cookie,
    'status=' + adminLogin.res.status);
  const adminCookie = adminLogin.cookie;
  check('A2. Session reports role ADMIN', adminLogin.res.json?.data?.user?.role === 'ADMIN');

  const list = await getJson('/api/users', adminCookie);
  check('A3. GET /api/users returns 200', list.status === 200, 'status=' + list.status);
  const listUsers = list.json?.data?.users;
  check('A4. Response carries a users array', Array.isArray(listUsers),
    'count=' + (Array.isArray(listUsers) ? listUsers.length : 'n/a'));
  check('A5. Admin appears in the list with role ADMIN',
    Array.isArray(listUsers) && listUsers.some((u) => u.email === ADMIN_EMAIL && u.role === 'ADMIN'));
  check('A6. List exposes only safe fields (no password anywhere)',
    !/password/i.test(list.text));
  check('A7. List entries expose createdAt (Created column)',
    Array.isArray(listUsers) && listUsers.every((u) => typeof u.createdAt === 'string'));

  /* ================================================================ */
  /* PRO USER CREATION                                                */
  /* ================================================================ */
  console.log('\n--- ADMIN creates a PRO user ---');

  const create = await postJson('/api/users',
    { email: PRO_EMAIL, password: PRO_PASSWORD, role: 'PRO' }, adminCookie);
  check('C1. POST /api/users returns 201', create.status === 201,
    'status=' + create.status + ' body=' + JSON.stringify(create.json).slice(0, 160));
  check('C2. Created user has role PRO', create.json?.data?.user?.role === 'PRO');
  check('C3. Creation response exposes no password', !/password/i.test(create.text));
  const createdId = create.json?.data?.user?.id;
  check('C4. Created user has an id for role management', typeof createdId === 'string' && createdId.length > 0);

  const invalidCreate = await postJson('/api/users',
    { email: 'x-' + RUN + '@example.com', password: 'short', role: 'PRO' }, adminCookie);
  check('C5. Invalid password rejected with a displayable message',
    invalidCreate.status === 400 && typeof invalidCreate.json?.error?.message === 'string',
    'status=' + invalidCreate.status);

  /* ================================================================ */
  /* ROLE CHANGE                                                      */
  /* ================================================================ */
  console.log('\n--- ADMIN changes a role ---');

  const promote = await patchJson('/api/users/' + createdId + '/role', { role: 'ADMIN' }, adminCookie);
  check('R1. PRO -> ADMIN succeeds', promote.status === 200,
    'status=' + promote.status + ' body=' + JSON.stringify(promote.json).slice(0, 140));
  check('R2. Response reports role ADMIN', promote.json?.data?.user?.role === 'ADMIN');
  check('R3. Role persisted in the database',
    (await prisma.user.findUnique({ where: { id: createdId } }))?.role === 'ADMIN');

  const demote = await patchJson('/api/users/' + createdId + '/role', { role: 'PRO' }, adminCookie);
  check('R4. ADMIN -> PRO succeeds', demote.status === 200, 'status=' + demote.status);
  check('R5. Response reports role PRO', demote.json?.data?.user?.role === 'PRO');

  const badRole = await patchJson('/api/users/' + createdId + '/role', { role: 'SUPERADMIN' }, adminCookie);
  check('R6. Invalid role rejected with a displayable message',
    badRole.status === 400 && typeof badRole.json?.error?.message === 'string',
    'status=' + badRole.status);

  /* ================================================================ */
  /* LAST-ADMIN PROTECTION (error the UI displays)                    */
  /* ================================================================ */
  console.log('\n--- Last-admin protection ---');

  const adminRow = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
  check('L1. Exactly one ADMIN before the demotion attempt', adminCount === 1, 'count=' + adminCount);

  const lastAdmin = await patchJson('/api/users/' + adminRow.id + '/role', { role: 'PRO' }, adminCookie);
  check('L2. Demoting the last ADMIN returns 409', lastAdmin.status === 409, 'status=' + lastAdmin.status);
  check('L3. Error code is LAST_ADMIN', lastAdmin.json?.error?.code === 'LAST_ADMIN',
    JSON.stringify(lastAdmin.json));
  check('L4. Error carries a human-readable message for the UI',
    typeof lastAdmin.json?.error?.message === 'string' && lastAdmin.json.error.message.length > 0,
    'message=' + (lastAdmin.json?.error?.message ?? 'n/a'));
  check('L5. The admin is still ADMIN after the rejected change',
    (await prisma.user.findUnique({ where: { id: adminRow.id } }))?.role === 'ADMIN');

  /* ================================================================ */
  /* PRO CANNOT ACCESS THE PAGE/API                                   */
  /* ================================================================ */
  console.log('\n--- PRO denied (UI hiding is backed by 403) ---');

  const proLogin = await login(PRO_EMAIL, PRO_PASSWORD);
  check('P1. PRO can log in', proLogin.res.status === 200 && !!proLogin.cookie,
    'status=' + proLogin.res.status);
  const proCookie = proLogin.cookie;
  check('P2. Session reports role PRO', proLogin.res.json?.data?.user?.role === 'PRO');

  const proList = await getJson('/api/users', proCookie);
  check('P3. PRO GET /api/users -> 403', proList.status === 403, 'status=' + proList.status);
  check('P4. 403 uses FORBIDDEN code', proList.json?.error?.code === 'FORBIDDEN',
    JSON.stringify(proList.json));

  const proCreate = await postJson('/api/users',
    { email: PRO_EMAIL_2, password: PRO_PASSWORD, role: 'PRO' }, proCookie);
  check('P5. PRO POST /api/users -> 403', proCreate.status === 403, 'status=' + proCreate.status);

  const proPatch = await patchJson('/api/users/' + createdId + '/role', { role: 'ADMIN' }, proCookie);
  check('P6. PRO PATCH /api/users/:id/role -> 403', proPatch.status === 403, 'status=' + proPatch.status);

  const anon = await getJson('/api/users');
  check('P7. Unauthenticated GET /api/users -> 401', anon.status === 401, 'status=' + anon.status);

  console.log('\nAssertions run: ' + checks + ' | failed: ' + failures);
  console.log('=== ' + (failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED') + ' ===');
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('Error:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    const removed = await shutdown();
    if (!removed) console.log('WARNING: could not remove ' + WORK_DIR);
  });


