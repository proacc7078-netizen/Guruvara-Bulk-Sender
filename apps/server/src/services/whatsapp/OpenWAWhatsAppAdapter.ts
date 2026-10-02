import {
  WhatsAppAdapter,
  ConnectionStatus,
  SendResult,
  MediaPayload,
  MessageStatus,
  WhatsAppVerificationResult,
} from './types';
import {
  OPENWA_API_PREFIX,
  normalizeOpenWABaseUrl,
  summarizeOpenWAConfig,
  type OpenWAConfigSummary,
  type WhatsAppOpenWAConfig,
} from './openwaConfig';
import { WhatsAppConfigurationError, WhatsAppProviderNotConfiguredError } from './errors';
import { normalizePhoneNumber } from '../../utils/phone.util';

/**
 * Minimal fetch-compatible type for OpenWA REST calls.
 * Global fetch is used by default; tests inject a mock.
 */
export type OpenWAFetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const VERIFY_TIMEOUT_MS = 10000;
const SEND_TIMEOUT_MS = 15000;

/** OpenWA documents a 4096-character limit for a single text body. */
const MAX_TEXT_LENGTH = 4096;

/** Conservative caption guard for an image message. */
const MAX_CAPTION_LENGTH = 1024;

/** Placeholder used when sanitizing provider output. */
const REDACTED = '[redacted]';

/** A healthy OpenWA session reports this status. */
const READY_SESSION_STATUS = 'ready';

/**
 * Phase 7.1 — OpenWA adapter (UNOFFICIAL WhatsApp integration).
 *
 * OpenWA is a self-hosted WhatsApp API gateway. This adapter implements the
 * provider-independent WhatsAppAdapter interface on top of the documented
 * OpenWA REST API:
 *
 *   GET  {baseUrl}/api/sessions/{sessionId}                        (verification)
 *   POST {baseUrl}/api/sessions/{sessionId}/messages/send-text     { chatId, text }
 *   POST {baseUrl}/api/sessions/{sessionId}/messages/send-image    { chatId, url, caption }
 *
 * Authentication is header-only: the API key travels in the X-API-Key header.
 * It is never logged, never placed in a URL, never returned and never included
 * in an error message.
 *
 * SCOPE (wired into campaign delivery):
 * - Reachable from campaign execution and the queue worker: those obtain their
 *   adapter from the existing provider registry, which resolves this adapter
 *   whenever WHATSAPP_PROVIDER=openwa is configured with a key and a session.
 *   The delivery path itself stays provider-independent (no OpenWA-specific
 *   branch). Batching, the scheduler and retries are untouched by this adapter.
 * - Media is never uploaded from local storage: OpenWA fetches a URL itself,
 *   so a local-only storagePath is rejected explicitly.
 * - Delivery-status reconciliation is handled by the OpenWA webhook endpoint.
 */
export class OpenWAWhatsAppAdapter implements WhatsAppAdapter {
  private readonly config: WhatsAppOpenWAConfig;
  private connectionState: ConnectionStatus = 'DISCONNECTED';
  private readonly fetchImpl: OpenWAFetchFn;

  constructor(config: WhatsAppOpenWAConfig, fetchImpl?: OpenWAFetchFn) {
    this.config = config;
    this.fetchImpl = fetchImpl ?? (globalThis.fetch as unknown as OpenWAFetchFn);
  }

  /**
   * Local-only connection state. Live reachability is reported by
   * verifyConnection() / GET /api/whatsapp/status.
   */
  async getStatus(): Promise<ConnectionStatus> {
    return this.connectionState;
  }

  /**
   * Validates the configuration locally. No network I/O: the OpenWA session
   * lifecycle is owned by the OpenWA instance, so connecting here would be a
   * no-op. Use verifyConnection() for the explicit live non-message check.
   */
  async connect(): Promise<void> {
    if (this.connectionState === 'CONNECTED') {
      return;
    }

    this.connectionState = 'CONNECTING';

    if (!this.config.apiKey || !this.config.sessionId) {
      this.connectionState = 'DISCONNECTED';
      throw new WhatsAppConfigurationError(
        'OpenWA provider configuration is incomplete. Cannot connect.'
      );
    }

    this.connectionState = 'DISCONNECTED';
  }

  /**
   * Safe non-message connection verification.
   *
   * Reads the configured session (GET /api/sessions/{sessionId}) and reports a
   * healthy connection only when the API reports status = ready with no
   * connection error. Never sends a message and never touches the message
   * endpoints.
   */
  async verifyConnection(): Promise<WhatsAppVerificationResult> {
    if (!this.config.apiKey || !this.config.sessionId) {
      return {
        verified: false,
        reason: 'CONFIG_INVALID',
        message: 'OpenWA provider configuration is incomplete.',
      };
    }
    if (typeof this.fetchImpl !== 'function') {
      return {
        verified: false,
        reason: 'NETWORK_ERROR',
        message: 'Verification transport unavailable.',
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
    try {
      // The API key is passed straight to fetch; never logged or returned.
      const headers: Record<string, string> = {};
      headers['X-API-Key'] = this.config.apiKey;
      const response = await this.fetchImpl(this.sessionUrl(), {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      if (response.ok) {
        const body = await readJsonSafe(response);
        const session = extractSessionState(body);
        if (session.status === READY_SESSION_STATUS && !session.lastError) {
          this.connectionState = 'CONNECTED';
          return {
            verified: true,
            reason: 'VERIFIED',
            message: 'OpenWA session is ready.',
            httpStatus: response.status,
            providerStatus: session.status,
            phoneNumber: {
              displayPhoneNumber: session.phoneNumber,
              verifiedName: session.pushName,
            },
          };
        }
        this.connectionState = 'DISCONNECTED';
        const detail = session.lastError
          ? ' Reported reason: ' + this.redact(session.lastError).slice(0, 200)
          : '';
        return {
          verified: false,
          reason: 'API_ERROR',
          message: session.status
            ? 'OpenWA session is not ready (status: ' + session.status + ').' + detail
            : 'OpenWA session status could not be determined.' + detail,
          httpStatus: response.status,
          providerStatus: session.status || undefined,
        };
      }

      this.connectionState = 'DISCONNECTED';
      if (response.status === 401 || response.status === 403) {
        return {
          verified: false,
          reason: 'AUTH_FAILED',
          message: 'OpenWA rejected the configured API key (unauthorized).',
          httpStatus: response.status,
        };
      }
      if (response.status === 404) {
        return {
          verified: false,
          reason: 'API_ERROR',
          message: 'OpenWA session was not found for the configured session id.',
          httpStatus: response.status,
        };
      }
      return {
        verified: false,
        reason: 'API_ERROR',
        message: 'OpenWA session verification failed with status ' + response.status + '.',
        httpStatus: response.status,
      };
    } catch (error) {
      this.connectionState = 'DISCONNECTED';
      if (error instanceof Error && /abort/i.test(error.message)) {
        return {
          verified: false,
          reason: 'NETWORK_ERROR',
          message: 'OpenWA session verification timed out.',
        };
      }
      return {
        verified: false,
        reason: 'NETWORK_ERROR',
        message: 'Could not reach the OpenWA API (network error).',
      };
    } finally {
      clearTimeout(timer);
    }
  }


  /**
   * Drops the local connection state. Safe to call multiple times.
   * The OpenWA session itself is managed by the OpenWA instance.
   */
  async disconnect(): Promise<void> {
    this.connectionState = 'DISCONNECTED';
  }

  /**
   * Sends ONE text message through the configured OpenWA session.
   *
   * POST {baseUrl}/api/sessions/{sessionId}/messages/send-text
   *   { chatId: '<digits>@c.us', text: '<body>' }
   *
   * The recipient is normalized into the chat-id (JID) format OpenWA expects:
   * digits only, full international number, no plus sign. An input that is
   * already a JID is passed through unchanged.
   *
   * Used by the campaign execution / queue-worker delivery path whenever
   * WHATSAPP_PROVIDER=openwa is configured (see executionDelivery.service.ts).
   */
  async sendText(recipient: string, message: string): Promise<SendResult> {
    const chatId = buildOpenWAChatId(recipient);
    if (!chatId) {
      return invalidConfiguration('Recipient phone number is required.');
    }
    const text = (message ?? '').trim();
    if (!text) {
      return invalidConfiguration('Message body is required.');
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return invalidConfiguration('Message body exceeds maximum length.');
    }
    if (!this.hasRequiredConfig()) {
      return invalidConfiguration('OpenWA provider configuration is incomplete.');
    }
    if (typeof this.fetchImpl !== 'function') {
      return providerUnavailable('WhatsApp send transport is unavailable.');
    }

    return this.postToSession('/messages/send-text', { chatId, text });
  }

  /**
   * Sends ONE image message through the configured OpenWA session.
   *
   * POST {baseUrl}/api/sessions/{sessionId}/messages/send-image
   *   { chatId, url, caption? }
   *
   * OpenWA fetches the URL itself, so the media must be reachable FROM the
   * OpenWA instance. A local-only storagePath is therefore rejected instead of
   * being uploaded or guessed, and local storage is never made public to
   * satisfy this endpoint. Only the documented body fields are sent — OpenWA
   * rejects unknown body fields with 400.
   *
   * Used by the campaign execution / queue-worker delivery path whenever
   * WHATSAPP_PROVIDER=openwa is configured, provided the media payload carries
   * an externally reachable HTTP(S) URL (see executionDelivery.service.ts).
   */
  async sendMedia(
    recipient: string,
    media: MediaPayload,
    caption?: string
  ): Promise<SendResult> {
    const chatId = buildOpenWAChatId(recipient);
    if (!chatId) {
      return invalidConfiguration('Recipient phone number is required.');
    }
    const trimmedCaption = (caption ?? '').trim();
    if (trimmedCaption.length > MAX_CAPTION_LENGTH) {
      return invalidConfiguration('Caption exceeds maximum length.');
    }
    if (!this.hasRequiredConfig()) {
      return invalidConfiguration('OpenWA provider configuration is incomplete.');
    }

    const mediaUrl = resolveOpenWAMediaUrl(media);
    if (!mediaUrl.ok) {
      return invalidConfiguration(mediaUrl.reason);
    }
    if (typeof this.fetchImpl !== 'function') {
      return providerUnavailable('WhatsApp send transport is unavailable.');
    }

    const payload: { chatId: string; url: string; caption?: string } = {
      chatId,
      url: mediaUrl.url,
    };
    if (trimmedCaption) {
      payload.caption = trimmedCaption;
    }

    return this.postToSession('/messages/send-image', payload);
  }

  /**
   * Message status lookup is out of scope for this foundation phase: history
   * based status reconciliation is not wired up yet.
   */
  async getMessageStatus(providerMessageId: string): Promise<MessageStatus> {
    throw new WhatsAppProviderNotConfiguredError(
      'OpenWA provider getMessageStatus() is not implemented. Message status tracking is out of scope.'
    );
  }

  /**
   * Returns the provider configuration summary (without sensitive data).
   */
  getConfigSummary(): Readonly<OpenWAConfigSummary> {
    return summarizeOpenWAConfig(this.config);
  }


  /* ------------------------------------------------------------------ *
   * internals
   * ------------------------------------------------------------------ */

  private hasRequiredConfig(): boolean {
    return !!this.config.apiKey && !!this.config.sessionId;
  }

  private apiBase(): string {
    return normalizeOpenWABaseUrl(this.config.baseUrl) + OPENWA_API_PREFIX;
  }

  private sessionUrl(): string {
    return this.apiBase() + '/sessions/' + encodeURIComponent(this.config.sessionId);
  }

  /**
   * POSTs a documented message payload to the configured session.
   * Shared by sendText/sendMedia so both use the same error mapping.
   */
  private async postToSession(
    path: string,
    payload: Record<string, unknown>
  ): Promise<SendResult> {
    const url = this.sessionUrl() + path;
    const body = JSON.stringify(payload);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      // The API key travels only in the X-API-Key header: never logged, never
      // returned, never placed in a URL or an error message.
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      headers['X-API-Key'] = this.config.apiKey;
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      if (response.ok) {
        const parsed = await readJsonSafe(response);
        const providerMessageId = extractOpenWAMessageId(parsed);
        this.connectionState = 'CONNECTED';
        return { success: true, providerMessageId };
      }

      this.connectionState = 'DISCONNECTED';
      const errorBody = await readJsonSafe(response);
      const metaError = this.extractError(errorBody, response.status);

      if (response.status === 401 || response.status === 403) {
        return {
          success: false,
          errorCode: 'WHATSAPP_PROVIDER_UNAVAILABLE',
          errorMessage: 'OpenWA rejected the configured API key (unauthorized).',
          metaError,
        };
      }
      if (response.status === 409) {
        return {
          success: false,
          errorCode: 'WHATSAPP_PROVIDER_UNAVAILABLE',
          errorMessage: 'OpenWA session is not ready to send messages.',
          metaError,
        };
      }
      if (response.status === 429) {
        return {
          success: false,
          errorCode: 'WHATSAPP_PROVIDER_UNAVAILABLE',
          errorMessage: 'OpenWA rate-limited the request.',
          metaError,
        };
      }
      return {
        success: false,
        errorCode: 'WHATSAPP_SEND_FAILED',
        errorMessage: 'OpenWA API send failed with status ' + response.status + '.',
        metaError,
      };
    } catch (error) {
      this.connectionState = 'DISCONNECTED';
      if (error instanceof Error && /abort/i.test(error.message)) {
        return providerUnavailable('OpenWA API send timed out.');
      }
      return providerUnavailable('Could not reach the OpenWA API (network error).');
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Sanitized provider error details. Only the HTTP status and OpenWA's own
   * message/error/statusCode fields are used, and the API key is redacted even
   * if the provider echoes it back.
   */
  private extractError(parsed: unknown, httpStatus: number): SendResult['metaError'] {
    const metaError: {
      code?: number | string;
      type?: string;
      message?: string;
      httpStatus: number;
    } = { httpStatus };

    if (!parsed || typeof parsed !== 'object') return metaError;
    const record = parsed as { statusCode?: unknown; message?: unknown; error?: unknown };

    if (typeof record.statusCode === 'number' || typeof record.statusCode === 'string') {
      metaError.code = record.statusCode;
    }
    if (typeof record.error === 'string') {
      metaError.type = this.redact(record.error).slice(0, 200);
    }
    const rawMessage = Array.isArray(record.message)
      ? record.message.filter((part): part is string => typeof part === 'string').join('; ')
      : typeof record.message === 'string'
        ? record.message
        : '';
    if (rawMessage) {
      metaError.message = this.redact(rawMessage).slice(0, 300);
    }
    return metaError;
  }

  /** Removes the configured API key from any text kept for diagnostics. */
  private redact(text: string): string {
    const value = text ?? '';
    if (!this.config.apiKey || !value.includes(this.config.apiKey)) {
      return value;
    }
    return value.split(this.config.apiKey).join(REDACTED);
  }
}


/* -------------------------------------------------------------------- *
 * helpers (exported for tests)
 * -------------------------------------------------------------------- */

/**
 * Converts a CMS recipient phone number into the chat id (JID) format OpenWA
 * expects: `<digits>@c.us` — digits only, no plus sign. The CMS phone
 * normalization is reused so the same number always maps to the same chat id.
 * An input that is already a JID (contains '@') is passed through unchanged.
 */
export function buildOpenWAChatId(recipient: string): string {
  const raw = (recipient ?? '').trim();
  if (!raw) return '';
  if (raw.includes('@')) return raw;
  const digits = normalizePhoneNumber(raw);
  return digits ? digits + '@c.us' : '';
}

/**
 * Resolves the media URL for an OpenWA image send.
 *
 * Requirement: the OpenWA send-image endpoint takes a URL that the OpenWA
 * instance fetches itself. The CMS stores media locally, and local storage must
 * not be made publicly reachable to satisfy a provider, so:
 * - an explicit, externally reachable absolute http(s) URL is accepted;
 * - a local-only storagePath (no URL), a non-http(s) scheme, or a loopback URL
 *   is rejected with a sanitized configuration error.
 */
export function resolveOpenWAMediaUrl(
  media: MediaPayload | undefined
): { ok: true; url: string } | { ok: false; reason: string } {
  const raw = (media?.url ?? '').trim();
  if (!raw) {
    return {
      ok: false,
      reason:
        'OpenWA image sending requires an externally reachable media URL; the local media path is not reachable by the OpenWA instance.',
    };
  }
  if (!/^https?:\/\//i.test(raw)) {
    return {
      ok: false,
      reason: 'OpenWA image sending supports absolute http(s) media URLs only.',
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      ok: false,
      reason: 'OpenWA image sending supports absolute http(s) media URLs only.',
    };
  }
  if (isLoopbackHostname(parsed.hostname)) {
    return {
      ok: false,
      reason:
        'OpenWA image sending requires an externally reachable media URL; local-only URLs are not supported.',
    };
  }
  return { ok: true, url: raw };
}

function isLoopbackHostname(hostname: string): boolean {
  const host = (hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\./.test(host) ||
    /^localhost\./.test(host)
  );
}

/** Reads a JSON body, tolerating an empty or malformed response. */
async function readJsonSafe(response: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Extracts the WhatsApp message id from an OpenWA send response.
 * The documented shape is { messageId, timestamp }; a couple of plausible
 * aliases are accepted defensively so a successful send is never reported as
 * missing an id. Returns undefined when absent.
 */
function extractOpenWAMessageId(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const record = parsed as Record<string, unknown>;

  if (typeof record.messageId === 'string' && record.messageId) return record.messageId;
  if (typeof record.id === 'string' && record.id) return record.id;

  const message = record.message;
  if (message && typeof message === 'object') {
    const messageId = (message as Record<string, unknown>).id;
    if (typeof messageId === 'string' && messageId) return messageId;
  }

  const key = record.key;
  if (key && typeof key === 'object') {
    const keyId = (key as Record<string, unknown>).id;
    if (typeof keyId === 'string' && keyId) return keyId;
  }

  return undefined;
}

interface OpenWASessionState {
  status: string;
  lastError: string;
  phoneNumber?: string;
  pushName?: string;
}

/**
 * Extracts the connection state from a GET /api/sessions/{sessionId} response.
 * OpenWA reports a lowercase `status` (ready, qr_ready, initializing,
 * authenticating, action_required, disconnected, failed, created) and an
 * optional human-readable `lastError`.
 */
function extractSessionState(parsed: unknown): OpenWASessionState {
  const record = (parsed ?? {}) as Record<string, unknown>;
  const status = typeof record.status === 'string' ? record.status.trim().toLowerCase() : '';

  const candidateError = record.lastError ?? record.errorMessage;
  const lastError =
    typeof candidateError === 'string' && candidateError.trim() ? candidateError.trim() : '';

  const phoneNumber = typeof record.phoneNumber === 'string' ? record.phoneNumber : undefined;
  const pushName = typeof record.pushName === 'string' ? record.pushName : undefined;

  return { status, lastError, phoneNumber, pushName };
}

function invalidConfiguration(message: string): SendResult {
  return { success: false, errorCode: 'WHATSAPP_CONFIGURATION_INVALID', errorMessage: message };
}

function providerUnavailable(message: string): SendResult {
  return { success: false, errorCode: 'WHATSAPP_PROVIDER_UNAVAILABLE', errorMessage: message };
}

