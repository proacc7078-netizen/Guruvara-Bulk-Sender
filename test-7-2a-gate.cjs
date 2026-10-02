/*
 * Phase 7.2 → Phase 7.4 — provider routing on the campaign delivery path.
 *
 * Phase 7.2 wired the OpenWA adapter in behind a TEST-ONLY
 * WHATSAPP_OPENWA_CAMPAIGN_SENDING_ENABLED gate. Phase 7.4 removed that gate:
 * provider selection alone decides which adapter the campaign execution /
 * queue-worker delivery path resolves, and WHATSAPP_PROVIDER=none is the safe
 * "nothing is configured" state. These are the updated (gate-free) assertions.
 *
 * Mocked/local only: the OpenWA host does not resolve, no request is made, no
 * real send and no database access.
 */
const h = require('./test-5-3-helpers.cjs');
const path = require('path');
let C = 0; let F = 0;
function check(n, c, e) { C++; if (!c) F++; console.log((c ? 'PASS' : 'FAIL') + ': ' + n + (e ? ' | ' + e : '')); }
function setEnv(vars) { for (const k of Object.keys(vars)) { if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; } }

const OPENWA_ENV = {
  WHATSAPP_PROVIDER: 'openwa',
  WHATSAPP_OPENWA_API_KEY: 'DUMMY_OPENWA_KEY',
  WHATSAPP_OPENWA_SESSION_ID: 'DUMMY_SESSION_ID',
  WHATSAPP_OPENWA_BASE_URL: 'http://openwa.invalid:2785',
};
const OFFICIAL_ENV = {
  WHATSAPP_PROVIDER: 'official',
  WHATSAPP_ACCESS_TOKEN: 'DUMMY_ACCESS_TOKEN',
  WHATSAPP_BUSINESS_ACCOUNT_ID: 'DUMMY_WABA',
  WHATSAPP_PHONE_NUMBER_ID: 'DUMMY_PN',
};
const TOUCHED = ['WHATSAPP_PROVIDER', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_BUSINESS_ACCOUNT_ID', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_OPENWA_API_KEY', 'WHATSAPP_OPENWA_SESSION_ID', 'WHATSAPP_OPENWA_BASE_URL', 'WHATSAPP_OPENWA_CAMPAIGN_SENDING_ENABLED'];

async function main() {
  console.log('=== Phase 7.2a -> 7.4 — provider routing on the delivery path ===');
  const SAVE = {};
  for (const k of TOUCHED) SAVE[k] = process.env[k];

  const SRC_DELIVERY = h.src(path.join(h.REPO_ROOT, 'apps/server/src/services/executionDelivery.service.ts'));
  const SRC_PROVIDER = h.src(path.join(h.REPO_ROOT, 'apps/server/src/services/whatsapp/whatsappProvider.ts'));
  const SRC_PROVIDER2 = h.src(path.join(h.REPO_ROOT, 'apps/server/src/services/whatsapp/provider.ts'));
  const SRC_GATE = h.src(path.join(h.REPO_ROOT, 'apps/server/src/services/whatsapp/openwaConfig.ts'));
  const SRC_INDEX = h.src(path.join(h.REPO_ROOT, 'apps/server/src/services/whatsapp/index.ts'));
  const SRC_WORKER = h.src(path.join(h.REPO_ROOT, 'apps/server/src/services/executionQueueWorker.ts'));
  const REGISTRY = SRC_PROVIDER + SRC_PROVIDER2;

  check('S1 delivery path resolves its adapter through the provider registry',
    /whatsappProviderRegistry\.getAdapter\(\)/.test(SRC_DELIVERY));
  check('S2 delivery path holds no provider-specific adapter selection or gate',
    !/OpenWAWhatsAppAdapter|OfficialWhatsAppAdapter|UnconfiguredWhatsAppAdapter/.test(SRC_DELIVERY) &&
    !/OPENWA_CAMPAIGN_SENDING/.test(SRC_DELIVERY));
  check('S3 the registry resolves OpenWA by provider configuration',
    /isOpenWAProviderConfigured/.test(SRC_PROVIDER) && /isOpenWAProviderConfigured/.test(SRC_PROVIDER2));
  check('S4 the Phase 7.2 gate helper no longer exists in code',
    !/export\s+(function|const)\s+isOpenWACampaignSendingEnabled/.test(SRC_GATE) &&
    !/OPENWA_CAMPAIGN_SENDING_ENV_VAR\s*=/.test(SRC_GATE) &&
    !/isOpenWACampaignSendingEnabled\s*\(/.test(SRC_GATE));
  check('S5 the barrel no longer exports the gate', !/OPENWA_CAMPAIGN_SENDING_ENV_VAR/.test(SRC_INDEX));
  check('S6 no gate usage survives in delivery/registry/barrel',
    !/isOpenWACampaignSendingEnabled\s*\(/.test(SRC_DELIVERY + REGISTRY + SRC_INDEX) &&
    !/OPENWA_CAMPAIGN_SENDING_ENV_VAR/.test(SRC_DELIVERY + REGISTRY + SRC_INDEX) &&
    !/isOpenWADeliveryEnabled/.test(REGISTRY));
  check('S7 no localhost:2785 literal in delivery/worker/registry',
    !/localhost:2785/.test(SRC_DELIVERY) && !/localhost:2785/.test(SRC_WORKER) && !/localhost:2785/.test(REGISTRY));
  check('S8 delivery still uses the immutable snapshot',
    /executionRecipient\.whatsappNumber/.test(SRC_DELIVERY) && /execution\.messageBody/.test(SRC_DELIVERY));

  function loadSingleton() {
    const cfgMod = h.fresh('services/whatsapp/config.js');
    const provMod = h.fresh('services/whatsapp/whatsappProvider.js');
    try { provMod.resetWhatsAppAdapter(); } catch {}
    const cfg2 = h.fresh('services/whatsapp/config.js');
    const prov2 = h.fresh('services/whatsapp/whatsappProvider.js');
    void cfgMod; void cfg2;
    return prov2;
  }

  setEnv(OFFICIAL_ENV);
  let prov = loadSingleton();
  check('1 provider=official resolves the official adapter',
    prov.getWhatsAppAdapter().constructor.name === 'OfficialWhatsAppAdapter', prov.getWhatsAppAdapter().constructor.name);

  setEnv({ WHATSAPP_PROVIDER: 'none' });
  prov = loadSingleton();
  check('2 provider=none resolves the safe unconfigured adapter',
    prov.getWhatsAppAdapter().constructor.name === 'UnconfiguredWhatsAppAdapter', prov.getWhatsAppAdapter().constructor.name);

  setEnv(OPENWA_ENV);
  prov = loadSingleton();
  check('3 provider=openwa resolves the OpenWA adapter',
    prov.getWhatsAppAdapter().constructor.name === 'OpenWAWhatsAppAdapter', prov.getWhatsAppAdapter().constructor.name);

  // The removed Phase 7.2 switch must not influence selection any more.
  setEnv(OPENWA_ENV);
  process.env.WHATSAPP_OPENWA_CAMPAIGN_SENDING_ENABLED = 'false';
  prov = loadSingleton();
  check('4 the removed gate variable no longer blocks provider=openwa',
    prov.getWhatsAppAdapter().constructor.name === 'OpenWAWhatsAppAdapter', prov.getWhatsAppAdapter().constructor.name);

  setEnv({ WHATSAPP_PROVIDER: 'none' });
  process.env.WHATSAPP_OPENWA_CAMPAIGN_SENDING_ENABLED = 'true';
  prov = loadSingleton();
  check('5 the removed gate variable cannot enable anything by itself',
    prov.getWhatsAppAdapter().constructor.name === 'UnconfiguredWhatsAppAdapter', prov.getWhatsAppAdapter().constructor.name);

  setEnv({ WHATSAPP_PROVIDER: 'openwa', WHATSAPP_OPENWA_API_KEY: undefined, WHATSAPP_OPENWA_SESSION_ID: undefined, WHATSAPP_OPENWA_BASE_URL: 'http://openwa.invalid:2785' });
  prov = loadSingleton();
  check('6 incomplete OpenWA configuration stays on the safe unconfigured adapter',
    prov.getWhatsAppAdapter().constructor.name === 'UnconfiguredWhatsAppAdapter', prov.getWhatsAppAdapter().constructor.name);

  const cfgMod = h.fresh('services/whatsapp/config.js');
  setEnv(OPENWA_ENV);
  check('7 explicit per-config build still selects OpenWA (status path)',
    prov.createWhatsAppAdapterForConfig(cfgMod.loadWhatsAppConfig()).constructor.name === 'OpenWAWhatsAppAdapter');

  setEnv(OPENWA_ENV);
  const oneMod = h.fresh('services/whatsapp/whatsappProvider.js');
  const first = oneMod.getWhatsAppAdapter();
  setEnv(OFFICIAL_ENV);
  const second = oneMod.getWhatsAppAdapter();
  check('8 the cached singleton follows provider selection',
    first.constructor.name === 'OpenWAWhatsAppAdapter' && second.constructor.name === 'OfficialWhatsAppAdapter',
    first.constructor.name + ' -> ' + second.constructor.name);

  for (const k of TOUCHED) { if (SAVE[k] === undefined) delete process.env[k]; else process.env[k] = SAVE[k]; }
  console.log('Phase 7.2a -> 7.4 assertions: ' + C + ' failed: ' + F);
  if (F > 0) process.exitCode = 1;
}
main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
