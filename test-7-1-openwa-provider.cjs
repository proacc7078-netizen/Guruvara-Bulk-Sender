/*
 * Phase 7.1 — OpenWA provider foundation tests (configuration, provider
 * selection, status endpoint, safety).
 *
 * Updated in Phase 7.4: the Phase 7.1/7.2 delivery guard was removed when the
 * adapter was wired into the campaign execution / queue-worker delivery path,
 * so checks 16, 25 and 26 assert the wired (gate-free) behaviour.
 *
 * Safety:
 * - The OpenWA host in these tests does not resolve and every fetch is mocked;
 *   no request ever reaches localhost:2785 or any real OpenWA instance.
 * - No WhatsApp message is sent, no campaign/execution data is touched and no
 *   database access happens in this file.
 * - Dummy credential/session placeholders only — no real API key or session id.
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

function envOpenWA(over) {
  return Object.assign({
    WHATSAPP_PROVIDER: 'openwa',
    WHATSAPP_OPENWA_API_KEY: KEY,
    WHATSAPP_OPENWA_SESSION_ID: SID,
    WHATSAPP_OPENWA_BASE_URL: BASE,
  }, over || {});
}

async function main() {
  console.log('=== Phase 7.1 — OpenWA provider (config, selection, status) ===');

  /* ---------------- configuration ---------------- */
  let saved = h.setEnv(envOpenWA({ WHATSAPP_OPENWA_BASE_URL: undefined }));
  let cfgMod = h.fresh('services/whatsapp/config.js');
  const loaded = cfgMod.loadWhatsAppConfig();
  check('1 provider=openwa loads the OpenWA configuration',
    loaded.provider === 'openwa' && loaded.apiKey === KEY && loaded.sessionId === SID, String(loaded.provider));
  check('2 base url defaults to the local OpenWA instance', loaded.baseUrl === 'http://localhost:2785', loaded.baseUrl);
  check('3 default provider is still none', cfgMod.DEFAULT_WHATSAPP_CONFIG.provider === 'none');
  h.rest(saved);

  saved = h.setEnv({ WHATSAPP_PROVIDER: 'openwa', WHATSAPP_OPENWA_API_KEY: KEY, WHATSAPP_OPENWA_SESSION_ID: SID, WHATSAPP_OPENWA_BASE_URL: 'http://localhost:2785/' });
  cfgMod = h.fresh('services/whatsapp/config.js');
  check('4 trailing slash trimmed from the base url', cfgMod.loadWhatsAppConfig().baseUrl === 'http://localhost:2785');
  h.rest(saved);

  saved = h.setEnv({ WHATSAPP_PROVIDER: 'openwa', WHATSAPP_OPENWA_API_KEY: KEY, WHATSAPP_OPENWA_SESSION_ID: SID, WHATSAPP_OPENWA_BASE_URL: 'http://localhost:2785/api' });
  cfgMod = h.fresh('services/whatsapp/config.js');
  check('5 an optional /api suffix is not doubled', cfgMod.loadWhatsAppConfig().baseUrl === 'http://localhost:2785');
  h.rest(saved);

  saved = h.setEnv(envOpenWA({ WHATSAPP_OPENWA_API_KEY: '', WHATSAPP_OPENWA_SESSION_ID: '' }));
  cfgMod = h.fresh('services/whatsapp/config.js');
  let threw = null;
  try { cfgMod.loadWhatsAppConfig(); } catch (e) { threw = e; }
  check('6 missing OpenWA credentials are rejected with the existing error pattern',
    !!threw && /WHATSAPP_CONFIGURATION_INVALID/.test(threw.message), threw && threw.message);
  check('7 the rejection names the missing environment variables without values',
    !!threw && /WHATSAPP_OPENWA_API_KEY/.test(threw.message) && /WHATSAPP_OPENWA_SESSION_ID/.test(threw.message) && !threw.message.includes(KEY));
  const state = cfgMod.resolveWhatsAppConfigState();
  check('8 resolve state reports the raw provider and a null config', state.rawProvider === 'openwa' && state.config === null && !!state.error);
  check('9 the incomplete-config guard reports not-configured',
    cfgMod.isOpenWAProviderConfigured({ provider: 'openwa', baseUrl: BASE, apiKey: '', sessionId: '' }) === false);
  check('10 empty base url normalizes to the safe default',
    cfgMod.normalizeOpenWABaseUrl('') === 'http://localhost:2785');
  check('11 summary masks session id and never carries the key',
    cfgMod.summarizeOpenWAConfig({ provider: 'openwa', baseUrl: BASE, apiKey: KEY, sessionId: SID }).sessionIdMasked !== SID &&
    !JSON.stringify(cfgMod.summarizeOpenWAConfig({ provider: 'openwa', baseUrl: BASE, apiKey: KEY, sessionId: SID })).includes(KEY));
  check('12 official provider still loads its own config',
    (() => { const s = h.setEnv({ WHATSAPP_PROVIDER: 'official', WHATSAPP_ACCESS_TOKEN: 'AT', WHATSAPP_BUSINESS_ACCOUNT_ID: 'B', WHATSAPP_PHONE_NUMBER_ID: 'PN' }); try { return h.fresh('services/whatsapp/config.js').loadWhatsAppConfig().provider; } finally { h.rest(s); } })() === 'official');
  h.rest(saved);

  /* ---------------- provider selection ---------------- */
  saved = h.setEnv(envOpenWA());
  cfgMod = h.fresh('services/whatsapp/config.js');
  const provMod = h.fresh('services/whatsapp/whatsappProvider.js');
  const openwaCfg = cfgMod.loadWhatsAppConfig();
  const statusAdapter = provMod.createWhatsAppAdapterForConfig(openwaCfg);
  check('13 provider=openwa selects the OpenWA adapter',
    statusAdapter.constructor.name === 'OpenWAWhatsAppAdapter', statusAdapter.constructor.name);
  check('14 selected adapter implements the existing interface',
    ['getStatus', 'connect', 'disconnect', 'sendText', 'sendMedia', 'verifyConnection', 'getConfigSummary'].every((m) => typeof statusAdapter[m] === 'function'));
  check('15 fallback input resolves to the safe unconfigured adapter',
    provMod.createWhatsAppAdapterForConfig({ provider: 'none' }).constructor.name === 'UnconfiguredWhatsAppAdapter');
  check('16 worker singleton path resolves the OpenWA adapter for provider=openwa',
    (() => { try { delete require.cache[require.resolve(path.join(h.DIST, 'services/whatsapp/whatsappProvider.js'))]; } catch {} const m2 = h.fresh('services/whatsapp/whatsappProvider.js'); return m2.getWhatsAppAdapter().constructor.name; })() === 'OpenWAWhatsAppAdapter');
  h.rest(saved);

  /* ---------------- status endpoint ---------------- */
  saved = h.setEnv(envOpenWA());
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'ready', phoneNumber: '15551234567' }) });
  let ctl = h.fresh('controllers/whatsapp.controller.js');
  let payload = null;
  await ctl.getStatus({}, { json: (x) => { payload = x; } }, (e) => { throw e; });
  check('17 ready status reports connected without the key',
    payload && payload.configured === true && payload.provider === 'openwa' && payload.status === 'CONNECTED' &&
    payload.verification && payload.verification.verified === true && payload.verification.providerStatus === 'ready' &&
    !JSON.stringify(payload).includes(KEY), JSON.stringify(payload));
  check('18 summary marks OpenWA as unofficial opt-in',
    payload && payload.config && payload.config.unofficial === true && payload.config.apiKeyConfigured === true);
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'qr_ready' }) });
  ctl = h.fresh('controllers/whatsapp.controller.js');
  payload = null;
  await ctl.getStatus({}, { json: (x) => { payload = x; } }, (e) => { throw e; });
  check('19 non-ready maps to disconnected status response', payload && payload.status === 'DISCONNECTED' && payload.verification.verified === false);
  globalThis.fetch = origFetch;
  h.rest(saved);

  saved = h.setEnv(envOpenWA({ WHATSAPP_OPENWA_API_KEY: '', WHATSAPP_OPENWA_SESSION_ID: '' }));
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('must not be called'); };
  ctl = h.fresh('controllers/whatsapp.controller.js');
  payload = null;
  await ctl.getStatus({}, { json: (x) => { payload = x; } }, (e) => { throw e; });

  check('20 missing OpenWA config reports disconnected without a request',
    payload && payload.provider === 'openwa' && payload.status === 'DISCONNECTED' &&
    payload.verification && payload.verification.verified === false &&
    payload.verification.reason === 'CONFIG_INVALID' && fetchCalled === false &&
    !JSON.stringify(payload).includes(KEY), JSON.stringify(payload));
  globalThis.fetch = origFetch;
  h.rest(saved);

  saved = h.setEnv({ WHATSAPP_PROVIDER: 'official', WHATSAPP_ACCESS_TOKEN: 'AT', WHATSAPP_BUSINESS_ACCOUNT_ID: 'B', WHATSAPP_PHONE_NUMBER_ID: 'PN' });
  cfgMod = h.fresh('services/whatsapp/config.js');
  check('21 provider=official still loads its own adapter config',
    cfgMod.loadWhatsAppConfig().provider === 'official' &&
    provMod.createWhatsAppAdapterForConfig(cfgMod.loadWhatsAppConfig()).constructor.name === 'OfficialWhatsAppAdapter');
  h.rest(saved);

  saved = h.setEnv({ WHATSAPP_PROVIDER: 'none' });
  cfgMod = h.fresh('services/whatsapp/config.js');
  check('22 provider=none still loads the safe default',
    cfgMod.loadWhatsAppConfig().provider === 'none' &&
    provMod.createWhatsAppAdapterForConfig(cfgMod.loadWhatsAppConfig()).constructor.name === 'UnconfiguredWhatsAppAdapter');
  h.rest(saved);

  const noneMod = h.fresh('services/whatsapp/UnconfiguredWhatsAppAdapter.js');
  const noneVerify = await new noneMod.UnconfiguredWhatsAppAdapter().verifyConnection();
  check('23 provider=none verification is unchanged',
    noneVerify.verified === false && noneVerify.reason === 'NOT_CONFIGURED', JSON.stringify(noneVerify));

  const envExample = h.src(path.join(h.REPO_ROOT, '.env.example'));
  check('24 env example documents OpenWA vars with empty secrets',
    envExample.indexOf('WHATSAPP_OPENWA_BASE_URL=http://localhost:2785') >= 0 &&
    envExample.indexOf('WHATSAPP_OPENWA_API_KEY=') >= 0 &&
    envExample.indexOf('WHATSAPP_OPENWA_SESSION_ID=') >= 0);
  const readme = h.src(path.join(h.REPO_ROOT, 'README.md'));
  check('25 README marks OpenWA unofficial + opt-in with delivery by provider selection',
    /unofficial/i.test(readme) && /disabled unless explicitly selected/i.test(readme) &&
    /WHATSAPP_PROVIDER=openwa/.test(readme) && /provider selection/i.test(readme));
  const deliverySrc = h.src(path.join(h.REPO_ROOT, 'apps/server/src/services/executionDelivery.service.ts'));
  const workerSrc = h.src(path.join(h.REPO_ROOT, 'apps/server/src/services/executionQueueWorker.ts'));
  const registrySrc = h.src(path.join(h.REPO_ROOT, 'apps/server/src/services/whatsapp/whatsappProvider.ts')) +
    h.src(path.join(h.REPO_ROOT, 'apps/server/src/services/whatsapp/provider.ts'));
  check('26 delivery path stays provider-neutral and the worker never selects OpenWA directly',
    /whatsappProviderRegistry\.getAdapter\(\)/.test(deliverySrc) &&
    !/OpenWAWhatsAppAdapter|OfficialWhatsAppAdapter|UnconfiguredWhatsAppAdapter/.test(deliverySrc) &&
    !/localhost:2785/.test(workerSrc) && !/OpenWAWhatsAppAdapter/.test(workerSrc) &&
    /isOpenWAProviderConfigured/.test(registrySrc));

  console.log('Provider assertions: ' + C + ' failed: ' + F);
  if (F > 0) process.exitCode = 1;

}
main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });

