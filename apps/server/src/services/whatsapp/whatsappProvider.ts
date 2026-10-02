import { WhatsAppAdapter } from './types';
import { UnconfiguredWhatsAppAdapter } from './UnconfiguredWhatsAppAdapter';
import { OfficialWhatsAppAdapter } from './OfficialWhatsAppAdapter';
import { OpenWAWhatsAppAdapter } from './OpenWAWhatsAppAdapter';
import {
  loadWhatsAppConfig,
  isOfficialProviderConfigured,
  isOpenWAProviderConfigured,
  type WhatsAppProviderConfig,
} from './config';

let adapterInstance: WhatsAppAdapter | null = null;
let adapterCacheKey: string | null = null;

/**
 * Resolves the currently configured provider for the active process.
 * Never throws: an unloadable/invalid environment resolves to 'none' so the
 * delivery singleton stays on the safe UnconfiguredWhatsAppAdapter.
 */
function resolveCurrentConfig(): WhatsAppProviderConfig {
  try {
    return loadWhatsAppConfig();
  } catch {
    return { provider: 'none' };
  }
}

/**
 * Cache key for the delivery singleton. The adapter is rebuilt whenever the
 * effective provider selection changes (provider switch, safety-gate flip, or
 * credential/config rotation), so a module singleton preserved across an
 * env/reload boundary cannot keep serving the previously-created adapter.
 */
function resolveAdapterCacheKey(config: WhatsAppProviderConfig): string {
  if (config.provider === 'official') {
    return [
      'official',
      config.phoneNumberId,
      config.businessAccountId,
      config.apiVersion,
      config.apiBaseUrl,
    ].join('|');
  }
  if (config.provider === 'openwa') {
    return [
      'openwa',
      config.baseUrl,
      config.sessionId,
    ].join('|');
  }
  return 'none';
}

/**
 * Phase 7.4 — campaign execution / queue-worker delivery selection.
 *
 * The delivery singleton resolves the adapter from the configured provider,
 * exactly like createWhatsAppAdapterForConfig() does for explicit status
 * verification:
 *
 *   provider=none      -> safe UnconfiguredWhatsAppAdapter (nothing is sent)
 *   provider=official  -> OfficialWhatsAppAdapter (unchanged behaviour)
 *   provider=openwa    -> OpenWAWhatsAppAdapter (API key + session id required)
 *
 * The Phase 7.1 guard that kept OpenWA unreachable from this path - and the
 * Phase 7.2 WHATSAPP_OPENWA_CAMPAIGN_SENDING_ENABLED test-only gate that
 * temporarily replaced it - were removed when the adapter was wired in. An
 * incomplete OpenWA configuration is still not "configured", so it resolves to
 * the safe unconfigured adapter and can never be contacted.
 */
function createAdapter(config: WhatsAppProviderConfig): WhatsAppAdapter {
  if (isOfficialProviderConfigured(config)) {
    return new OfficialWhatsAppAdapter(config);
  }
  if (isOpenWAProviderConfigured(config)) {
    return new OpenWAWhatsAppAdapter(config);
  }
  return new UnconfiguredWhatsAppAdapter();
}

/**
 * Phase 5.2B — builds a fresh adapter for an explicitly resolved config.
 * Used by GET /api/whatsapp/status so verification always reflects the
 * current environment without mutating the cached singleton.
 * Preserves the provider abstraction (callers use the WhatsAppAdapter interface).
 */
export function createWhatsAppAdapterForConfig(config: WhatsAppProviderConfig): WhatsAppAdapter {
  if (isOfficialProviderConfigured(config)) {
    return new OfficialWhatsAppAdapter(config);
  }
  if (isOpenWAProviderConfigured(config)) {
    return new OpenWAWhatsAppAdapter(config);
  }
  return new UnconfiguredWhatsAppAdapter();
}

export function getWhatsAppAdapter(): WhatsAppAdapter {
  const currentConfig = resolveCurrentConfig();
  const cacheKey = resolveAdapterCacheKey(currentConfig);
  if (!adapterInstance || adapterCacheKey !== cacheKey) {
    adapterInstance = createAdapter(currentConfig);
    adapterCacheKey = cacheKey;
  }
  return adapterInstance;
}

/**
 * Resets the cached adapter. Primarily useful for testing.
 *
 * Not exposed in production via HTTP.
 */
export function resetWhatsAppAdapter(): void {
  adapterInstance = null;
  adapterCacheKey = null;
}