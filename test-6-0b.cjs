// Phase 6.0B focused test: Apps Script bridge -> compiled mapper plus
// mocked Prisma -> compiled runSyncNow. PART 1/3: harness.
const fs = require('fs');
const path = require('path');
let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS: ' + name); }
  else { fail++; console.log('FAIL: ' + name + (extra ? ' | ' + extra : '')); }
}
const root = __dirname;
const mapper = require('./apps/server/dist/services/google-sync.mapper.js');
const service = require('./apps/server/dist/services/google-sync.service.js');
const client = require('./apps/server/dist/services/google-sheets.client.js');
const prisma = require('./apps/server/dist/config/db.js').prisma;
const SECRET = 'test-shared-secret-6-0b';
const EXEC_URL = 'https://script.google.com/macros/s/ABC123_def-456/exec';
function bridgePayload(rows) {
  return {
    success: true,
    headers: ['Timestamp', 'Name', 'WhatsApp Number', 'I agree to receive WhatsApp updates from JAPA'],
    tabName: 'Form Responses 1',
    rows,
  };
}
function mockBridge(handler) {
  return async (url) => {
    const u = new URL(String(url));
    return handler(u, u.searchParams.get('token'));
  };
}
function okBridge(rows) {
  return mockBridge((u, token) => {
    if (token !== SECRET) return { ok: false, status: 401, json: async () => ({ success: false, error: 'UNAUTHORIZED' }) };
    if (u.searchParams.get('action') === 'ping') return { ok: true, status: 200, json: async () => ({ success: true, message: 'ok' }) };
    return { ok: true, status: 200, json: async () => bridgePayload(rows) };
  });
}
async function withEnv(env, fn) {
  const prev = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; process.env[k] = env[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(env)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}
(async () => {
  const rows = [
    { timestamp: 't1', name: 'Asha', whatsappNumber: '98765 43210', consent: 'Yes' },
    { timestamp: 't2', name: 'Ravi', whatsappNumber: '9123456789', consent: 'No' },
  ];
  const okFetch = okBridge(rows);
  const out = await client.fetchAppsScriptRows({ url: EXEC_URL, token: SECRET }, okFetch);
  check('success response has headers and rows', Array.isArray(out.headers) && out.rows.length === 2);
  await client.pingAppsScript({ url: EXEC_URL, token: SECRET }, okFetch);
  check('ping ok with secret', true);
  try {
    await client.fetchAppsScriptRows({ url: EXEC_URL, token: 'wrong' }, okFetch);
    check('auth fail throws', false);
  } catch (e) { check('auth fail is UNAUTHORIZED', e.message === 'APPS_SCRIPT_UNAUTHORIZED', e.message); }
  const pUrl = process.env.GOOGLE_APPS_SCRIPT_URL;
  const pTok = process.env.GOOGLE_APPS_SCRIPT_TOKEN;
  process.env.GOOGLE_APPS_SCRIPT_URL = EXEC_URL;
  process.env.GOOGLE_APPS_SCRIPT_TOKEN = 'wrong';
  const badV = await service.verifySheetsConnection(okFetch);
  check('verify hides secret', badV.ok === false && !badV.message.includes('wrong'), JSON.stringify(badV));
  process.env.GOOGLE_APPS_SCRIPT_TOKEN = SECRET;
  const goodV = await service.verifySheetsConnection(okFetch);
  check('verify ok with secret', goodV.ok === true, JSON.stringify(goodV));
  if (pUrl === undefined) delete process.env.GOOGLE_APPS_SCRIPT_URL; else process.env.GOOGLE_APPS_SCRIPT_URL = pUrl;
  if (pTok === undefined) delete process.env.GOOGLE_APPS_SCRIPT_TOKEN; else process.env.GOOGLE_APPS_SCRIPT_TOKEN = pTok;
  await withEnv(ENV, async () => {
    const created = [];
    prisma.recipient.findUnique = async () => null;
    prisma.recipient.create = async ({ data }) => { created.push(data); return { id: 'r1', ...data }; };
    prisma.recipient.update = async () => { throw new Error('no update'); };
    const s = await service.runSyncNow(okBridge([
      { timestamp: 't1', name: 'Asha', whatsappNumber: '98765 43210', consent: 'Yes' },
      { timestamp: 't2', name: 'Ravi', whatsappNumber: '9123456789', consent: 'No' },
      { timestamp: 't3', name: '', whatsappNumber: '9988776655', consent: 'Yes' },
      { timestamp: 't4', name: 'Bad', whatsappNumber: '123', consent: 'Yes' },
    ]));
    check('sync creates Yes-only recipient', created.length === 1 && created[0].consentStatus === 'GRANTED');
    check('sync summary counts', s.newRecipients === 1 && s.skippedNoConsent === 1 && s.invalidRows === 2, JSON.stringify(s));
  });
  await withEnv(ENV, async () => {
    let created = 0; let updated = 0;
    prisma.recipient.findUnique = async () => ({ id: 'x', name: 'Old', whatsappNumber: 'o', normalizedPhone: '919876543210', consentStatus: 'PENDING', consentTimestamp: null });
    prisma.recipient.create = async () => { created++; return {}; };
    prisma.recipient.update = async () => { updated++; return {}; };
    const s = await service.runSyncNow(okBridge([{ timestamp: 't', name: 'New', whatsappNumber: '9876543210', consent: 'YES' }]));
    check('sync updates no duplicate', created === 0 && updated === 1 && s.updatedRecipients === 1, JSON.stringify(s));
  });
  await withEnv(ENV, async () => {
    try { await service.runSyncNow(async () => ({ ok: false, status: 500, json: async () => ({}) })); check('api fail throws', false); }
    catch (e) { check('api fail is 502', e.statusCode === 502 && e.message === 'GOOGLE_API_ERROR', e.message); }
    try { await service.runSyncNow(async () => ({ ok: false, status: 401, json: async () => ({}) })); check('auth throws', false); }
    catch (e) { check('auth is 502 AUTH_FAILED', e.statusCode === 502 && e.message === 'GOOGLE_AUTH_FAILED', e.message); }
  });
  check('mapper consent gate', mapper.classifyRow({ name: 'A', phone: '9876543210', consent: 'Yes' }).kind === 'import');
  check('mapper phone invalid', mapper.classifyRow({ name: 'A', phone: 'abc', consent: 'Yes' }).reason === 'INVALID_PHONE');

  // --- Fix 2: strict affirmative consent values ---
  check('isConsentYes("Yes")', mapper.isConsentYes('Yes') === true);
  check('isConsentYes("Yes, I agree to receive WhatsApp updates")', mapper.isConsentYes('Yes, I agree to receive WhatsApp updates') === true);
  check('isConsentYes("I agree to receive WhatsApp updates")', mapper.isConsentYes('I agree to receive WhatsApp updates') === true);
  check('isConsentYes("No") is false', mapper.isConsentYes('No') === false);
  check('isConsentYes("") is false', mapper.isConsentYes('') === false);
  check('isConsentYes("   ") is false', mapper.isConsentYes('   ') === false);
  check('isConsentYes("No, I do not agree") is false', mapper.isConsentYes('No, I do not agree') === false);
  check('isConsentYes("Maybe") is false', mapper.isConsentYes('Maybe') === false);
  check('isConsentYes arbitrary text is false', mapper.isConsentYes('please contact me') === false);
  check('isConsentYes does not match mid-string "i agree"', mapper.isConsentYes('sure i agree') === false);

  // --- Fix 1: Apps Script consent header detection ---
  const bridgeSrc = fs.readFileSync(path.join(root, 'apps/server/src/services/google-apps-script.bridge.gs'), 'utf8');
  const fnSrc = bridgeSrc.slice(bridgeSrc.indexOf('function findColumnIndexes'), bridgeSrc.indexOf('function readRows'));
  const findColumnIndexes = new Function('headers', fnSrc + '; return findColumnIndexes(headers);');
  const REAL_HEADERS = [
    'Timestamp', 'Name', 'WhatsApp Number',
    'Would you like to receive WhatsApp updates from Advaithamrutha Varsshini?',
    'Preferred Language to Receive Updates', 'Column 5',
  ];
  const idx = findColumnIndexes(REAL_HEADERS);
  check('form question header detected as consent column', idx.consentIdx === 3, JSON.stringify(idx));
  check('name column still detected', idx.nameIdx === 1, JSON.stringify(idx));
  check('phone column still detected', idx.phoneIdx === 2, JSON.stringify(idx));
  check('consent header match is case-insensitive + trimmed',
    findColumnIndexes(['Name', 'WhatsApp Number', '  WOULD YOU LIKE TO RECEIVE WhatsApp updates?  ']).consentIdx === 2);
  check('legacy "i agree" header still detected',
    findColumnIndexes(['Name', 'WhatsApp Number', 'I agree to receive WhatsApp updates from JAPA']).consentIdx === 2);
  check('legacy "consent" header still detected',
    findColumnIndexes(['Name', 'WhatsApp Number', 'Consent']).consentIdx === 2);
  check('no consent column -> -1', findColumnIndexes(['Timestamp', 'Name']).consentIdx === -1);

  // --- Fix 3: rowsRead counts fetched rows, including skipped/invalid ---
  await withEnv(ENV, async () => {
    prisma.recipient.findUnique = async () => null;
    prisma.recipient.create = async ({ data }) => ({ id: 'n', ...data });
    prisma.recipient.update = async () => ({});
    const s = await service.runSyncNow(okBridge([
      { timestamp: 't1', name: 'Ravi', whatsappNumber: '9123456789', consent: 'No' },
      { timestamp: 't2', name: '', whatsappNumber: '', consent: 'Yes, I agree to receive WhatsApp updates' },
      { timestamp: 't3', name: 'Bad', whatsappNumber: '123', consent: 'Yes' },
      { timestamp: 't4', name: 'Raksha', whatsappNumber: '9448864595', consent: 'Yes, I agree to receive WhatsApp updates' },
    ]));
    check('rowsRead counts fetched rows (4)', s.rowsRead === 4, JSON.stringify(s));
    check('rowsRead counts skipped-consent rows', s.rowsRead === 4 && s.skippedNoConsent === 1, JSON.stringify(s));
    check('rowsRead counts invalid rows', s.rowsRead === 4 && s.invalidRows === 2, JSON.stringify(s));
    check('skipped/invalid unchanged by rowsRead move', s.newRecipients === 1, JSON.stringify(s));
  });

  const ctrl = fs.readFileSync(path.join(root, 'apps/server/src/controllers/google-sheets.controller.ts'), 'utf8');
  const svc = fs.readFileSync(path.join(root, 'apps/server/src/services/google-sync.service.ts'), 'utf8');
  const cli = fs.readFileSync(path.join(root, 'apps/server/src/services/google-sheets.client.ts'), 'utf8');
  const setg = fs.readFileSync(path.join(root, 'apps/server/src/controllers/settings.controller.ts'), 'utf8');
  const rtes = fs.readFileSync(path.join(root, 'apps/server/src/routes/google-sheets.routes.ts'), 'utf8');
  check('routes require auth', rtes.includes('requireAuth'));
  check('no service account needed', !/GOOGLE_SERVICE_ACCOUNT/.test(svc) && !/GOOGLE_SERVICE_ACCOUNT/.test(cli));
  check('no token in json', !/res\.json\([\s\S]*TOKEN/i.test(ctrl));
  check('settings hides token', !/GOOGLE_APPS_SCRIPT_TOKEN|CMS_SHARED_SECRET/i.test(setg));
  check('status hides secret', JSON.stringify(service.publicStatus()).indexOf(SECRET) === -1);
  console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });
  const ENV = { GOOGLE_APPS_SCRIPT_URL: EXEC_URL, GOOGLE_APPS_SCRIPT_TOKEN: SECRET };
