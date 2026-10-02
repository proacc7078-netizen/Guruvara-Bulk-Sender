/**
 * Step 12D - Import wizard duplicate detection tests.
 *
 * These tests exercise the real production logic:
 * - apps/web/src/utils/importMapping.util.ts (the module ImportWizard.tsx uses)
 * - the real Express app (in-process), its auth middleware and the real database
 *
 * The duplicate endpoint is READ ONLY against the recipient table: every test
 * snapshots the recipients and asserts they are untouched. Test users are
 * created for authentication and deleted again during cleanup.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const XLSX = require('xlsx');
const dotenv = require('dotenv');
const argon2 = require('argon2');
const { spawnSync } = require('child_process');

const {
  validateAndNormalizeRows,
  collectUniqueNormalizedPhones,
  applyDuplicateDetection,
  clearDuplicateDetection,
  getDuplicateSummary,
  describeDuplicateStatus,
} = require('./apps/web/src/utils/importMapping.util.ts');

dotenv.config({ path: path.join(__dirname, '.env') });

const REPO_ROOT = __dirname;
const WIZARD_PATH = path.join(REPO_ROOT, 'apps/web/src/pages/ImportWizard.tsx');
const CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/recipients.controller.ts');
const ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/recipients.routes.ts');
const DIR = path.join(REPO_ROOT, 'test-12d-files');
const PREVIEW_ROW_COUNT = 5;
const TEST_PORT = 3139; // dedicated port so a running dev server is not disturbed
const BASE = `http://127.0.0.1:${TEST_PORT}`;

let failures = 0;
let server = null;
let prisma = null;
let tempUserId = null;

function check(name, cond, extra) {
  if (!cond) failures++;
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (extra ? ' | ' + extra : ''));
}

function emptyMapping() {
  return {
    name: null,
    whatsappNumber: null,
    language: null,
    category: null,
    consentStatus: null,
    consentTimestamp: null,
    notes: null,
    source: null,
  };
}

/** Mirrors the Step 12A parsing in ImportWizard.tsx. */
function buildPreview(fileName, content) {
  const filePath = path.join(DIR, fileName);
  fs.writeFileSync(filePath, content);
  const workbook = XLSX.read(fs.readFileSync(filePath), { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });
  const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  return {
    fileName,
    headers,
    rows: rows.slice(0, PREVIEW_ROW_COUNT),
    allRows: rows,
    totalRows: rows.length,
  };
}

/** Step 12C validation + normalization of a CSV fixture. */
function rowsFrom(fileName, content, mapping) {
  return validateAndNormalizeRows(buildPreview(fileName, content), mapping);
}

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function postJson(url, body, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${BASE}${url}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  return { status: res.status, body: parsed, setCookie: res.headers.get('set-cookie') };
}

async function loginAs(email, password) {
  const res = await postJson('/api/auth/login', { email, password });
  if (res.status !== 200 || !res.setCookie) {
    throw new Error('login failed with status ' + res.status);
  }
  return res.setCookie.split(';')[0];
}

/** Full read-only snapshot of the recipient table (used to prove nothing changed). */
function snapshotRecipients() {
  return prisma.recipient.findMany({
    select: {
      id: true,
      name: true,
      whatsappNumber: true,
      normalizedPhone: true,
      language: true,
      category: true,
      status: true,
      source: true,
      consentStatus: true,
      consentTimestamp: true,
      notes: true,
      createdAt: true,
      updatedAt: true,
      tags: { select: { tagId: true } },
    },
    orderBy: { id: 'asc' },
  });
}

function runCommand(commandLine, cwd) {
  const result = spawnSync(commandLine, { cwd: cwd, shell: true, encoding: 'utf8' });
  const output = String(result.stdout || '') + String(result.stderr || '');
  return { status: result.status, output: output };
}

function frontendDuplicateTests() {
  console.log('\n--- Duplicate detection logic (frontend) ---');
  const map1 = { ...emptyMapping(), name: 'Name', whatsappNumber: 'WhatsApp Number' };

  // 1. Valid unique row -> no duplicate
  const rows1 = rowsFrom('unique.csv', 'Name,WhatsApp Number\nRavi Kumar,+91 90000 11111\n', map1);
  const lookup1 = collectUniqueNormalizedPhones(rows1);
  const detected1 = applyDuplicateDetection(rows1, []);
  const summary1 = getDuplicateSummary(detected1);
  check('1. Valid unique row produces a single lookup value', lookup1.length === 1 && lookup1[0] === '919000011111', 'phones=' + lookup1.join(','));
  check('1. Valid unique row is not a duplicate', detected1[0].existingInDatabase === false && detected1[0].duplicateRows.length === 0 && detected1[0].status === 'valid');
  check('1. Valid unique row is described as unique', describeDuplicateStatus(detected1[0]) === 'No duplicate found');
  check('1. Summary counts one unique valid row', summary1.totalRows === 1 && summary1.validRows === 1 && summary1.invalidRows === 0 && summary1.uniqueValidRows === 1 && summary1.existingDatabaseDuplicates === 0 && summary1.withinFileDuplicates === 0);

  // 2. Existing normalizedPhone -> existing database duplicate
  const rows2 = rowsFrom('existing.csv', 'Name,WhatsApp Number\nSuresh,+91 90000 22222\n', map1);
  const detected2 = applyDuplicateDetection(rows2, ['919000022222']);
  const summary2 = getDuplicateSummary(detected2);
  check('2. Existing database duplicate detected', detected2[0].existingInDatabase === true && detected2[0].status === 'existing-duplicate');
  check('2. Existing duplicate keeps its validation result', detected2[0].isValid === true && detected2[0].errors.length === 0 && detected2[0].normalizedPhone === '919000022222');
  check('2. Existing duplicate shown in the details column', describeDuplicateStatus(detected2[0]) === 'Existing recipient');
  check('2. Summary counts the existing duplicate', summary2.existingDatabaseDuplicates === 1 && summary2.withinFileDuplicates === 0 && summary2.uniqueValidRows === 0);
  check('2. Existing duplicate is not silently marked invalid', detected2[0].isValid === true && summary2.invalidRows === 0);

  // 3. Two imported rows with the same normalizedPhone -> both flagged
  const rows3 = rowsFrom('pair.csv', 'Name,WhatsApp Number\nA,+91 90000 11111\nB,919000011111\n', map1);
  const detected3 = applyDuplicateDetection(rows3, []);
  const summary3 = getDuplicateSummary(detected3);
  check('3. Both rows flagged as within-file duplicates', detected3.length === 2 && detected3.every((r) => r.status === 'within-file-duplicate'));
  check('3. Each row points at the other row', detected3[0].duplicateRows.join(',') === '2' && detected3[1].duplicateRows.join(',') === '1');
  check('3. Neither row disappears and row numbers are kept', detected3.map((r) => r.rowNumber).join(',') === '1,2');
  check('3. Details describe the duplicate row', describeDuplicateStatus(detected3[0]) === 'Duplicate of row 2' && describeDuplicateStatus(detected3[1]) === 'Duplicate of row 1');
  check('3. Summary counts 2 affected rows in 1 duplicate group', summary3.withinFileDuplicates === 2 && summary3.withinFileDuplicateGroups === 1 && summary3.uniqueValidRows === 0);

  // 4. Three imported rows with the same normalizedPhone -> all three flagged
  const rows4 = rowsFrom('triple.csv', 'Name,WhatsApp Number\nA,+91 90000 77777\nB,+91 90000 77777\nC,+91 90000 77777\n', map1);
  const detected4 = applyDuplicateDetection(rows4, []);
  const summary4 = getDuplicateSummary(detected4);
  check('4. All three rows flagged', detected4.every((r) => r.status === 'within-file-duplicate') && detected4.every((r) => r.duplicateRows.length === 2));
  check('4. Each row lists the other two rows', detected4[0].duplicateRows.join(',') === '2,3' && detected4[1].duplicateRows.join(',') === '1,3' && detected4[2].duplicateRows.join(',') === '1,2');
  check('4. Summary counts 3 affected rows and 1 duplicate group', summary4.withinFileDuplicates === 3 && summary4.withinFileDuplicateGroups === 1);
  check('4. Details list multiple rows', describeDuplicateStatus(detected4[0]) === 'Duplicate of rows 2, 3');

  // 5. A row can be both a database duplicate and a within-file duplicate
  const rows5 = rowsFrom('both.csv', 'Name,WhatsApp Number\nA,+91 90000 88888\nB,+91 90000 88888\n', map1);
  const detected5 = applyDuplicateDetection(rows5, ['919000088888']);
  const summary5 = getDuplicateSummary(detected5);
  check('5. Rows carry both duplicate reasons', detected5.every((r) => r.existingInDatabase === true && r.duplicateRows.length === 1 && r.status === 'existing-and-within-file-duplicate'));
  check('5. Details show both reasons', describeDuplicateStatus(detected5[0]) === 'Existing recipient; duplicate of row 2');
  check('5. Summary counts the rows in both counters', summary5.existingDatabaseDuplicates === 2 && summary5.withinFileDuplicates === 2 && summary5.uniqueValidRows === 0);

  // 6. Invalid rows with a null normalizedPhone are never treated as duplicates
  const rows6 = rowsFrom('null-phone.csv', 'Name,WhatsApp Number\nSuresh,\nRavi,+91 90000 11111\n', map1);
  const lookup6 = collectUniqueNormalizedPhones(rows6);
  const detected6 = applyDuplicateDetection(rows6, ['919000011111', '919000022222']);
  const summary6 = getDuplicateSummary(detected6);
  check('6. Invalid row keeps its Step 12C errors', rows6[0].isValid === false && rows6[0].errors.includes('WhatsApp number is required.') && rows6[0].normalizedPhone === null);
  check('6. Null normalizedPhone is not sent to the duplicate lookup', lookup6.join(',') === '919000011111', 'phones=' + lookup6.join(','));
  check('6. Invalid row has no duplicate information', detected6[0].existingInDatabase === false && detected6[0].duplicateRows.length === 0 && detected6[0].status === 'invalid');
  check('6. Invalid row is not counted as a duplicate', summary6.existingDatabaseDuplicates === 1 && summary6.invalidRows === 1);
  check('6. Invalid row is labelled as not checked', describeDuplicateStatus(detected6[0]) === 'Not checked (row is invalid)');

  // 6b. An invalid row must not make a valid row look duplicated
  const rows6b = rowsFrom('invalid-same-phone.csv', 'Name,WhatsApp Number\n,+91 90000 11111\nRavi,+91 90000 11111\n', map1);
  const detected6b = applyDuplicateDetection(rows6b, []);
  const summary6b = getDuplicateSummary(detected6b);
  check('6. Invalid row does not create a within-file duplicate', detected6b[0].status === 'invalid' && detected6b[1].status === 'valid' && detected6b[1].duplicateRows.length === 0);
  check('6. Only the valid row counts as valid', summary6b.validRows === 1 && summary6b.invalidRows === 1 && summary6b.withinFileDuplicates === 0);

  // 7. Detection uses the normalized phone, not the raw WhatsApp formatting
  const rows7 = rowsFrom('formats.csv', 'Name,WhatsApp Number\nA,+91 90000 11111\nB,919000011111\nC,91-90000-11111\n', map1);
  const detected7 = applyDuplicateDetection(rows7, []);
  check('7. Formatting differences collapse to one lookup value', collectUniqueNormalizedPhones(rows7).join(',') === '919000011111');
  check('7. All three formatting variants are within-file duplicates', detected7.every((r) => r.duplicateRows.length === 2 && r.status === 'within-file-duplicate'));
  check('7. Raw WhatsApp values are preserved for display', detected7.map((r) => r.whatsappNumber).join('|') === '+91 90000 11111|919000011111|91-90000-11111');
  check('7. Canonical value identical for all three', detected7.every((r) => r.normalizedPhone === '919000011111'));

  // 8. The lookup request list is de-duplicated before it is sent
  const rows8 = rowsFrom('dedupe.csv', 'Name,WhatsApp Number\nA,+91 90000 11111\nB,919000011111\nC,+91 90000 11111\nD,+91 90000 22222\n', map1);
  const lookup8 = collectUniqueNormalizedPhones(rows8);
  check('8. Request list contains only unique normalized phones', lookup8.join(',') === '919000011111,919000022222', 'phones=' + lookup8.join(','));
  check('8. All four rows are still reported (none dropped silently)', rows8.length === 4 && getDuplicateSummary(applyDuplicateDetection(rows8, [])).withinFileDuplicates === 3);
}

function backNavigationTests() {
  console.log('\n--- Back navigation + mapping change (items 13, 14) ---');
  const wizard = readSource(WIZARD_PATH);
  const map1 = { ...emptyMapping(), name: 'Name', whatsappNumber: 'WhatsApp Number' };

  // 13. "Back to Validation" returns to Step 12C and preserves the wizard state
  const backNavSource = (wizard.match(/const handleBackToValidation = \(\) => \{[\s\S]*?\n  \};/) || [''])[0];
  check('13. Back to Validation returns to the validation step', /setStep\('validate'\)/.test(backNavSource), backNavSource.replace(/\s+/g, ' '));
  check('13. Back to Validation keeps the file, preview, mapping and rows', !/(setFile\(|setPreview\(|setMapping\(|setImportRows\(|resetSelection)/.test(backNavSource));
  check('13. Back to Validation control is rendered', /Back to Validation/.test(wizard));
  check('13. Duplicate detection is its own wizard step', /'upload' \| 'mapping' \| 'validate' \| 'duplicates'/.test(wizard));

  const rows13 = rowsFrom('backnav.csv', 'Name,WhatsApp Number\nA,+91 90000 33333\nB,+91 90000 33333\n', map1);
  const rows13Before = JSON.stringify(rows13);
  const existing13 = ['919000033333'];
  const existing13Before = JSON.stringify(existing13);
  const detected13 = applyDuplicateDetection(rows13, existing13);
  check('13. Step 12C validation state is preserved for every row', JSON.stringify(rows13) === rows13Before && detected13[0].isValid === true && detected13[0].errors.length === 0);
  check('13. Lookup list passed in is not mutated', JSON.stringify(existing13) === existing13Before);
  check('13. Original row numbers are preserved through detection', detected13.map((r) => r.rowNumber).join(',') === rows13.map((r) => r.rowNumber).join(','));

  // 14. Changing the mapping discards and recalculates the duplicate results
  const preview14 = buildPreview('mapping-change.csv', 'Name,Phone,Alternate Phone\nA,+91 90000 44444,+91 90000 55555\nB,+91 90000 44444,+91 90000 66666\n');
  const mapA = { ...emptyMapping(), name: 'Name', whatsappNumber: 'Phone' };
  const detectedA = applyDuplicateDetection(validateAndNormalizeRows(preview14, mapA), []);
  check('14. First mapping yields within-file duplicates', detectedA.every((r) => r.duplicateRows.length === 1 && r.status === 'within-file-duplicate') && detectedA[0].normalizedPhone === '919000044444');

  const cleared = clearDuplicateDetection(detectedA);
  check('14. Mapping change discards the stale duplicate results', cleared.every((r) => r.existingInDatabase === false && r.duplicateRows.length === 0 && r.status === 'valid') && cleared[0].normalizedPhone === '919000044444');
  const clearedSummary = getDuplicateSummary(cleared);
  check('14. Mapping change clears the duplicate summary', clearedSummary.existingDatabaseDuplicates === 0 && clearedSummary.withinFileDuplicates === 0 && clearedSummary.withinFileDuplicateGroups === 0);

  const mapB = { ...mapA, whatsappNumber: 'Alternate Phone' };
  const detectedB = applyDuplicateDetection(validateAndNormalizeRows(preview14, mapB), []);
  check('14. Duplicates recalculated from the newly normalized phones', detectedB[0].normalizedPhone === '919000055555' && detectedB[1].normalizedPhone === '919000066666' && detectedB.every((r) => r.duplicateRows.length === 0 && r.status === 'valid'));
  const updateMappingSource = (wizard.match(/const updateMapping = \([\s\S]*?\n  \};/) || [''])[0];
  check('14. ImportWizard discards duplicate results when the mapping changes', /clearDuplicateDetection/.test(updateMappingSource));
  check('14. ImportWizard runs a single duplicate request per batch', /collectUniqueNormalizedPhones\(importRows\)/.test(wizard) && /axios\.post\('\/api\/recipients\/import-duplicates'/.test(wizard));
}

async function endpointTests(snapshotBefore) {
  console.log('\n--- Duplicate lookup endpoint (real server + real database) ---');

  const dbPhones = (await prisma.recipient.findMany({ select: { normalizedPhone: true }, orderBy: { id: 'asc' } })).map((r) => r.normalizedPhone);
  const existingPhone = dbPhones[0];
  const existingPhones = dbPhones.slice(0, 2);
  let unknownPhone = '9199' + String(Date.now()).slice(-8);
  while (dbPhones.includes(unknownPhone)) unknownPhone += '1';
  const localPart = existingPhone.slice(-10);
  const rawFormatted = '+91 ' + localPart.slice(0, 5) + ' ' + localPart.slice(5);

  // 9. The lookup endpoint requires the existing authenticated admin session
  const anonymous = await postJson('/api/recipients/import-duplicates', { normalizedPhones: [existingPhone] });
  check('9. Unauthenticated duplicate lookup returns 401', anonymous.status === 401 && anonymous.body?.error?.code === 'UNAUTHORIZED', 'status=' + anonymous.status);

  // Temporary admin user created for this run and removed again in cleanup
  const email = 'test-12d-' + Date.now() + '@local.test';
  const tempUser = await prisma.user.create({ data: { email: email, password: await argon2.hash('test-12d-password') } });
  tempUserId = tempUser.id;
  const cookie = await loginAs(email, 'test-12d-password');
  check('9. Temporary admin session works for the duplicate lookup', typeof cookie === 'string' && cookie.startsWith('connect.sid='), 'cookie=' + cookie.slice(0, 12) + '...');

  // 2. An existing normalized phone is reported as a duplicate
  const existingLookup = await postJson('/api/recipients/import-duplicates', { normalizedPhones: [existingPhone] }, cookie);
  const existingDuplicates = existingLookup.body?.data?.duplicates ?? [];
  check('2. Existing normalizedPhone reported by the endpoint', existingLookup.status === 200 && existingDuplicates.length === 1 && existingDuplicates[0].normalizedPhone === existingPhone, JSON.stringify(existingLookup.body));
  check('2. Endpoint exposes only the normalized phone', existingDuplicates.length > 0 && existingDuplicates.every((d) => Object.keys(d).join(',') === 'normalizedPhone'));
  const unknownLookup = await postJson('/api/recipients/import-duplicates', { normalizedPhones: [unknownPhone] }, cookie);
  check('2. Unknown normalizedPhone is not reported', unknownLookup.body?.data?.duplicates?.length === 0 && unknownLookup.body?.data?.checkedCount === 1);

  // 7. The lookup matches the canonical value, not the raw WhatsApp formatting
  const rawLookup = await postJson('/api/recipients/import-duplicates', { normalizedPhones: [rawFormatted] }, cookie);
  const canonicalLookup = await postJson('/api/recipients/import-duplicates', { normalizedPhones: [existingPhone] }, cookie);
  check('7. Raw WhatsApp formatting does not match a stored recipient', rawLookup.body?.data?.duplicates?.length === 0, 'raw=' + rawFormatted);
  check('7. Canonical normalized phone does match', canonicalLookup.body?.data?.duplicates?.length === 1);

  // 8. The request list is de-duplicated before the single lookup
  const dedupeLookup = await postJson('/api/recipients/import-duplicates', { normalizedPhones: [existingPhone, existingPhone, unknownPhone, unknownPhone, ''] }, cookie);
  const dedupeDuplicates = dedupeLookup.body?.data?.duplicates ?? [];
  check('8. Backend de-duplicates the request before querying', dedupeLookup.body?.data?.checkedCount === 2, 'checkedCount=' + dedupeLookup.body?.data?.checkedCount);
  check('8. Duplicate list contains no repeated entries', dedupeDuplicates.length === 1 && new Set(dedupeDuplicates.map((d) => d.normalizedPhone)).size === dedupeDuplicates.length);

  // 10. One single batch request covers the whole import set
  const batchPhones = existingPhones.concat([unknownPhone]);
  const batchLookup = await postJson('/api/recipients/import-duplicates', { normalizedPhones: batchPhones }, cookie);
  check('10. One batch request checks the whole import set', batchLookup.body?.data?.checkedCount === batchPhones.length && batchLookup.body?.data?.duplicates?.length === existingPhones.length, JSON.stringify(batchLookup.body?.data));

  // Empty and malformed payloads
  const emptyLookup = await postJson('/api/recipients/import-duplicates', { normalizedPhones: [] }, cookie);
  const badLookup = await postJson('/api/recipients/import-duplicates', { normalizedPhones: 'not-an-array' }, cookie);
  check('8. Empty request list short-circuits without duplicates', emptyLookup.status === 200 && emptyLookup.body?.data?.checkedCount === 0 && emptyLookup.body?.data?.duplicates?.length === 0);
  check('8. Malformed request list is rejected', badLookup.status === 400 && badLookup.body?.error?.code === 'VALIDATION_ERROR');

    // 10. The handler is read-only and the route uses the shared middleware
  const controllerSource = readSource(CONTROLLER_PATH);
  const handlerStart = controllerSource.indexOf('export const checkImportDuplicates');
  const handlerEnd = controllerSource.indexOf('};', controllerSource.indexOf('checkImportDuplicates')) + 2;
  const handlerSource = controllerSource.slice(handlerStart, handlerEnd);
  check('10. Handler performs a read-only lookup only', /prisma\.recipient\.findMany\s*\(/.test(handlerSource) && !/prisma\.recipient\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/.test(handlerSource) && !/\$transaction|\$executeRaw|\$queryRaw/.test(handlerSource));
  const routesSource = readSource(ROUTES_PATH);
  check('9. Route registered under the existing auth middleware', /router\.use\(requireAuth\)/.test(routesSource) && /router\.post\('\/import-duplicates', checkImportDuplicates\)/.test(routesSource));

  // 10./11./12. The recipient database is untouched by all of the above
  const snapshotAfter = await snapshotRecipients();
  check('11. Recipient count is unchanged', snapshotBefore.length === snapshotAfter.length, 'before=' + snapshotBefore.length + ' after=' + snapshotAfter.length);
  check('12. Every existing recipient record is unchanged', JSON.stringify(snapshotBefore) === JSON.stringify(snapshotAfter));
  check('10. Duplicate lookup created no recipients', (await prisma.recipient.count()) === snapshotBefore.length);
}
function regressionTests() {
  console.log('\n--- Regression + build checks (items 15-18) ---');

  const step12c = runCommand('node test-12c.cjs', REPO_ROOT);
  check('15. Existing Steps 12A/12B/12C tests still pass', step12c.status === 0 && /All checks passed/.test(step12c.output), step12c.status === 0 ? '' : step12c.output.slice(-300));

  const serverBuild = runCommand('npx tsc -p apps/server/tsconfig.json --noEmit', REPO_ROOT);
  check('16. Backend TypeScript build passes', serverBuild.status === 0, serverBuild.status === 0 ? '' : serverBuild.output.slice(-300));

  const webBuild = runCommand('npm run build --workspace=apps/web', REPO_ROOT);
  check('17. Frontend TypeScript + build passes', webBuild.status === 0 && /built in/.test(webBuild.output), webBuild.status === 0 ? '' : webBuild.output.slice(-300));

  const lint = runCommand('npm run lint --workspace=apps/web', REPO_ROOT);
  check('18. Frontend lint passes with no errors', lint.status === 0 && /0 errors/.test(lint.output), lint.status === 0 ? '' : lint.output.slice(-300));

  // Scope boundary: Step 12D must not use the legacy import endpoints. Step 12F
  // (added later) legitimately adds the explicit import action, so the assertion
  // now pins it to the new /api/recipients/import endpoint instead of banning it.
  const wizard = readSource(WIZARD_PATH);
  check('19. No legacy import endpoint is wired into the wizard',
    !/\/api\/imports\/(confirm|preview)/.test(wizard) &&
    !/(Send Now|Import Now|Start Import)/i.test(wizard));
  check('19b. The only import action targets POST /api/recipients/import',
    /axios\.post\('\/api\/recipients\/import'/.test(wizard));
}
async function main() {
  console.log('=== Step 12D: Duplicate Detection Tests ===\n');
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

  // Start the real Express app on a dedicated port (the same entry point `npm run dev` uses)
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

  const usersBefore = await prisma.user.count();
  const snapshotBefore = await snapshotRecipients();

  try {
    frontendDuplicateTests();
    backNavigationTests();

    if (serverUp) {
      await endpointTests(snapshotBefore);
    } else {
      console.log('SKIP: endpoint tests (server was not reachable)');
    }

    regressionTests();

    const snapshotFinal = await snapshotRecipients();
    check('12. Recipient table unchanged after the whole Step 12D run', JSON.stringify(snapshotBefore) === JSON.stringify(snapshotFinal));
  } finally {
    // Cleanup: temporary admin user + local fixtures
    if (tempUserId) {
      try {
        await prisma.user.delete({ where: { id: tempUserId } });
      } catch (error) {
        check('cleanup. Temporary test user deleted', false, String(error.message));
      }
      tempUserId = null;
    }
    const usersAfter = await prisma.user.count();
    check('cleanup. No test users left behind', usersBefore === usersAfter, 'before=' + usersBefore + ' after=' + usersAfter);
    fs.rmSync(DIR, { recursive: true, force: true });

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