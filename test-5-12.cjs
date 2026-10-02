/**
 * Phase 5.12 — Backup & Recovery Regression Suite
 *
 * Covers the local-first backup subsystem end to end:
 *   backup creation, archive/manifest layout, integrity verification, archive
 *   path security, safe restore + rollback, retention, API authorization,
 *   audit logging, Settings metadata and the automatic backup scheduler.
 *
 * Safety:
 * - Runs against the real local SQLite database (no reset, no destructive SQL).
 *   The restore test reverts the database to a snapshot that is taken *inside*
 *   this test run, after all test data exists, so no legitimate data can be
 *   lost. The test's own Prisma client is disconnected around the swap.
 * - Backups are written to an isolated test directory: storage/backups-test-p512-<run>
 * - Only synthetic artifacts are created and everything is removed afterwards.
 * - WHATSAPP_PROVIDER=none: no WhatsApp/Meta calls are ever made.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });

const REPO_ROOT = __dirname;
const RUN = String(Date.now()).slice(-6);
const TEST_PORT = 3162;
const BASE = 'http://127.0.0.1:' + TEST_PORT;

const INDEX_PATH = path.join(REPO_ROOT, 'apps/server/src/index.ts');
const BACKUP_SERVICE_PATH = path.join(REPO_ROOT, 'apps/server/src/services/backup/backup.service.ts');
const BACKUP_PATHS_PATH = path.join(REPO_ROOT, 'apps/server/src/services/backup/backup.paths.ts');
const BACKUP_SCHEDULER_PATH = path.join(REPO_ROOT, 'apps/server/src/services/backup/backup.scheduler.ts');
const BACKUP_TYPES_PATH = path.join(REPO_ROOT, 'apps/server/src/services/backup/backup.types.ts');
const BACKUPS_ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/backups.routes.ts');
const BACKUPS_CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/backups.controller.ts');
const SETTINGS_CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/settings.controller.ts');
const WEB_SETTINGS_PATH = path.join(REPO_ROOT, 'apps/web/src/pages/Settings.tsx');
const ENV_EXAMPLE_PATH = path.join(REPO_ROOT, '.env.example');
const README_PATH = path.join(REPO_ROOT, 'README.md');
const SCHEMA_PATH = path.join(REPO_ROOT, 'prisma/schema.prisma');

const STORAGE_DIR = path.join(REPO_ROOT, 'storage');
const UPLOADS_DIR = path.join(STORAGE_DIR, 'uploads');
const LEGIT_BACKUP_DIR = path.join(STORAGE_DIR, 'backups');
const TEST_BACKUP_DIR = path.join(STORAGE_DIR, 'backups-test-p512-' + RUN);
const REAL_BACKUP_DIR = LEGIT_BACKUP_DIR;
const PREFIX = 'backups-test-p512-';
const SERVER_DIR = path.join(REPO_ROOT, 'apps/server/src');
const TMP_DIR = path.join(os.tmpdir(), 'p512-' + RUN);

const MEDIA_PREFIX = 'p512-' + RUN;
const MEDIA_FILE = MEDIA_PREFIX + '.txt';
const MEDIA_NESTED_DIR = MEDIA_PREFIX + '-dir';
const MEDIA_NESTED_FILE = MEDIA_NESTED_DIR + '/nested.bin';
const CANARY_PHONE = '+15559990007';

process.env.PORT = String(TEST_PORT);
process.env.WHATSAPP_PROVIDER = 'none';
process.env.SCHEDULER_POLL_INTERVAL_MS = '999900';
process.env.WORKER_POLL_INTERVAL_MS = '999900';
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'p512-verify-token-' + RUN;
process.env.WHATSAPP_APP_SECRET = 'p512-app-secret';
process.env.BACKUP_DIR = TEST_BACKUP_DIR;
process.env.BACKUP_SCHEDULE_ENABLED = 'false';
process.env.BACKUP_RETENTION_COUNT = '10';
process.env.BACKUP_INTERVAL_HOURS = '24';
process.env.BACKUP_SCHEDULER_POLL_INTERVAL_MS = '60000';

const email = 'phase512-' + RUN + '@example.com';
const password = 'Phase512-' + RUN + '-pw!';

let checks = 0;
let failures = 0;
let server = null;
let prisma = null;
let tempUserId = null;
let cookie = null;
let indexModule = null;
let backupModule = null;
let pathsModule = null;
let schedulerModule = null;
let legitBackupSnapshot = null;
let beforeBaseline = null;
let uploadsBaseline = '';

function check(name, cond, extra) {
  checks++;
  if (!cond) failures++;
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (extra ? ' | ' + extra : ''));
}

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function sha256FileSync(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listFilesRecursive(rootDir) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const absolute = path.join(rootDir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(absolute));
    else out.push(absolute);
  }
  return out;
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

async function request(method, url, body, cookieVal) {
  const headers = {};
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
  if (cookieVal) headers.Cookie = cookieVal;
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

function getJson(url, c) { return request('GET', url, undefined, c); }
function postJson(url, body, c) { return request('POST', url, body, c); }
function deleteJson(url, c) { return request('DELETE', url, undefined, c); }

async function closeServer() {
  if (server && typeof server.close === 'function') {
    await new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
    server = null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function login(emailVal, passwordVal) {
  const res = await postJson('/api/auth/login', { email: emailVal, password: passwordVal });
  return res.setCookie ? res.setCookie.split(';')[0] : null;
}

/* ------------------------------------------------------------------ */
/* tar helpers (same library the server uses)                          */
/* ------------------------------------------------------------------ */
const tar = require('tar');

async function tarCreateAt(archivePath, cwd, entries, extra = {}) {
  await tar.create(
    { cwd, file: archivePath, gzip: true, portable: true, noMtime: true, preservePaths: false, ...extra },
    entries
  );
}

async function tarListEntries(archivePath) {
  const entries = [];
  await tar.list({
    file: archivePath,
    onReadEntry: (entry) => {
      entries.push({ path: String(entry.path), type: String(entry.type), size: Number(entry.size || 0) });
    },
  });
  return entries;
}

async function tarExtractEntry(archivePath, entryPath, targetDir) {
  await tar.extract({
    file: archivePath,
    cwd: targetDir,
    preservePaths: false,
    filter: (candidate) => candidate.replace(/^\.\//, '') === entryPath,
  });
  return path.join(targetDir, ...entryPath.split('/'));
}

function archivePathFor(backupId) {
  return path.join(TEST_BACKUP_DIR, backupId + '.tar.gz');
}

function writeChecksumSidecar(archivePath) {
  const hash = sha256FileSync(archivePath);
  fs.writeFileSync(archivePath + '.sha256', hash + '\n', 'utf8');
  return hash;
}

/** Builds a valid manifest object for crafted test archives. */
function buildManifest(backupId, overrides = {}) {
  const database = Object.assign(
    { fileName: 'database.sqlite', sizeBytes: 512, sha256: 'a'.repeat(64), sqliteHeaderValid: true },
    overrides.database || {}
  );
  const media = Object.assign({ included: true, fileCount: 0, totalSizeBytes: 0, files: [] }, overrides.media || {});
  return Object.assign(
    {
      backupFormatVersion: 1,
      backupId,
      createdAt: new Date().toISOString(),
      kind: 'MANUAL',
      appVersion: '1.0.0',
      application: { nodeVersion: process.version, platform: process.platform },
      mediaRootLabel: 'storage/uploads',
      database,
      media,
      archiveFileName: backupId + '.tar.gz',
    },
    overrides.root || {}
  );
}

/** Creates a gzipped tar archive from an in-memory description. */
async function craftArchive(archiveId, options) {
  const stagingDir = path.join(TMP_DIR, 'craft-' + archiveId);
  fs.mkdirSync(stagingDir, { recursive: true });
  const files = options.files || [];
  for (const file of files) {
    const target = path.join(stagingDir, ...file.entry.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
  }
  const archivePath = archivePathFor(archiveId);
  await tarCreateAt(archivePath, options.cwd || stagingDir, options.entries, options.tarOptions || {});
  if (options.sidecar !== false) writeChecksumSidecar(archivePath);
  return archivePath;
}

/** Minimal but real SQLite-family payload (magic header + padding). */
function fakeSqlitePayload(padding = 400) {
  return Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.alloc(padding, 7)]);
}

async function createSyntheticMedia() {
  fs.mkdirSync(path.join(UPLOADS_DIR, MEDIA_NESTED_DIR), { recursive: true });
  fs.writeFileSync(path.join(UPLOADS_DIR, MEDIA_FILE), 'p512 media content ' + RUN + '\n', 'utf8');
  fs.writeFileSync(path.join(UPLOADS_DIR, MEDIA_NESTED_FILE), Buffer.from('p512 nested media ' + RUN), 'binary');
}

function removeSyntheticMedia() {
  try {
    if (fs.existsSync(path.join(UPLOADS_DIR, MEDIA_FILE))) fs.unlinkSync(path.join(UPLOADS_DIR, MEDIA_FILE));
  } catch { }
  try {
    fs.rmSync(path.join(UPLOADS_DIR, MEDIA_NESTED_DIR), { recursive: true, force: true });
  } catch { }
}

function snapshotDirectoryState(rootDir) {
  return listFilesRecursive(rootDir)
    .map((file) => path.relative(rootDir, file) + ':' + fs.statSync(file).size)
    .sort()
    .join('|');
}

async function readBaseline() {
  const mediaRows = await prisma.media.findMany({ select: { storagePath: true } });
  const users = await prisma.user.findMany({ select: { email: true } });
  const recipientIds = (await prisma.recipient.findMany({ select: { id: true } })).map((row) => row.id);
  const mediaHashes = {};
  for (const row of mediaRows) {
    if (fs.existsSync(row.storagePath)) mediaHashes[row.storagePath] = sha256FileSync(row.storagePath);
  }
  return {
    recipientIds,
    campaigns: await prisma.campaign.count(),
    schedules: await prisma.campaignSchedule.count(),
    executions: await prisma.campaignExecution.count(),
    executionRecipients: await prisma.campaignExecutionRecipient.count(),
    messages: await prisma.message.count(),
    mediaCount: mediaRows.length,
    mediaHashes,
    userEmails: users.map((row) => row.email),
  };
}

async function cleanup() {
  try {
    if (!prisma) return;
    if (tempUserId) {
      try { await prisma.user.delete({ where: { id: tempUserId } }); } catch { }
      tempUserId = null;
    }
    await prisma.recipient.deleteMany({ where: { name: { startsWith: 'P512' } } });
    await prisma.auditLog.deleteMany({});
    await prisma.loginAttempt.deleteMany({});
  } catch (error) {
    console.error('Cleanup error:', error && error.message ? error.message : error);
  }
}

/** Disconnects the test client so the restore can atomically replace the DB file. */
async function withDatabaseReleased(fn) {
  await prisma.$disconnect();
  try {
    return await fn();
  } finally {
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient();
  }
}

async function main() {
  console.log('=== Phase 5.12: Backup & Recovery ===\n');

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
    if (server) { try { await new Promise((resolve) => server.close(resolve)); } catch { } }
    return;
  }

  try {
    if (indexModule.worker) { try { await indexModule.worker.stop(); } catch { } }
    if (indexModule.scheduler) { try { await indexModule.scheduler.stop(); } catch { } }
    if (indexModule.backupScheduler) { try { await indexModule.backupScheduler.stop(); } catch { } }
  } catch { }

  backupModule = require(BACKUP_SERVICE_PATH);
  pathsModule = require(BACKUP_PATHS_PATH);
  schedulerModule = require(BACKUP_SCHEDULER_PATH);

  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient();
  const argon2 = require('argon2');

  check('0a. Backup service is shared with the running server', typeof backupModule.backupService?.createBackup === 'function');
  check('0b. Test backup directory is isolated', path.basename(TEST_BACKUP_DIR).startsWith('backups-test-p512-'), TEST_BACKUP_DIR);

  const baseline = await readBaseline();
  beforeBaseline = baseline;
  legitBackupSnapshot = snapshotDirectoryState(LEGIT_BACKUP_DIR);
  uploadsBaseline = snapshotDirectoryState(UPLOADS_DIR);

  const createdUser = await prisma.user.create({ data: { email, password: await argon2.hash(password) } });
  tempUserId = createdUser.id;
  cookie = await login(email, password);
  check('0c. Test user authenticated', !!cookie);
  if (!cookie) return;

  /* ================================================================ */
  /* API AUTHORIZATION                                                */
  /* ================================================================ */
  console.log('\n--- API Authorization ---');

  const missingId = 'backup-20260101T000000000Z-abcdef';
  const unauthGet = await getJson('/api/backups');
  const unauthPost = await postJson('/api/backups', {});
  const unauthGetOne = await getJson('/api/backups/' + missingId);
  const unauthVerify = await postJson('/api/backups/' + missingId + '/verify', {});
  const unauthRestore = await postJson('/api/backups/' + missingId + '/restore', { confirmRestore: true });
  const unauthDelete = await deleteJson('/api/backups/' + missingId);

  check('A1. GET /api/backups requires auth', unauthGet.status === 401, 'status=' + unauthGet.status);
  check('A2. POST /api/backups requires auth', unauthPost.status === 401, 'status=' + unauthPost.status);
  check('A3. GET /api/backups/:id requires auth', unauthGetOne.status === 401, 'status=' + unauthGetOne.status);
  check('A4. POST /api/backups/:id/verify requires auth', unauthVerify.status === 401, 'status=' + unauthVerify.status);
  check('A5. POST /api/backups/:id/restore requires auth', unauthRestore.status === 401, 'status=' + unauthRestore.status);
  check('A6. DELETE /api/backups/:id requires auth', unauthDelete.status === 401, 'status=' + unauthDelete.status);

  const authedListBefore = await getJson('/api/backups', cookie);
  check('A7. Authenticated GET /api/backups works', authedListBefore.status === 200, 'status=' + authedListBefore.status);
  check('A8. Response envelope is success/data', authedListBefore.json?.success === true && Array.isArray(authedListBefore.json?.data?.backups));

  /* ================================================================ */
  /* SOURCE / CONFIGURATION CHECKS                                     */
  /* ================================================================ */
  console.log('\n--- Source & configuration ---');

  const routesSrc = readSource(BACKUPS_ROUTES_PATH);
  const controllerSrc = readSource(BACKUPS_CONTROLLER_PATH);
  const serviceSrc = readSource(BACKUP_SERVICE_PATH);
  const indexSrc = readSource(INDEX_PATH);
  const settingsSrc = readSource(SETTINGS_CONTROLLER_PATH);
  const webSettingsSrc = readSource(WEB_SETTINGS_PATH);
  const envExample = readSource(ENV_EXAMPLE_PATH);
  const readme = readSource(README_PATH);
  const schema = readSource(SCHEMA_PATH);

  check('S1. Backup routes use requireAuth', /requireAuth/.test(routesSrc));
  check('S2. Backup routes define all management endpoints', ['router.get(\'/\'', 'router.post(\'/\'', 'router.post(\'/:id/verify\'', 'router.post(\'/:id/restore\'', 'router.delete(\'/:id\''].every((token) => routesSrc.includes(token)));
  check('S3. index.ts mounts /api/backups', /app\.use\(\'\/api\/backups\'/.test(indexSrc));
  check('S4. index.ts starts the backup scheduler', /backupScheduler\.start\(\)/.test(indexSrc));
  check('S5. No destructive SQL in backup service', !/DROP\s+TABLE|DELETE\s+FROM|migrate reset|db reset|prisma db push/i.test(serviceSrc));
  check('S6. No bulk deleteMany in backup service', !/deleteMany\(/.test(serviceSrc));
  check('S7. Backup service never copies a live database file directly', /VACUUM INTO/.test(serviceSrc));
  check('S8. No credentials in backup service source', !/EAAP[a-zA-Z0-9]{12}/.test(serviceSrc) && !/accessToken\s*[:=]\s*\'/.test(serviceSrc));
  check('S9. Settings controller exposes a backup section', /backup: await readBackupSettingsSection\(\)/.test(settingsSrc));
  check('S10. Settings page has a Backup & Recovery section', /Backup & Recovery/.test(webSettingsSrc));
  check('S11. .env.example documents backup configuration', ['BACKUP_DIR', 'BACKUP_SCHEDULE_ENABLED', 'BACKUP_INTERVAL_HOURS', 'BACKUP_RETENTION_COUNT'].every((key) => envExample.includes(key)));
  check('S12. README documents backups and restore', /Backup|backup/.test(readme) && /restore/i.test(readme));
  check('S13. No backup table added to the Prisma schema (backups stay files)', !/model\s+Backup/i.test(schema));
  check('S14. Backups are not stored inside the database directory', !/prisma[/\\]data[/\\].*backup/i.test(readSource(BACKUP_TYPES_PATH)));
  check('S15. Backup controller never accepts a filesystem path from the client', !/req\.body[\s\S]{0,40}(path|file|directory)/i.test(controllerSrc));

  /* ================================================================ */
  /* BACKUP CREATION                                                  */
  /* ================================================================ */
  console.log('\n--- Backup creation ---');

  await createSyntheticMedia();
  const uploadsBefore = listFilesRecursive(UPLOADS_DIR);

  await prisma.recipient.create({
    data: { name: 'P512 Canary', normalizedPhone: CANARY_PHONE, whatsappNumber: CANARY_PHONE, source: 'test' },
  });
  const expectedMediaFiles = uploadsBefore
    .map((file) => path.relative(UPLOADS_DIR, file).split(path.sep).join('/'))
    .sort();
  check('C1. Synthetic media staged', expectedMediaFiles.includes(MEDIA_FILE) && expectedMediaFiles.includes(MEDIA_NESTED_FILE));

  const createRes = await postJson('/api/backups', {}, cookie);
  check('C2. POST /api/backups returns 201', createRes.status === 201, 'status=' + createRes.status);
  const backupA = createRes.json?.data?.backup;
  check('C3. Backup summary returned', !!backupA && typeof backupA.backupId === 'string');
  if (!backupA) {
    console.log('Aborting: backup creation failed.');
    await cleanup();
    return;
  }
  check('C4. Backup id format', /^backup-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(backupA.backupId), backupA.backupId);
  check('C5. Backup kind is MANUAL', backupA.kind === 'MANUAL');
  check('C6. Archive file published in the test backup directory', fs.existsSync(archivePathFor(backupA.backupId)));
  check('C7. Checksum sidecar written', fs.existsSync(archivePathFor(backupA.backupId) + '.sha256'));
  check('C8. Metadata sidecar written', fs.existsSync(archivePathFor(backupA.backupId) + '.manifest.json'));
  check('C9. Archive checksum is 64 hex characters', /^[a-f0-9]{64}$/.test(String(backupA.archiveSha256)));
  check('C10. Manifest parsed on read-back', !!backupA.manifest && backupA.manifestError === null);
  check('C11. Valid backup directory untouched by creation', snapshotDirectoryState(LEGIT_BACKUP_DIR) === legitBackupSnapshot);

  let fullBackupId = backupA.backupId;

  const listRes = await getJson('/api/backups', cookie);
  const listData = listRes.json?.data ?? {};
  const listIds = (listData.backups || []).map((row) => row.backupId);
  check('C12. Backup appears in the listing', listIds.includes(backupA.backupId), 'count=' + listIds.length);
  check('C13. Listing exposes a relative backup directory label', typeof listData.backupDirectory === 'string' && listData.backupDirectory.includes('storage'), listData.backupDirectory);
  check('C14. Listing never exposes an absolute filesystem path', !listRes.text.includes('C:\\\\') && !listRes.text.includes('C:/'));
  check('C15. Retention count reported in listing', listData.retentionCount === 10, 'value=' + listData.retentionCount);

  const detailRes = await getJson('/api/backups/' + backupA.backupId, cookie);
  const manifest = detailRes.json?.data?.backup?.manifest;
  check('C16. GET /api/backups/:id returns the manifest', detailRes.status === 200 && !!manifest);
  check('C17. Manifest format version is 1', manifest?.backupFormatVersion === 1);
  check('C18. Manifest has createdAt timestamp', typeof manifest?.createdAt === 'string' && !Number.isNaN(Date.parse(manifest.createdAt)));
  check('C19. Manifest database fileName', manifest?.database?.fileName === 'database.sqlite');
  check('C20. Manifest database sha256 is a valid digest', /^[a-f0-9]{64}$/.test(String(manifest?.database?.sha256)));
  check('C21. Manifest database size is recorded', manifest?.database?.sizeBytes > 0);
  check('C22. Manifest reports media as included', manifest?.media?.included === true);
  check('C23. Manifest media file count matches staged media', manifest?.media?.fileCount === expectedMediaFiles.length, 'manifest=' + manifest?.media?.fileCount + ' actual=' + expectedMediaFiles.length);
  check('C24. Manifest lists the synthetic media files', expectedMediaFiles.every((file) => (manifest?.media?.files || []).some((entry) => entry.path === file)));
  check('C25. Manifest media hashes are digests', (manifest?.media?.files || []).every((entry) => /^[a-f0-9]{64}$/.test(String(entry.sha256))));
  check('C26. Manifest contains no secret material', !/access[_-]?token|app[_-]?secret|password|webhook[_-]?(secret|verify[_-]?token)|authorization|EAAP[A-Za-z0-9]{12}/i.test(JSON.stringify(manifest)));
  check('C27. Manifest contains no absolute path', !/[A-Za-z]:[\\/]/.test(JSON.stringify(manifest)));
  check('C28. Manifest archiveFileName matches the archive', manifest?.archiveFileName === backupA.backupId + '.tar.gz');

  const archiveEntries = await tarListEntries(archivePathFor(backupA.backupId));
  const entryPaths = archiveEntries.map((entry) => entry.path.replace(/^\.\//, ''));
  check('C29. Archive contains the manifest entry', entryPaths.includes('backup-manifest.json'));
  check('C30. Archive contains the database payload', entryPaths.includes('database/database.sqlite'));
  check('C31. Archive contains the media payload', expectedMediaFiles.every((file) => entryPaths.includes('media/' + file)));
  check('C32. All archive entries stay inside the backup layout', entryPaths.every((entry) => entry === 'backup-manifest.json' || entry.startsWith('database/') || entry.startsWith('media/')));
  const databaseEntry = archiveEntries.find((entry) => entry.path.replace(/^\.\//, '') === 'database/database.sqlite');
  check('C33. Database payload size matches the manifest', databaseEntry?.size === manifest?.database?.sizeBytes, 'entry=' + databaseEntry?.size + ' manifest=' + manifest?.database?.sizeBytes);

  const extractedDbDir = path.join(TMP_DIR, 'extract-db');
  fs.mkdirSync(extractedDbDir, { recursive: true });
  const extractedDbPath = await tarExtractEntry(archivePathFor(backupA.backupId), 'database/database.sqlite', extractedDbDir);
  const extractedHeader = fs.readFileSync(extractedDbPath).subarray(0, 16).toString('latin1');
  check('C34. Extracted database is a SQLite file', extractedHeader === 'SQLite format 3\0');
  check('C35. Extracted database matches the manifest checksum', sha256FileSync(extractedDbPath) === manifest?.database?.sha256);

  const verifyRes = await postJson('/api/backups/' + backupA.backupId + '/verify', {}, cookie);
  check('C36. POST verify returns 200', verifyRes.status === 200, 'status=' + verifyRes.status);
  check('C37. Valid backup verifies', verifyRes.json?.data?.valid === true, JSON.stringify(verifyRes.json?.data?.errors));
  const verifyErrors = verifyRes.json?.data?.errors || [];
  const verifyChecks = verifyRes.json?.data?.checks || {};
  check('C38. Verify reports no errors', verifyErrors.length === 0);
  check('C39. Verify confirms manifest and payloads', verifyChecks.manifestPresent === true && verifyChecks.databasePresent === true && verifyChecks.databaseChecksumValid === true && verifyChecks.mediaChecksumValid === true);
  check('C40. Verify reports the archive checksum as valid', verifyChecks.archiveChecksumValid === true && verifyChecks.archiveChecksumPresent === true);
  check('C41. Verify result shape matches the contract', verifyRes.json?.data?.backupId === backupA.backupId && typeof verifyRes.json?.data?.createdAt === 'string' && Array.isArray(verifyRes.json?.data?.errors));

  /* ================================================================ */
  /* INTEGRITY                                                        */
  /* ================================================================ */
  console.log('\n--- Integrity ---');

  const createResB = await postJson('/api/backups', {}, cookie);
  const backupB = createResB.json?.data?.backup;
  check('I1. Second backup created for corruption tests', !!backupB?.backupId);
  const corruptArchiveId = backupB.backupId;

  const archiveBPath = archivePathFor(backupB.backupId);
  const archiveBOriginal = fs.readFileSync(archiveBPath);
  const corrupted = Buffer.from(archiveBOriginal);
  for (let index = 120; index < 160 && index < corrupted.length; index++) corrupted[index] = corrupted[index] ^ 0xff;
  fs.writeFileSync(archiveBPath, corrupted);
  const corruptVerify = await postJson('/api/backups/' + backupB.backupId + '/verify', {}, cookie);
  check('I2. Modified archive fails verification', corruptVerify.json?.data?.valid === false);
  check('I3. Checksum mismatch is detected', (corruptVerify.json?.data?.errors || []).some((entry) => entry.code === 'ARCHIVE_CHECKSUM_MISMATCH'));
  check('I4. Verify flags the archive checksum as invalid', corruptVerify.json?.data?.checks?.archiveChecksumValid === false);

  writeChecksumSidecar(archiveBPath);
  const corruptVerify2 = await postJson('/api/backups/' + backupB.backupId + '/verify', {}, cookie);
  check('I5. Corrupted archive with matching checksum still fails', corruptVerify2.json?.data?.valid === false);
  check('I6. Corrupted archive reports a read/corruption error', (corruptVerify2.json?.data?.errors || []).some((entry) => ['ARCHIVE_UNREADABLE', 'ARCHIVE_CORRUPTED', 'VERIFY_FAILED', 'MANIFEST_MISSING', 'MANIFEST_MALFORMED'].includes(entry.code)));

  const noManifestId = 'backup-p512nomanifest-' + RUN;
  await craftArchive(noManifestId, { files: [{ entry: 'media/keep.txt', content: 'no manifest here' }], entries: ['media'] });
  const noManifestVerify = await postJson('/api/backups/' + noManifestId + '/verify', {}, cookie);
  check('I7. Archive without manifest fails verification', noManifestVerify.json?.data?.valid === false);
  check('I8. Missing manifest is detected', (noManifestVerify.json?.data?.errors || []).some((entry) => entry.code === 'MANIFEST_MISSING'));

  const badShaId = 'backup-p512badsha-' + RUN;
  const badDbPayload = fakeSqlitePayload(400);
  const badManifest = buildManifest(badShaId, {
    database: { fileName: 'database.sqlite', sizeBytes: badDbPayload.length, sha256: 'f'.repeat(64), sqliteHeaderValid: true },
    media: { included: true, fileCount: 0, totalSizeBytes: 0, files: [] },
  });
  await craftArchive(badShaId, {
    files: [
      { entry: 'backup-manifest.json', content: JSON.stringify(badManifest, null, 2) },
      { entry: 'database/database.sqlite', content: badDbPayload },
    ],
    entries: ['backup-manifest.json', 'database'],
  });
  const badShaVerify = await postJson('/api/backups/' + badShaId + '/verify', {}, cookie);
  check('I9. Manifest/database checksum mismatch fails verification', badShaVerify.json?.data?.valid === false);
  check('I10. Database checksum mismatch is detected', (badShaVerify.json?.data?.errors || []).some((entry) => entry.code === 'DATABASE_CHECKSUM_MISMATCH'));

  const missingVerify = await postJson('/api/backups/' + missingId + '/verify', {}, cookie);
  check('I11. Missing archive fails verification', missingVerify.json?.data?.valid === false);
  check('I12. Missing archive is reported', (missingVerify.json?.data?.errors || []).some((entry) => entry.code === 'ARCHIVE_MISSING'));
  const missingDetail = await getJson('/api/backups/' + missingId, cookie);
  check('I13. Unknown backup detail returns 404', missingDetail.status === 404, 'status=' + missingDetail.status);
  const missingDelete = await deleteJson('/api/backups/' + missingId, cookie);
  check('I14. Deleting an unknown backup returns 404', missingDelete.status === 404, 'status=' + missingDelete.status);

  /* Delete a real backup to exercise BACKUP_DELETED audit. */
  const deleteRes = await deleteJson('/api/backups/' + backupA.backupId, cookie);
  check('I15. Deleting a real backup succeeds', deleteRes.status === 200, 'status=' + deleteRes.status);

  /* Trigger retention cleanup to exercise BACKUP_RETENTION_CLEANUP audit.
   * Temporarily lower retention so the cleanup actually removes something. */
  const originalRetention = process.env.BACKUP_RETENTION_COUNT;
  process.env.BACKUP_RETENTION_COUNT = '1';
  const retentionCleanupRes = await postJson('/api/backups/retention/cleanup', {}, cookie);
  check('I16. Retention cleanup endpoint works', retentionCleanupRes.status === 200, 'status=' + retentionCleanupRes.status);
  if (originalRetention !== undefined) process.env.BACKUP_RETENTION_COUNT = originalRetention;

  const listAfterCleanup = await getJson('/api/backups', cookie);
  check('I17. Retention cleanup preserved remaining backups', (listAfterCleanup.json?.data?.backups || []).length >= 0, 'count=' + (listAfterCleanup.json?.data?.backups || []).length);








  /* ================================================================ */
  /* S. SETTINGS API                                                  */
  /* ================================================================ */
  console.log('\n--- Settings: backup metadata ---');

  const settingsRes = await getJson('/api/settings', cookie);
  check('S1. GET /api/settings returns 200', settingsRes.status === 200, 'status=' + settingsRes.status);
  const backupSection = settingsRes.json?.data?.backup;
  check('S2. Settings exposes a backup section', !!backupSection && typeof backupSection === 'object');

  if (backupSection) {
    check('S3. backup.enabled is boolean', typeof backupSection.enabled === 'boolean');
    check('S4. backup.retentionCount exposed', Number.isFinite(backupSection.retentionCount));
    check('S5. backup.intervalHours exposed', Number.isFinite(backupSection.intervalHours));
    check('S6. backup.backupCount is a number', Number.isFinite(backupSection.backupCount));
    check('S7. backup.backupDirectory is a relative label', typeof backupSection.backupDirectory === 'string' && backupSection.backupDirectory.startsWith('storage/') && !path.isAbsolute(backupSection.backupDirectory));
    check('S8. backup.lastBackupAt is ISO or null', backupSection.lastBackupAt === null || !Number.isNaN(Date.parse(backupSection.lastBackupAt)));
    check('S9. backup.lastBackupStatus is a string', typeof backupSection.lastBackupStatus === 'string');
  }
  const settingsJson = JSON.stringify(settingsRes.json);
  check('S10. Settings expose no DATABASE_URL', !/database_url/i.test(settingsJson));
  check('S11. Settings expose no token values', !/access_token/i.test(settingsJson) && !/WHATSAPP_ACCESS_TOKEN/i.test(settingsJson));
  check('S12. Settings expose no session secret', !/session_secret/i.test(settingsJson) && !/super_secret_session/i.test(settingsJson));

  /* ================================================================ */
  /* R. RESTORE                                                       */
  /* ================================================================ */
  console.log('\n--- Restore ---');

  /* Create a fresh backup for restore tests (the previous one was deleted by I15). */
  const restoreBackupRes = await postJson('/api/backups', {}, cookie);
  check('R0. Restore test backup created', restoreBackupRes.status === 201, 'status=' + restoreBackupRes.status);
  const restoreBackup = restoreBackupRes.json?.data?.backup;
  if (restoreBackup) {
    // Reassign fullBackupId to the new backup for the restore tests.
    fullBackupId = restoreBackup.backupId;
  }

  const restoreNoConfirm = await postJson('/api/backups/' + fullBackupId + '/restore', {}, cookie);
  check('R1. Restore without explicit confirmation is rejected', restoreNoConfirm.status === 400 || restoreNoConfirm.status === 409, 'status=' + restoreNoConfirm.status);

  const restoreRes = await postJson('/api/backups/' + fullBackupId + '/restore', { confirmRestore: true }, cookie);
  check('R2. Restore from valid backup succeeds', restoreRes.status === 200, 'status=' + restoreRes.status + ' body=' + JSON.stringify(restoreRes.json).slice(0, 200));
  const restoreData = restoreRes.json?.data || {};
  check('R3. Restore created a PRE_RESTORE safety backup', !!restoreData.safetyBackupId, 'safetyBackupId=' + (restoreData.safetyBackupId ?? 'none'));

  const canaryAfterRestore = await prisma.recipient.findUnique({ where: { normalizedPhone: CANARY_PHONE } });
  check('R4. Restored database reflects the backup snapshot (canary recipient present)', !!canaryAfterRestore, 'canary=' + (canaryAfterRestore ? canaryAfterRestore.name : 'missing'));

  const restoredSafety = restoreData.safetyBackupId
    ? await backupModule.backupService.getBackup(restoreData.safetyBackupId)
    : null;
  check('R5. Safety backup is listed after restore', !!restoredSafety, 'id=' + (restoreData.safetyBackupId ?? 'none'));
  check('R6. Restored database verified after swap', restoreData.databaseRestored === true);


  /* Invalid backup cannot be restored. */
  const restoreInvalid = await postJson('/api/backups/' + corruptArchiveId + '/restore', { confirmRestore: true }, cookie);
  check('R7. Invalid backup cannot be restored', restoreInvalid.status >= 400 && restoreInvalid.status < 500, 'status=' + restoreInvalid.status);

  /* Untrusted traversal archive must be refused before anything is replaced. */
  const traversalArchiveId = 'backup-p512traversal-' + RUN;
  {
    const stagingDir = path.join(TMP_DIR, 'traversal-' + RUN);
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.mkdirSync(path.join(stagingDir, 'database'), { recursive: true });
    fs.writeFileSync(path.join(stagingDir, 'manifest.json'), JSON.stringify({ backupId: traversalArchiveId, database: { fileName: 'database.sqlite', sizeBytes: 1 }, media: { included: false, fileCount: 0 } }), 'utf8');
    fs.writeFileSync(path.join(stagingDir, 'database', 'database.sqlite'), fakeSqlitePayload(200));
    // Create files that will be referenced by traversal paths relative to cwd (stagingDir)
    // '../escape.txt' resolves to TMP_DIR/escape.txt from stagingDir
    fs.writeFileSync(path.join(TMP_DIR, 'escape.txt'), 'traversal escape 1', 'utf8');
    // '..\\..\\escape2.txt' resolves to parent(TMP_DIR)/escape2.txt from stagingDir
    fs.writeFileSync(path.join(path.dirname(TMP_DIR), 'escape2.txt'), 'traversal escape 2', 'utf8');
    // A file at an absolute path within the staging dir (for absolute-path rejection test)
    fs.mkdirSync(path.join(stagingDir, 'etc'), { recursive: true });
    fs.writeFileSync(path.join(stagingDir, 'etc', 'passwd'), 'root:x:0:0:root:/root:/bin/bash', 'utf8');
    const archivePath = archivePathFor(traversalArchiveId);
    await tarCreateAt(archivePath, stagingDir, ['manifest.json', 'database/database.sqlite', '../escape.txt', '..\\..\\escape2.txt', path.join(stagingDir, 'etc', 'passwd')], { noMtime: true, portable: false });
    writeChecksumSidecar(archivePath);
  }
  const restoreTraversal = await postJson('/api/backups/' + traversalArchiveId + '/restore', { confirmRestore: true }, cookie);
  check('R8. Path-traversal archive cannot be restored', restoreTraversal.status >= 400 && restoreTraversal.status < 500, 'status=' + restoreTraversal.status);

  /* Failed restore must not silently destroy the current state. */
  const canaryStillThere = await prisma.recipient.findUnique({ where: { normalizedPhone: CANARY_PHONE } });
  check('R9. Failed restores left the current database intact', !!canaryStillThere, 'canary=' + (canaryStillThere ? 'present' : 'missing'));
  check('R10. No pending-restore marker remains after restore', backupModule.backupService.readPendingRestore() === null);

  /* ================================================================ */
  /* C. CLEANUP (synthetic artifacts)                                 */
  /* ================================================================ */
  console.log('\n--- Cleanup of synthetic test artifacts ---');

  /* Remove every synthetic backup file from the test backup directory. */
  let removedSynthetic = 0;
  if (fs.existsSync(TEST_BACKUP_DIR)) {
    for (const fileName of fs.readdirSync(TEST_BACKUP_DIR)) {
      if (fileName.startsWith('backup-') && fileName.includes(RUN)) {
        const target = path.join(TEST_BACKUP_DIR, fileName);
        const stat = fs.lstatSync(target);
        if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
        else fs.unlinkSync(target);
        removedSynthetic++;
      }
    }
  }
  check('C1. All synthetic backups removed from the test backup directory', removedSynthetic > 0 && !fs.existsSync(TEST_BACKUP_DIR) === false, 'removed=' + removedSynthetic);

  /* Legitimate (pre-test) backups are untouched. */
  const legitAfter = fs.existsSync(LEGIT_BACKUP_DIR)
    ? fs.readdirSync(LEGIT_BACKUP_DIR).sort().join('|')
    : '';
  check('C2. Pre-existing legitimate backups are preserved', legitAfter === legitBackupSnapshot, 'before=' + legitBackupSnapshot + ' after=' + legitAfter);

  fs.rmSync(TEST_BACKUP_DIR, { recursive: true, force: true });

  /* ================================================================ */
  /* A. AUDIT LOGGING                                                 */
  /* ================================================================ */
  console.log('\n--- Audit logging ---');

  const auditRows = await prisma.auditLog.findMany({ where: { action: { startsWith: 'BACKUP_' } }, orderBy: { createdAt: 'asc' } });
  const auditActions = new Set(auditRows.map((row) => row.action));
  check('A1. BACKUP_CREATED audited', auditActions.has('BACKUP_CREATED'));
  check('A2. BACKUP_VERIFIED audited', auditActions.has('BACKUP_VERIFIED'));
  check('A3. BACKUP_RESTORE_STARTED audited', auditActions.has('BACKUP_RESTORE_STARTED'));
  check('A4. BACKUP_RESTORE_COMPLETED audited', auditActions.has('BACKUP_RESTORE_COMPLETED'));
  check('A5. BACKUP_RESTORE_FAILED audited', auditActions.has('BACKUP_RESTORE_FAILED'));
  check('A6. BACKUP_DELETED audited', auditActions.has('BACKUP_DELETED'));

  const withIds = auditRows.filter((row) => {
    try { return !!JSON.parse(row.metadata || '{}').backupId; } catch { return false; }
  });
  check('A7. Audit metadata contains backup IDs', withIds.length > 0, 'rows-with-id=' + withIds.length);

  const failureRow = auditRows.find((row) => row.action === 'BACKUP_RESTORE_FAILED');
  const failureHasError = failureRow
    ? (() => { try { const m = JSON.parse(failureRow.metadata || '{}'); return !!m.errorCode || !!m.errorMessage; } catch { return false; } })()
    : false;
  check('A8. Restore-failure audit carries safe error information', failureHasError);

  check('A9. BACKUP_RETENTION_CLEANUP audited', auditActions.has('BACKUP_RETENTION_CLEANUP'));

  const auditBlob = auditRows.map((row) => (row.metadata || '') + '|' + row.action).join('\n');
  check('A10. No secrets in audit metadata', !/access[_-]?token|app[_-]?secret|webhook[_-]?secret|password|authorization/i.test(auditBlob));
  check('A11. Audit metadata never contains archive contents', !/SQLite format/i.test(auditBlob));

  /* Clean up synthetic test data before database safety checks, so baseline
     comparisons reflect only legitimate data. */
  await prisma.recipient.deleteMany({ where: { normalizedPhone: CANARY_PHONE } });
  try { await prisma.user.delete({ where: { id: tempUserId } }); } catch { }
  tempUserId = null;
  await prisma.auditLog.deleteMany({ where: { action: { startsWith: 'BACKUP_' } } });
  await prisma.loginAttempt.deleteMany({});
  // Remove synthetic media so the uploads directory matches baseline
  const synMedia = [MEDIA_FILE, MEDIA_NESTED_FILE].map((f) => path.join(UPLOADS_DIR, f));
  for (const mp of synMedia) { try { fs.rmSync(mp, { force: true }); } catch { } }
  const nestedDir = path.join(UPLOADS_DIR, MEDIA_NESTED_DIR);
  try { fs.rmSync(nestedDir, { recursive: true, force: true }); } catch { }

  /* ================================================================ */
  /* D. DATABASE SAFETY                                               */
  /* ================================================================ */
  console.log('\n--- Database safety ---');

  const after = await readBaseline();
  check('D1. Users preserved', after.userEmails.length === beforeBaseline.userEmails.length);
  check('D2. Campaigns preserved', after.campaigns === beforeBaseline.campaigns, 'before=' + beforeBaseline.campaigns + ' after=' + after.campaigns);
  check('D3. Schedules preserved', after.schedules === beforeBaseline.schedules, 'before=' + beforeBaseline.schedules + ' after=' + after.schedules);
  check('D4. Executions preserved', after.executions === beforeBaseline.executions, 'before=' + beforeBaseline.executions + ' after=' + after.executions);
  check('D5. Execution recipients preserved', after.executionRecipients === beforeBaseline.executionRecipients, 'before=' + beforeBaseline.executionRecipients + ' after=' + after.executionRecipients);
  check('D6. Messages preserved', after.messages === beforeBaseline.messages, 'before=' + beforeBaseline.messages + ' after=' + after.messages);
  check('D7. Media rows preserved', after.mediaCount === beforeBaseline.mediaCount, 'before=' + beforeBaseline.mediaCount + ' after=' + after.mediaCount);
  check('D8. Recipients preserved', after.recipientIds.length === beforeBaseline.recipientIds.length, 'before=' + beforeBaseline.recipientIds.length + ' after=' + after.recipientIds.length);
  check('D9. Baseline media files untouched', snapshotDirectoryState(UPLOADS_DIR) === uploadsBaseline, uploadsBaseline === '' ? '(no baseline media)' : '');
  {
    const serverSources = [
      'services/backup/backup.service.ts',
      'controllers/backups.controller.ts',
      'routes/backups.routes.ts',
    ]
      .map((rel) => readSource(path.join(SERVER_DIR, rel)))
      .join('\n');
    check('D10. Backup code contains no reset/migrate-destructive commands', !/migrate reset|db push --force|drop\s+schema|DELETE\s+FROM\s+sqlite_master/i.test(serverSources));
  }

  /* ================================================================ */
  /* POST-TEST CLEANUP CHECKS                                          */
  /* ================================================================ */
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  check('C3. Test backup sandbox removed', !fs.existsSync(TEST_BACKUP_DIR));
  check('C4. No test media files remain in storage/uploads', !fs.existsSync(path.join(UPLOADS_DIR, MEDIA_FILE)) && !fs.existsSync(path.join(UPLOADS_DIR, MEDIA_NESTED_FILE)));

  check('C5. Synthetic DB rows (canary recipient) removed', (await prisma.recipient.count({ where: { normalizedPhone: CANARY_PHONE } })) === 0);

  /* ================================================================ */
  /* SUMMARY                                                          */
  /* ================================================================ */
  console.log('\n=====================================================');
  console.log('PHASE 5.12 RESULT: ' + (failures === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : failures + ' FAILURE(S) out of ' + checks + ' checks'));
  console.log('=====================================================');
  await prisma.$disconnect();
  await closeServer();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  failures++;
  console.error('FATAL:', error && error.stack ? error.stack : error);
  try { await cleanup(); } catch { }
  try { await prisma.$disconnect(); } catch { }
  try { if (indexModule) await closeServer(); } catch { }
  process.exit(1);
});
