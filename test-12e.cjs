/**
 * Step 12E - Final import preview + row-selection decision tests.
 *
 * These tests exercise the real production pipeline:
 * - apps/web/src/utils/importMapping.util.ts   (real Step 12C + 12D logic)
 * - apps/web/src/utils/importSelection.util.ts (real Step 12E decision logic)
 * - apps/web/src/pages/ImportWizard.tsx        (source-level safety checks)
 * - the real database (read-only: recipients are snapshotted before and after)
 *
 * Step 12E must be completely database-write-free, so nothing here ever inserts,
 * updates or deletes a recipient; the snapshots must be byte-identical.
 */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { spawnSync } = require('child_process');
const XLSX = require('xlsx');
const {
  validateAndNormalizeRows,
  applyDuplicateDetection,
} = require('./apps/web/src/utils/importMapping.util.ts');
const {
  buildImportSelection,
  reconcileImportSelection,
  setImportDecision,
  selectAllImportableRows,
  deselectAllRows,
  getRowDecision,
  getImportPreviewSummary,
  getImportDecisionReason,
  getImportDecisionDetails,
  canChangeImportDecision,
  isImportEligible,
} = require('./apps/web/src/utils/importSelection.util.ts');

dotenv.config({ path: path.join(__dirname, '.env') });

const REPO_ROOT = __dirname;
const WIZARD_PATH = path.join(REPO_ROOT, 'apps/web/src/pages/ImportWizard.tsx');
const SELECTION_PATH = path.join(REPO_ROOT, 'apps/web/src/utils/importSelection.util.ts');
const MAPPING_PATH = path.join(REPO_ROOT, 'apps/web/src/utils/importMapping.util.ts');
const DIR = path.join(REPO_ROOT, 'test-12e-files');
const PREVIEW_ROW_COUNT = 5;

let failures = 0;
let prisma = null;

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
  return { fileName, headers, rows: rows.slice(0, PREVIEW_ROW_COUNT), allRows: rows, totalRows: rows.length };
}

function rowsFrom(fileName, content, mapping) {
  return validateAndNormalizeRows(buildPreview(fileName, content), mapping);
}

function readSource(p) {
  return fs.readFileSync(p, 'utf8');
}

function runCommand(cmd, cwd) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8' });
  return { status: r.status, output: String(r.stdout || '') + String(r.stderr || '') };
}

const MAPPING_FIXTURE = { ...emptyMapping(), name: 'Name', whatsappNumber: 'WhatsApp Number' };
const CSV_FIXTURE =
  'Name,WhatsApp Number\n' +
  'Unique One,+91 90000 10001\n' + // valid unique -> IMPORT
  ',+91 90000 10002\n' +           // invalid (missing name) -> SKIP, not selectable
  'Db Dup,+91 90000 10003\n' +     // existing database duplicate -> SKIP
  'File A,+91 90000 10004\n' +     // within-file duplicate of File B -> SKIP
  'File B,919000010004\n' +        // same normalized phone, different raw format -> SKIP
  'Both A,+91 90000 10005\n' +     // database duplicate AND within-file duplicate -> SKIP
  'Both B,+91 90000 10005\n';      // database duplicate AND within-file duplicate -> SKIP
const EXISTING_PHONES = ['919000010003', '919000010005'];

/** Full Step 12C + 12D pipeline result for the fixture (rows 1-7). */
function previewFixture() {
  const rows = rowsFrom('preview.csv', CSV_FIXTURE, MAPPING_FIXTURE);
  return applyDuplicateDetection(rows, EXISTING_PHONES);
}

function byName(rows) {
  return Object.fromEntries(rows.map((r) => [r.name === '' ? '(invalid)' : r.name, r]));
}

function selectionTests() {
  console.log('\n--- Import decisions (items 1-10) ---');
  const rows = previewFixture();
  const name = byName(rows);
  const sel = buildImportSelection(rows);

  check('1. Valid unique rows default to IMPORT', getRowDecision(sel, name['Unique One']) === 'IMPORT');
  check('2. Invalid rows default to SKIP', getRowDecision(sel, name['(invalid)']) === 'SKIP');
  check('3. Existing database duplicates default to SKIP', getRowDecision(sel, name['Db Dup']) === 'SKIP');
  check('4. Within-file duplicates default to SKIP (both rows of the group)',
    getRowDecision(sel, name['File A']) === 'SKIP' && getRowDecision(sel, name['File B']) === 'SKIP');
  check('5. Rows with both duplicate conditions default to SKIP',
    getRowDecision(sel, name['Both A']) === 'SKIP' && getRowDecision(sel, name['Both B']) === 'SKIP');

  check('6. Invalid rows cannot be changed to IMPORT',
    getRowDecision(setImportDecision(sel, name['(invalid)'], 'IMPORT'), name['(invalid)']) === 'SKIP');
  check('7. Existing DB duplicates cannot be changed to IMPORT',
    getRowDecision(setImportDecision(sel, name['Db Dup'], 'IMPORT'), name['Db Dup']) === 'SKIP');
  check('8. Within-file duplicates cannot be changed to IMPORT',
    getRowDecision(setImportDecision(sel, name['File A'], 'IMPORT'), name['File A']) === 'SKIP');
  check('8b. Both-conditions rows cannot be changed to IMPORT',
    getRowDecision(setImportDecision(sel, name['Both A'], 'IMPORT'), name['Both A']) === 'SKIP');

  const skipped = setImportDecision(sel, name['Unique One'], 'SKIP');
  check('9. Valid unique row can be changed IMPORT -> SKIP', getRowDecision(skipped, name['Unique One']) === 'SKIP');
  check('10. Valid unique row can be changed SKIP -> IMPORT',
    getRowDecision(setImportDecision(skipped, name['Unique One'], 'IMPORT'), name['Unique One']) === 'IMPORT');

  check('6b. Locked rows report cannot-change',
    !canChangeImportDecision(name['(invalid)']) && !canChangeImportDecision(name['Db Dup']) &&
    !canChangeImportDecision(name['File A']) && !canChangeImportDecision(name['Both A']));
  check('10b. Eligible row reports can-change',
    canChangeImportDecision(name['Unique One']) && isImportEligible(name['Unique One']));

  check('3b. DB duplicate reason text', getImportDecisionReason(name['Db Dup']) === 'Already exists in database.');
  check('4b. Within-file duplicate reason text', getImportDecisionReason(name['File A']) === 'Duplicate in this file.');
  check('5b. Both-conditions reason text',
    getImportDecisionReason(name['Both A']) === 'Already exists in database and is duplicated in this file.');
  check('2b. Invalid reason text', getImportDecisionReason(name['(invalid)']) === 'Validation error.');
  check('1b. Ready reason text', getImportDecisionReason(name['Unique One']) === 'Ready');
  check('9b. Manual skip is explained in the details column',
    getImportDecisionDetails(name['Unique One'], 'SKIP') === 'Ready. Skipped by user.');
  check('4c. Duplicate lookup was based on normalizedPhone, not raw formatting',
    name['File A'].normalizedPhone === '919000010004' && name['File B'].normalizedPhone === '919000010004' &&
    name['File A'].duplicateRows.length === 1 && name['File A'].duplicateRows[0] === name['File B'].rowNumber);
}

function summaryTests() {
  console.log('\n--- Preview summary + bulk controls (items 11-15) ---');
  const rows = previewFixture();
  const name = byName(rows);
  const defaults = buildImportSelection(rows);

  const d = getImportPreviewSummary(rows, defaults);
  check('13. Selected count is correct by default', d.selectedForImport === 1, JSON.stringify(d));
  check('14. Skipped count is correct by default', d.skippedRows === 6);
  check('13a. Total/valid/invalid counts are correct',
    d.totalRows === 7 && d.validRows === 6 && d.invalidRows === 1);
  check('13b. Duplicate counts count affected rows',
    d.existingDatabaseDuplicates === 3 && d.withinFileDuplicateRows === 4);

  check('15. Every row remains visible in the preview set',
    rows.length === 7 && rows.every((r) => Object.prototype.hasOwnProperty.call(defaults, r.rowNumber)));

  const afterUserSkip = setImportDecision(defaults, name['Unique One'], 'SKIP');
  const s2 = getImportPreviewSummary(rows, afterUserSkip);
  check('13c. Selected count reflects a manual skip', s2.selectedForImport === 0);
  check('14b. Skipped count reflects a manual skip', s2.skippedRows === 7);

  const allSelected = selectAllImportableRows(rows);
  const s3 = getImportPreviewSummary(rows, allSelected);
  check('11. Select-all selects only eligible valid unique rows', s3.selectedForImport === 1);
  check('11b. Select-all never selects invalid, DB-duplicate or within-file rows',
    getRowDecision(allSelected, name['(invalid)']) === 'SKIP' &&
    getRowDecision(allSelected, name['Db Dup']) === 'SKIP' &&
    getRowDecision(allSelected, name['File A']) === 'SKIP' &&
    getRowDecision(allSelected, name['Both A']) === 'SKIP');

  const noneSelected = deselectAllRows(rows);
  const s4 = getImportPreviewSummary(rows, noneSelected);
  check('12. Deselect-all clears every eligible selection', s4.selectedForImport === 0 && s4.skippedRows === 7);
}

function reconcileTests() {
  console.log('\n--- Back navigation + stale selection safety (items 17-18) ---');
  const rows = previewFixture();
  const name = byName(rows);
  const sel = buildImportSelection(rows);

  // Item 17: leaving the preview (back to duplicate check) and returning again
  // reconciles the same rows, so the decisions must survive unchanged.
  const userSkipped = setImportDecision(sel, name['Unique One'], 'SKIP');
  const reconciled = reconcileImportSelection(rows, userSkipped);
  check('17. Manual skip survives back navigation + reconcile',
    getRowDecision(reconciled, name['Unique One']) === 'SKIP');
  check('17b. Default decisions survive back navigation + reconcile',
    getRowDecision(reconciled, name['Db Dup']) === 'SKIP' &&
    getRowDecision(reconciled, name['File A']) === 'SKIP' &&
    getRowDecision(reconciled, name['Both A']) === 'SKIP' &&
    getRowDecision(reconciled, name['Unique One']) !== undefined);
  check('17c. Reconcile keeps a decision for every row',
    rows.every((r) => Object.prototype.hasOwnProperty.call(reconciled, r.rowNumber)));

  // Item 18: a mapping change re-runs validation; Unique One loses its phone and
  // becomes invalid. A stale IMPORT from the previous run must NOT survive, and
  // the reconciled decisions must equal the fresh defaults for every row.
  const stalePrev = { [name['Unique One'].rowNumber]: 'IMPORT', [name['File A'].rowNumber]: 'SKIP' };
  const remapped = rowsFrom('remapped.csv',
    'Name,WhatsApp Number\nUnique One,\nGood Two,+91 90000 10009\n', MAPPING_FIXTURE);
  const remappedName = byName(remapped);
  check('18-setup. Remapped Unique One is now invalid with no normalized phone',
    remappedName['Unique One'].isValid === false && remappedName['Unique One'].normalizedPhone === null);
  const afterRemap = reconcileImportSelection(remapped, stalePrev);
  check('18. Stale IMPORT cannot survive a changed classification',
    getRowDecision(afterRemap, remappedName['Unique One']) === 'SKIP');
  check('18b. Newly invalid row is locked to SKIP',
    !canChangeImportDecision(remappedName['Unique One']));
  check('18c. Reconciled decisions equal fresh defaults for every remapped row',
    remapped.every((r) => getRowDecision(afterRemap, r) === getRowDecision(buildImportSelection(remapped), r)));
}

function wizardSafetyTests() {
  console.log('\n--- Wizard UI safety (items 15-16, scope boundary) ---');
  const wizard = readSource(WIZARD_PATH);

  check('15b. Preview table renders every import row',
    /importRows\.map\(\(row\) => \{/.test(wizard));

  check('16. Continue button only navigates to the confirmation state',
    /const handleContinueToConfirmation = \(\) => \{\s*setStep\('confirmation'\);\s*\};/.test(wizard));

  const apiCalls = wizard.match(/axios\.(post|put|patch|delete)\(/g) ?? [];
  check('16b. Wizard calls exactly the two intended recipient endpoints',
    apiCalls.length === 2 && wizard.includes("axios.post('/api/recipients/import-duplicates'"),
    wizard.includes("axios.post('/api/recipients/import'"),
    JSON.stringify(apiCalls));

  check('16c. No legacy import or confirmation endpoints are referenced',
    !/\/api\/imports\//.test(wizard) && !/\/api\/recipients['"]/.test(wizard));

  check('16d. The only import action is the explicit "Confirm Import" gate',
    /Confirm Import/.test(wizard) &&
    !/(Import Now|Start Import|Send Now)/i.test(wizard));

  check('16e. "Continue to Import Confirmation" navigation button present',
    /Continue to Import Confirmation/.test(wizard));

  check('16f. "Nothing has been imported yet" safety message present',
    /Nothing has been imported yet/.test(wizard));

  check('16g. Selection count message present',
    /recipients are selected for import\./.test(wizard));

  check('16h. Decision buttons are disabled for locked rows',
    /disabled=\{!editable\}/.test(wizard));

  check('16i. Bulk controls present (select all eligible / deselect all)',
    /handleSelectAllImportable/.test(wizard) && /handleDeselectAll/.test(wizard));

  check('16j. Per-row decision control present',
    /handleDecisionChange\(/.test(wizard) && /getDecisionButtonClass\(/.test(wizard));

  check('17d. "Back to Duplicate Check" only navigates back (preserves all state)',
    /const handleBackToDuplicates = \(\) => \{\s*setStep\('duplicates'\);\s*\};/.test(wizard));

  check('18d. Mapping change discards stale preview decisions',
    /setImportSelection\(\{\}\);/.test(wizard));

  const selection = readSource(SELECTION_PATH);
  check('19a. Selection module performs no database or HTTP work',
    !/prisma|axios|fetch\(|http|require\(/i.test(selection));
  check('19b. Decision state is kept out of ImportRow (separate ImportSelection type)',
    /export type ImportSelection = Record<number, ImportDecision>;/.test(selection) &&
    !/ImportDecision/.test(readSource(MAPPING_PATH)));
}

async function snapshotRecipients() {
  const recipients = await prisma.recipient.findMany({ orderBy: { id: 'asc' } });
  return JSON.parse(JSON.stringify(recipients));
}

function regressionTests() {
  console.log('\n--- Regression + build checks (items 20-23) ---');

  const step12c = runCommand('node test-12c.cjs', REPO_ROOT);
  check('20. Steps 12A/12B/12C tests still pass',
    step12c.status === 0 && /All checks passed/.test(step12c.output),
    step12c.status === 0 ? '' : step12c.output.slice(-300));

  const step12d = runCommand('node test-12d.cjs', REPO_ROOT);
  check('20b. Step 12D tests still pass',
    step12d.status === 0 && /All checks passed/.test(step12d.output),
    step12d.status === 0 ? '' : step12d.output.slice(-300));

  const serverBuild = runCommand('npx tsc -p apps/server/tsconfig.json --noEmit', REPO_ROOT);
  check('21. Backend TypeScript build passes', serverBuild.status === 0,
    serverBuild.status === 0 ? '' : serverBuild.output.slice(-300));

  const webBuild = runCommand('npm run build --workspace=apps/web', REPO_ROOT);
  check('22. Frontend TypeScript + build passes',
    webBuild.status === 0 && /built in/.test(webBuild.output),
    webBuild.status === 0 ? '' : webBuild.output.slice(-300));

  const lint = runCommand('npm run lint --workspace=apps/web', REPO_ROOT);
  check('23. Frontend lint passes with no errors', lint.status === 0 && /0 errors/.test(lint.output),
    lint.status === 0 ? '' : lint.output.slice(-300));
}

async function main() {
  console.log('=== Step 12E: Final Import Preview Tests ===\n');
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient();

  try {
    const snapshotBefore = await snapshotRecipients();
    check('0. Recipient snapshot taken for the read-only verification',
      Array.isArray(snapshotBefore), 'recipients=' + snapshotBefore.length);

    selectionTests();
    summaryTests();
    reconcileTests();
    wizardSafetyTests();

    // Items 12/16/19: nothing in Step 12E may write to the database.
    const snapshotAfter = await snapshotRecipients();
    check('19. Recipient count is unchanged',
      snapshotAfter.length === snapshotBefore.length,
      'before=' + snapshotBefore.length + ' after=' + snapshotAfter.length);
    check('19c. Every existing recipient record is unchanged',
      JSON.stringify(snapshotBefore) === JSON.stringify(snapshotAfter));

    regressionTests();

    const snapshotFinal = await snapshotRecipients();
    check('19d. Recipient table unchanged after the whole Step 12E run',
      JSON.stringify(snapshotBefore) === JSON.stringify(snapshotFinal));
  } finally {
    fs.rmSync(DIR, { recursive: true, force: true });
    await prisma.$disconnect();
  }

  console.log('\n=== ' + (failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED') + ' ===');
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('Error:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});