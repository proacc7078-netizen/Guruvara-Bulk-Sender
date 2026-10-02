/* Phase 6.0C — focused sendMedia tests (mocked HTTP only, no real sends). */
const h = require('./test-5-3-helpers.cjs');
const path = require('path');
const fs = require('fs');
const os = require('os');
let C = 0; let F = 0;
function check(n, c, e) { C++; if (!c) F++; console.log((c ? 'PASS' : 'FAIL') + ': ' + n + (e ? ' | ' + e : '')); }
function cfg() { return { provider: 'official', accessToken: 'DUMMY', businessAccountId: 'B', phoneNumberId: 'PN1', apiVersion: 'v20.0', apiBaseUrl: 'https://graph.facebook.com' }; }
function mk(fetch) { const m = h.fresh('services/whatsapp/OfficialWhatsAppAdapter.js'); return new m.OfficialWhatsAppAdapter(cfg(), fetch); }
async function main() {
  console.log('=== Phase 6.0C sendMedia ===');
  const S = h.src(path.join(h.REPO_ROOT, 'apps/server/src/services/whatsapp/OfficialWhatsAppAdapter.ts'));
  check('src uses type image', /type:\s*'image'/.test(S));
  check('src has media upload step', /\/media/.test(S));
  check('src caption optional', /caption\?:/.test(S));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wam-'));
  const img = path.join(tmp, 'test.png');
  fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const MEDIA = { path: img, mimeType: 'image/png' };
  const up = (id) => h.ok({ id }, 200);
  const sent = (wamid) => h.ok({ messages: [{ id: wamid }] }, 200);

  // 1. image send success (upload + message)
  const f1 = h.mf(async (u) => (String(u).endsWith('/media') ? up('MEDIA_ID_1') : sent('wamid.IMG1')));
  const r1 = await mk(f1).sendMedia('+15551234567', MEDIA, 'hello caption');
  check('1 image send success', r1.success === true && r1.providerMessageId === 'wamid.IMG1', JSON.stringify(r1));
  check('2 two http calls', f1.calls.length === 2);
  check('3 upload url /media', /\/media$/.test(f1.calls[0].url));
  check('4 upload auth header', /Bearer/.test(f1.calls[0].init.headers.Authorization));
  check('5 upload is multipart', f1.calls[0].init.body instanceof FormData);
  check('6 msg url /messages', /\/messages$/.test(f1.calls[1].url));
  const b1 = JSON.parse(f1.calls[1].init.body);
  check('7 payload shape', b1.messaging_product === 'whatsapp' && b1.to === '+15551234567' && b1.type === 'image' && b1.image && b1.image.id === 'MEDIA_ID_1', JSON.stringify(b1));
  check('8 caption included', b1.image.caption === 'hello caption', JSON.stringify(b1));

  // 9. caption omitted when not provided
  const f2 = h.mf(async (u) => (String(u).endsWith('/media') ? up('M2') : sent('wamid.2')));
  await mk(f2).sendMedia('+1555', MEDIA);
  const b2 = JSON.parse(f2.calls[1].init.body);
  check('9 caption omitted', b2.image && b2.image.id === 'M2' && !('caption' in b2.image));

  // 10. whitespace-only caption treated as omitted (never invented)
  const f2b = h.mf(async (u) => (String(u).endsWith('/media') ? up('M2b') : sent('wamid.2b')));
  await mk(f2b).sendMedia('+1555', MEDIA, '   ');
  const b2b = JSON.parse(f2b.calls[1].init.body);
  check('10 blank caption omitted', !('caption' in b2b.image));

  await require('./test-6-0c-part2.cjs')({ check, mk, MEDIA, sent, up, tmp, h });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('6.0C Assertions: ' + C + ' failed: ' + F);
  if (F > 0) process.exitCode = 1;
}
main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });