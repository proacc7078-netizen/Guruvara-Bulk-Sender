/**
 * Phase 5.2A — WhatsApp Adapter Foundation (Public API)
 *
 * Provider-independent WhatsApp adapter layer.
 *
 * Import from this barrel to use the adapter abstraction.
 *
 *   import { getWhatsAppAdapter, WhatsAppAdapter } from '../services/whatsapp';
 */

export { getWhatsAppAdapter, resetWhatsAppAdapter } from './whatsappProvider';
export { whatsappProviderRegistry, type WhatsAppProviderRegistry, type WhatsAppAdapterFactory, type WhatsAppAdapter } from './WhatsAppAdapter';
export type { ConnectionStatus, SendResult, MessageStatus, MediaPayload, WhatsAppErrorCode, WhatsAppError, WhatsAppVerificationResult } from './types';
export { DEFAULT_WHATSAPP_CONFIG, isProviderConfigured, isOfficialProviderConfigured, loadWhatsAppConfig, resolveWhatsAppConfigState, whatsappConfig, whatsappConfigError, type WhatsAppProviderConfig, type WhatsAppProviderType, type WhatsAppOfficialConfig } from './config';

/**
 * Phase 7.1 — OpenWA (unofficial, opt-in) provider foundation.
 *
 * Configuration, the OpenWA adapter and its safe configuration summary are
 * exported here.
 *
 * Phase 7.4 — the adapter is now wired into the campaign execution /
 * queue-worker delivery path: WHATSAPP_PROVIDER=openwa resolves it through the
 * provider registry, and WHATSAPP_PROVIDER=none keeps the safe unconfigured
 * adapter. The Phase 7.2 test-only sending gate no longer exists.
 */
export {
  OpenWAWhatsAppAdapter,
  buildOpenWAChatId,
  resolveOpenWAMediaUrl,
  type OpenWAFetchFn,
} from './OpenWAWhatsAppAdapter';
export {
  DEFAULT_OPENWA_BASE_URL,
  OPENWA_API_PREFIX,
  isOpenWAProviderConfigured,
  loadOpenWAConfig,
  maskOpenWAIdentifier,
  normalizeOpenWABaseUrl,
  summarizeOpenWAConfig,
  type OpenWAConfigSummary,
  type WhatsAppOpenWAConfig,
} from './openwaConfig';

// Phase 7.3 — OpenWA webhook normalization + signature verification
export {
  normalizeOpenWAWebhookEvents,
  verifyOpenWAWebhookSignature,
  type OpenWAWebhookEnvelope,
} from './openwaWebhook.service';
export {
  loadOpenWAWebhookConfig,
  isOpenWAWebhookConfigured,
  type OpenWAWebhookConfig,
} from './config';
