/*
 * Phase 7.1 — OpenWA adapter foundation tests (part 2: media).
 *
 * Safety:
 * - Every HTTP call is mocked; no request reaches a real OpenWA instance.
 * - Local media files are never read, uploaded or made public. The adapter must
 *   reject a local-only storagePath because OpenWA's send-image endpoint takes a
 *   URL that OpenWA fetches itself.
 * - No WhatsApp message is sent. No database access.
 */
const h = require('./test-5-3-helpers.cjs');
const path = require('path');

let C = 0;
let F = 0;
function check(n, c, e) { C++; if (!c) F++; console.log((c ? 'PASS' : 'FAIL') + ': ' + n + (e ? ' | ' + e : '')); }

const KEY = 'DUMMY_OPENWA_KEY';
const SID = 'DUMMY_SESSION_ID';
const BASE = 'http://openwa.invalid:2785';
const SESSIONS_URL = BASE + '/api/sessions/' + SID;
const LOCAL_PATH = path.join(h.REPO_ROOT, 'storage', 'uploads', 'local-only-photo.png');
const MEDIA_URL = 'https://cdn.example.com/media/photo.png';

function cfg(over) {
  return Object.assign({ provider: 'openwa', baseUrl: BASE, apiKey: KEY, sessionId: SID }, over || {});
}
function okJson(body, status) { return { ok: true, status: status || 201, json: async () => body }; }
function mk(fetchImpl, over) {
  const m = h.fresh('services/whatsapp/OpenWAWhatsAppAdapter.js');
  return new m.OpenWAWhatsAppAdapter(cfg(over), fetchImpl);
}
function mod() { return h.fresh('services/whatsapp/OpenWAWhatsAppAdapter.js'); }
function bodyOf(call) { return JSON.parse(call.init.body); }

async function main() {
  console.log('=== Phase 7.1 — OpenWA adapter (media) ===');

  const SRC = h.src(path.join(h.REPO_ROOT, 'apps/server/src/services/whatsapp/OpenWAWhatsAppAdapter.ts'));
  check('S1 local files are never read or uploaded', !/readFile|createReadStream|FormData|new Blob|from 'fs'/.test(SRC));
  check('S2 a local-only media path is rejected explicitly', /resolveOpenWAMediaUrl/.test(SRC) && /local media path is not reachable/.test(SRC));
  check('S3 media url must be absolute http(s)', /absolute http\(s\) media URLs only/.test(SRC));
  check('S4 local-only (loopback) media urls are rejected', /local-only URLs are not supported/.test(SRC));
  check('S5 the local storage path is never used as a url', !/media\.path/.test(SRC));

  /* ---------------- local-only media is rejected ---------------- */
  const f1 = h.mf(async () => okJson({ messageId: 'should-not-happen' }, 201));
  const r1 = await mk(f1).sendMedia('+15551234567', { path: LOCAL_PATH, mimeType: 'image/png' }, 'caption');
  check('1 local-only storagePath rejected', r1.success === false && r1.errorCode === 'WHATSAPP_CONFIGURATION_INVALID', JSON.stringify(r1));
  check('2 rejected local path never issues a request', f1.calls.length === 0);
  check('3 rejected local path is not echoed in the error', !JSON.stringify(r1).includes('uploads'));

  const rejectedUrls = [
    ['file:///', 'file:///C:/media/photo.png'],
    ['relative path', 'storage/uploads/photo.png'],
    ['loopback 127.0.0.1', 'http://127.0.0.1:3000/media/photo.png'],
    ['loopback localhost', 'http://localhost:3000/media/photo.png'],
    ['wildcard host', 'http://0.0.0.0:3000/media/photo.png'],
  ];
  for (const pair of rejectedUrls) {
    const f = h.mf(async () => okJson({ messageId: 'nope' }, 201));
    const r = await mk(f).sendMedia('+15551234567', { path: LOCAL_PATH, mimeType: 'image/png', url: pair[1] }, 'caption');
    check('4 local-only url rejected (' + pair[0] + ')',
      r.success === false && r.errorCode === 'WHATSAPP_CONFIGURATION_INVALID' && f.calls.length === 0, JSON.stringify(r));
  }
  const preUploaded = await mk(h.mf(async () => okJson({ messageId: 'nope' }, 201)))
    .sendMedia('+15551234567', { path: LOCAL_PATH, mimeType: 'image/png', metaMediaId: 'MEDIA_ID' }, 'caption');
  check('5 a local file with only a pre-uploaded id is still rejected',
    preUploaded.success === false && preUploaded.errorCode === 'WHATSAPP_CONFIGURATION_INVALID');
  check('6 media url helper accepts an external https url',
    mod().resolveOpenWAMediaUrl({ path: LOCAL_PATH, mimeType: 'image/png', url: MEDIA_URL }).ok === true);
  check('7 media url helper rejects a path-only payload',
    mod().resolveOpenWAMediaUrl({ path: LOCAL_PATH, mimeType: 'image/png' }).ok === false);

  /* ---------------- sendMedia request construction ---------------- */
  const f8 = h.mf(async () => okJson({ messageId: 'true_15551234567@c.us_IMG1', timestamp: 1719312000 }, 201));
  const r8 = await mk(f8).sendMedia('+1 (555) 123-4567', { path: LOCAL_PATH, mimeType: 'image/png', url: MEDIA_URL }, 'Guru Purnima wishes');
  check('8 sendMedia success parses messageId', r8.success === true && r8.providerMessageId === 'true_15551234567@c.us_IMG1', JSON.stringify(r8));
  check('9 sendMedia posts to the documented endpoint', f8.calls.length === 1 && f8.calls[0].url === SESSIONS_URL + '/messages/send-image');
  check('10 sendMedia is a JSON POST carrying the API key header',
    f8.calls[0].init.method === 'POST' && /application\/json/.test(f8.calls[0].init.headers['Content-Type']) && f8.calls[0].init.headers['X-API-Key'] === KEY);
  const b8 = bodyOf(f8.calls[0]);
  check('11 sendMedia body shape', b8.chatId === '15551234567@c.us' && b8.url === MEDIA_URL && b8.caption === 'Guru Purnima wishes', JSON.stringify(b8));
  check('12 only the documented fields are sent (OpenWA rejects unknown fields)',
    Object.keys(b8).sort().join(',') === 'caption,chatId,url', JSON.stringify(Object.keys(b8)));
  check('13 local storage fields are not part of the request', !('path' in b8) && !('mimeType' in b8) && !('metaMediaId' in b8));

  const f9 = h.mf(async () => okJson({ messageId: 'IMG2' }, 201));
  await mk(f9).sendMedia('+15551234567', { path: LOCAL_PATH, mimeType: 'image/png', url: MEDIA_URL });
  const b9 = bodyOf(f9.calls[0]);
  check('14 caption omitted when not provided', !('caption' in b9) && Object.keys(b9).sort().join(',') === 'chatId,url');
  const f10 = h.mf(async () => okJson({ messageId: 'IMG3' }, 201));
  await mk(f10).sendMedia('+15551234567', { path: LOCAL_PATH, mimeType: 'image/png', url: MEDIA_URL }, '   ');
  check('15 blank caption omitted', !('caption' in bodyOf(f10.calls[0])));
  const f11 = h.mf(async () => okJson({ messageId: 'IMG4' }, 201));
  const r11 = await mk(f11).sendMedia('+15551234567', { path: LOCAL_PATH, mimeType: 'image/png', url: MEDIA_URL }, 'x'.repeat(1025));
  check('16 over-long caption rejected without a request', r11.success === false && r11.errorCode === 'WHATSAPP_CONFIGURATION_INVALID' && f11.calls.length === 0);
  const f12 = h.mf(async () => okJson({ messageId: 'IMG5' }, 201));
  const r12 = await mk(f12).sendMedia('   ', { path: LOCAL_PATH, mimeType: 'image/png', url: MEDIA_URL }, 'caption');
  check('17 empty recipient rejected without a request', r12.success === false && r12.errorCode === 'WHATSAPP_CONFIGURATION_INVALID' && f12.calls.length === 0);
  const f13 = h.mf(async () => okJson({ messageId: 'IMG6' }, 201));
  const r13 = await mk(f13, { apiKey: '' }).sendMedia('+15551234567', { path: LOCAL_PATH, mimeType: 'image/png', url: MEDIA_URL }, 'caption');
  check('18 incomplete config rejected without a request', r13.success === false && r13.errorCode === 'WHATSAPP_CONFIGURATION_INVALID' && f13.calls.length === 0);

  /* ---------------- sendMedia error mapping ---------------- */
  const mediaCases = [
    [400, 'WHATSAPP_SEND_FAILED'], [413, 'WHATSAPP_SEND_FAILED'], [500, 'WHATSAPP_SEND_FAILED'], [501, 'WHATSAPP_SEND_FAILED'],
    [401, 'WHATSAPP_PROVIDER_UNAVAILABLE'], [403, 'WHATSAPP_PROVIDER_UNAVAILABLE'],
    [409, 'WHATSAPP_PROVIDER_UNAVAILABLE'], [429, 'WHATSAPP_PROVIDER_UNAVAILABLE'],
  ];
  for (const pair of mediaCases) {
    const r = await mk(h.mf(async () => ({ ok: false, status: pair[0], json: async () => ({ statusCode: pair[0], message: 'failure', error: 'Error' }) })))
      .sendMedia('+15551234567', { path: LOCAL_PATH, mimeType: 'image/png', url: MEDIA_URL }, 'caption');
    check('19 sendMedia http ' + pair[0] + ' -> ' + pair[1],
      r.success === false && r.errorCode === pair[1] && r.metaError && r.metaError.httpStatus === pair[0], JSON.stringify(r));
  }
  const r14 = await mk(h.mf(async () => { throw new Error('down'); })).sendMedia('+15551234567', { path: LOCAL_PATH, mimeType: 'image/png', url: MEDIA_URL }, 'caption');
  check('20 sendMedia network failure is unavailable', r14.success === false && r14.errorCode === 'WHATSAPP_PROVIDER_UNAVAILABLE');
  const r15 = await mk(h.mf(async () => { throw new Error('The operation was aborted'); })).sendMedia('+15551234567', { path: LOCAL_PATH, mimeType: 'image/png', url: MEDIA_URL }, 'caption');
  check('21 sendMedia timeout is unavailable', r15.success === false && r15.errorCode === 'WHATSAPP_PROVIDER_UNAVAILABLE' && /timed out/.test(r15.errorMessage));
  const r16 = await mk(h.mf(async () => okJson({ unexpected: 1 }, 200))).sendMedia('+15551234567', { path: LOCAL_PATH, mimeType: 'image/png', url: MEDIA_URL }, 'caption');
  check('22 malformed success response stays successful without an id', r16.success === true && r16.providerMessageId === undefined);
  const allResults = JSON.stringify([r1, r8, r11, r12, r13, r14, r15, r16, preUploaded]);
  check('23 no API key or local path in any media result', !allResults.includes(KEY) && !allResults.includes('uploads'));

  console.log('Media assertions: ' + C + ' failed: ' + F);
  if (F > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
