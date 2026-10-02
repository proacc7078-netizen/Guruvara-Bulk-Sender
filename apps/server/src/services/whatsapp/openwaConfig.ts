/**
 * OpenWA (unofficial WhatsApp integration) configuration.
 *
 * OpenWA is a self-hosted, unofficial WhatsApp API gateway. It is an OPTIONAL
 * provider: the CMS only uses it when WHATSAPP_PROVIDER=openwa is set
 * explicitly. It is never the default and it never replaces the official
 * Meta Cloud API provider.
 *
 * All values are read from the environment only. They are never committed,
 * never logged, never returned by an HTTP response and never included in an
 * error message.
 *
 * Environment variables:
 *   WHATSAPP_OPENWA_BASE_URL    Base URL of the OpenWA instance, without the
 *                               /api prefix (e.g. http://localhost:2785).
 *                               Defaults to the local development instance.
 *   WHATSAPP_OPENWA_API_KEY     OpenWA API key. Required, no default.
 *   WHATSAPP_OPENWA_SESSION_ID  OpenWA session id. Required, no default. The
 *                               session id is environment-specific.
 */

/** Safe default for local development only. */
export const DEFAULT_OPENWA_BASE_URL = 'http://localhost:2785';

/** Global REST prefix of the OpenWA API (all routes live under /api). */
export const OPENWA_API_PREFIX = '/api';

export interface WhatsAppOpenWAConfig {
  readonly provider: 'openwa';
  /** Base URL without the /api prefix, e.g. http://localhost:2785 */
  readonly baseUrl: string;
  /**
   * OpenWA API key. Sent only in the X-API-Key header; never logged, never
   * returned by an API response and never included in an error message.
   */
  readonly apiKey: string;
  /** OpenWA session id (environment-specific). */
  readonly sessionId: string;
}

/**
 * Normalizes a configured base URL: trims whitespace, removes trailing
 * slashes and accepts (but strips) an optional /api suffix so the adapter can
 * always append the documented /api prefix exactly once.
 */
export function normalizeOpenWABaseUrl(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return DEFAULT_OPENWA_BASE_URL;
  return trimmed.replace(/\/+$/, '').replace(/\/api$/i, '').replace(/\/+$/, '');
}

/**
 * OpenWA campaign delivery selection.
 *
 * The Phase 7.2 TEST-ONLY gate (WHATSAPP_OPENWA_CAMPAIGN_SENDING_ENABLED) was
 * removed when the adapter was wired into the campaign execution / queue-worker
 * delivery path: it existed only to keep campaign sending inert while the
 * wiring was being validated, and it made WHATSAPP_PROVIDER=openwa insufficient
 * on its own.
 *
 * Provider selection is now the single switch, and the delivery path resolves
 * its adapter through the existing provider registry:
 *
 *   WHATSAPP_PROVIDER=none      (default) safe UnconfiguredWhatsAppAdapter
 *   WHATSAPP_PROVIDER=official            OfficialWhatsAppAdapter (unchanged)
 *   WHATSAPP_PROVIDER=openwa              OpenWAWhatsAppAdapter (opt-in)
 *
 * An invalid/incomplete OpenWA configuration still fails with the existing
 * WHATSAPP_CONFIGURATION_INVALID pattern and never contacts the OpenWA
 * instance from here.
 */

/**
 * Reads OpenWA configuration from environment variables.
 *
 * Throws WHATSAPP_CONFIGURATION_INVALID (the existing configuration error
 * pattern) when the API key or the session id is missing, so a
 * misconfigured provider is reported instead of being contacted.
 */
export function loadOpenWAConfig(): WhatsAppOpenWAConfig {
  const apiKey = (process.env.WHATSAPP_OPENWA_API_KEY ?? '').trim();
  const sessionId = (process.env.WHATSAPP_OPENWA_SESSION_ID ?? '').trim();

  const missing: string[] = [];
  if (!apiKey) missing.push('WHATSAPP_OPENWA_API_KEY');
  if (!sessionId) missing.push('WHATSAPP_OPENWA_SESSION_ID');

  if (missing.length > 0) {
    throw new Error(
      `WHATSAPP_CONFIGURATION_INVALID: Missing required environment variables: ${missing.join(', ')}`
    );
  }

  return {
    provider: 'openwa',
    baseUrl: normalizeOpenWABaseUrl(process.env.WHATSAPP_OPENWA_BASE_URL),
    apiKey,
    sessionId,
  };
}

/**
 * Type guard: true when an OpenWA provider is configured with the required
 * credentials. Never contacts the OpenWA instance.
 */
export function isOpenWAProviderConfigured(
  config: WhatsAppProviderConfigLike
): config is WhatsAppOpenWAConfig {
  return (
    !!config &&
    config.provider === 'openwa' &&
    !!(config as WhatsAppOpenWAConfig).apiKey &&
    !!(config as WhatsAppOpenWAConfig).sessionId
  );
}

/** Structural input accepted by the type guard (avoids a circular import). */
interface WhatsAppProviderConfigLike {
  readonly provider: string;
}

/**
 * Masks an identifier so diagnostics can confirm *which* value is configured
 * without disclosing it.
 */
export function maskOpenWAIdentifier(value: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) return '****';
  return trimmed.slice(0, 8) + '...';
}

/**
 * Safe, non-secret OpenWA configuration summary for diagnostics and for
 * GET /api/whatsapp/status. Contains no API key and no full session id.
 */
export interface OpenWAConfigSummary {
  readonly provider: 'openwa';
  readonly apiBaseUrl: string;
  readonly apiPrefix: string;
  readonly sessionIdMasked: string;
  readonly sessionIdConfigured: boolean;
  readonly apiKeyConfigured: boolean;
  /** OpenWA is an unofficial WhatsApp integration. */
  readonly unofficial: true;
}

export function summarizeOpenWAConfig(config: WhatsAppOpenWAConfig): OpenWAConfigSummary {
  return {
    provider: 'openwa',
    apiBaseUrl: normalizeOpenWABaseUrl(config.baseUrl),
    apiPrefix: OPENWA_API_PREFIX,
    sessionIdMasked: maskOpenWAIdentifier(config.sessionId),
    sessionIdConfigured: !!config.sessionId,
    apiKeyConfigured: !!config.apiKey,
    unofficial: true,
  };
}
