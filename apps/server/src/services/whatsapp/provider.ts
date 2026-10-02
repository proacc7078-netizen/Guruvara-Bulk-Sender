/**
 * Phase 5.2A — WhatsApp Provider Registry / Factory
 *
 * The application obtains a WhatsAppAdapter through this registry rather than
 * importing a concrete provider throughout the application.
 *
 * Desired future dependency direction:
 *   CampaignExecution
 *     ↓
 *   Execution service/worker
 *     ↓
 *   WhatsAppAdapter
 *     ↓
 *   Concrete provider
 *
 * NOT:
 *   CampaignExecution
 *     ↓
 *   Meta API
 */

import { UnconfiguredWhatsAppAdapter } from './UnconfiguredWhatsAppAdapter';
import { OfficialWhatsAppAdapter } from './OfficialWhatsAppAdapter';
import { OpenWAWhatsAppAdapter } from './OpenWAWhatsAppAdapter';
import type { WhatsAppAdapter } from './WhatsAppAdapter';
import type { WhatsAppProviderRegistry } from './WhatsAppAdapter';
import {
  whatsappConfig,
  isOfficialProviderConfigured,
  isOpenWAProviderConfigured,
  type WhatsAppProviderConfig,
} from './config';

let _adapter: WhatsAppAdapter | null = null;

/**
 * Creates the appropriate adapter based on current configuration.
 * Does not cache - callers should use getWhatsAppAdapter() for cached access.
 *
 * Phase 7.4 — provider selection alone decides the adapter:
 *   none      -> safe UnconfiguredWhatsAppAdapter (nothing is sent)
 *   official  -> OfficialWhatsAppAdapter (unchanged behaviour)
 *   openwa    -> OpenWAWhatsAppAdapter (API key + session id required)
 *
 * The Phase 7.1 guard and the Phase 7.2 WHATSAPP_OPENWA_CAMPAIGN_SENDING_ENABLED
 * test-only gate were removed when the OpenWA adapter was wired into the
 * campaign execution / queue-worker delivery path.
 */
function createAdapter(): WhatsAppAdapter {
  if (isOfficialProviderConfigured(whatsappConfig)) {
    return new OfficialWhatsAppAdapter(whatsappConfig);
  }
  if (isOpenWAProviderConfigured(whatsappConfig)) {
    return new OpenWAWhatsAppAdapter(whatsappConfig);
  }
  return new UnconfiguredWhatsAppAdapter();
}

/**
 * Phase 5.2B — builds a fresh adapter for an explicitly resolved config.
 * Preserves the provider abstraction (callers use WhatsAppAdapter).
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

/**
 * Returns the currently configured WhatsAppAdapter.
 *
 * In Phase 5.1 this always returned the unconfigured placeholder.
 * In Phase 5.2A, it returns OfficialWhatsAppAdapter when WHATSAPP_PROVIDER=official
 * with valid credentials, otherwise UnconfiguredWhatsAppAdapter.
 *
 * The adapter is instantiated lazily on first call and cached.
 */
export function getWhatsAppAdapter(): WhatsAppAdapter {
  if (_adapter === null) {
    _adapter = createAdapter();
  }
  return _adapter;
}

/**
 * Provider registry implementation.
 */
export const whatsappProviderRegistry: WhatsAppProviderRegistry = {
  getAdapter: getWhatsAppAdapter,
};

/**
 * Resets the cached adapter. Primarily useful for testing.
 *
 * Not exposed in production via HTTP.
 */
export function resetWhatsAppAdapter(): void {
  _adapter = null;
}