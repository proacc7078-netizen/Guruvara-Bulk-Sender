/* Phase 5.2B part A: static + missing/invalid/success. No secrets. */
const h = require('./test-5-2b-helpers.cjs');
const path = require('path');
let C = 0; let F = 0;
function check(n, c, e) { C++; if (!c) F++; console.log((c ? 'PASS' : 'FAIL') + ': ' + n + (e ? ' | ' + e : '')); }
async function main() {
  console.log('=== Phase 5.2B-A ===');
  const OFF = h.src(path.join(h.REPO_ROOT, 'apps/server/src/services/whatsapp/OfficialWhatsAppAdapter.ts'));
  const OFF_CODE = OFF.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  check('A1 adapter verifyConnection', /verifyConnection/.test(OFF));
  const verifyBlock = (OFF.match(/async verifyConnection\(\)[\s\S]*?\n  \}/) || [''])[0];
  check('A2 verify path uses no /messages', !/\/messages/.test(verifyBlock));
  check('A3 version from config', /this\.config\.apiVersion/.test(OFF));
  const RTE = h.src(path.join(h.REPO_ROOT, 'apps/server/src/routes/whatsapp.routes.ts'));
  check('A4 route auth', /requireAuth/.test(RTE));
  const TYP = h.src(path.join(h.REPO_ROOT, 'apps/server/src/services/whatsapp/types.ts'));
  check('A5 verify type', /WhatsAppVerificationResult/.test(TYP));
  const CTL = h.src(path.join(h.REPO_ROOT, 'apps/server/src/controllers/whatsapp.controller.ts'));
  const CTL_CODE = CTL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  check('A6 no token leak', !/access_token/.test(CTL_CODE));
  check('A7 no authz leak', !/Authorization/.test(CTL_CODE));
  const u = h.fresh('services/whatsapp/UnconfiguredWhatsAppAdapter.js');
  const r0 = await new u.UnconfiguredWhatsAppAdapter().verifyConnection();
  check('A8 missing NOT_CONFIGURED', r0.reason === 'NOT_CONFIGURED' && r0.verified === false);
  const m = h.fresh('services/whatsapp/OfficialWhatsAppAdapter.js');
  let called = false;
  const a = new m.OfficialWhatsAppAdapter({ provider: 'official', accessToken: '', businessAccountId: '', phoneNumberId: '', apiVersion: 'v20.0', apiBaseUrl: 'https://graph.facebook.com' }, async () => { called = true; return h.er(400); });
  check('A9 invalid CONFIG_INVALID', (await a.verifyConnection()).reason === 'CONFIG_INVALID' && called === false);
  const p = h.setEnv({ WHATSAPP_PROVIDER: 'official', WHATSAPP_ACCESS_TOKEN: '', WHATSAPP_BUSINESS_ACCOUNT_ID: '', WHATSAPP_PHONE_NUMBER_ID: '' });
  const cfg = h.fresh('services/whatsapp/config.js');
  let threw = false;
  try { cfg.loadWhatsAppConfig(); } catch (e) { threw = /WHATSAPP_CONFIGURATION_INVALID/.test(String((e && e.message) || e)); }
  check('A10 loader throws', threw);
  h.rest(p);
  const f = h.mf(async () => h.ok({ id: '123' }, 200));
  const b = new m.OfficialWhatsAppAdapter({ provider: 'official', accessToken: 'D', businessAccountId: 'B', phoneNumberId: 'PNX', apiVersion: 'v21.0', apiBaseUrl: 'https://graph.facebook.com' }, f);
  const r1 = await b.verifyConnection();
  check('A11 success VERIFIED', r1.verified === true && r1.reason === 'VERIFIED');
  check('A12 uses version', f.calls.length === 1 && /\/v21\.0\//.test(f.calls[0].url));
  check('A13 no messages target', /PNX/.test(f.calls[0].url) && !/\/messages/.test(f.calls[0].url));
  check('A14 GET Bearer', f.calls[0].init.method === 'GET' && /Bearer/.test(f.calls[0].init.headers.Authorization));
  check('A15 no hardcoded version literal in URL build', !/['"]\/v\d+\.\d+\/['"]/.test(OFF_CODE));
  console.log('A Assertions: ' + C + ' failed: ' + F);
  if (F > 0) process.exitCode = 1;
}
main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
