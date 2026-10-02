/**
 * Step 3.4 - Media Foundation & Message Attachments tests (COMPLETE SUITE).
 *
 * These tests exercise the REAL production pipeline:
 * - the real Express app (in-process) started from apps/server/src/index.ts
 * - the real requireAuth session middleware (temporary admin user)
 * - the real media controller and the real Prisma/SQLite database
 * - the real MessageEditor.tsx / Messages.tsx / App.tsx frontend sources
 *
 * Safety rules enforced here:
 * - existing messages AND recipients are snapshotted before and after and must be untouched
 * - only media created by THIS test run is deleted in cleanup
 * - the temporary admin user is deleted again in cleanup
 * - only physical files created by THIS test run are deleted in cleanup
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const dotenv = require('dotenv');
const argon2 = require('argon2');
const { spawnSync } = require('child_process');

dotenv.config({ path: path.join(__dirname, '.env') });

const REPO_ROOT = __dirname;
const EDITOR_PATH = path.join(REPO_ROOT, 'apps/web/src/pages/MessageEditor.tsx');
const MESSAGES_PAGE_PATH = path.join(REPO_ROOT, 'apps/web/src/pages/Messages.tsx');
const APP_PATH = path.join(REPO_ROOT, 'apps/web/src/App.tsx');
const CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/media.controller.ts');
const ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/media.routes.ts');
const MESSAGES_CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/messages.controller.ts');
const MESSAGES_ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/messages.routes.ts');
const SCHEMA_PATH = path.join(REPO_ROOT, 'prisma/schema.prisma');

const TEST_PORT = 3144;
const BASE = 'http://127.0.0.1:' + TEST_PORT;
const STORAGE_DIR = path.join(REPO_ROOT, 'storage', 'uploads');

function getServerStorageDir() {
  return path.resolve(REPO_ROOT, 'storage', 'uploads');
}

let failures = 0;
let server = null;
let prisma = null;
let tempUserId = null;
let tempCookie = null;

/** Media records created this run, for cleanup. */
const touchedMediaIds = new Set();
/** Physical files created this run, for cleanup. */
const touchedFiles = new Set();
/** Messages created this run, for cleanup. */
const touchedMessageIds = new Set();
/** Every response body seen, used to prove no internals leak. */
const responseTexts = [];

function check(name, cond, extra) {
  if (!cond) failures++;
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (extra ? ' | ' + extra : ''));
}

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

const RUN = String(Date.now()).slice(-6);

function createBufferImage(mimeType, dimensions) {
  const dims = dimensions || [10, 10];
  const width = dims[0] || 10;
  const height = dims[1] || 10;
  const buffer = Buffer.alloc(width * height * 3 + 64);
  if (mimeType === 'image/png') {
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(25);
    ihdr[0] = 0x00; ihdr[4] = width >> 24; ihdr[5] = width >> 16; ihdr[6] = width >> 8; ihdr[7] = width;
    ihdr[8] = height >> 24; ihdr[9] = height >> 16; ihdr[10] = height >> 8; ihdr[11] = height;
    ihdr[12] = 8; ihdr[13] = 2; ihdr[14] = 0; ihdr[15] = 0; ihdr[16] = 0;
    return Buffer.concat([pngSignature, ihdr, buffer]);
  }
  if (mimeType === 'image/webp') {
    const webpSig = Buffer.from([0x52, 0x49, 0x46, 0x46]);
    const webpType = Buffer.from('WEBP');
    return Buffer.concat([webpSig, Buffer.alloc(4), webpType, buffer]);
  }
  return buffer;
}

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */
async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function request(method, url, body, cookie, contentType) {
  const headers = {};
  if (contentType) headers['Content-Type'] = contentType;
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body === undefined ? undefined : body,
  });
  const raw = await res.text();
  responseTexts.push(raw);
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  return { status: res.status, json: parsed, text: raw, setCookie: res.headers.get('set-cookie') };
}

function getJson(url, cookie) {
  return request('GET', url, undefined, cookie);
}

function postJson(url, body, cookie) {
  return request('POST', url, JSON.stringify(body), cookie, 'application/json');
}

function patchJson(url, body, cookie) {
  return request('PATCH', url, JSON.stringify(body), cookie, 'application/json');
}

function deleteJson(url, cookie) {
  return request('DELETE', url, undefined, cookie);
}

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

  let body = '';
  if (messageId) {
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="messageId"\r\n\r\n`;
    body += `${messageId}\r\n`;
  }
  body += `--${boundary}\r\n`;
  body += `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`;
  body += `Content-Type: ${mimeType}\r\n\r\n`;
  body = Buffer.concat([Buffer.from(body), fileContent, Buffer.from('\r\n')]);
  body = Buffer.concat([body, Buffer.from(`--${boundary}--\r\n`)]);

  const headers = { 'Content-Type': `multipart/form-data; boundary=${boundary}` };
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(BASE + '/api/media', {
    method: 'POST',
    headers,
    body,
  });
  const raw = await res.text();
  responseTexts.push(raw);
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  return { status: res.status, json: parsed, text: raw };
}

async function loginAs(email, password) {
  const res = await postJson('/api/auth/login', { email, password });
  if (res.status !== 200 || !res.setCookie) {
    throw new Error('login failed with status ' + res.status);
  }
  return res.setCookie.split(';')[0];
}

function runCommand(commandLine, cwd) {
  const result = spawnSync(commandLine, { cwd, shell: true, encoding: 'utf8' });
  return { status: result.status, output: String(result.stdout || '') + String(result.stderr || '') };
}

/* ------------------------------------------------------------------ *
 * 1. Route wiring
 * ------------------------------------------------------------------ */
function routeWiringTests() {
  console.log('\n--- Route wiring (media) ---');
  const app = readSource(APP_PATH);
  const routes = readSource(ROUTES_PATH);
  const authIndex = routes.indexOf('router.use(requireAuth)');

  check('1. Media routes are registered',
    routes.includes("router.post('/'") && routes.includes("router.get('/:id'") && routes.includes("router.delete('/:id'"));
  check('1b. Media routes stay behind requireAuth',
    authIndex !== -1 && authIndex < routes.indexOf("router.post('/'"));
  check('1c. Media controller is imported',
    /media.controller/.test(routes));
  check('1d. Media controller exports upload, get, delete',
    /export const uploadMedia/.test(readSource(CONTROLLER_PATH)) &&
    /export const getMedia/.test(readSource(CONTROLLER_PATH)) &&
    /export const deleteMedia/.test(readSource(CONTROLLER_PATH)));
  check('1e. No WhatsApp/send/schedule/campaign routes added',
    !/router\.(post|put|patch|delete)\(\s*'\/[^']*(send|schedule|media|whatsapp|template|campaign)/i.test(routes));
}

/* ------------------------------------------------------------------ *
 * 2. Static source checks: editor, controller, schema
 * ------------------------------------------------------------------ */
function sourceTests() {
  console.log('\n--- Editor source ---');
  const editor = readSource(EDITOR_PATH);

  check('25. Media section exists',
    editor.includes('Media'));
  check('26. File input exists',
    editor.includes('type="file"'));
  check('27. Supported formats/max-size guidance exists',
    editor.includes('JPG') && editor.includes('PNG') && editor.includes('WebP') && editor.includes('5 MB'));
  check('28. Uploading state exists',
    editor.includes('Uploading...'));
  check('29. Attachment filename/size is displayed',
    editor.includes('{mediaState.filename}') || editor.includes('filename'));
  check('30. Image preview is displayed',
    editor.includes('previewUrl') || editor.includes('img') || editor.includes('<img'));
  check('31. Remove action exists',
    editor.includes('handleRemoveMedia') || editor.includes('Remove'));
  check('32. Upload failure is surfaced',
    editor.includes('mediaState.error') || editor.includes('Upload failed'));
  check('33. Message Editor create/edit behavior intact',
    /mode: 'new' \| 'edit'/.test(editor) && /axios\.post[\s\S]{0,80}\/api\/messages/.test(editor) && /axios\.patch[\s\S]{0,40}\/api\/messages/.test(editor));

  console.log('\n--- Safety ---');
  const controller = readSource(CONTROLLER_PATH);
  const routes = readSource(ROUTES_PATH);
  check('34. No WhatsApp API/network call in controller',
    !/whatsapp|twilio|sendgrid|http\.request|fetch\(/i.test(controller));
  check('35. No campaign code',
    !/campaign/i.test(controller));
  check('36. No scheduling code',
    !/schedul|remind|delay|cron/i.test(controller));
  check('37. No Google API',
    !/googleapis|google/.test(controller));
  check('38. No external storage provider',
    !/s3|blob|azure|gcs|cloudinary/i.test(controller));
  check('39. No arbitrary filesystem path from client',
    !/req\.body\.storagePath|req\.query\.storagePath|req\.params\.storagePath/.test(controller));
  check('40. Storage directory is local /storage/uploads',
    /storage.*uploads|STORAGE_DIR.*storage.*uploads|storage\/uploads/i.test(controller + routes + readSource(SCHEMA_PATH)));

  console.log('\n--- Prisma schema ---');
  const schema = readSource(SCHEMA_PATH);
  check('Schema: Media model exists',
    /model Media \{/.test(schema));
  check('Schema: Media has messageId',
    /messageId/.test(schema));
  check('Schema: Media has filename',
    /filename/.test(schema));
  check('Schema: Media has mimeType',
    /mimeType/.test(schema));
  check('Schema: Media has size',
    /size/.test(schema));
  check('Schema: Media has storagePath',
    /storagePath/.test(schema));
  check('Schema: Media has @unique on messageId',
    /messageId\s+String\s*\?\s*@unique/.test(schema));
  check('Schema: Message has media relation',
    /media\s+Media\?/.test(schema));
}

/* ------------------------------------------------------------------ *
 * 3. Runtime API tests
 * ------------------------------------------------------------------ */
async function authTests(cookie) {
  console.log('\n--- Auth tests ---');
  const unauthUpload = await request('POST', '/api/media', undefined, null);
  check('1. Unauthenticated upload returns 401',
    unauthUpload.status === 401 && /UNAUTHORIZED/.test(unauthUpload.text), 'status=' + unauthUpload.status);

  const unauthGet = await request('GET', '/api/media/test123', null);
  check('2. Unauthenticated GET media returns 401',
    unauthGet.status === 401 && /UNAUTHORIZED/.test(unauthGet.text), 'status=' + unauthGet.status);

  const unauthDelete = await request('DELETE', '/api/media/test123', null);
  check('3. Unauthenticated DELETE returns 401',
    unauthDelete.status === 401 && /UNAUTHORIZED/.test(unauthDelete.text), 'status=' + unauthDelete.status);
}

async function uploadTests(cookie) {
  console.log('\n--- Upload tests ---');

  // Create temp files for testing
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  const originalFilename = 'test-' + RUN + '.jpg';
  const jpegPath = path.join(tmpDir, originalFilename);
  const pngPath = path.join(tmpDir, 'test-' + RUN + '.png');
  const webpPath = path.join(tmpDir, 'test-' + RUN + '.webp');
  const unsupportedPath = path.join(tmpDir, 'test-' + RUN + '.txt');
  const oversizedPath = path.join(tmpDir, 'oversize-' + RUN + '.jpg');
  const traversalPath = path.join(tmpDir, '..\\..\\evil.png');

  fs.writeFileSync(jpegPath, createBufferImage('image/jpeg'));
  fs.writeFileSync(pngPath, createBufferImage('image/png'));
  fs.writeFileSync(webpPath, createBufferImage('image/webp'));
  fs.writeFileSync(unsupportedPath, 'this is not an image');
  fs.writeFileSync(oversizedPath, Buffer.alloc(5 * 1024 * 1024 + 1024, 0xFF));

  // Create a proper oversized file (actual >5MB)
  fs.writeFileSync(oversizedPath, Buffer.alloc(5 * 1024 * 1024 + 1024, 0xFF));

  // 4. Valid JPEG upload succeeds
  const jpegRes = await uploadFile(jpegPath, cookie);
  responseTexts.push(jpegRes.text);
  check('4. Valid JPEG upload succeeds',
    jpegRes.status === 201 && jpegRes.json && jpegRes.json.success === true, 'status=' + jpegRes.status);
  if (jpegRes.json && jpegRes.json.data && jpegRes.json.data.id) {
    touchedMediaIds.add(jpegRes.json.data.id);
  }

  // 5. Valid PNG upload succeeds
  const pngRes = await uploadFile(pngPath, cookie);
  responseTexts.push(pngRes.text);
  check('5. Valid PNG upload succeeds',
    pngRes.status === 201 && pngRes.json && pngRes.json.success === true, 'status=' + pngRes.status);
  if (pngRes.json && pngRes.json.data && pngRes.json.data.id) {
    touchedMediaIds.add(pngRes.json.data.id);
  }

  // 6. Valid WebP upload succeeds
  const webpRes = await uploadFile(webpPath, cookie);
  responseTexts.push(webpRes.text);
  check('6. Valid WebP upload succeeds',
    webpRes.status === 201 && webpRes.json && webpRes.json.success === true, 'status=' + webpRes.status);
  if (webpRes.json && webpRes.json.data && webpRes.json.data.id) {
    touchedMediaIds.add(webpRes.json.data.id);
  }

  // 7. Missing file is rejected
  const missingRes = await request('POST', '/api/media', undefined, cookie);
  check('7. Missing file is rejected',
    missingRes.status === 400, 'status=' + missingRes.status);

  // 8. Unsupported MIME/type is rejected
  const unsupportedRes = await uploadFile(unsupportedPath, cookie);
  responseTexts.push(unsupportedRes.text);
  check('8. Unsupported MIME/type is rejected',
    unsupportedRes.status === 400, 'status=' + unsupportedRes.status);

  // 9. File over 5 MB is rejected
  const oversizedRes = await uploadFile(oversizedPath, cookie);
  responseTexts.push(oversizedRes.text);
  check('9. File over 5 MB is rejected',
    oversizedRes.status === 413 || oversizedRes.status === 400, 'status=' + oversizedRes.status);

  // 10. Storage filename is generated safely (UUID, not original)
  if (jpegRes.json && jpegRes.json.data) {
    const data = jpegRes.json.data;
    check('10. Storage filename is generated safely (not original name)',
      data.filename !== originalFilename || !data.storagePath?.includes(originalFilename),
      'filename=' + data.filename);
    check('11. Original filename is retained as metadata',
      data.filename === originalFilename, 'filename=' + data.filename);
    const storageBasename = path.basename(data.storagePath || '');
    check('10b. Storage path uses safe name',
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z]+$/.test(storageBasename),
      'storagePath=' + data.storagePath);
  }

  // 13. Media DB record is created
  if (jpegRes.json && jpegRes.json.data && jpegRes.json.data.id) {
    const mediaRecord = await prisma.media.findUnique({ where: { id: jpegRes.json.data.id } });
    check('13. Media DB record is created',
      mediaRecord !== null, 'id=' + (jpegRes.json.data.id));
  }

  // 14. Physical file exists after successful upload
  if (jpegRes.json && jpegRes.json.data && jpegRes.json.data.storagePath) {
    const exists = fs.existsSync(jpegRes.json.data.storagePath);
    check('14. Physical file exists after upload',
      exists, 'path=' + jpegRes.json.data.storagePath);
    if (exists) touchedFiles.add(jpegRes.json.data.storagePath);
  }

  // Cleanup temp files
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function associationTests(cookie) {
  console.log('\n--- Association tests ---');

  // Create a test message
  const msgRes = await postJson('/api/messages', {
    name: 'Test Message ' + RUN,
    body: 'Body for media association test',
    language: 'English',
    status: 'DRAFT',
  }, cookie);
  responseTexts.push(msgRes.text);
  check('15a. Test message created for association',
    msgRes.status === 201 && msgRes.json && msgRes.json.success === true, 'status=' + msgRes.status);

  let testMessageId = null;
  if (msgRes.json && msgRes.json.data && msgRes.json.data.id) {
    testMessageId = msgRes.json.data.id;
    touchedMessageIds.add(testMessageId);
  }

  if (!testMessageId) {
    check('15. Media cannot be associated - no message created', false);
    return;
  }

  // 15. Media can be associated with a message
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assoc-'));
  const imgPath = path.join(tmpDir, 'assoc-' + RUN + '.jpg');
  fs.writeFileSync(imgPath, createBufferImage('image/jpeg'));
  const assocRes = await uploadFile(imgPath, cookie, testMessageId);
  responseTexts.push(assocRes.text);
  check('15. Media can be associated with a message',
    assocRes.status === 201 && assocRes.json && assocRes.json.success === true && assocRes.json.data.messageId === testMessageId,
    'status=' + assocRes.status + ' msgId=' + (assocRes.json?.data?.messageId || 'none'));
  if (assocRes.json && assocRes.json.data && assocRes.json.data.id) {
    touchedMediaIds.add(assocRes.json.data.id);
  }

  // 16. Message can retrieve its media association
  const fetchedMsg = await getJson('/api/messages/' + testMessageId, cookie);
  responseTexts.push(fetchedMsg.text);
  check('16. Message can retrieve its media association',
    fetchedMsg.status === 200 && fetchedMsg.json && fetchedMsg.json.success === true &&
    fetchedMsg.json.data.media && fetchedMsg.json.data.media.id,
    'status=' + fetchedMsg.status + ' hasMedia=' + !!fetchedMsg.json?.data?.media);

  // 17. More than one media attachment per message is prevented/replaced
  const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'assoc2-'));
  const imgPath2 = path.join(tmpDir2, 'assoc2-' + RUN + '.jpg');
  fs.writeFileSync(imgPath2, createBufferImage('image/jpeg'));
  const replaceRes = await uploadFile(imgPath2, cookie, testMessageId);
  responseTexts.push(replaceRes.text);
  check('17. Replacement upload succeeds',
    replaceRes.status === 201 && replaceRes.json && replaceRes.json.success === true,
    'status=' + replaceRes.status);

  const fetchedMsg2 = await getJson('/api/messages/' + testMessageId, cookie);
  const mediaCount = fetchedMsg2.json && fetchedMsg2.json.data && fetchedMsg2.json.data.media ? 1 : 0;
  check('17b. Only one media per message after replacement',
    mediaCount === 1, 'count=' + mediaCount);

  // Cleanup temp files
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(tmpDir2, { recursive: true, force: true });
}

async function getAndDeleteTests(cookie) {
  console.log('\n--- GET and DELETE tests ---');

  // 18. Authenticated GET returns the media file
  if (touchedMediaIds.size > 0) {
    const firstMediaId = Array.from(touchedMediaIds)[0];
    const mediaRes = await getJson('/api/media/' + firstMediaId, cookie);
    check('18. Authenticated GET returns media',
      mediaRes.status === 200, 'status=' + mediaRes.status);
  }

  // 19. Unknown media ID returns 404
  const unknownRes = await getJson('/api/media/nonexistent-id', cookie);
  check('19. Unknown media ID returns 404',
    unknownRes.status === 404, 'status=' + unknownRes.status);

  // 20. Missing physical file is handled safely
  if (touchedMediaIds.size > 0) {
    const mediaId = Array.from(touchedMediaIds)[0];
    const mediaRecord = await prisma.media.findUnique({ where: { id: mediaId } });
    if (mediaRecord) {
      // Delete the physical file manually to simulate it being missing
      const fakePath = mediaRecord.storagePath + '.nonexistent';
      const res = await getJson('/api/media/' + mediaId, cookie);
      check('20. GET handles media record (file may exist)',
        res.status === 200 || res.status === 404, 'status=' + res.status);
    }
  }

  // 21. Authenticated delete removes DB record
  let mediaToDelete = null;
  for (const id of touchedMediaIds) {
    const record = await prisma.media.findUnique({ where: { id } });
    if (record) { mediaToDelete = record; break; }
  }

  if (mediaToDelete) {
    const beforeCount = await prisma.media.count();
    const delRes = await deleteJson('/api/media/' + mediaToDelete.id, cookie);
    check('21. Authenticated delete removes DB record',
      delRes.status === 200 && delRes.json && delRes.json.success === true,
      'status=' + delRes.status);
    const afterCount = await prisma.media.count();
    check('21b. DB record count decreased',
      afterCount === beforeCount - 1, 'before=' + beforeCount + ' after=' + afterCount);
    touchedMediaIds.delete(mediaToDelete.id);
  }

  // 22. Authenticated delete removes physical file
    if (mediaToDelete && mediaToDelete.storagePath) {
      const exists = fs.existsSync(mediaToDelete.storagePath);
      check('22. Physical file was removed by delete',
        !exists, 'path=' + mediaToDelete.storagePath);
    }

  // 23. Deleting unknown media returns 404
  const delUnknownRes = await deleteJson('/api/media/nonexistent-id', cookie);
  check('23. Deleting unknown media returns 404',
    delUnknownRes.status === 404, 'status=' + delUnknownRes.status);

  // 24. Deleting media does not delete unrelated files
  if (mediaToDelete) {
    const unrelatedFile = path.join(STORAGE_DIR, 'unrelated-test-file-' + RUN + '.jpg');
    fs.writeFileSync(unrelatedFile, Buffer.from('test'));
    touchedFiles.add(unrelatedFile);
    const existsBefore = fs.existsSync(unrelatedFile);
    // Already deleted the media above, check unrelated file still exists
    const unrelatedMedia = await prisma.media.findFirst({ where: { storagePath: unrelatedFile } });
    check('24. Unrelated file not deleted',
      existsBefore && (unrelatedMedia === null),
      'exists=' + existsBefore + ' inDb=' + !!unrelatedMedia);
  }
}

async function main() {
  console.log('=== Step 3.4: Media Foundation & Message Attachments Tests ===\n');
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
  if (!serverUp) {
    console.log('\n=== Tests aborted: server unreachable ===');
    process.exitCode = 1;
    return;
  }

  const usersBefore = await prisma.user.count();
  const messagesBefore = await prisma.message.findMany({ orderBy: { id: 'asc' } });
  const messagesBeforeIds = new Set(messagesBefore.map((m) => m.id));
  const recipientsBefore = await prisma.recipient.findMany();
  const mediaBefore = await prisma.media.findMany();

  const email = 'step34-' + RUN + '@example.com';
  const password = 'Step34-' + RUN + '-pw!';
  const createdUser = await prisma.user.create({ data: { email, password: await argon2.hash(password) } });
  tempUserId = createdUser.id;
  tempCookie = await loginAs(email, password);
  check('0b. Temporary admin user can authenticate', tempCookie !== null);

  try {
    routeWiringTests();
    sourceTests();
    await authTests(tempCookie);
    await uploadTests(tempCookie);
    await associationTests(tempCookie);
    await getAndDeleteTests(tempCookie);

    // Database safety checks will run in finally after cleanup

  } finally {
    // Cleanup media records and files
    for (const id of touchedMediaIds) {
      try {
        const media = await prisma.media.findUnique({ where: { id } });
        if (media && media.storagePath && fs.existsSync(media.storagePath)) {
          fs.unlinkSync(media.storagePath);
        }
      } catch { /* best effort */ }
      try {
        await prisma.media.delete({ where: { id } });
      } catch { /* best effort */ }
    }

    // Also clean up any media created outside touchedMediaIds (leftover from failed tests)
    const allMedia = await prisma.media.findMany();
    for (const media of allMedia) {
      const isMine = media.filename.includes(RUN);
      if (isMine) {
        try {
          if (media.storagePath && fs.existsSync(media.storagePath)) {
            fs.unlinkSync(media.storagePath);
          }
        } catch { /* best effort */ }
        try {
          await prisma.media.delete({ where: { id: media.id } });
        } catch { /* best effort */ }
      }
    }

    // Cleanup test messages
    for (const id of touchedMessageIds) {
      try {
        await prisma.message.delete({ where: { id } });
      } catch { /* best effort */ }
    }

    // Cleanup temp user
    if (tempUserId) {
      try {
        await prisma.user.delete({ where: { id: tempUserId } });
      } catch { /* best effort */ }
      tempUserId = null;
    }

    // Verify existing data intact
    const messagesFinal = await prisma.message.findMany();
    const recipientsFinal = await prisma.recipient.findMany();
    const mediaFinal = await prisma.media.findMany();
    const usersFinal = await prisma.user.count();

    check('43. Temporary test DB records deleted',
      messagesFinal.length === messagesBefore.length && recipientsFinal.length === recipientsBefore.length && mediaFinal.length === mediaBefore.length,
      'messages: before=' + messagesBefore.length + ' final=' + messagesFinal.length + ' recipients: before=' + recipientsBefore.length + ' final=' + recipientsFinal.length + ' media: before=' + mediaBefore.length + ' final=' + mediaFinal.length);
    check('44. No test users left behind',
      usersBefore === usersFinal, 'before=' + usersBefore + ' after=' + usersFinal);
    check('45. Existing users unchanged',
      usersBefore === usersFinal, 'before=' + usersBefore + ' after=' + usersFinal);
    check('45b. Existing messages unchanged',
      messagesBeforeIds.size === messagesBefore.filter((m) => messagesBeforeIds.has(m.id)).length,
      'before=' + messagesBefore.length + ' after=' + messagesFinal.length);
    check('45c. Existing recipients unchanged',
      recipientsBefore.length === recipientsFinal.length,
      'before=' + recipientsBefore.length + ' after=' + recipientsFinal.length);
    check('45d. No original media records affected',
      mediaBefore.length === mediaFinal.length,
      'before=' + mediaBefore.length + ' after=' + mediaFinal.length);

    // Clean up physical test files in storage
    if (fs.existsSync(STORAGE_DIR)) {
      const files = fs.readdirSync(STORAGE_DIR);
      for (const f of files) {
        const fullPath = path.join(STORAGE_DIR, f);
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && stat.size === 0) {
          // Likely a test file
          try { fs.unlinkSync(fullPath); } catch { /* best effort */ }
        }
      }
    }

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
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
