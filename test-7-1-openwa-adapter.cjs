/*
 * Phase 7.1 — OpenWA adapter foundation tests (part 1: verification + sendText).
 *
 * Safety:
 * - Every HTTP call is mocked. No request is ever made to a real OpenWA
 *   instance: the configured host is non-resolvable and fetch is always
 *   injected/mocked. No campaign/queue path is exercised. No database access.
 * - Dummy credential/session placeholders only — no real API key or session id.
 */
const h = require('./test-5-3-helpers.cjs');
const path = require('path');

let C = 0;
let F = 0;
function check(n, c, e) { C++; if (!c) F++; console.log((c ? 'PASS' : 'FAIL') + ': ' + n + (e ? ' | ' + e : '')); }

const KEY = 'DUMMY_OPENWA_KEY';
const SID = 'DUMMY_SESSION_ID';
const BASE = 'http://openwa.invalid:2785'; // never resolved: fetch is mocked in every test
const SESSIONS_URL = BASE + '/api/sessions/' + SID;

function cfg(over) {
  return Object.assign({ provider: 'openwa', baseUrl: BASE, apiKey: KEY, sessionId: SID }, over || {});
}
function okJson(body, status) { return { ok: true, status: status || 201, json: async () => body }; }
function errJson(body, status) { return { ok: false, status: status, json: async () => body }; }
function mk(fetchImpl, over) {
  const m = h.fresh('services/whatsapp/OpenWAWhatsAppAdapter.js');
  return new m.OpenWAWhatsAppAdapter(cfg(over), fetchImpl);
}
function mod() { return h.fresh('services/whatsapp/OpenWAWhatsAppAdapter.js'); }
function bodyOf(call) { return JSON.parse(call.init.body); }

async function main() {
  console.log('=== Phase 7.1 — OpenWA adapter (verification + sendText) ===');

  /* ---------------- static shape ---------------- */
  const SRC = h.src(path.join(h.REPO_ROOT, 'apps/server/src/services/whatsapp/OpenWAWhatsAppAdapter.ts'));
  check('S1 implements the existing WhatsAppAdapter interface', /implements\s+WhatsAppAdapter/.test(SRC));
  check('S2 uses the documented send-text endpoint', /\/messages\/send-text/.test(SRC));
  check('S3 uses the documented send-image endpoint', /\/messages\/send-image/.test(SRC));
  check('S4 verification reads the session endpoint', /\/sessions\//.test(SRC) && /async verifyConnection\(\)/.test(SRC));
  check('S5 auth is header-only (X-API-Key header, never a URL parameter)',
    /headers\['X-API-Key'\]\s*=\s*this\.config\.apiKey/.test(SRC) && !/[?&]apiKey=/.test(SRC) && !/Bearer/.test(SRC));
  check('S6 session id comes from configuration', /this\.config\.sessionId/.test(SRC));
  check('S7 no hardcoded base url / session / api key literal', !/localhost:2785/.test(SRC) && !/DUMMY/.test(SRC) && !/owa_k1_/.test(SRC));
  check('S8 the adapter never logs', !/console\./.test(SRC));
  check('S9 reuses the CMS phone normalization util', /from '\.\.\/\.\.\/utils\/phone\.util'/.test(SRC));

  /* ---------------- verification: ready ---------------- */
  const f1 = h.mf(async () => okJson({ id: SID, name: 'session', status: 'ready', phoneNumber: '15551234567', pushName: 'Test Account' }, 200));
  const a1 = mk(f1);
  const v1 = await a1.verifyConnection();
  check('1 ready session is verified', v1.verified === true && v1.reason === 'VERIFIED', JSON.stringify(v1));
  check('2 ready session reports the provider status', v1.providerStatus === 'ready');
  check('3 verification GETs the configured session', f1.calls.length === 1 && f1.calls[0].url === SESSIONS_URL && f1.calls[0].init.method === 'GET', f1.calls[0] && f1.calls[0].url);
  check('4 verification sends only the API key header',
    f1.calls[0].init.headers['X-API-Key'] === KEY && f1.calls[0].init.headers.Authorization === undefined);
  check('5 verification never touches a message endpoint', !/messages/.test(f1.calls[0].url));
  check('6 ready maps to the connected state', (await a1.getStatus()) === 'CONNECTED');
  check('7 safe phone metadata exposed',
    v1.phoneNumber && v1.phoneNumber.displayPhoneNumber === '15551234567' && v1.phoneNumber.verifiedName === 'Test Account');

  /* ---------------- verification: non-ready ---------------- */
  for (const status of ['created', 'initializing', 'qr_ready', 'authenticating', 'action_required', 'disconnected', 'failed']) {
    const a = mk(h.mf(async () => okJson({ status: status, lastError: 'reason text' }, 200)));
    const r = await a.verifyConnection();
    check('8 non-ready status maps to disconnected: ' + status,
      r.verified === false && r.reason === 'API_ERROR' && r.providerStatus === status && (await a.getStatus()) === 'DISCONNECTED',
      JSON.stringify(r));
  }
  const r9 = await mk(h.mf(async () => okJson({ status: 'ready', lastError: 'engine needs a human action' }, 200))).verifyConnection();
  check('9 ready with a connection error is not healthy', r9.verified === false && r9.reason === 'API_ERROR', JSON.stringify(r9));
  check('10 reported connection error is surfaced sanitized', /engine needs a human action/.test(r9.message));
  const r10 = await mk(h.mf(async () => okJson({ status: 'failed', lastError: 'auth failed' }, 200))).verifyConnection();
  check('11 non-ready reason is surfaced sanitized', r10.verified === false && /auth failed/.test(r10.message));
  const r11 = await mk(h.mf(async () => okJson({ unexpected: 1 }, 200))).verifyConnection();
  check('12 unknown session shape is not healthy', r11.verified === false && r11.reason === 'API_ERROR');

  /* ---------------- verification: http / network ---------------- */
  for (const pair of [[401, 'AUTH_FAILED'], [403, 'AUTH_FAILED'], [404, 'API_ERROR'], [500, 'API_ERROR']]) {
    const r = await mk(h.mf(async () => errJson({ statusCode: pair[0], message: 'x', error: 'Error' }, pair[0]))).verifyConnection();
    check('13 verification http ' + pair[0] + ' -> ' + pair[1],
      r.verified === false && r.reason === pair[1] && r.httpStatus === pair[0], JSON.stringify(r));
  }
  const r12 = await mk(h.mf(async () => { throw new Error('down'); })).verifyConnection();
  check('14 verification network error', r12.reason === 'NETWORK_ERROR' && r12.verified === false);
  const r13 = await mk(h.mf(async () => { throw new Error('The operation was aborted'); })).verifyConnection();
  check('15 verification timeout', r13.reason === 'NETWORK_ERROR' && /timed out/.test(r13.message));
  const r14 = await mk(h.mf(async () => okJson({ status: 'ready' }, 200)), { apiKey: '' }).verifyConnection();
  check('16 incomplete config cannot verify', r14.verified === false && r14.reason === 'CONFIG_INVALID');

  /* ---------------- connect / disconnect ---------------- */
  const f15 = h.mf(async () => okJson({}, 200));
  const a15 = mk(f15);
  await a15.connect();
  check('17 connect performs no network I/O and stays disconnected', f15.calls.length === 0 && (await a15.getStatus()) === 'DISCONNECTED');
  await a15.disconnect();
  check('18 disconnect is safe', (await a15.getStatus()) === 'DISCONNECTED');
  let thrown16 = null;
  try { await mk(h.mf(async () => okJson({}, 200)), { sessionId: '' }).connect(); } catch (e) { thrown16 = e; }
  check('19 connect rejects incomplete config without the key', !!thrown16 && /incomplete/.test(thrown16.message) && !String(thrown16.message).includes(KEY));
  let thrown17 = null;
  try { await mk(h.mf(async () => okJson({}, 200))).getMessageStatus('x'); } catch (e) { thrown17 = e; }
  check('20 getMessageStatus is not implemented in this phase', !!thrown17 && /not implemented/.test(thrown17.message));

  /* ---------------- sendText request construction ---------------- */
  const f21 = h.mf(async () => okJson({ messageId: 'true_15551234567@c.us_3EB0ABCD', timestamp: 1719312000 }, 201));
  const r21 = await mk(f21).sendText('+1 (555) 123-4567', 'Hello from the test suite');
  check('21 sendText success parses messageId', r21.success === true && r21.providerMessageId === 'true_15551234567@c.us_3EB0ABCD', JSON.stringify(r21));
  check('22 sendText posts to the documented endpoint', f21.calls.length === 1 && f21.calls[0].url === SESSIONS_URL + '/messages/send-text');
  check('23 sendText is a JSON POST carrying the API key header',
    f21.calls[0].init.method === 'POST' && /application\/json/.test(f21.calls[0].init.headers['Content-Type']) && f21.calls[0].init.headers['X-API-Key'] === KEY);
  const b21 = bodyOf(f21.calls[0]);
  check('24 sendText body shape is exactly chatId + text',
    b21.chatId === '15551234567@c.us' && b21.text === 'Hello from the test suite' && Object.keys(b21).length === 2, JSON.stringify(b21));
  check('25 chatId normalization reuses CMS normalization',
    mod().buildOpenWAChatId('98765 43210') === '919876543210@c.us' && mod().buildOpenWAChatId('+1 (555) 123-4567') === '15551234567@c.us');
  check('26 an existing JID is passed through', mod().buildOpenWAChatId('120363021234567890@g.us') === '120363021234567890@g.us');
  check('27 empty recipient normalizes to empty', mod().buildOpenWAChatId('   ') === '');
  const f22 = h.mf(async () => okJson({ messageId: 'x' }, 201));
  const r22 = await mk(f22).sendText('   ', 'body');
  check('28 empty recipient rejected without a request', r22.success === false && r22.errorCode === 'WHATSAPP_CONFIGURATION_INVALID' && f22.calls.length === 0);
  const f23 = h.mf(async () => okJson({ messageId: 'x' }, 201));
  const r23 = await mk(f23).sendText('+15551234567', '   ');
  check('29 empty body rejected without a request', r23.success === false && r23.errorCode === 'WHATSAPP_CONFIGURATION_INVALID' && f23.calls.length === 0);
  const f24 = h.mf(async () => okJson({ messageId: 'x' }, 201));
  const r24 = await mk(f24).sendText('+15551234567', 'x'.repeat(4097));
  check('30 over-long body rejected without a request', r24.success === false && r24.errorCode === 'WHATSAPP_CONFIGURATION_INVALID' && f24.calls.length === 0);
  const f25 = h.mf(async () => okJson({ messageId: 'x' }, 201));
  const r25 = await mk(f25, { apiKey: '' }).sendText('+15551234567', 'body');
  check('31 incomplete config rejected without a request', r25.success === false && r25.errorCode === 'WHATSAPP_CONFIGURATION_INVALID' && f25.calls.length === 0);
  const r26 = await mk(h.mf(async () => okJson({ unexpected: true }, 200))).sendText('+15551234567', 'body');
  check('32 malformed success response stays successful without an id', r26.success === true && r26.providerMessageId === undefined);
  const r27 = await mk(h.mf(async () => okJson({ id: 'fallback_id' }, 201))).sendText('+15551234567', 'body');
  check('33 id fallback parsed', r27.success === true && r27.providerMessageId === 'fallback_id');

  /* ---------------- sendText error mapping ---------------- */
  const sendCases = [
    [400, 'WHATSAPP_SEND_FAILED'], [404, 'WHATSAPP_SEND_FAILED'], [500, 'WHATSAPP_SEND_FAILED'], [501, 'WHATSAPP_SEND_FAILED'],
    [401, 'WHATSAPP_PROVIDER_UNAVAILABLE'], [403, 'WHATSAPP_PROVIDER_UNAVAILABLE'],
    [409, 'WHATSAPP_PROVIDER_UNAVAILABLE'], [429, 'WHATSAPP_PROVIDER_UNAVAILABLE'],
  ];
  for (const pair of sendCases) {
    const r = await mk(h.mf(async () => errJson({ statusCode: pair[0], message: 'failure ' + pair[0], error: 'Error' }, pair[0])))
      .sendText('+15551234567', 'body');
    check('34 sendText http ' + pair[0] + ' -> ' + pair[1],
      r.success === false && r.errorCode === pair[1] && r.metaError && r.metaError.httpStatus === pair[0], JSON.stringify(r));
  }
  const r28 = await mk(h.mf(async () => { throw new Error('down'); })).sendText('+15551234567', 'body');
  check('35 sendText network failure is unavailable', r28.success === false && r28.errorCode === 'WHATSAPP_PROVIDER_UNAVAILABLE');
  const r29 = await mk(h.mf(async () => { throw new Error('The operation was aborted'); })).sendText('+15551234567', 'body');
  check('36 sendText timeout is unavailable', r29.success === false && r29.errorCode === 'WHATSAPP_PROVIDER_UNAVAILABLE' && /timed out/.test(r29.errorMessage));
  const r30 = await mk(h.mf(async () => errJson({ statusCode: 400, message: ['chatId must be a string', 'text too long'], error: 'Bad Request' }, 400)))
    .sendText('+15551234567', 'body');
  check('37 sanitized validation details are kept', r30.metaError && /chatId must be a string/.test(r30.metaError.message) && r30.metaError.type === 'Bad Request');

  /* ---------------- API key hygiene ---------------- */
  const logged = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  function spy(level) { return (...args) => { logged.push(args.map((a) => String(a)).join(' ')); orig[level](...args); }; }
  console.log = spy('log'); console.error = spy('error'); console.warn = spy('warn'); console.info = spy('info');
  try {
    const echoedKey = await mk(h.mf(async () => errJson({ statusCode: 401, message: 'invalid key ' + KEY, error: 'Unauthorized ' + KEY }, 401)))
      .sendText('+15551234567', 'body');
    check('38 echoed API key is redacted from the send result', !JSON.stringify(echoedKey).includes(KEY) && /\[redacted\]/.test(echoedKey.metaError.message));
    const echoedVerify = await mk(h.mf(async () => okJson({ status: 'failed', lastError: 'bad key ' + KEY }, 200))).verifyConnection();
    check('39 echoed API key is redacted from the verification result', !JSON.stringify(echoedVerify).includes(KEY));
    const summary = mk(h.mf(async () => okJson({}, 200))).getConfigSummary();
    check('40 config summary exposes no API key', !JSON.stringify(summary).includes(KEY) && summary.apiKeyConfigured === true && summary.provider === 'openwa');
    check('41 config summary masks the session id', summary.sessionIdMasked !== SID && summary.sessionIdMasked.indexOf(SID.slice(0, 8)) === 0 && summary.sessionIdConfigured === true);
  } finally {
    console.log = orig.log; console.error = orig.error; console.warn = orig.warn; console.info = orig.info;
  }
  const leaked = logged.filter((line) => !/^(PASS|FAIL):/.test(line) && (line.includes(KEY) || line.includes('X-API-Key')));
  check('42 the API key is never logged', leaked.length === 0, leaked.join(' || '));
  const allResults = JSON.stringify([r21, r22, r23, r24, r25, r26, r27, r28, r29, r30, r12, r13, v1]);
  check('43 no API key in any result payload', !allResults.includes(KEY));

  console.log('Adapter assertions: ' + C + ' failed: ' + F);
  if (F > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
