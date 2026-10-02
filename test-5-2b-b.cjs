/* Phase 5.2B part B: auth/net/redact/none/auth-guard. No secrets. */
const h = require('./test-5-2b-helpers.cjs');
const path = require('path');
let C = 0; let F = 0;
function check(n, c, e) { C++; if (!c) F++; console.log((c ? 'PASS' : 'FAIL') + ': ' + n + (e ? ' | ' + e : '')); }
async function main() {
  console.log('=== Phase 5.2B-B ===');
  const m = h.fresh('services/whatsapp/OfficialWhatsAppAdapter.js');
  for (const code of [401, 403]) {
    const a = new m.OfficialWhatsAppAdapter({ provider: 'official', accessToken: 'T', businessAccountId: 'B', phoneNumberId: 'P', apiVersion: 'v20.0', apiBaseUrl: 'https://graph.facebook.com' }, h.mf(async () => h.er(code)));
    const r = await a.verifyConnection();
    check('B auth ' + code, r.reason === 'AUTH_FAILED' && r.httpStatus === code);
  }
  const a1 = new m.OfficialWhatsAppAdapter({ provider: 'official', accessToken: 'T', businessAccountId: 'B', phoneNumberId: 'P', apiVersion: 'v20.0', apiBaseUrl: 'https://graph.facebook.com' }, h.mf(async () => h.er(500)));
  check('B 500 API_ERROR', (await a1.verifyConnection()).reason === 'API_ERROR');
  const a2 = new m.OfficialWhatsAppAdapter({ provider: 'official', accessToken: 'T', businessAccountId: 'B', phoneNumberId: 'P', apiVersion: 'v20.0', apiBaseUrl: 'https://graph.facebook.com' }, h.mf(async () => { throw new Error('down'); }));
  const r2 = await a2.verifyConnection();
  check('B net NETWORK_ERROR', r2.reason === 'NETWORK_ERROR' && /Could not reach/.test(r2.message));
  const S = 'SECRET_TOKEN_ABC123XYZ';
  const a3 = new m.OfficialWhatsAppAdapter({ provider: 'official', accessToken: S, businessAccountId: 'B', phoneNumberId: 'P', apiVersion: 'v20.0', apiBaseUrl: 'https://graph.facebook.com' }, h.mf(async () => h.ok({ id: '1' }, 200)));
  const r3 = await a3.verifyConnection();
  check('B redact result', !JSON.stringify(r3).includes(S));
  check('B redact summary', !JSON.stringify(a3.getConfigSummary()).includes(S));
  const mw = h.src(path.join(h.REPO_ROOT, 'apps/server/src/middleware/auth.middleware.ts'));
  check('B auth 401 guard', /401/.test(mw));
  console.log('B Assertions: ' + C + ' failed: ' + F);
  if (F > 0) process.exitCode = 1;
}
main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
