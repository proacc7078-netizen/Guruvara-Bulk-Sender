/* Phase 5.2B part C: controller states. No secrets. */
const h = require('./test-5-2b-helpers.cjs');
let C = 0; let F = 0;
function check(n, c, e) { C++; if (!c) F++; console.log((c ? 'PASS' : 'FAIL') + ': ' + n + (e ? ' | ' + e : '')); }
async function main() {
  console.log('=== Phase 5.2B-C ===');
  const S = 'SECRET_TOKEN_ABC123XYZ';
  let p = h.setEnv({ WHATSAPP_PROVIDER: 'official', WHATSAPP_ACCESS_TOKEN: S, WHATSAPP_BUSINESS_ACCOUNT_ID: 'B9', WHATSAPP_PHONE_NUMBER_ID: 'PN9', WHATSAPP_API_VERSION: 'v20.0', WHATSAPP_API_BASE_URL: 'https://graph.facebook.com' });
  let o = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'PN9' }) });
  let c = h.fresh('controllers/whatsapp.controller.js');
  let pl = null;
  await c.getStatus({}, { json: (x) => { pl = x; } }, (e) => { throw e; });
  check('C1 ctl no secret', !JSON.stringify(pl).includes(S));
  check('C2 ctl no Bearer', !JSON.stringify(pl).includes('Bearer'));
  check('C3 ctl verified', pl && pl.verification && pl.verification.verified === true);
  check('C4 ctl connected', pl && pl.status === 'CONNECTED' && pl.configured === true);
  globalThis.fetch = o; h.rest(p);
  p = h.setEnv({ WHATSAPP_PROVIDER: 'none', WHATSAPP_ACCESS_TOKEN: undefined, WHATSAPP_BUSINESS_ACCOUNT_ID: undefined, WHATSAPP_PHONE_NUMBER_ID: undefined });
  o = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('no net'); };
  c = h.fresh('controllers/whatsapp.controller.js');
  pl = null;
  await c.getStatus({}, { json: (x) => { pl = x; } }, (e) => { throw e; });
  check('C5 none false', pl && pl.configured === false && pl.provider === 'none');
  check('C6 none NOT_CONFIGURED', pl && pl.verification && pl.verification.reason === 'NOT_CONFIGURED');
  globalThis.fetch = o; h.rest(p);
  p = h.setEnv({ WHATSAPP_PROVIDER: 'official', WHATSAPP_ACCESS_TOKEN: '', WHATSAPP_BUSINESS_ACCOUNT_ID: '', WHATSAPP_PHONE_NUMBER_ID: '' });
  o = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('no'); };
  c = h.fresh('controllers/whatsapp.controller.js');
  pl = null;
  await c.getStatus({}, { json: (x) => { pl = x; } }, (e) => { throw e; });
  check('C7 invalid CONFIG_INVALID', pl && pl.verification && pl.verification.reason === 'CONFIG_INVALID');
  check('C8 invalid no net', called === false);
  globalThis.fetch = o; h.rest(p);
  console.log('C Assertions: ' + C + ' failed: ' + F);
  if (F > 0) process.exitCode = 1;
}
main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
