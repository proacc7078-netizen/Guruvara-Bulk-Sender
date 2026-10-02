// Phase 6.0A behavioral test: mocked Google Sheets rows -> compiled mapper +
// mocked Prisma -> compiled runSyncNow. Verifies new/update/no-duplicate,
// consent Yes/No, invalid phone, empty name, Google API failure, auth and
// secret hygiene.
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
const prisma = require('./apps/server/dist/config/db.js').prisma;

const HEADER = ['Timestamp', 'Name', 'WhatsApp Number', 'I agree to receive WhatsApp updates from JAPA'];
const row = (name, phone, consent) => [new Date().toISOString(), name, phone, consent];

function mockFetch(values, mode = 'ok') {
  return async (url) => {
    if (String(url).includes('oauth2.googleapis.com/token')) {
      if (mode === 'auth-fail') return { ok: false, status: 401, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ access_token: 'mock-token' }) };
    }
    if (String(url).includes('sheets.googleapis.com')) {
      if (mode === 'api-fail') return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ values }) };
    }
    throw new Error('unexpected url ' + url);
  };
}

// Mapper-level: consent gating + invalid rows
check('consent Yes maps, No skips', (() => {
  const yes = mapper.mapValuesToRow(HEADER, row('Asha', '9876543210', 'Yes'));
  const no = mapper.mapValuesToRow(HEADER, row('Ravi', '9876543211', 'No'));
  return mapper.classifyRow(yes).kind === 'import' && mapper.classifyRow(no).kind === 'skip-consent';
})());
check('empty name is invalid', mapper.classifyRow({ name: '', phone: '9876543210', consent: 'Yes' }).reason === 'MISSING_NAME');
check('invalid phone is invalid', mapper.classifyRow({ name: 'Asha', phone: 'abc', consent: 'Yes' }).reason === 'INVALID_PHONE');

async function withEnv(env, fn) {
  const prev = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; process.env[k] = env[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(env)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}

(async () => {
  const { generateKeyPairSync } = require('crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const ENV = {
    GOOGLE_SHEETS_SPREADSHEET_ID: '1MgMSRx9mQCVqcIDUPodRdw3JaAST2POzHH1-zyQVpI8',
    GOOGLE_SHEETS_TAB_NAME: 'Form Responses 1',
    GOOGLE_SERVICE_ACCOUNT_EMAIL: 'test@example.iam.gserviceaccount.com',
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: pem,
  };

  // New recipient + no-consent skip + invalid rows counted
  await withEnv(ENV, async () => {
    const created = [];
    prisma.recipient.findUnique = async () => null;
    prisma.recipient.create = async ({ data }) => { created.push(data); return { id: 'r1', ...data }; };
    prisma.recipient.update = async () => { throw new Error('should not update'); };
    const values = [HEADER, row('Asha', '98765 43210', 'Yes'), row('Ravi', '9123456789', 'No'), row('', '9988776655', 'Yes'), row('Bad', '123', 'Yes')];
    const s = await service.runSyncNow(mockFetch(values));
    check('new recipient created for consent Yes', created.length === 1 && created[0].name === 'Asha' && created[0].consentStatus === 'GRANTED');
    check('summary counts new/skip/invalid', s.newRecipients === 1 && s.skippedNoConsent === 1 && s.invalidRows === 2 && s.rowsRead === 1, JSON.stringify(s));
  });

  // Existing recipient update, no duplicate
  await withEnv(ENV, async () => {
    let created = 0; let updated = 0;
    prisma.recipient.findUnique = async () => ({ id: 'ex1', name: 'Old', whatsappNumber: 'old', normalizedPhone: '919876543210', consentStatus: 'PENDING', consentTimestamp: null });
    prisma.recipient.create = async () => { created++; return {}; };
    prisma.recipient.update = async () => { updated++; return {}; };
    const s = await service.runSyncNow(mockFetch([HEADER, row('Asha New', '9876543210', 'YES')]));
    check('existing phone updates instead of duplicating', created === 0 && updated === 1 && s.updatedRecipients === 1 && s.newRecipients === 0);
  });

  // Google API failure surfaces as sanitized 502
  await withEnv(ENV, async () => {
    try { await service.runSyncNow(mockFetch([HEADER], 'api-fail')); check('Google API failure throws', false); }
    catch (e) { check('Google API failure maps to 502 GOOGLE_API_ERROR', e.statusCode === 502 && e.message === 'GOOGLE_API_ERROR'); }
  });

  // Auth: routes require authentication
  const routesSrc = fs.readFileSync(path.join(root, 'apps/server/src/routes/google-sheets.routes.ts'), 'utf8');
  check('authentication protection (requireAuth)', routesSrc.includes('requireAuth'));
  // Secrets: never serialized into API responses
  const ctrlSrc = fs.readFileSync(path.join(root, 'apps/server/src/controllers/google-sheets.controller.ts'), 'utf8');
  const svcSrc = fs.readFileSync(path.join(root, 'apps/server/src/services/google-sync.service.ts'), 'utf8');
  check('no credentials exposed in responses', !/privateKey|access_token|accessToken|client_secret/i.test(ctrlSrc) && !/res\.json\([\s\S]*privateKey/i.test(svcSrc));

  console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });
