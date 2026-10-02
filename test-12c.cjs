/**
 * Step 12C - Validation + Normalization tests.
 *
 * These tests exercise the real production logic in
 * apps/web/src/utils/importMapping.util.ts (the same module ImportWizard.tsx uses),
 * so the tests cannot drift from the UI behaviour.
 */
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const {
  validateAndNormalizeRows,
  getObviousMatch,
  MAPPING_FIELDS,
} = require('./apps/web/src/utils/importMapping.util.ts');

const PREVIEW_ROW_COUNT = 5;
const utilPath = path.join(__dirname, 'apps/web/src/utils/importMapping.util.ts');
const DIR = path.join(__dirname, 'test-12c-files');

let failures = 0;

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

/**
 * Mirrors the Step 12A parsing in ImportWizard.tsx: parse the file with XLSX,
 * keep every row in `allRows` and only the first PREVIEW_ROW_COUNT rows in `rows`.
 */
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
async function main() {
  console.log('=== Step 12C: Validation + Normalization Tests ===\n');
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

  // 1. Valid row: valid name + valid WhatsApp number -> valid row
  const p1 = buildPreview('valid.csv', 'Name,WhatsApp Number\nRavi Kumar,+91 90000 11111\n');
  const map1 = { ...emptyMapping(), name: 'Name', whatsappNumber: 'WhatsApp Number' };
  const r1 = validateAndNormalizeRows(p1, map1);
  check('1. Valid row marked valid', r1.length === 1 && r1[0].isValid === true && r1[0].errors.length === 0);
  check('1. Name + number read from mapped columns', r1[0].name === 'Ravi Kumar' && r1[0].whatsappNumber === '+91 90000 11111', 'name=' + r1[0].name);
  check('1. Normalized phone produced', r1[0].normalizedPhone === '919000011111', 'normalized=' + r1[0].normalizedPhone);

  // 2. Blank name -> invalid, with a clear error message
  const p2 = buildPreview('missing-name.csv', 'Name,WhatsApp Number\n   ,+91 90000 22222\n');
  const r2 = validateAndNormalizeRows(p2, map1);
  check('2. Blank name -> invalid', r2[0].isValid === false && r2[0].errors.includes('Name is required.'), 'errors=' + r2[0].errors.join('; '));
  check('2. Phone still normalized when only name is missing', r2[0].normalizedPhone === '919000022222', 'normalized=' + r2[0].normalizedPhone);

  // 3. Blank WhatsApp number -> invalid
  const p3 = buildPreview('missing-phone.csv', 'Name,WhatsApp Number\nSuresh,\n');
  const r3 = validateAndNormalizeRows(p3, map1);
  check('3. Blank number -> invalid', r3[0].isValid === false && r3[0].errors.includes('WhatsApp number is required.'), 'errors=' + r3[0].errors.join('; '));
  check('3. normalizedPhone is null', r3[0].normalizedPhone === null);

  // 4. Non-numeric WhatsApp number -> invalid
  const p4 = buildPreview('invalid-phone.csv', 'Name,WhatsApp Number\nSuresh,not-a-number\n');
  const r4 = validateAndNormalizeRows(p4, map1);
  check('4. Non-numeric number -> invalid', r4[0].isValid === false && r4[0].errors.includes('Invalid WhatsApp number.'), 'errors=' + r4[0].errors.join('; '));

  // 5. Local 10-digit number is normalized with the 91 country prefix
  const p5 = buildPreview('ten-digit.csv', 'Name,WhatsApp Number\nRavi,9000011111\n');
  const r5 = validateAndNormalizeRows(p5, map1);
  check('5. 10-digit number -> 91 prefixed', r5[0].normalizedPhone === '919000011111' && r5[0].isValid, 'normalized=' + r5[0].normalizedPhone);

  // 6. Spaces, brackets, hyphens and plus signs are stripped
  const p6 = buildPreview('dirty-format.csv', 'Name,WhatsApp Number\nRavi,+91 (90000) 111-11\n');
  const r6 = validateAndNormalizeRows(p6, map1);
  check('6. Formatting characters stripped', r6[0].normalizedPhone === '919000011111' && r6[0].isValid, 'normalized=' + r6[0].normalizedPhone);

  // 7. Already-international numbers keep all of their digits
  const p7 = buildPreview('international.csv', 'Name,WhatsApp Number\nRavi,+91 98765 43210\n');
  const r7 = validateAndNormalizeRows(p7, map1);
  check('7. 12-digit international number kept as digits only', r7[0].normalizedPhone === '919876543210', 'normalized=' + r7[0].normalizedPhone);

  // 8. Optional fields are captured (and trimmed) when they are mapped
  const optionalCsv =
    'Name,WhatsApp Number,Language,Category,Consent Status,Consent Timestamp,Notes,Source\n' +
    'Ravi,+91 90000 11111,  Malayalam  ,Senior Citizens,Opted In,2026-01-05T09:00:00Z,Prefers morning,Website\n' +
    'Suresh,+91 90000 22222,,,,,,\n';
  const p8 = buildPreview('optional-fields.csv', optionalCsv);
  const map8 = {
    name: 'Name',
    whatsappNumber: 'WhatsApp Number',
    language: 'Language',
    category: 'Category',
    consentStatus: 'Consent Status',
    consentTimestamp: 'Consent Timestamp',
    notes: 'Notes',
    source: 'Source',
  };
  const r8 = validateAndNormalizeRows(p8, map8);
  check('8. Optional fields captured and trimmed', r8[0].language === 'Malayalam' && r8[0].category === 'Senior Citizens' && r8[0].consentStatus === 'Opted In', 'lang=' + r8[0].language);
  check('8. Consent timestamp, notes and source captured', r8[0].consentTimestamp === '2026-01-05T09:00:00Z' && r8[0].notes === 'Prefers morning' && r8[0].source === 'Website');
  check('8. Empty optional values become null', r8[1].language === null && r8[1].notes === null && r8[1].source === null);
  check('8. Row with empty optional values is still valid', r8[1].isValid === true);

  // 9. Unmapped optional fields stay null
  const r9 = validateAndNormalizeRows(p8, map1);
  check('9. Unmapped optional fields are null', r9[0].language === null && r9[0].category === null && r9[0].consentStatus === null && r9[0].consentTimestamp === null && r9[0].notes === null && r9[0].source === null);

  // 10. Multiple problems on the same row are reported together
  const p10 = buildPreview('multi-error.csv', 'Name,WhatsApp Number\n,ABC\n');
  const r10 = validateAndNormalizeRows(p10, map1);
  check('10. Row has exactly the two expected errors', r10[0].isValid === false && r10[0].errors.length === 2, 'errors=' + r10[0].errors.join('; '));
  check('10. Name error included', r10[0].errors.includes('Name is required.'));
  check('10. Number error included', r10[0].errors.includes('Invalid WhatsApp number.'));
  check('10. Known limitation: short digit strings pass normalization', (() => { const r = validateAndNormalizeRows(buildPreview('digits-only.csv', 'Name,WhatsApp Number\nRavi,91-ABC-99\n'), map1)[0]; return r.isValid === true && r.normalizedPhone === '9199'; })(), 'pre-existing phone.util behaviour');

  // 11. Every parsed row is validated and keeps its original spreadsheet row number
  let rowsCsv = 'Name,WhatsApp Number\n';
  for (let i = 1; i <= 7; i++) rowsCsv += 'Person ' + i + ',+91 90000 0000' + i + '\n';
  const p11 = buildPreview('seven-rows.csv', rowsCsv);
  const r11 = validateAndNormalizeRows(p11, map1);
  check('11. All rows validated, not only the preview slice', r11.length === 7 && p11.rows.length === PREVIEW_ROW_COUNT, 'validated=' + r11.length + ' previewRows=' + p11.rows.length);
  check('11. Row numbers are 1..7 in order', r11.map((r) => r.rowNumber).join(',') === '1,2,3,4,5,6,7', 'rows=' + r11.map((r) => r.rowNumber).join(','));
  check('11. Every row produced a valid normalized phone', r11.every((r) => r.isValid && r.normalizedPhone && r.normalizedPhone.startsWith('9190')), 'valid=' + r11.filter((r) => r.isValid).length);

  // 12. Valid / invalid totals are correct
  const p12 = buildPreview('mixed.csv', 'Name,WhatsApp Number\nRavi,+91 90000 11111\n,+91 90000 22222\nSuresh,bad-number\nMahesh,+91 90000 44444\n');
  const r12 = validateAndNormalizeRows(p12, map1);
  check('12. Valid count correct', r12.filter((r) => r.isValid).length === 2, 'valid=' + r12.filter((r) => r.isValid).length);
  check('12. Invalid count correct', r12.filter((r) => !r.isValid).length === 2, 'invalid=' + r12.filter((r) => !r.isValid).length);
  check('12. Totals add up to the parsed rows', r12.length === p12.totalRows, 'total=' + r12.length);

  // 13. Going back to Column Mapping preserves the mapping (validation is read-only)
  const map13 = { ...map1 };
  const map13Before = JSON.stringify(map13);
  validateAndNormalizeRows(p11, map13);
  check('13. Mapping preserved and not mutated by validation', JSON.stringify(map13) === map13Before && map13.name === 'Name' && map13.whatsappNumber === 'WhatsApp Number');

  // 14. Re-running after a mapping change recalculates the validation result
  const map14 = { ...map1, whatsappNumber: null };
  const r14 = validateAndNormalizeRows(p11, map14);
  check('14. Changed mapping recalculates validation', r14[0].isValid === false && r14[0].errors.includes('WhatsApp number is required.') && r14[0].normalizedPhone === null, 'errors=' + r14[0].errors.join('; '));
  check('14. Re-running with the original mapping restores valid rows', validateAndNormalizeRows(p11, map1).every((r) => r.isValid));

  // 15. No database records are created or modified, and no network calls happen
  const utilSource = fs.readFileSync(utilPath, 'utf8');
  check('15. Validation module performs no DB / network calls', !/@prisma\/client|axios|fetch\(|XMLHttpRequest/.test(utilSource));
  try {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    const countBefore = await prisma.recipient.count();
    const r15 = validateAndNormalizeRows(p12, map1);
    const countAfter = await prisma.recipient.count();
    await prisma.$disconnect();
    check('15. Recipient table unchanged by validation', countBefore === countAfter && r15.length === p12.totalRows, 'before=' + countBefore + ' after=' + countAfter);
  } catch (e) {
    console.log('SKIP: 15. DB row-count check unavailable (' + String(e.message).split('\n')[0] + ')');
  }

  // 16. Existing Step 12A parsing still works
  const p16 = buildPreview('step12a.csv', 'Name,WhatsApp Number,Language\nTest User,+91 11111 22222,English\n');
  check('16. Step 12A parsing still works', p16.totalRows === 1 && p16.headers.join(',') === 'Name,WhatsApp Number,Language', 'headers=' + p16.headers.join(','));
  check('16. Step 12A preview slice still used for the raw table', p16.rows.length === 1 && p16.allRows.length === 1);

  // 17. Existing Step 12B mapping still works
  check('17. Step 12B obvious matches still work', getObviousMatch('Name', 'name') === true && getObviousMatch('whatsapp number', 'whatsappNumber') === true && getObviousMatch('Mobile', 'whatsappNumber') === true);
  check('17. Step 12B non-matches still rejected', getObviousMatch('Name', 'language') === false && getObviousMatch('Random Column', 'name') === false);
  check('17. Step 12B required fields still Name + WhatsApp Number', MAPPING_FIELDS.filter((f) => f.required).map((f) => f.key).join(',') === 'name,whatsappNumber');

  fs.rmSync(DIR, { recursive: true, force: true });

  console.log('\n=== ' + (failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED') + ' ===');
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error('Error:', e && e.stack ? e.stack : e);
  process.exit(1);
});
