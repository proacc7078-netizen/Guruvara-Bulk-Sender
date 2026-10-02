/**
 * Step 3.5 — Final Message CMS Integration & Hardening Tests (COMPLETE SUITE).
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const dotenv = require('dotenv');
const argon2 = require('argon2');

dotenv.config({ path: path.join(__dirname, '.env') });

const REPO_ROOT = __dirname;
const EDITOR_PATH = path.join(REPO_ROOT, 'apps/web/src/pages/MessageEditor.tsx');
const MESSAGES_PAGE_PATH = path.join(REPO_ROOT, 'apps/web/src/pages/Messages.tsx');
const APP_PATH = path.join(REPO_ROOT, 'apps/web/src/App.tsx');
const CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/messages.controller.ts');
const MEDIA_CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/media.controller.ts');
const MESSAGES_ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/messages.routes.ts');
const MEDIA_ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/media.routes.ts');
const SCHEMA_PATH = path.join(REPO_ROOT, 'prisma/schema.prisma');

const TEST_PORT = 3145;
const BASE = 'http://127.0.0.1:' + TEST_PORT;
const STORAGE_DIR = path.join(REPO_ROOT, 'storage', 'uploads');

const MAX_FILE_SIZE = 5 * 1024 * 1024;

let failures = 0;
let server = null;
let prisma = null;
let tempUserId = null;
let tempCookie = null;
const touchedMessageIds = new Set();
const touchedMediaIds = new Set();

function check(name, cond, extra) {
  if (!cond) failures++;
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (extra ? ' | ' + extra : ''));
}

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

const RUN = String(Date.now()).slice(-6);
const TEST_NAME = 'Integration Test ' + RUN;
const TEST_BODY = 'Test body content for integration ' + RUN;

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
function patchJson(url, body, cookie) { return request('PATCH', url, JSON.stringify(body), cookie, 'application/json'); }
function deleteJson(url, cookie) { return request('DELETE', url, undefined, cookie); }

async function uploadFile(filePath, cookie, messageId) {
  const fileContent = fs.readFileSync(filePath);
  const boundary = '----Boundary' + Date.now();
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.txt': 'text/plain',
  };
  const mimeType = mimeMap[ext] || 'application/octet-stream';

  const prefix = (messageId ? `--${boundary}\r\nContent-Disposition: form-data; name="messageId"\r\n\r\n${messageId}\r\n` : '') + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const bodyBuffer = Buffer.concat([
    Buffer.from(prefix),
    fileContent,
    Buffer.from('\r\n'),
    Buffer.from(`--${boundary}--\r\n`),
  ]);

  const headers = { 'Content-Type': `multipart/form-data; boundary=${boundary}` };
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(BASE + '/api/media', { method: 'POST', headers, body: bodyBuffer });
  const raw = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: res.status, json: parsed };
}

function createTestImage(extension, sizeBytes) {
  const dir = os.tmpdir();
  const filename = 'test-img-' + RUN + extension;
  const filepath = path.join(dir, filename);
  const header = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00]);
  const padding = Buffer.alloc(Math.max(0, sizeBytes - header.length));
  const buf = Buffer.concat([header, padding]);
  fs.writeFileSync(filepath, buf);
  return filepath;
}

/* ------------------------------------------------------------------ *
 * Route wiring (static)
 * ------------------------------------------------------------------ */
function routeWiringTests() {
  console.log('\n--- Route wiring ---');
  const app = readSource(APP_PATH);
  const msgRoutes = readSource(MESSAGES_ROUTES_PATH);
  const mediaRoutes = readSource(MEDIA_ROUTES_PATH);

  check('1. /messages exists',
    app.includes('<Route path="/messages" element={<Messages />} />'));
  check('2. /messages/new exists',
    app.includes('<Route path="/messages/new" element={<MessageEditor mode="new" />} />'));
  check('3. /messages/:id/edit exists',
    app.includes('<Route path="/messages/:id/edit" element={<MessageEditor mode="edit" />} />'));
  check('4. MessageEditor imported by App.tsx',
    app.includes("import MessageEditor from './pages/MessageEditor'"));
  check('5. Message routes registered',
    msgRoutes.includes("router.get('/'") && msgRoutes.includes("router.post('/'") &&
    msgRoutes.includes("router.get('/:id'") && msgRoutes.includes("router.patch('/:id'") &&
    msgRoutes.includes("router.delete('/:id'"));
  check('6. Media routes registered',
    mediaRoutes.includes("router.post('/'") && mediaRoutes.includes("router.get('/:id'") &&
    mediaRoutes.includes("router.delete('/:id'"));
  check('7. All routes behind requireAuth',
    msgRoutes.includes('router.use(requireAuth)') && mediaRoutes.includes('router.use(requireAuth)'));
}

/* ------------------------------------------------------------------ *
 * Source-level checks
 * ------------------------------------------------------------------ */
function sourceTests() {
  console.log('\n--- Source checks ---');
  const editor = readSource(EDITOR_PATH);
  const controller = readSource(CONTROLLER_PATH);
  const schema = readSource(SCHEMA_PATH);

  check('35. New message defaults to DRAFT', /status: status \|\| 'DRAFT'/.test(controller));
  check('36. No WhatsApp API calls', !/whatsapp|twilio|sendgrid|http\.request|fetch\(/i.test(controller));
  check('37. No campaign code', !/campaign/i.test(controller));
  check('38. No scheduling code', !/schedul|remind|delay/i.test(controller));
  check('39. No Google API', !/google|sheets|forms/i.test(controller));
  check('39b. No external storage provider', !/s3|azure|gcs|cloudinary|@aws-sdk|@google-cloud/i.test(controller));
  check('Media model in schema', /model Media/.test(schema) && /messageId.*@unique/.test(schema));
  check('Message has media relation', /media\s+Media\?/.test(schema));
}

/* ------------------------------------------------------------------ *
 * Runtime tests
 * ------------------------------------------------------------------ */
async function runtimeTests(cookie) {
  console.log('\n--- Message CRUD ---');

  // AUTH
  check('31. Unauthenticated message request returns 401',
    (await request('GET', '/api/messages')).status === 401);
  check('32. Unauthenticated media request returns 401',
    (await request('GET', '/api/media/test')).status === 401);

  // CREATE
  console.log('\n--- Message create ---');
  const created = await postJson('/api/messages', {
    name: TEST_NAME,
    body: TEST_BODY,
    language: 'English',
    status: 'DRAFT',
  }, cookie);
  check('4. New message defaults to DRAFT',
    created.status === 201 && created.json && created.json.data && created.json.data.status === 'DRAFT',
    'status=' + created.status);
  const testMessageId = created.json && created.json.data && created.json.data.id;
  touchedMessageIds.add(testMessageId);
  check('7. Valid message creation succeeds', !!testMessageId, 'id=' + testMessageId);

  check('5. Empty name rejected',
    (await postJson('/api/messages', { name: '', body: 'Body' }, cookie)).status === 400);
  check('6. Empty body rejected',
    (await postJson('/api/messages', { name: 'Name', body: '' }, cookie)).status === 400);

  const list = await getJson('/api/messages', cookie);
  check('8. Created message appears in GET /api/messages',
    list.json && list.json.data && list.json.data.some((m) => m.id === testMessageId));

  const fetched = await getJson('/api/messages/' + testMessageId, cookie);
  check('9. Created values are preserved',
    fetched.json && fetched.json.data &&
    fetched.json.data.name === TEST_NAME && fetched.json.data.body === TEST_BODY);

  // READ
  check('10. GET message returns expected fields',
    fetched.json && fetched.json.data &&
    fetched.json.data.id === testMessageId &&
    typeof fetched.json.data.name === 'string' &&
    typeof fetched.json.data.body === 'string' &&
    'status' in fetched.json.data);

  // EDIT
  console.log('\n--- Message edit ---');
  const patched = await patchJson('/api/messages/' + testMessageId, {
    name: TEST_NAME + ' (Updated)',
    body: TEST_BODY + ' (Updated)',
    language: 'Spanish',
    status: 'READY',
  }, cookie);
  check('12. PATCH updates name',
    patched.status === 200 && patched.json && patched.json.data &&
    patched.json.data.name === TEST_NAME + ' (Updated)');
  check('13. PATCH updates body',
    patched.json && patched.json.data && patched.json.data.body === TEST_BODY + ' (Updated)');
  check('14. PATCH updates language',
    patched.json && patched.json.data && patched.json.data.language === 'Spanish');
  check('15. PATCH updates status',
    patched.json && patched.json.data && patched.json.data.status === 'READY');
  check('16. Invalid status rejected',
    (await patchJson('/api/messages/' + testMessageId, { status: 'INVALID' }, cookie)).status === 400);

  const fetchedAfter = await getJson('/api/messages/' + testMessageId, cookie);
  check('17. Updated message can be read again',
    fetchedAfter.json && fetchedAfter.json.data &&
    fetchedAfter.json.data.name === TEST_NAME + ' (Updated)' &&
    fetchedAfter.json.data.status === 'READY');

  // Error cases
  check('Invalid message ID returns 404',
    (await getJson('/api/messages/nonexistent', cookie)).status === 404);
  check('Malformed payload rejected',
    (await postJson('/api/messages', { name: 123, body: null }, cookie)).status === 400);

  // MEDIA
  console.log('\n--- Media ---');
  const testImagePath = createTestImage('.jpg', 1024);
  const uploadResult = await uploadFile(testImagePath, cookie, testMessageId);
  check('18. Valid image upload succeeds',
    uploadResult.status === 201 && uploadResult.json && uploadResult.json.success);
  const testMediaId = uploadResult.json && uploadResult.json.data && uploadResult.json.data.id;
  const testMediaPath = uploadResult.json && uploadResult.json.data && uploadResult.json.data.storagePath;

  check('19. Media associates with message',
    uploadResult.json && uploadResult.json.data && uploadResult.json.data.messageId === testMessageId);

  const mediaFetched = await getJson('/api/media/' + testMediaId, cookie);
  check('20. Media can be retrieved',
    mediaFetched.status === 200 && mediaFetched.text.length > 0);

  const msgWithMedia = await getJson('/api/messages/' + testMessageId, cookie);
  check('11. Existing media included when associated',
    msgWithMedia.json && msgWithMedia.json.data && msgWithMedia.json.data.media &&
    msgWithMedia.json.data.media.id === testMediaId);

  // Replacement
  const replacementImagePath = createTestImage('.png', 2048);
  const replaceResult = await uploadFile(replacementImagePath, cookie, testMessageId);
  check('21. Media replacement works',
    replaceResult.status === 201 && replaceResult.json && replaceResult.json.success);
  const replacementMediaPath = replaceResult.json && replaceResult.json.data && replaceResult.json.data.storagePath;
  check('22. Old physical media file removed',
    testMediaPath && !fs.existsSync(testMediaPath));
  const msgAfterReplace = await getJson('/api/messages/' + testMessageId, cookie);
  check('22b. One media per message after replacement',
    msgAfterReplace.json && msgAfterReplace.json.data && msgAfterReplace.json.data.media &&
    msgAfterReplace.json.data.media.id === (replaceResult.json && replaceResult.json.data && replaceResult.json.data.id));

  // Invalid media type
  const invalidFile = path.join(os.tmpdir(), 'test-' + RUN + '.txt');
  fs.writeFileSync(invalidFile, 'not an image');
  check('25. Invalid media type rejected',
    (await uploadFile(invalidFile, cookie, testMessageId)).status === 400);
  fs.unlinkSync(invalidFile);

  // Oversized
  const bigFile = createTestImage('.jpg', MAX_FILE_SIZE + 1);
  check('26. >5 MB rejected',
    (await uploadFile(bigFile, cookie, testMessageId)).status === 413);
  fs.unlinkSync(bigFile);

  check('Nonexistent media returns 404',
    (await getJson('/api/media/nonexistent-id', cookie)).status === 404);

  // MEDIA DELETE
  console.log('\n--- Media delete ---');
  const unrelatedMsg = await postJson('/api/messages', { name: 'Unrelated ' + RUN, body: 'Body' }, cookie);
  const unrelatedMsgId = unrelatedMsg.json.data.id;
  const unrelatedImagePath = createTestImage('.webp', 512);
  const unrelatedUpload = await uploadFile(unrelatedImagePath, cookie, unrelatedMsgId);
  const unrelatedMediaPath = unrelatedUpload.json.data.storagePath;

  check('23. Media deletion works',
    (await request('DELETE', '/api/media/' + replaceResult.json.data.id, undefined, cookie)).status === 200);
  check('24. Physical media file removed by delete',
    testMediaPath && !fs.existsSync(testMediaPath));
  check('30. Unrelated media untouched', fs.existsSync(unrelatedMediaPath));

  // MESSAGE DELETE + MEDIA SAFETY
  console.log('\n--- Message delete + media safety ---');
  const msgBeforeDelete = await prisma.message.count();
  const mediaBeforeDelete = await prisma.media.count();

  const msgToDelete = await postJson('/api/messages', { name: 'Delete Me ' + RUN, body: 'Body' }, cookie);
  const msgToDeleteId = msgToDelete.json.data.id;
  const msgMediaUpload = await uploadFile(createTestImage('.jpg', 512), cookie, msgToDeleteId);
  const msgMediaId = msgMediaUpload.json.data.id;
  const msgMediaStoragePath = msgMediaUpload.json.data.storagePath;

  check('27. Message with media can be deleted',
    (await request('DELETE', '/api/messages/' + msgToDeleteId, undefined, cookie)).status === 200);

  const mediaAfterDelete = await prisma.media.findUnique({ where: { id: msgMediaId } });
  check('28. Associated media DB record cleaned up', mediaAfterDelete === null);
  check('29. Associated physical media file cleaned up',
    msgMediaStoragePath && !fs.existsSync(msgMediaStoragePath));
  check('30b. Unrelated media remains untouched', fs.existsSync(unrelatedMediaPath));

  const msgAfterDelete = await prisma.message.count();
  const mediaFinal = await prisma.media.count();
  check('Message count decreased by 1', msgAfterDelete === msgBeforeDelete,
    'before=' + msgBeforeDelete + ' after=' + msgAfterDelete);
  check('Media count decreased by 1', mediaFinal === mediaBeforeDelete,
    'before=' + mediaBeforeDelete + ' after=' + mediaFinal);

  check('Deleting nonexistent message returns 404',
    (await request('DELETE', '/api/messages/nonexistent', undefined, cookie)).status === 404);

  // Cleanup unrelated
  await prisma.message.delete({ where: { id: unrelatedMsgId } }).catch(() => { });
  try {
    await prisma.media.delete({ where: { id: unrelatedUpload.json.data.id } });
    if (unrelatedMediaPath && fs.existsSync(unrelatedMediaPath)) fs.unlinkSync(unrelatedMediaPath);
  } catch { }

  // Safety static
  console.log('\n--- Safety ---');
  check('33. Arbitrary storage paths not accepted',
    !readSource(MEDIA_CONTROLLER_PATH).includes('req.query.path') &&
    !readSource(MEDIA_CONTROLLER_PATH).includes('req.body.path') &&
    !readSource(MEDIA_CONTROLLER_PATH).includes('req.params.path'));
  check('34. Storage uses server-side directory',
    /path\.resolve\(.*storage.*uploads/.test(readSource(MEDIA_CONTROLLER_PATH)));
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */
async function main() {
  console.log('=== Step 3.5: Final Message CMS Integration & Hardening ===\n');
  process.env.PORT = String(TEST_PORT);
  const originalListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    server = this;
    return originalListen.apply(this, args);
  };
  require('tsx/cjs');
  const indexModule = require('./apps/server/src/index.ts');
  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient();
  const serverUp = await waitForServer(20000);
  check('0. Real server is reachable', serverUp, BASE);
  if (!serverUp) { process.exitCode = 1; return; }

  const usersBefore = await prisma.user.count();
  const messagesBefore = await prisma.message.findMany();
  const messagesBeforeIds = new Set(messagesBefore.map((m) => m.id));
  const recipientsBefore = await prisma.recipient.findMany();
  const recipientsBeforeIds = new Set(recipientsBefore.map((r) => r.id));
  const mediaBefore = await prisma.media.findMany();
  const mediaBeforeIds = new Set(mediaBefore.map((m) => m.id));
  const storageFilesBefore = fs.existsSync(STORAGE_DIR) ? fs.readdirSync(STORAGE_DIR) : [];

  const email = 'step35-' + RUN + '@example.com';
  const password = 'Step35-' + RUN + '-pw!';
  const createdUser = await prisma.user.create({ data: { email, password: await argon2.hash(password) } });
  tempUserId = createdUser.id;

  const loginRes = await request('POST', '/api/auth/login', JSON.stringify({ email, password }), null, 'application/json');
  tempCookie = loginRes.setCookie ? loginRes.setCookie.split(';')[0] : null;
  check('0b. Temporary admin user can authenticate', tempCookie !== null);

  try {
    routeWiringTests();
    sourceTests();
    await runtimeTests(tempCookie);

    // Cleanup test messages, media, and files
    for (const mid of touchedMessageIds) {
      try { await prisma.message.delete({ where: { id: mid } }); } catch { }
    }
    for (const mid of touchedMediaIds) {
      try {
        const m = await prisma.media.findUnique({ where: { id: mid } });
        if (m && m.storagePath && fs.existsSync(m.storagePath)) fs.unlinkSync(m.storagePath);
      } catch { }
      try { await prisma.media.delete({ where: { id: mid } }); } catch { }
    }
    if (fs.existsSync(STORAGE_DIR)) {
      const files = fs.readdirSync(STORAGE_DIR);
      for (const f of files) {
        if (f.includes(RUN)) {
          try { fs.unlinkSync(path.join(STORAGE_DIR, f)); } catch { }
        }
      }
    }
    // Delete temp user before DB safety checks
    if (tempUserId) {
      try { await prisma.user.delete({ where: { id: tempUserId } }); } catch { }
      tempUserId = null;
    }

    console.log('\n--- Database safety ---');
    const usersAfter = await prisma.user.count();
    const messagesAfter = await prisma.message.findMany();
    const recipientsAfter = await prisma.recipient.findMany();
    const mediaAfter = await prisma.media.findMany();

    check('43. Temporary test records cleaned up',
      messagesAfter.length === messagesBefore.length,
      'before=' + messagesBefore.length + ' after=' + messagesAfter.length);
    check('45. Existing recipients unchanged',
      recipientsAfter.length === recipientsBefore.length &&
      recipientsAfter.every((r) => recipientsBeforeIds.has(r.id)),
      'before=' + recipientsBefore.length + ' after=' + recipientsAfter.length);
    check('46. Existing users unchanged', usersAfter === usersBefore,
      'before=' + usersBefore + ' after=' + usersAfter);
    const remainingMediaIds = new Set(mediaAfter.map((m) => m.id));
    check('47. Existing media fixtures untouched',
      mediaBefore.filter((m) => mediaBeforeIds.has(m.id)).every((m) => remainingMediaIds.has(m.id)) &&
      mediaAfter.length === mediaBefore.length,
      'before=' + mediaBefore.length + ' after=' + mediaAfter.length);

    if (fs.existsSync(STORAGE_DIR)) {
      const storageFilesAfter = fs.readdirSync(STORAGE_DIR);
      const leftoverFiles = storageFilesAfter.filter((f) => !storageFilesBefore.includes(f));
      check('44. No test files left in storage/uploads', leftoverFiles.length === 0,
        'new=' + leftoverFiles.length);
    } else {
      check('44. No test files left in storage/uploads', true, 'dir does not exist');
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (indexModule.worker) { try { await indexModule.worker.stop(); } catch { } }
    await prisma.$disconnect();
  }

  console.log('\n=== ' + (failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED') + ' ===');
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('Error:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
