/**
 * Phase 5.2A — WhatsApp Provider Configuration
 *
 * Typed configuration abstraction with safe defaults.
 *
 * NO real WhatsApp credentials are stored here or anywhere in this phase.
 * The default provider is "none" (unconfigured).
 */

import {
  isOpenWAProviderConfigured,
  loadOpenWAConfig,
  normalizeOpenWABaseUrl,
  summarizeOpenWAConfig,
  type OpenWAConfigSummary,
  type WhatsAppOpenWAConfig,
} from './openwaConfig';

/**
 * Phase 7.1 — provider selection supports:
 *   'none'     no provider configured (default)
 *   'official' official Meta WhatsApp Cloud API (unchanged behavior)
 *   'openwa'   OpenWA, an unofficial self-hosted gateway (opt-in, never default)
 *
 * Phase 7.4 — delivery selection: the OpenWA adapter is resolved by provider
 * selection alone. WHATSAPP_PROVIDER=openwa (with an API key and a session id)
 * is used by campaign execution and the queue worker; WHATSAPP_PROVIDER=none
 * (the default) keeps the safe unconfigured adapter. The Phase 7.2 test-only
 * WHATSAPP_OPENWA_CAMPAIGN_SENDING_ENABLED gate was removed with the wiring.
 */
export type WhatsAppProviderType = 'none' | 'official' | 'openwa';

export interface WhatsAppOfficialConfig {
  readonly provider: 'official';
  readonly accessToken: string;
  readonly businessAccountId: string;
  readonly phoneNumberId: string;
  readonly apiVersion: string;
  readonly apiBaseUrl: string;
}

export interface WhatsAppNoneConfig {
  readonly provider: 'none';
}

export type WhatsAppProviderConfig =
  | WhatsAppOfficialConfig
  | WhatsAppOpenWAConfig
  | WhatsAppNoneConfig;

/**
 * Default configuration indicating no provider is configured.
 */
export const DEFAULT_WHATSAPP_CONFIG: WhatsAppNoneConfig = {
  provider: 'none',
};

/**
 * Maximum retry attempts for failed WhatsApp deliveries.
 * Configurable via WHATSAPP_MAX_RETRIES env var (default: 3).
 */
export function getWhatsAppMaxRetries(): number {
  const envValue = process.env.WHATSAPP_MAX_RETRIES;
  if (envValue !== undefined) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return 3;
}

/**
 * Reads WhatsApp configuration from environment variables.
 * Returns a validated configuration object or throws on invalid official config.
 */
export function loadWhatsAppConfig(): WhatsAppProviderConfig {
  const provider = (process.env.WHATSAPP_PROVIDER as WhatsAppProviderType) || 'none';

  if (provider === 'none') {
    return { provider: 'none' };
  }

  if (provider === 'official') {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const businessAccountId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const apiVersion = process.env.WHATSAPP_API_VERSION || 'v20.0';
    const apiBaseUrl = process.env.WHATSAPP_API_BASE_URL || 'https://graph.facebook.com';

    const missing: string[] = [];
    if (!accessToken) missing.push('WHATSAPP_ACCESS_TOKEN');
    if (!businessAccountId) missing.push('WHATSAPP_BUSINESS_ACCOUNT_ID');
    if (!phoneNumberId) missing.push('WHATSAPP_PHONE_NUMBER_ID');

    if (missing.length > 0) {
      throw new Error(
        `WHATSAPP_CONFIGURATION_INVALID: Missing required environment variables: ${missing.join(', ')}`
      );
    }

    return {
      provider: 'official',
      accessToken: accessToken!,
      businessAccountId: businessAccountId!,
      phoneNumberId: phoneNumberId!,
      apiVersion,
      apiBaseUrl,
    };
  }

  if (provider === 'openwa') {
    // Phase 7.1 — fails with the existing WHATSAPP_CONFIGURATION_INVALID
    // pattern when the API key or session id is missing; the OpenWA instance
    // is never contacted from here.
    return loadOpenWAConfig();
  }

  throw new Error(`WHATSAPP_CONFIGURATION_INVALID: Unknown provider "${provider}"`);
}

/**
 * The active WhatsApp configuration, loaded from environment at module init.
 *
 * Phase 5.2B: loaded safely so an invalid official configuration does not
 * crash the server at import time. Use loadWhatsAppConfig() per request
 * (or whatsappConfigError) to distinguish "not configured" from
 * "configured but invalid". The throwing behaviour of loadWhatsAppConfig()
 * is preserved.
 */
export const whatsappConfig: WhatsAppProviderConfig = (() => {
  try {
    return loadWhatsAppConfig();
  } catch {
    return { provider: 'none' };
  }
})();

/**
 * Captures the configuration error at module init, if any.
 * Null when the initial configuration loaded cleanly.
 */
export const whatsappConfigError: Error | null = (() => {
  try {
    loadWhatsAppConfig();
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
})();

/**
 * Resolves fresh WhatsApp configuration state per request.
 * Never throws: returns the raw provider value plus either a config or an error.
 */
export function resolveWhatsAppConfigState(): {
  rawProvider: string;
  config: WhatsAppProviderConfig | null;
  error: Error | null;
} {
  const rawProvider = (process.env.WHATSAPP_PROVIDER as WhatsAppProviderType) || 'none';
  try {
    return { rawProvider, config: loadWhatsAppConfig(), error: null };
  } catch (error) {
    return {
      rawProvider,
      config: null,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Type guard: returns true if an official provider is configured with valid credentials.
 */
export function isOfficialProviderConfigured(
  config: WhatsAppProviderConfig
): config is WhatsAppOfficialConfig {
  return config.provider === 'official';
}

/**
 * Phase 7.1 — re-exports the OpenWA configuration surface so callers only
 * need this module for provider configuration.
 *
 * Phase 7.4 — also re-exports the base URL normalizer. The Phase 7.2
 * TEST-ONLY campaign sending gate is gone: provider selection decides which
 * adapter the delivery path uses.
 */
export {
  isOpenWAProviderConfigured,
  loadOpenWAConfig,
  normalizeOpenWABaseUrl,
  summarizeOpenWAConfig,
};
export type { OpenWAConfigSummary, WhatsAppOpenWAConfig };

/**
 * Validates an official WhatsApp configuration.
 * Throws WHATSAPP_CONFIGURATION_INVALID if required fields are missing.
 */
export function validateOfficialConfig(config: WhatsAppOfficialConfig): void {
  const missing: string[] = [];
  if (!config.accessToken) missing.push('accessToken');
  if (!config.businessAccountId) missing.push('businessAccountId');
  if (!config.phoneNumberId) missing.push('phoneNumberId');

  if (missing.length > 0) {
    throw new Error(
      `WHATSAPP_CONFIGURATION_INVALID: Missing required configuration fields: ${missing.join(', ')}`
    );
  }
}

/**
 * Type guard: returns true if any provider is configured (not 'none').
 *
 * Phase 7.1 — widened to cover OpenWA as well; the check itself is unchanged.
 */
export function isProviderConfigured(
  config: WhatsAppProviderConfig
): config is WhatsAppOfficialConfig | WhatsAppOpenWAConfig {
  return config.provider !== 'none';
}

/**
 * Webhook configuration for Meta WhatsApp delivery webhooks.
 * These are used to verify incoming webhook requests from Meta.
 */
export interface WhatsAppWebhookConfig {
  readonly verifyToken: string;
  readonly appSecret: string;
}

/**
 * Reads webhook configuration from environment variables.
 * Returns null if not configured.
 */
export function loadWhatsAppWebhookConfig(): WhatsAppWebhookConfig | null {
  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  const appSecret = process.env.WHATSAPP_APP_SECRET;

  if (!verifyToken || !appSecret) {
    return null;
  }

  return { verifyToken, appSecret };
}

/**
 * Validates that webhook configuration is complete.
 * Throws if partially configured.
 */
export function validateWebhookConfig(config: WhatsAppWebhookConfig | null): {
  configured: boolean;
  error: Error | null;
} {
  if (!config) {
    return { configured: false, error: null };
  }

  if (!config.verifyToken || !config.appSecret) {
    return {
      configured: false,
      error: new Error('WHATSAPP_WEBHOOK_CONFIGURATION_INVALID: Both WHATSAPP_WEBHOOK_VERIFY_TOKEN and WHATSAPP_APP_SECRET are required'),
    };
  }

  return { configured: true, error: null };
}

/**
 * Checks if webhook verification is configured.
 */
export function isWebhookConfigured(): boolean {
  const config = loadWhatsAppWebhookConfig();
  return config !== null && !!config.verifyToken && !!config.appSecret;
}

// -----------------------------------------------------------------------
// Phase 7.3 — OpenWA webhook configuration
// -----------------------------------------------------------------------

/**
 * OpenWA webhook configuration.
 *
 * OpenWA can POST delivery-status events to a configured webhook URL.
 * When WHATSAPP_OPENWA_WEBHOOK_SECRET is set, OpenWA signs the raw body with
 * HMAC-SHA256 and sends the signature in X-OpenWA-Signature: sha256=<hex>.
 *
 * The secret is read from the environment only. It is never logged, never
 * returned by an API response and never included in an error message.
 */
export interface OpenWAWebhookConfig {
  readonly secret: string;
}

/**
 * Reads OpenWA webhook configuration from environment variables.
 * Returns null when the secret is not configured (unsigned webhook mode).
 */
export function loadOpenWAWebhookConfig(): OpenWAWebhookConfig | null {
  const secret = (process.env.WHATSAPP_OPENWA_WEBHOOK_SECRET ?? '').trim();
  if (!secret) return null;
  return { secret };
}

/**
 * Checks whether the OpenWA webhook secret is configured.
 */
export function isOpenWAWebhookConfigured(): boolean {
  return loadOpenWAWebhookConfig() !== null;
}