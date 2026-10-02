/**
 * Step 12F - Recipient import confirmation tests (COMPLETE SUITE).
 *
 * These tests exercise the REAL production pipeline:
 * - the real Express app (in-process) started from apps/server/src/index.ts
 * - the real requireAuth session middleware (temporary admin user)
 * - the real importRecipients controller and the real Prisma/SQLite database
 * - the real ImportWizard.tsx source (frontend wiring / safety assertions)
 *
 * Safety rules enforced here:
 * - existing recipients are snapshotted before and after and must be untouched
 * - only recipients created by THIS test run are deleted again in cleanup
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
const WIZARD_PATH = path.join(REPO_ROOT, 'apps/web/src/pages/ImportWizard.tsx');
const RECIPIENTS_PAGE_PATH = path.join(REPO_ROOT, 'apps/web/src/pages/Recipients.tsx');
const API_UTIL_PATH = path.join(REPO_ROOT, 'apps/web/src/utils/importApi.util.ts');
const CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/recipients.controller.ts');
const ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/recipients.routes.ts');

const TEST_PORT = 3141; // dedicated port so a running dev server is not disturbed
const BASE = 'http://127.0.0.1:' + TEST_PORT;

let failures = 0;
let server = null;
let prisma = null;
let tempUserId = null;

/** Every recipient this run creates, so cleanup removes ONLY these. */
const touchedPhones = new Set();
/** Every response body seen, used to prove no internals leak. */
const responseTexts = [];
/** Sum of the CREATED statuses the endpoint reported. */
let reportedCreated = 0;

function check(name, cond, extra) {
  if (!cond) failures++;
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (extra ? ' | ' + extra : ''));
}

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

/* ------------------------------------------------------------------ *
 * Deterministic, collision-free fixture phone numbers for this run.
 * 12 digits, so the canonical normalization keeps them unchanged.
 * ------------------------------------------------------------------ */
const RUN = String(Date.now()).slice(-6);

/** 12-digit canonical fixture phone: 9198 + RUN + index */
function phone(index) {
  return '9198' + RUN + String(index).padStart(2, '0');
}

/** 10-digit fixture phone used to prove the existing 91-prefix rule is reused. */
function phone10(index) {
  return '98' + RUN + String(index).padStart(2, '0');
}

/** '+91 9812 3456 07' style raw formatting that must normalize back to `canonical`. */
function rawFormat(canonical) {
  return '+91 ' + canonical.slice(2, 6) + ' ' + canonical.slice(6, 8) + ' ' + canonical.slice(8);
}

function makeRow(rowNumber, fields) {
  return {
    rowNumber,
    name: fields.name,
    whatsappNumber: fields.whatsappNumber,
    normalizedPhone: fields.normalizedPhone,
    language: fields.language === undefined ? null : fields.language,
    category: fields.category === undefined ? null : fields.category,
    consentStatus: fields.consentStatus === undefined ? null : fields.consentStatus,
    consentTimestamp: fields.consentTimestamp === undefined ? null : fields.consentTimestamp,
    notes: fields.notes === undefined ? null : fields.notes,
    source: fields.source === undefined ? null : fields.source,
  };
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

async function postJson(url, body, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  responseTexts.push(raw);
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  return { status: res.status, body: parsed, raw, text: raw, json: parsed, setCookie: res.headers.get('set-cookie') };
}

async function loginAs(email, password) {
  const res = await postJson('/api/auth/login', { email, password });
  if (res.status !== 200 || !res.setCookie) {
    throw new Error('login failed with status ' + res.status);
  }
  return res.setCookie.split(';')[0];
}

/* ------------------------------------------------------------------ *
 * Database helpers
 * ------------------------------------------------------------------ */

function runCommand(commandLine, cwd) {
  const result = spawnSync(commandLine, { cwd, shell: true, encoding: 'utf8' });
  const output = String(result.stdout || '') + String(result.stderr || '');
  return { status: result.status, output };
}

/* Wrapper kept so older helper references still resolve to the real snapshot. */
function snapshotRecipients() {
  return prisma.recipient.findMany({ orderBy: { id: 'asc' } });
}
/* ------------------------------------------------------------------ *
 * Item 1: the route exists, is authenticated and reuses the controller
 * ------------------------------------------------------------------ */
function routeWiringTests() {
  console.log('\n--- Route wiring (POST /api/recipients/import) ---');
  const routes = readSource(ROUTES_PATH);
  const controller = readSource(CONTROLLER_PATH);

  check('1. POST /api/recipients/import is registered',
    /router\.post\('\/import',\s*importRecipients\)/.test(routes));
  check('1b. The route is registered below router.use(requireAuth)',
    routes.indexOf('router.use(requireAuth)') !== -1 &&
    routes.indexOf('router.use(requireAuth)') < routes.indexOf('/import'));
  check('1c. The route reuses the existing importRecipients controller',
    /importRecipients/.test(routes) && /export const importRecipients/.test(controller));
  check('1d. The route does not use the legacy imports controller',
    !/imports\.controller|previewImport|confirmImport/.test(routes));
  check('1e. The handler validates the payload shape and size',
    /Array\.isArray\(rows\)/.test(controller) && /rows\.length > MAX_IMPORT_ROWS/.test(controller));
  check('1f. The handler reuses the shared normalization utility',
    /normalizePhoneNumber\(whatsappNumber\)/.test(controller));
  check('1g. The legacy imports controller still exists untouched',
    /export const confirmImport/.test(readSource(path.join(REPO_ROOT, 'apps/server/src/controllers/imports.controller.ts'))));
}
/* ------------------------------------------------------------------ *
 * Items 13, 19-23: ImportWizard.tsx wiring and safety
 * ------------------------------------------------------------------ */
function frontendTests() {
  console.log('\n--- Wizard wiring (frontend source safety) ---');
  const wizard = readSource(WIZARD_PATH);
  const apiUtil = readSource(API_UTIL_PATH);
  const recipientsPage = readSource(RECIPIENTS_PAGE_PATH);

  const confirmBlock = wizard.match(/const handleConfirmImport = async \(\) => \{[\s\S]*?\n  \};/);
  const confirmSource = confirmBlock ? confirmBlock[0] : '';
  const continueBlock = wizard.match(/const handleContinueToConfirmation = \(\) => \{[\s\S]*?\n  \};/);
  const continueSource = continueBlock ? continueBlock[0] : '';
  const importCalls = wizard.match(/axios\.post\('\/api\/recipients\/import'/g) || [];

  // 19. Nothing is submitted before the explicit Confirm Import action
  check('19. The 12E "Continue to Import Confirmation" action makes no request',
    continueSource.length > 0 && !/axios|fetch\(/.test(continueSource));
  check('19. handleConfirmImport exists and is the only import submit',
    confirmSource.length > 0 && importCalls.length === 1);
  check('19. Confirm Import is wired to handleConfirmImport',
    /onClick=\{handleConfirmImport\}/.test(wizard));
  check('19. Only the IMPORT-decided rows are submitted',
    /buildImportPayload\(importRows, importSelection\)/.test(confirmSource));
  check('19. buildImportPayload drops every non-IMPORT row',
    /getRowDecision\(selection, row\) !== 'IMPORT'\) continue;/.test(apiUtil));

  // 20. Confirm Import calls the new endpoint only
  check('20. Confirm Import posts to POST /api/recipients/import',
    /axios\.post\('\/api\/recipients\/import', payload\)/.test(confirmSource));
  check('20. The legacy /api/imports/preview and /api/imports/confirm are not used',
    !/\/api\/imports\//.test(wizard));
  check('20. The wizard calls exactly the two intended recipient endpoints',
    (wizard.match(/axios\.(post|put|patch|delete)\(/g) || []).length === 2 &&
    wizard.includes("axios.post('/api/recipients/import-duplicates'") &&
    wizard.includes("axios.post('/api/recipients/import'"));
  check('20b. No WhatsApp/Google/external API is referenced by the wizard',
    !/graph\.facebook|googleapis|docs\.google|twilio|sendgrid|api\.whatsapp/i.test(wizard));

  // 21. Loading state and double-click protection
  check('21. The handler refuses re-entry while importing',
    /if \(importing\) return;/.test(confirmSource));
  check('21. The loading flag is set before the request and released in finally',
    /setImporting\(true\);/.test(confirmSource) && /finally \{/.test(confirmSource) && /setImporting\(false\);/.test(confirmSource));
  check('21. The Confirm Import button is disabled while importing',
    /onClick=\{handleConfirmImport\}\s*\n\s*disabled=\{importing\}/.test(wizard));
  check('21. The button shows a loading label',
    /importing \? 'Importing\.\.\.' : 'Confirm Import'/.test(wizard));

  // 22. The final result screen renders the server response
  check('22. The previously unused result step is implemented',
    /step === 'result'/.test(wizard) && /setStep\('result'\);/.test(wizard));
  check('22. The result screen renders the summary counters',
    /importResult\.summary\.total/.test(wizard) && /importResult\.summary\.created/.test(wizard) &&
    /importResult\.summary\.skipped/.test(wizard) && /importResult\.summary\.failed/.test(wizard) &&
    ['Total processed', 'Created', 'Skipped', 'Failed'].every((label) => wizard.includes(label)));
  check('22. The result screen renders a per-row table',
    /importResult\.results\.map\(/.test(wizard) &&
    ['>Row<', '>Name<', '>WhatsApp Number<', '>Normalized Phone<', '>Result<', '>Reason<'].every((h) => wizard.includes(h)));
  check('22. Per-row status and reason are displayed',
    /getImportResultBadgeClass\(result\.status\)/.test(wizard) && /result\.reason \|\| '-'/.test(wizard));
  check('22. The wizard does not auto-restart after the import',
    !/setStep\('result'\)[\s\S]{0,400}setStep\('upload'\)/.test(wizard));

  // 13. User-facing error handling without internals
  check('13. API failures surface a user-facing message',
    /setImportError\('Could not import the selected recipients/.test(confirmSource));
  check('13. A failed attempt keeps the selected import data',
    !/resetSelection\(\)|setImportSelection\(\{\}\)/.test(confirmSource));
  check('13. The frontend never renders raw error internals',
    !/err\.message|error\.stack|\.stack/.test(confirmSource));
  check('13. The confirmation screen renders the import error',
    /\{importError && \(/.test(wizard));

  // 23. Back to Recipients
  check('23. The result screen offers "Back to Recipients"',
    /onClick=\{handleBackToRecipients\}/.test(wizard) && wizard.includes('Back to Recipients'));
  check('23. Back to Recipients navigates to the recipients route',
    /const handleBackToRecipients = \(\) => \{\s*\n\s*navigate\('\/recipients'\);\s*\n\s*\};/.test(wizard));
  check('23. The recipients page refetches its list on mount',
    /useEffect\(\(\) => \{\s*\n\s*fetchRecipients\(\);/.test(recipientsPage));
}

function rowsToResults(body) {
  return Array.isArray(body && body.data && body.data.results) ? body.data.results : [];
}

function summaryOf(body) {
  return body && body.data && body.data.summary ? body.data.summary : {};
}

async function endpointTests(snapshotBefore, cookie) {
  console.log('\n--- Real POST /api/recipients/import tests (items 1-18) ---');
  const existingPhone = snapshotBefore.length ? snapshotBefore[0].normalizedPhone : null;
  const fresh = phone(1);
  const fresh10 = phone10(2);
  const fresh10Canonical = '91' + fresh10;
  const dupExisting = existingPhone || phone(90);
  const dupPair = phone(10);
  const triple = phone(20);
  const missingNamePhone = phone(30);
  const badBrowserPhone = phone(40);
  const badRaw = rawFormat(phone(41));
  const skippedOnlyPhone = phone(50);
  const freshARow = phone(60);
  const freshBRow = phone(61);
  [fresh, fresh10, fresh10Canonical, dupPair, triple, missingNamePhone,
    badBrowserPhone, phone(41), skippedOnlyPhone, freshARow, freshBRow
  ].forEach((p) => touchedPhones.add(p));
  if (!existingPhone) touchedPhones.add(dupExisting);

  const unauth = await postJson('/api/recipients/import', { rows: [] });
  responseTexts.push(unauth.text);
  check('1. Unauthenticated POST /api/recipients/import returns 401',
    unauth.status === 401 && /UNAUTHORIZED/.test(unauth.text), 'status=' + unauth.status);

  const created = await postJson('/api/recipients/import', {
    rows: [makeRow(1, { name: 'Import User A ' + RUN, whatsappNumber: fresh, normalizedPhone: fresh })],
  }, cookie);
  responseTexts.push(created.text);
  check('2. Authenticated valid import succeeds',
    created.status === 200 && created.json && created.json.success === true, 'status=' + created.status);
  check('2. Exactly one recipient was reported CREATED',
    summaryOf(created.json).created === 1 && summaryOf(created.json).total === 1,
    JSON.stringify(summaryOf(created.json)));
  reportedCreated += summaryOf(created.json).created || 0;
  const persistedA = await prisma.recipient.findUnique({ where: { normalizedPhone: fresh } });
  check('2. Imported recipient exists in DB with source IMPORT',
    persistedA !== null && persistedA.source === 'IMPORT' && persistedA.status === 'ACTIVE',
    persistedA ? persistedA.name + '/' + persistedA.source : 'missing');
  check('3. A row that was never submitted was not created',
    (await prisma.recipient.findUnique({ where: { normalizedPhone: skippedOnlyPhone } })) === null);

  const missName = await postJson('/api/recipients/import', {
    rows: [makeRow(2, { name: '   ', whatsappNumber: missingNamePhone, normalizedPhone: missingNamePhone })],
  }, cookie);
  responseTexts.push(missName.text);
  const missNameRow = rowsToResults(missName.json)[0];
  check('4. Missing name is rejected without creating a recipient',
    missName.status === 200 && missNameRow && missNameRow.status === 'FAILED' && /Name is required/.test(missNameRow.reason || ''),
    JSON.stringify(missNameRow || {}));
  check('4b. No recipient persisted for missing-name row',
    (await prisma.recipient.findUnique({ where: { normalizedPhone: missingNamePhone } })) === null);

  const missPhone = await postJson('/api/recipients/import', {
    rows: [makeRow(3, { name: 'No Phone ' + RUN, whatsappNumber: '  ', normalizedPhone: '' })],
  }, cookie);
  responseTexts.push(missPhone.text);
  const missPhoneRow = rowsToResults(missPhone.json)[0];
  check('5. Missing phone is rejected without creating a recipient',
    missPhone.status === 200 && missPhoneRow && missPhoneRow.status === 'FAILED' && /number is required/i.test(missPhoneRow.reason || ''),
    JSON.stringify(missPhoneRow || {}));

  const normRes = await postJson('/api/recipients/import', {
    rows: [
      makeRow(4, { name: 'Ten Digit ' + RUN, whatsappNumber: fresh10, normalizedPhone: fresh10 }),
      makeRow(5, { name: 'Sneaky ' + RUN, whatsappNumber: badRaw, normalizedPhone: badBrowserPhone }),
    ],
  }, cookie);
  responseTexts.push(normRes.text);
  const byRowA = {};
  rowsToResults(normRes.json).forEach((r) => { byRowA[r.rowNumber] = r; });
  check('6. Server recalculates normalizedPhone with 91-prefix rule',
    byRowA[4] && byRowA[4].status === 'CREATED' && byRowA[4].normalizedPhone === fresh10Canonical,
    JSON.stringify(byRowA[4] || {}));
  reportedCreated += summaryOf(normRes.json).created || 0;
  const stored10 = await prisma.recipient.findUnique({ where: { normalizedPhone: fresh10Canonical } });
  check('6b. Canonical value is what is stored', stored10 !== null && stored10.whatsappNumber === fresh10,
    stored10 ? stored10.normalizedPhone : 'missing');
  check('7. Incorrect browser normalizedPhone cannot bypass server',
    byRowA[5] && byRowA[5].status === 'CREATED' && byRowA[5].normalizedPhone === phone(41),
    JSON.stringify(byRowA[5] || {}));
  check('7b. Spoofed browser value was not stored',
    (await prisma.recipient.findUnique({ where: { normalizedPhone: badBrowserPhone } })) === null &&
    (await prisma.recipient.findUnique({ where: { normalizedPhone: phone(41) } })) !== null);

  const beforeDup = await prisma.recipient.findUnique({ where: { normalizedPhone: dupExisting } });
  const dupRes = await postJson('/api/recipients/import', {
    rows: [makeRow(6, { name: 'Hacker ' + RUN, whatsappNumber: dupExisting, normalizedPhone: dupExisting })],
  }, cookie);
  responseTexts.push(dupRes.text);
  const dupRow = rowsToResults(dupRes.json)[0];
  check('8. An existing normalizedPhone is SKIPPED',
    dupRes.status === 200 && dupRow && dupRow.status === 'SKIPPED' && /Already exists in database/.test(dupRow.reason || ''),
    JSON.stringify(dupRow || {}));
  const afterDup = await prisma.recipient.findUnique({ where: { normalizedPhone: dupExisting } });
  check('8b. The existing recipient was not updated',
    beforeDup && afterDup && beforeDup.name === afterDup.name && beforeDup.id === afterDup.id,
    (beforeDup ? beforeDup.name : '?') + ' -> ' + (afterDup ? afterDup.name : '?'));

  const pairRes = await postJson('/api/recipients/import', {
    rows: [
      makeRow(7, { name: 'Dup One ' + RUN, whatsappNumber: dupPair, normalizedPhone: dupPair }),
      makeRow(8, { name: 'Dup Two ' + RUN, whatsappNumber: dupPair, normalizedPhone: dupPair }),
      makeRow(9, { name: 'Triple One ' + RUN, whatsappNumber: triple, normalizedPhone: triple }),
      makeRow(10, { name: 'Triple Two ' + RUN, whatsappNumber: triple, normalizedPhone: triple }),
      makeRow(11, { name: 'Triple Three ' + RUN, whatsappNumber: triple, normalizedPhone: triple }),
    ],
  }, cookie);
  responseTexts.push(pairRes.text);
  const byRowB = {};
  rowsToResults(pairRes.json).forEach((r) => { byRowB[r.rowNumber] = r; });
  check('9. Within-request duplicate handled (first CREATED, second SKIPPED)',
    byRowB[7] && byRowB[7].status === 'CREATED' &&
    byRowB[8] && byRowB[8].status === 'SKIPPED' && /same as row 7/.test(byRowB[8].reason || ''),
    JSON.stringify([byRowB[7], byRowB[8]]));
  reportedCreated += summaryOf(pairRes.json).created || 0;
  check('10. Three identical phones cannot create three recipients',
    byRowB[9] && byRowB[9].status === 'CREATED' &&
    byRowB[10] && byRowB[10].status === 'SKIPPED' &&
    byRowB[11] && byRowB[11].status === 'SKIPPED',
    JSON.stringify([byRowB[9], byRowB[10], byRowB[11]]));
  check('10b. Only one DB row exists for the triple-submitted phone',
    (await prisma.recipient.findMany({ where: { normalizedPhone: triple } })).length === 1);

  const summaryRes = await postJson('/api/recipients/import', {
    rows: [
      makeRow(12, { name: 'Summary A ' + RUN, whatsappNumber: freshARow, normalizedPhone: freshARow }),
      makeRow(13, { name: 'Summary B ' + RUN, whatsappNumber: freshBRow, normalizedPhone: freshBRow }),
      makeRow(14, { name: '   ', whatsappNumber: freshBRow, normalizedPhone: freshBRow }),
      makeRow(15, { name: 'Summary Dup ' + RUN, whatsappNumber: freshARow, normalizedPhone: freshARow }),
    ],
  }, cookie);
  responseTexts.push(summaryRes.text);
  const summary = summaryOf(summaryRes.json);
  const statuses = rowsToResults(summaryRes.json).map((r) => r.status).join(',');
  reportedCreated += summary.created || 0;
  check('16. Result summary counts are correct',
    summary.total === 4 && summary.created === 2 && summary.skipped === 1 && summary.failed === 1,
    JSON.stringify(summary));
  check('17. Per-row result statuses are correct', statuses === 'CREATED,CREATED,FAILED,SKIPPED', statuses);

  check('18. Unhandled Prisma/DB errors are not exposed',
    !responseTexts.some((t) => /P2002|PrismaClient|at .*\(.*:\d+:\d+\)|node_modules\/@prisma/i.test(t)));

  const payload = {
    rows: [
      makeRow(16, { name: 'Double A ' + RUN, whatsappNumber: phone(70), normalizedPhone: phone(70) }),
      makeRow(17, { name: 'Double B ' + RUN, whatsappNumber: phone(71), normalizedPhone: phone(71) }),
    ],
  };
  touchedPhones.add(phone(70));
  touchedPhones.add(phone(71));
  const first = await postJson('/api/recipients/import', payload, cookie);
  responseTexts.push(first.text);
  reportedCreated += summaryOf(first.json).created || 0;
  const countAfterFirst = await prisma.recipient.count();
  const second = await postJson('/api/recipients/import', payload, cookie);
  responseTexts.push(second.text);
  const secondRows = rowsToResults(second.json);
  check('11. Double submission does not create duplicate recipients',
    summaryOf(first.json).created === 2 &&
    summaryOf(second.json).created === 0 &&
    secondRows.every((r) => r.status === 'SKIPPED'),
    'first=' + JSON.stringify(summaryOf(first.json)) + ' second=' + JSON.stringify(summaryOf(second.json)));
  check('11b. Recipient count identical after repeated submission',
    (await prisma.recipient.count()) === countAfterFirst);
}

function regressionTests() {
  console.log('\n--- Regression + build checks (items 24-27) ---');
  const step12c = runCommand('node test-12c.cjs', REPO_ROOT);
  check('24. Step 12C still passes',
    step12c.status === 0 && /All checks passed/.test(step12c.output),
    step12c.status === 0 ? '' : step12c.output.slice(-300));
  const step12d = runCommand('node test-12d.cjs', REPO_ROOT);
  check('24b. Step 12D still passes',
    step12d.status === 0 && /All checks passed/.test(step12d.output),
    step12d.status === 0 ? '' : step12d.output.slice(-300));
  const step12e = runCommand('node test-12e.cjs', REPO_ROOT);
  check('24c. Step 12E still passes',
    step12e.status === 0 && /All checks passed/.test(step12e.output),
    step12e.status === 0 ? '' : step12e.output.slice(-300));
  const serverBuild = runCommand('npx tsc -p apps/server/tsconfig.json --noEmit', REPO_ROOT);
  check('25. Backend TypeScript build passes', serverBuild.status === 0,
    serverBuild.status === 0 ? '' : serverBuild.output.slice(-300));
  const webBuild = runCommand('npm run build --workspace=apps/web', REPO_ROOT);
  check('26. Frontend TypeScript + build passes',
    webBuild.status === 0 && /built in/.test(webBuild.output),
    webBuild.status === 0 ? '' : webBuild.output.slice(-300));
  const lint = runCommand('npm run lint --workspace=apps/web', REPO_ROOT);
  check('27. Frontend lint passes with no errors', lint.status === 0 && /0 errors/.test(lint.output),
    lint.status === 0 ? '' : lint.output.slice(-300));
}

function snapshotList() {
  return prisma.recipient.findMany({ orderBy: { id: 'asc' } });
}

function snapshotById(snapshot) {
  const map = new Map();
  snapshot.forEach((r) => map.set(r.id, r));
  return map;
}

function countByPhone(list, normalizedPhone) {
  return list.filter((r) => r.normalizedPhone === normalizedPhone).length;
}

async function main() {
  console.log('=== Step 12F: Import Confirmation Tests ===\n');
  process.env.PORT = String(TEST_PORT);
  const originalListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    server = this;
    return originalListen.apply(this, args);
  };
  require('tsx/cjs');
  require('./apps/server/src/index.ts');
  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient();
  const serverUp = await waitForServer(20000);
  check('0. Real server is reachable for the endpoint tests', serverUp, BASE);
  if (!serverUp) {
    console.log('\n=== 1 check(s) FAILED ===');
    process.exitCode = 1;
    return;
  }
  const usersBefore = await prisma.user.count();
  const snapshotBefore = await snapshotList();
  const byIdBefore = snapshotById(snapshotBefore);
  const countBefore = snapshotBefore.length;
  const email = 'step12f-' + RUN + '@example.com';
  const password = 'Step12f-' + RUN + '-pw!';
  const createdUser = await prisma.user.create({ data: { email, password: await argon2.hash(password) } });
  tempUserId = createdUser.id;
  const cookie = await loginAs(email, password);
  check('0b. Temporary admin user can authenticate', cookie !== null);
  try {
    routeWiringTests();
    frontendTests();
    await endpointTests(snapshotBefore, cookie);
    const snapshotAfter = await snapshotList();
    const afterById = snapshotById(snapshotAfter);
    const missing = snapshotBefore.filter((r) => !afterById.has(r.id));
    const changed = snapshotBefore.filter((r) => {
      const now = afterById.get(r.id);
      return now && JSON.stringify(now) !== JSON.stringify(r);
    });
    check('12. All previous recipients still exist', missing.length === 0,
      missing.length ? 'missing=' + missing.length : 'recipients=' + snapshotAfter.length);
    check('12b. Every previous recipient record is unchanged', changed.length === 0,
      changed.length ? 'changed=' + changed.length : '');
    check('13. Count changed only by successfully created records',
      snapshotAfter.length === countBefore + reportedCreated,
      'before=' + countBefore + ' after=' + snapshotAfter.length + ' created=' + reportedCreated);
    check('14. No existing recipient was updated or deleted', missing.length === 0 && changed.length === 0);
    const stray = [...touchedPhones].filter((p) => countByPhone(snapshotAfter, p) > 1);
    check('15. No duplicate normalizedPhone was created', stray.length === 0,
      stray.length ? stray.join(',') : 'checked=' + touchedPhones.size);
    const legacyWired = /\/api\/imports\/(preview|confirm)/.test(readSource(WIZARD_PATH) + readSource(API_UTIL_PATH));
    check('15b. Legacy /api/imports flow was not wired', !legacyWired);
    regressionTests();
  } finally {
    if (touchedPhones.size) {
      try {
        await prisma.recipient.deleteMany({ where: { normalizedPhone: { in: [...touchedPhones] } } });
      } catch (error) {
        check('cleanup. Temporary import recipients deleted', false, String(error && error.message));
      }
    }
    if (tempUserId) {
      try {
        await prisma.user.delete({ where: { id: tempUserId } });
      } catch (error) {
        check('cleanup. Temporary test user deleted', false, String(error && error.message));
      }
      tempUserId = null;
    }
    const snapshotFinal = await snapshotList();
    check('cleanup. Only temporary recipients were removed',
      snapshotFinal.length === countBefore &&
      snapshotFinal.every((r) => {
        const before = byIdBefore.get(r.id);
        return before && JSON.stringify(before) === JSON.stringify(r);
      }),
      'before=' + countBefore + ' final=' + snapshotFinal.length);
    const usersAfter = await prisma.user.count();
    check('cleanup. No test users left behind', usersBefore === usersAfter,
      'before=' + usersBefore + ' after=' + usersAfter);
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await prisma.$disconnect();
  }
  console.log('\n=== ' + (failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED') + ' ===');
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('Error:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});