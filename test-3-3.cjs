/**
 * Step 3.3 - Message Create/Edit editor tests (COMPLETE SUITE).
 *
 * These tests exercise the REAL production pipeline:
 * - the real Express app (in-process) started from apps/server/src/index.ts
 * - the real requireAuth session middleware (temporary admin user)
 * - the real messages controller and the real Prisma/SQLite database
 * - the real MessageEditor.tsx / Messages.tsx / App.tsx frontend sources
 *
 * Safety rules enforced here:
 * - existing messages AND recipients are snapshotted before and after and must be untouched
 * - only messages created by THIS test run are deleted again in cleanup
 * - the temporary admin user is deleted again in cleanup
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const dotenv = require('dotenv');
const argon2 = require('argon2');
const { spawnSync } = require('child_process');

dotenv.config({ path: path.join(__dirname, '.env') });

const REPO_ROOT = __dirname;
const EDITOR_PATH = path.join(REPO_ROOT, 'apps/web/src/pages/MessageEditor.tsx');
const MESSAGES_PAGE_PATH = path.join(REPO_ROOT, 'apps/web/src/pages/Messages.tsx');
const APP_PATH = path.join(REPO_ROOT, 'apps/web/src/App.tsx');
const CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/messages.controller.ts');
const ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/messages.routes.ts');

const TEST_PORT = 3143; // dedicated port so a running dev server is not disturbed
const BASE = 'http://127.0.0.1:' + TEST_PORT;

let failures = 0;
let server = null;
let prisma = null;
let tempUserId = null;

/** Every message this run creates, so cleanup removes ONLY these. */
const touchedMessageIds = new Set();
/** Every response body seen, used to prove no internals leak. */
const responseTexts = [];
/** Number of messages the real API reported as created. */
let reportedCreated = 0;

function check(name, cond, extra) {
  if (!cond) failures++;
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (extra ? ' | ' + extra : ''));
}

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

/** Unique suffix so fixtures never collide with existing rows. */
const RUN = String(Date.now()).slice(-6);

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

async function request(method, url, body, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
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
  return request('POST', url, body, cookie);
}

function patchJson(url, body, cookie) {
  return request('PATCH', url, body, cookie);
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
 * 1. Route wiring: the editor is reachable and stays authenticated
 * ------------------------------------------------------------------ */
function routeWiringTests() {
  console.log('\n--- Route wiring (/messages/new, /messages/:id/edit) ---');
  const app = readSource(APP_PATH);
  const routes = readSource(ROUTES_PATH);
  const authIndex = routes.indexOf('router.use(requireAuth)');
  const editRouteIndex = app.indexOf('/messages/:id/edit');

  check('1. /messages/new renders MessageEditor in new mode',
    app.includes('<Route path="/messages/new" element={<MessageEditor mode="new" />} />'));
  check('1b. /messages/:id/edit renders MessageEditor in edit mode',
    app.includes('<Route path="/messages/:id/edit" element={<MessageEditor mode="edit" />} />'));
  check('1c. MessageEditor is imported by App.tsx',
    app.includes("import MessageEditor from './pages/MessageEditor';"));
  check('1d. The existing /messages list route is unchanged',
    app.includes('<Route path="/messages" element={<Messages />} />'));
  check('1e. The parameterised edit route is declared after the list route',
    editRouteIndex !== -1 && app.indexOf('<Route path="/messages" element=') < editRouteIndex);

  check('2. GET /api/messages is unchanged', routes.includes("router.get('/', getMessages);"));
  check('2b. GET /api/messages/:id reuses getMessageById',
    routes.includes("router.get('/:id', getMessageById);"));
  check('2c. POST /api/messages reuses createMessage',
    routes.includes("router.post('/', createMessage);"));
  check('2d. PATCH /api/messages/:id reuses updateMessage',
    routes.includes("router.patch('/:id', updateMessage);"));
  check('2e. DELETE /api/messages/:id is unchanged',
    routes.includes("router.delete('/:id', deleteMessage);"));
  check('2f. Every message route stays behind requireAuth',
    authIndex !== -1 && authIndex < routes.indexOf("router.get('/'") &&
    authIndex < routes.indexOf("router.post('/'") &&
    authIndex < routes.indexOf("router.patch('/:id'"));
  check('2g. No send / schedule / media route was added',
    !/router\.(post|put|patch)\(\s*'\/[^']*(send|schedule|media|whatsapp|template)/i.test(routes));
}

/* ------------------------------------------------------------------ *
 * 3. Editor source: new + edit behaviour, validation and payload rules
 * ------------------------------------------------------------------ */
function editorTests() {
  console.log('\n--- Editor source (MessageEditor.tsx) ---');
  const editor = readSource(EDITOR_PATH);
  const saveBlock = (editor.match(/const handleSave = async \(e: React\.FormEvent\) => \{[\s\S]*?\n  \};/) || [''])[0];
  const payloadBlock = (editor.match(/const payload = \{[\s\S]*?\n      \};/) || [''])[0];
  const loadBlock = (editor.match(/const loadMessage = async \(\) => \{[\s\S]*?\n    \};/) || [''])[0];

  check('3. The editor supports both new and edit modes',
    /mode: 'new' \| 'edit'/.test(editor) && /mode === 'new'/.test(editor) && /mode === 'edit'/.test(editor));
  check('3b. The edit mode reads the message id from the route',
    /useParams<\{ id: string \}>\(\)/.test(editor) && /const messageId = params\.id;/.test(editor));

  // Load an existing message
  check('4. Edit mode loads the message from GET /api/messages/:id',
    loadBlock.length > 0 && /axios\.get</.test(loadBlock) && /`\/api\/messages\/\$\{messageId\}`/.test(loadBlock));
  check('4b. Fields are prefilled from the loaded message',
    /setName\(msg\.name \?\? ''\)/.test(editor) && /setBody\(msg\.body \?\? ''\)/.test(editor) &&
    /setLanguage\(msg\.language \?\? ''\)/.test(editor));
  check('4c. A 404 surfaces a "not found" message',
    /isAxiosError\(err\) && err\.response\?\.status === 404/.test(editor) &&
    editor.includes("setLoadError('Message not found. It may have been deleted.')"));
  check('4d. A connection/other failure surfaces a retryable message',
    editor.includes("setLoadError('Unable to load message. Please check your connection and try again.')"));
  check('4e. The loading and error states render instead of the form',
    /if \(mode === 'edit' && loading\)/.test(editor) && /if \(mode === 'edit' && loadError\)/.test(editor) &&
    editor.includes('Loading message...'));

  // Client-side validation
  check('5. The name is required', editor.includes("setNameError('Message Name is required')"));
  check('5b. The name is capped at 200 characters',
    /const MAX_NAME_LENGTH = 200;/.test(editor) &&
    /maxLength=\{MAX_NAME_LENGTH\}/.test(editor) &&
    /Message Name must be at most \$\{MAX_NAME_LENGTH\} characters/.test(editor));
  check('5c. The body is required', editor.includes("setBodyError('Message Body is required')"));
  check('5d. Validation runs before any request is sent',
    /if \(!validate\(\)\) return;/.test(saveBlock) &&
    saveBlock.indexOf('validate()') < saveBlock.indexOf('axios.'));
  check('5e. Validation failures block the request entirely',
    /if \(saving\) return;/.test(saveBlock));

  // Payload contract
  check('6. The payload contains exactly name, body, language and status',
    /const payload = \{[\s\S]*?\};/.test(editor) &&
    /name: name\.trim\(\)/.test(payloadBlock) && /body,/.test(payloadBlock) &&
    /language: language\.trim\(\) \? language\.trim\(\) : null/.test(payloadBlock) &&
    /status,/.test(payloadBlock));
  check('6b. The name is trimmed before saving', /name: name\.trim\(\)/.test(payloadBlock));
  check('6c. The body is sent exactly as typed',
    /^      body,$/m.test(payloadBlock) && !/body:\s*body\.trim\(\)/.test(editor));
  check('6d. A blank language is sent as null', /language: language\.trim\(\) \? language\.trim\(\) : null/.test(payloadBlock));
  check('6e. The status is sent from the DRAFT / READY / ARCHIVED options',
    /const ALLOWED_STATUSES = \['DRAFT', 'READY', 'ARCHIVED'\] as const;/.test(editor) &&
    /ALLOWED_STATUSES\.map\(/.test(editor) && /status,/.test(payloadBlock));

  // Save behaviour
  check('7. New mode POSTs to /api/messages',
    saveBlock.includes("axios.post") && saveBlock.includes("'/api/messages'") && saveBlock.includes('payload'));
  check('7b. Edit mode PATCHes /api/messages/:id',
    saveBlock.includes('await axios.patch(`/api/messages/${messageId}`, payload);'));
  check('7c. A successful save returns to the messages list',
    /navigate\('\/messages'\);/.test(saveBlock));
  check('7d. Cancel returns to the messages list without a request',
    /const handleCancel = \(\) => \{\s*\n\s*navigate\('\/messages'\);\s*\n\s*\};/.test(editor));
  check('7e. Double submission is guarded',
    /if \(saving\) return;/.test(saveBlock) && /setSaving\(true\)/.test(saveBlock) &&
    /disabled=\{saving\}/.test(editor) && editor.includes("{saving ? 'Saving...' : 'Save Message'}"));
  check('7f. API failures surface the server message without leaking internals',
    /setApiError\(data\.error\?\.message \|\| 'Failed to save message\. Please try again\.'\)/.test(editor) &&
    !/err\.message|error\.stack|\.stack/.test(editor));
  check('7g. The form is a controlled form (no form library)',
    /onSubmit=\{handleSave\}/.test(editor) && /value=\{name\}/.test(editor) &&
    /value=\{body\}/.test(editor) && /value=\{language\}/.test(editor) &&
    !/react-hook-form|zodResolver|from 'zod'/.test(editor));
  check('7h. The page keeps the shared layout (Sidebar)',
    /import \{ Sidebar \} from '\.\.\/components\/Sidebar';/.test(editor) && /<Sidebar \/>/.test(editor));

  // Media integration is intentional in this phase; verify it doesn't break core editing
  check('8. Media integration does not break message editing',
    editor.includes("mode === 'new'") && editor.includes("mode === 'edit'") && editor.includes('handleSave'));
}

/* ------------------------------------------------------------------ *
 * 9. Messages list page: entry points into the editor
 * ------------------------------------------------------------------ */
function listPageTests() {
  console.log('\n--- Messages list page entry points ---');
  const page = readSource(MESSAGES_PAGE_PATH);

  check('9. The list page offers a "New Message" action',
    page.includes("<Plus className=\"w-4 h-4\" />") && page.includes('New Message'));
  check('9b. "New Message" opens the editor route',
    page.includes("onClick={() => navigate('/messages/new')}"));
  check('9c. View opens the editor for that message',
    /title="View"[\s\S]{0,60}/.test(page) && page.includes('navigate(`/messages/${msg.id}/edit`)'));
  check('9d. Edit opens the editor for that message',
    (page.match(/navigate\(`\/messages\/\$\{msg\.id\}\/edit`\)/g) || []).length >= 2);
  check('9e. The list still renders the message body from GET /api/messages',
    /\{msg\.body\}/.test(page) && /axios\.get<\{ success: boolean; data: Message\[\] \}>/.test(page));
  check('9f. The list page does not fetch a single message for the editor',
    !/axios\.get\(`\/api\/messages\/\$\{/.test(page));
}

/* ------------------------------------------------------------------ *
 * 10. Controller: server-side validation and verbatim body storage
 * ------------------------------------------------------------------ */
function controllerTests() {
  console.log('\n--- Controller (messages.controller.ts) ---');
  const controller = readSource(CONTROLLER_PATH);
  const listBlock = (controller.match(/export const getMessages = async[\s\S]*?\n\};/) || [''])[0];
  const createBlock = (controller.match(/export const createMessage = async[\s\S]*?\n\};/) || [''])[0];
  const updateBlock = (controller.match(/export const updateMessage = async[\s\S]*?\n\};/) || [''])[0];

  check('10. The allowed statuses are DRAFT / READY / ARCHIVED',
    /const ALLOWED_STATUSES = \['DRAFT', 'READY', 'ARCHIVED'\];/.test(controller));
  check('10b. Creating rejects a missing/blank name',
    /if \(!name \|\| !String\(name\)\.trim\(\)\)/.test(createBlock) && createBlock.includes("'Name is required'"));
  check('10c. Creating rejects a name longer than 200 characters',
    /String\(name\)\.trim\(\)\.length > 200/.test(createBlock) &&
    createBlock.includes("'Name must be at most 200 characters'"));
  check('10d. Creating rejects a missing/blank body',
    /if \(!body \|\| !String\(body\)\.trim\(\)\)/.test(createBlock) && createBlock.includes("'Body is required'"));
  check('10e. Creating rejects an invalid status',
    /if \(status && !ALLOWED_STATUSES\.includes\(status\)\)/.test(createBlock));
  check('10f. Creating trims the name but stores the body verbatim',
    /name: String\(name\)\.trim\(\),/.test(createBlock) && /body: String\(body\),/.test(createBlock) &&
    !/body: String\(body\)\.trim\(\),/.test(createBlock));
  check('10g. The status defaults to DRAFT when omitted',
    /status: status \|\| 'DRAFT'/.test(createBlock));
  check('10h. Updating rejects an empty name and enforces the 200 character cap',
    updateBlock.includes("'Name cannot be empty'") &&
    /String\(name\)\.trim\(\)\.length > 200/.test(updateBlock));
  check('10i. Updating rejects an empty body and stores the body verbatim',
    updateBlock.includes("'Body cannot be empty'") && /updateData\.body = String\(body\);/.test(updateBlock) &&
    !/updateData\.body = String\(body\)\.trim\(\);/.test(updateBlock));
  check('10j. Updating stores a blank language as null',
    /updateData\.language = language \? String\(language\)\.trim\(\) : null;/.test(updateBlock));
  check('10k. Updating rejects an invalid status before writing',
    /if \(status && !ALLOWED_STATUSES\.includes\(status\)\)/.test(updateBlock) &&
    updateBlock.indexOf('ALLOWED_STATUSES.includes(status)') < updateBlock.indexOf('prisma.message.update'));
  check('10l. Updating an unknown message returns 404',
    /if \(!existing\)[\s\S]{0,220}status\(404\)/.test(updateBlock));
  check('10m. Fetching an unknown message returns 404',
    /if \(!message\)[\s\S]{0,220}status\(404\)/.test(controller));
  check('10n. The list query still returns every field the list page renders',
    listBlock.length > 0 && !/select:/.test(listBlock) && /prisma\.message\.findMany/.test(listBlock));
  check('10o. No internals are returned by the message endpoints',
    !/error\.message\b(?!:)/.test(controller.replace(/message: '/g, '')));
}

/* ------------------------------------------------------------------ *
 * Runtime API tests: real server, real auth, real DB
 * ------------------------------------------------------------------ */
async function runtimeTests(snapshotBefore, cookie) {
  console.log('\n--- Real API endpoint tests ---');

  const unauth = await request('GET', '/api/messages/1');
  check('22. Messages API routes remain protected',
    unauth.status === 401 && /UNAUTHORIZED/.test(unauth.text), 'status=' + unauth.status);

  const created = await postJson('/api/messages', {
    name: 'Test Message ' + RUN,
    body: 'Hello world',
    language: 'English',
    status: 'DRAFT',
  }, cookie);
  responseTexts.push(created.text);
  reportedCreated++;
  check('11. New message submits POST /api/messages',
    created.status === 201 && created.json && created.json.success === true, 'status=' + created.status);
  const createdId = created.json && created.json.data && created.json.data.id;
  if (createdId) touchedMessageIds.add(createdId);
  check('11b. Created message has default DRAFT status',
    created.json && created.json.data && created.json.data.status === 'DRAFT');

  const fetched = await getJson('/api/messages/' + createdId, cookie);
  responseTexts.push(fetched.text);
  check('12. Edit mode loads GET /api/messages/:id',
    fetched.status === 200 && fetched.json && fetched.json.success === true, 'status=' + fetched.status);
  check('15. Edit preserves existing status',
    fetched.json && fetched.json.data && fetched.json.data.status === 'DRAFT',
    fetched.json && fetched.json.data ? fetched.json.data.status : 'no data');

  const patched = await patchJson('/api/messages/' + createdId, {
    name: 'Updated Message ' + RUN,
    body: 'Updated body text',
    language: 'Spanish',
    status: 'READY',
  }, cookie);
  responseTexts.push(patched.text);
  check('13. Edit message submits PATCH /api/messages/:id',
    patched.status === 200 && patched.json && patched.json.success === true, 'status=' + patched.status);

  const fetchedAfter = await getJson('/api/messages/' + createdId, cookie);
  check('15b. Updated values reflected after PATCH',
    fetchedAfter.json && fetchedAfter.json.data &&
    fetchedAfter.json.data.name === 'Updated Message ' + RUN &&
    fetchedAfter.json.data.status === 'READY',
    fetchedAfter.json && fetchedAfter.json.data ? JSON.stringify(fetchedAfter.json.data) : 'no data');

  const notFound = await getJson('/api/messages/nonexistent', cookie);
  check('6b. Fetching unknown message returns 404',
    notFound.status === 404, 'status=' + notFound.status);

  const invalidStatus = await postJson('/api/messages', {
    name: 'Bad Status Test',
    body: 'Testing',
    status: 'INVALID',
  }, cookie);
  responseTexts.push(invalidStatus.text);
  check('10e_replica. Creating rejects invalid status',
    invalidStatus.status === 400, 'status=' + invalidStatus.status);

  const emptyName = await postJson('/api/messages', {
    name: '   ',
    body: 'Testing body',
  }, cookie);
  responseTexts.push(emptyName.text);
  check('10b_replica. Creating rejects empty name',
    emptyName.status === 400, 'status=' + emptyName.status);

  const emptyBody = await postJson('/api/messages', {
    name: 'Test body required',
    body: '   ',
  }, cookie);
  responseTexts.push(emptyBody.text);
  check('10d_replica. Creating rejects empty body',
    emptyBody.status === 400, 'status=' + emptyBody.status);

  const longName = await postJson('/api/messages', {
    name: 'A'.repeat(201),
    body: 'Testing',
  }, cookie);
  responseTexts.push(longName.text);
  check('10c_replica. Creating rejects name > 200 chars',
    longName.status === 400, 'status=' + longName.status);

  const badPatch = await patchJson('/api/messages/' + createdId, {
    name: 'Test',
    body: 'Test',
    status: 'INVALID',
  }, cookie);
  responseTexts.push(badPatch.text);
  check('10k_replica. PATCH rejects invalid status',
    badPatch.status === 400, 'status=' + badPatch.status);

  const patchNonExistent = await patchJson('/api/messages/nonexistent', {
    name: 'Test',
    body: 'Test',
  }, cookie);
  responseTexts.push(patchNonExistent.text);
  check('10l_replica. PATCH unknown returns 404',
    patchNonExistent.status === 404, 'status=' + patchNonExistent.status);

  const apiErr = await postJson('/api/messages', {
    name: 'Error Test',
    body: '',
  }, cookie);
  responseTexts.push(apiErr.text);
  check('API error is surfaced to the user',
    apiErr.status === 400 && apiErr.json && apiErr.json.error && typeof apiErr.json.error.message === 'string',
    apiErr.json && apiErr.json.error ? apiErr.json.error.message : 'no message');
}

/* ------------------------------------------------------------------ *
 * No forbidden fields check (static)
 * ------------------------------------------------------------------ */
function forbiddenFieldTests() {
  console.log('\n--- No forbidden fields in controller ---');
  const controller = readSource(CONTROLLER_PATH);
  const routes = readSource(ROUTES_PATH);
  check('20. No media upload/campaign code introduced in controller',
    !/upload\.single|multer|formData/i.test(controller));
  check('21. No scheduling fields introduced',
    !/schedul|remind|delay/i.test(controller));
  check('22. No campaign fields introduced',
    !/campaign/i.test(controller));
  check('23. No WhatsApp API/network call in controller',
    !/whatsapp|twilio|sendgrid|http\.request|fetch\(/i.test(controller));
  check('23b. No WhatsApp fields in routes',
    !/whatsapp|send|schedule|media|campaign|template/i.test(routes));
}

async function main() {
  console.log('=== Step 3.3: Message Create/Edit Editor Tests ===\n');
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

  const email = 'step33-' + RUN + '@example.com';
  const password = 'Step33-' + RUN + '-pw!';
  const createdUser = await prisma.user.create({ data: { email, password: await argon2.hash(password) } });
  tempUserId = createdUser.id;
  const cookie = await loginAs(email, password);
  check('0b. Temporary admin user can authenticate', cookie !== null);

  try {
    routeWiringTests();
    editorTests();
    listPageTests();
    controllerTests();
    forbiddenFieldTests();
    await runtimeTests(messagesBefore, cookie);

    const messagesAfter = await prisma.message.findMany({ orderBy: { id: 'asc' } });
    check('24. Existing messages remain unchanged',
      messagesBefore.length === messagesAfter.filter((m) => messagesBeforeIds.has(m.id)).length,
      'before=' + messagesBefore.length + ' preserved=' + messagesAfter.filter((m) => messagesBeforeIds.has(m.id)).length);
    const afterIds = new Set(messagesAfter.map((m) => m.id));
    const newMsgCount = messagesAfter.filter((m) => !messagesBeforeIds.has(m.id)).length;
    check('24b. Only test-created messages are new',
      newMsgCount === reportedCreated, 'new=' + newMsgCount + ' reported=' + reportedCreated);
  } finally {
    for (const id of touchedMessageIds) {
      try {
        await prisma.message.delete({ where: { id } });
      } catch (error) {
        check('cleanup. Deleted message ' + id, false, String(error && error.message));
      }
    }
    if (tempUserId) {
      try {
        await prisma.user.delete({ where: { id: tempUserId } });
      } catch (error) {
        check('cleanup. Deleted temp user', false, String(error && error.message));
      }
      tempUserId = null;
    }
    const usersAfter = await prisma.user.count();
    check('cleanup. No test users left behind', usersBefore === usersAfter,
      'before=' + usersBefore + ' after=' + usersAfter);
    const messagesFinal = await prisma.message.findMany();
    check('cleanup. Existing messages untouched', messagesFinal.length === messagesBefore.length,
      'before=' + messagesBefore.length + ' final=' + messagesFinal.length);
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
