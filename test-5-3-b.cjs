/* Phase 5.3-B: failures + validation. Mocked HTTP only. */
const h = require('./test-5-3-helpers.cjs');
let C = 0; let F = 0;
function check(n, c, e) { C++; if (!c) F++; console.log((c ? 'PASS' : 'FAIL') + ': ' + n + (e ? ' | ' + e : '')); }
function mk(fetch) { const m = h.fresh('services/whatsapp/OfficialWhatsAppAdapter.js'); return new m.OfficialWhatsAppAdapter({ provider: 'official', accessToken: 'T', businessAccountId: 'B', phoneNumberId: 'P', apiVersion: 'v20.0', apiBaseUrl: 'https://graph.facebook.com' }, fetch); }
async function main() {
  console.log('=== Phase 5.3-B failures ===');
  for (const code of [401, 403]) {
    const r = await mk(h.mf(async () => h.er(code))).sendText('+1', 'hi');
    check('B auth ' + code, r.success === false && r.errorCode === 'WHATSAPP_PROVIDER_UNAVAILABLE');
  }
  const r500 = await mk(h.mf(async () => h.er(500))).sendText('+1', 'hi');
  check('B 500 send failed', r500.success === false && r500.errorCode === 'WHATSAPP_SEND_FAILED');
  const rNet = await mk(h.mf(async () => { throw new Error('down'); })).sendText('+1', 'hi');
  check('B net unavailable', rNet.success === false && rNet.errorCode === 'WHATSAPP_PROVIDER_UNAVAILABLE' && /Could not reach/.test(rNet.errorMessage));
  const rTo = await mk(h.mf(async () => h.ok({}, 200))).sendText('   ', 'hi');
  check('B empty to invalid', rTo.success === false && rTo.errorCode === 'WHATSAPP_CONFIGURATION_INVALID');
  const rMsg = await mk(h.mf(async () => h.ok({}, 200))).sendText('+1', '   ');
  check('B empty msg invalid', rMsg.success === false && rMsg.errorCode === 'WHATSAPP_CONFIGURATION_INVALID');
  let called = false;
  const bad = h.fresh('services/whatsapp/OfficialWhatsAppAdapter.js');
  const aBad = new bad.OfficialWhatsAppAdapter({ provider: 'official', accessToken: '', businessAccountId: '', phoneNumberId: '', apiVersion: 'v20.0', apiBaseUrl: 'https://graph.facebook.com' }, async () => { called = true; return h.er(400); });
  const rBad = await aBad.sendText('+1', 'hi');
  check('B missing cfg no http', rBad.success === false && called === false);
  // Phase 5.3 diagnostic: sanitized metaError details
  const META_SECRET = 'FAKE_TOKEN_FOR_REDACTION_TEST';
  const metaBody = { error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190, fbtrace_id: 'abc', error_data: { details: META_SECRET } } };
  const errRes = (s, b) => ({ ok: false, status: s, json: async () => b });
  const r401meta = await mk(h.mf(async () => errRes(401, metaBody))).sendText('+1', 'hi');
  check('B metaError on 401', r401meta.metaError && r401meta.metaError.code === 190 && r401meta.metaError.type === 'OAuthException' && r401meta.metaError.httpStatus === 401 && /Invalid OAuth/.test(r401meta.metaError.message));
  check('B metaError no secret', !JSON.stringify(r401meta).includes(META_SECRET) && !JSON.stringify(r401meta).includes('Bearer'));
  const r500meta = await mk(h.mf(async () => errRes(500, { error: { message: 'Internal server error', type: 'ServerException', code: 2 } }))).sendText('+1', 'hi');
  check('B metaError on 500', r500meta.metaError && r500meta.metaError.code === 2 && r500meta.metaError.httpStatus === 500);
  const rNoBody = await mk(h.mf(async () => ({ ok: false, status: 502, json: async () => { throw new Error('bad json'); } }))).sendText('+1', 'hi');
  check('B metaError fallback no body', rNoBody.metaError && rNoBody.metaError.httpStatus === 502 && rNoBody.metaError.code === undefined);
  console.log('B Assertions: ' + C + ' failed: ' + F);
  if (F > 0) process.exitCode = 1;
}
main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
