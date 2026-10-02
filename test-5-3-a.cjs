/* Phase 5.3-A: adapter sendText. Mocked HTTP only. No real sends. */
const h = require('./test-5-3-helpers.cjs');
const path = require('path');
let C = 0; let F = 0;
function check(n, c, e) { C++; if (!c) F++; console.log((c ? 'PASS' : 'FAIL') + ': ' + n + (e ? ' | ' + e : '')); }
function cfg() { return { provider: 'official', accessToken: 'DUMMY', businessAccountId: 'B', phoneNumberId: 'PN1', apiVersion: 'v20.0', apiBaseUrl: 'https://graph.facebook.com' }; }
async function main() {
  console.log('=== Phase 5.3-A adapter ===');
  const S = h.src(path.join(h.REPO_ROOT, 'apps/server/src/services/whatsapp/OfficialWhatsAppAdapter.ts'));
  check('A1 sendText exists', /async sendText\(/.test(S));
  check('A2 posts to /messages', /\/messages/.test(S));
  check('A3 uses messaging_product', /messaging_product/.test(S));
  check('A4 no hardcoded version literal in URL', !/graph\.facebook\.com\/v\d+\.\d+\//.test(S) || /this\.config\.apiVersion/.test(S));
  check('A5 redaction note', /never logged or returned|sanitized/i.test(S));
  const m = h.fresh('services/whatsapp/OfficialWhatsAppAdapter.js');
  const f = h.mf(async () => h.ok({ messages: [{ id: 'wamid.X' }] }, 200));
  const a = new m.OfficialWhatsAppAdapter({ provider: 'official', accessToken: 'D', businessAccountId: 'B', phoneNumberId: 'PN9', apiVersion: 'v21.0', apiBaseUrl: 'https://graph.facebook.com' }, f);
  const r = await a.sendText('+15551234567', 'hello test');
  check('A6 success + wamid', r.success === true && r.providerMessageId === 'wamid.X');
  check('A7 POST method', f.calls.length === 1 && f.calls[0].init.method === 'POST');
  check('A8 version from config', /\/v21\.0\//.test(f.calls[0].url));
  check('A9 path /messages', /\/PN9\/messages$/.test(f.calls[0].url));
  const body = JSON.parse(f.calls[0].init.body);
  check('A10 payload shape', body.messaging_product === 'whatsapp' && body.to === '+15551234567' && body.type === 'text' && body.text && body.text.body === 'hello test');
  check('A11 auth header present', /Bearer/.test(f.calls[0].init.headers.Authorization));
  check('A12 content-type json', /application\/json/.test(f.calls[0].init.headers['Content-Type']));
  console.log('A Assertions: ' + C + ' failed: ' + F);
  if (F > 0) process.exitCode = 1;
}
main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
