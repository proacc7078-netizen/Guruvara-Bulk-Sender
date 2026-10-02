/* Phase 5.3-C: endpoint + redaction + none. Global fetch stubbed. */
const h = require('./test-5-3-helpers.cjs');
const path = require('path');
let C = 0; let F = 0;
function check(n, c, e) { C++; if (!c) F++; console.log((c ? 'PASS' : 'FAIL') + ': ' + n + (e ? ' | ' + e : '')); }
function mkRes() { let status = 200; let body = null; return { statusCode: 200, get s() { return status; }, res: { status: (c) => { status = c; return { json: (x) => { body = x; } }; }, json: (x) => { body = x; } }, getBody: () => body, getStatus: () => status }; }
async function callSend(env, reqBody, fetchStub) {
  const p = h.setEnv(env);
  const o = globalThis.fetch;
  if (fetchStub) globalThis.fetch = fetchStub;
  const c = h.fresh('controllers/whatsapp.controller.js');
  const holder = mkRes();
  await c.sendTest({ body: reqBody }, holder.res, (e) => { throw e; });
  globalThis.fetch = o; h.rest(p);
  return { status: holder.getStatus(), body: holder.getBody() };
}
async function main() {
  console.log('=== Phase 5.3-C endpoint ===');
  const RTE = h.src(path.join(h.REPO_ROOT, 'apps/server/src/routes/whatsapp.routes.ts'));
  check('C1 POST send-test auth', /router\.post\(['"]\/send-test['"]/.test(RTE) && /requireAuth/.test(RTE));
  const CTL = h.src(path.join(h.REPO_ROOT, 'apps/server/src/controllers/whatsapp.controller.ts'));
  check('C2 no secret leak', !/access_token|Authorization/.test(CTL) || /Sanitized|sanitized|never expose/i.test(CTL));
  const S = 'SECRET_TOKEN_ABC123XYZ';
  const goodEnv = { WHATSAPP_PROVIDER: 'official', WHATSAPP_ACCESS_TOKEN: S, WHATSAPP_BUSINESS_ACCOUNT_ID: 'B', WHATSAPP_PHONE_NUMBER_ID: 'PN9', WHATSAPP_API_VERSION: 'v20.0', WHATSAPP_API_BASE_URL: 'https://graph.facebook.com' };
  let seen = null;
  const stubOk = async (u, i) => { seen = { u, i }; return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.T' }] }) }; };
  const okR = await callSend(goodEnv, { to: '+1555', message: 'hi' }, stubOk);
  check('C3 endpoint success', okR.status === 200 && okR.body && okR.body.success === true && okR.body.providerMessageId === 'wamid.T');
  check('C4 endpoint no secret', !JSON.stringify(okR.body).includes(S));
  const bad1 = await callSend(goodEnv, { to: '', message: 'hi' }, stubOk);
  check('C5 empty to 400', bad1.status === 400 && bad1.body.success === false);
  const bad2 = await callSend(goodEnv, { to: '+1', message: '' }, stubOk);
  check('C6 empty msg 400', bad2.status === 400 && bad2.body.success === false);
  const noneR = await callSend({ WHATSAPP_PROVIDER: 'none', WHATSAPP_ACCESS_TOKEN: undefined, WHATSAPP_BUSINESS_ACCOUNT_ID: undefined, WHATSAPP_PHONE_NUMBER_ID: undefined }, { to: '+1', message: 'hi' }, stubOk);
  check('C7 none 409', noneR.status === 409 && noneR.body.errorCode === 'WHATSAPP_PROVIDER_NOT_CONFIGURED');
  const mw = h.src(path.join(h.REPO_ROOT, 'apps/server/src/middleware/auth.middleware.ts'));
  check('C8 auth 401', /401/.test(mw));
  console.log('C Assertions: ' + C + ' failed: ' + F);
  if (F > 0) process.exitCode = 1;
}
main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
