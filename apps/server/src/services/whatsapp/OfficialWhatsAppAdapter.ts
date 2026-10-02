import {
  WhatsAppAdapter,
  ConnectionStatus,
  SendResult,
  MediaPayload,
  MessageStatus,
  WhatsAppVerificationResult,
} from './types';
import { WhatsAppOfficialConfig } from './config';
import { WhatsAppProviderNotConfiguredError, WhatsAppConfigurationError } from './errors';
import { promises as fsp } from 'fs';

/**
 * Minimal fetch-compatible type for Meta Graph API calls.
 * Global fetch is used by default; tests inject a mock.
 */
export type VerificationFetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string | FormData; signal?: AbortSignal }
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const VERIFY_TIMEOUT_MS = 10000;
const SEND_TIMEOUT_MS = 15000;

/**
 * Phase 6.0C — maximum caption length for an image message.
 * Meta limits image captions to 1024 characters.
 */
const MAX_CAPTION_LENGTH = 1024;

/**
 * Maximum text length accepted for a single Phase 5.3 test send.
 * Meta allows longer, but a conservative guard keeps the test endpoint safe.
 */
const MAX_TEXT_LENGTH = 4096;

/** Adapter-level text-send validation errors use this code. */
const TEXT_VALIDATION_ERROR_CODE = 'WHATSAPP_CONFIGURATION_INVALID';

/**
 * Extracts sanitized, non-secret Meta error details from a Graph API error
 * body. Meta error shape: { error: { code, type, message, ... } }.
 * Only code/type/message plus the HTTP status are returned — never tokens,
 * Authorization headers, or request credentials.
 */
function extractMetaError(parsed: unknown, httpStatus: number): SendResult['metaError'] {
  if (!parsed || typeof parsed !== 'object') return { httpStatus };
  const err = (parsed as { error?: unknown }).error;
  if (!err || typeof err !== 'object') return { httpStatus };
  const e = err as { code?: unknown; type?: unknown; message?: unknown };
  return {
    code: typeof e.code === 'number' || typeof e.code === 'string' ? e.code : undefined,
    type: typeof e.type === 'string' ? e.type : undefined,
    message: typeof e.message === 'string' ? e.message : undefined,
    httpStatus,
  };
}

/**
 * Extracts Meta's message id from a successful send response.
 * Expected shape: { messages: [{ id: 'wamid...' }] }.
 * Returns undefined when absent so SendResult stays sanitized.
 */
function extractProviderMessageId(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  const first = messages[0] as { id?: unknown };
  return typeof first?.id === 'string' ? first.id : undefined;
}

/**
 * Phase 6.0C — extracts Meta's media ID from a successful media upload.
 * Expected shape: { id: '<media-id>' }. Returns undefined when absent.
 */
function extractMediaId(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const id = (parsed as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * Phase 5.2B — Official WhatsApp Cloud API Adapter.
 *
 * Phase 5.2B: verifyConnection() — CONNECTION VERIFICATION ONLY.
 * Phase 5.3: sendText() — single text send to a test number ONLY.
 *
 * verifyConnection() performs ONE non-message Graph API read:
 *   GET {apiBaseUrl}/{apiVersion}/{phoneNumberId}?fields=id,display_phone_number,verified_name
 * sendText() performs ONE message send:
 *   POST {apiBaseUrl}/{apiVersion}/{phoneNumberId}/messages
 * Both use `Authorization: Bearer <accessToken>` with the version taken from
 * config (WHATSAPP_API_VERSION), never hard-coded.
 * No tokens / Authorization headers / secrets are logged or returned.
 */
export class OfficialWhatsAppAdapter implements WhatsAppAdapter {
  private readonly config: WhatsAppOfficialConfig;
  private connectionState: ConnectionStatus = 'DISCONNECTED';
  private readonly fetchImpl: VerificationFetchFn;

  constructor(config: WhatsAppOfficialConfig, fetchImpl?: VerificationFetchFn) {
    this.config = config;
    this.fetchImpl = fetchImpl ?? (globalThis.fetch as unknown as VerificationFetchFn);
  }

  /**
   * Returns the current connection status.
   * Local-only state; live reachability is reported via
   * verifyConnection() / GET /api/whatsapp/status verification payload.
   */
  async getStatus(): Promise<ConnectionStatus> {
    return this.connectionState;
  }

  /**
   * Initiates connection to WhatsApp Cloud API.
   * In Phase 5.2B, this only validates configuration locally and stays
   * DISCONNECTED (no implicit network I/O at startup).
   * Use verifyConnection() for an explicit live non-message check.
   */
  async connect(): Promise<void> {
    if (this.connectionState === 'CONNECTED') {
      return;
    }

    this.connectionState = 'CONNECTING';

    // In Phase 5.2B, we only validate that config is present.
    // Explicit Meta connectivity check lives in verifyConnection().
    if (!this.config.accessToken || !this.config.phoneNumberId) {
      this.connectionState = 'DISCONNECTED';
      throw new WhatsAppConfigurationError(
        'Official WhatsApp provider configuration is incomplete. Cannot connect.'
      );
    }

    // Configuration is valid. We intentionally stay DISCONNECTED here
    // to avoid external API calls during startup.
    this.connectionState = 'DISCONNECTED';
  }

  /**
   * Phase 5.2B — safe non-message connection verification.
   *
   * Proves the configured credentials can access the configured WhatsApp
   * account by reading phone-number metadata. Never sends a message and
   * never touches the /messages endpoint.
   */
  async verifyConnection(): Promise<WhatsAppVerificationResult> {
    if (!this.config.accessToken || !this.config.phoneNumberId || !this.config.businessAccountId) {
      return {
        verified: false,
        reason: 'CONFIG_INVALID',
        message: 'Official WhatsApp provider configuration is incomplete.',
      };
    }
    if (typeof this.fetchImpl !== 'function') {
      return { verified: false, reason: 'NETWORK_ERROR', message: 'Verification transport unavailable.' };
    }
    const base = (this.config.apiBaseUrl || 'https://graph.facebook.com').replace(/\/+$/, '');
    const version = (this.config.apiVersion || 'v20.0').replace(/^\/+/, '');
    const url =
      base + '/' + version + '/' + encodeURIComponent(this.config.phoneNumberId) +
      '?fields=' + encodeURIComponent('id,display_phone_number,verified_name');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
    try {
      // Token is passed straight to fetch; never logged or returned.
      const headers: Record<string, string> = {};
      headers['Authorization'] = ['Bearer', this.config.accessToken].join(' ');
      const response = await this.fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
      if (response.ok) {
        let body: unknown = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        const record = (body ?? {}) as Record<string, unknown>;
        const id = typeof record['id'] === 'string' ? (record['id'] as string) : undefined;
        const displayPhoneNumber =
          typeof record['display_phone_number'] === 'string' ? (record['display_phone_number'] as string) : undefined;
        const verifiedName =
          typeof record['verified_name'] === 'string' ? (record['verified_name'] as string) : undefined;
        this.connectionState = 'CONNECTED';
        return {
          verified: true,
          reason: 'VERIFIED',
          message: 'Meta API access verified.',
          httpStatus: response.status,
          phoneNumber: { id, displayPhoneNumber, verifiedName },
        };
      }
      this.connectionState = 'DISCONNECTED';
      if (response.status === 401 || response.status === 403) {
        return {
          verified: false,
          reason: 'AUTH_FAILED',
          message: 'Meta rejected the configured credentials (unauthorized).',
          httpStatus: response.status,
        };
      }
      return {
        verified: false,
        reason: 'API_ERROR',
        message: 'Meta API verification failed with status ' + response.status + '.',
        httpStatus: response.status,
      };
    } catch (error) {
      this.connectionState = 'DISCONNECTED';
      if (error instanceof Error && /abort/i.test(error.message)) {
        return { verified: false, reason: 'NETWORK_ERROR', message: 'Meta API verification timed out.' };
      }
      return { verified: false, reason: 'NETWORK_ERROR', message: 'Could not reach the Meta API (network error).' };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Disconnects from WhatsApp Cloud API.
   * Safe to call multiple times.
   */
  async disconnect(): Promise<void> {
    this.connectionState = 'DISCONNECTED';
  }

  /**
   * Sends a single text message via Meta Cloud API.
   *
   * PHASE 5.3 — TEST NUMBER ONLY. No bulk, no campaigns, no scheduling,
   * no queues/workers/retries, no media.
   *
   * POST {apiBaseUrl}/{apiVersion}/{phoneNumberId}/messages with:
   *   { messaging_product: 'whatsapp', to, type: 'text', text: { body } }
   * Returns the existing SendResult abstraction with sanitized errors only.
   */
  async sendText(recipient: string, message: string): Promise<SendResult> {
    const to = (recipient ?? '').trim();
    const body = (message ?? '').trim();
    if (!to) {
      return {
        success: false,
        errorCode: 'WHATSAPP_CONFIGURATION_INVALID',
        errorMessage: 'Recipient phone number is required.',
      };
    }
    if (!body) {
      return {
        success: false,
        errorCode: 'WHATSAPP_CONFIGURATION_INVALID',
        errorMessage: 'Message body is required.',
      };
    }
    if (body.length > MAX_TEXT_LENGTH) {
      return {
        success: false,
        errorCode: 'WHATSAPP_CONFIGURATION_INVALID',
        errorMessage: 'Message body exceeds maximum length.',
      };
    }
    if (!this.config.accessToken || !this.config.phoneNumberId || !this.config.businessAccountId) {
      return {
        success: false,
        errorCode: 'WHATSAPP_CONFIGURATION_INVALID',
        errorMessage: 'Official WhatsApp provider configuration is incomplete.',
      };
    }
    if (typeof this.fetchImpl !== 'function') {
      return {
        success: false,
        errorCode: 'WHATSAPP_PROVIDER_UNAVAILABLE',
        errorMessage: 'WhatsApp send transport is unavailable.',
      };
    }

    const base = (this.config.apiBaseUrl || 'https://graph.facebook.com').replace(/\/+$/, '');
    const version = (this.config.apiVersion || 'v20.0').replace(/^\/+/, '');
    const url =
      base + '/' + version + '/' + encodeURIComponent(this.config.phoneNumberId) + '/messages';
    const payload = JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      // Token is passed straight to fetch; never logged or returned.
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      headers['Authorization'] = ['Bearer', this.config.accessToken].join(' ');
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: payload,
        signal: controller.signal,
      });

      if (response.ok) {
        let parsed: unknown = null;
        try {
          parsed = await response.json();
        } catch {
          parsed = null;
        }
        const providerMessageId = extractProviderMessageId(parsed);
        this.connectionState = 'CONNECTED';
        return { success: true, providerMessageId };
      }

      this.connectionState = 'DISCONNECTED';
      // Parse Meta error body once for sanitized diagnostics (Phase 5.3).
      let errorBody: unknown = null;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = null;
      }
      const metaError = extractMetaError(errorBody, response.status);
      if (response.status === 401 || response.status === 403) {
        return {
          success: false,
          errorCode: 'WHATSAPP_PROVIDER_UNAVAILABLE',
          errorMessage: 'Meta rejected the configured credentials (unauthorized).',
          metaError,
        };
      }
      return {
        success: false,
        errorCode: 'WHATSAPP_SEND_FAILED',
        errorMessage: 'Meta API text send failed with status ' + response.status + '.',
        metaError,
      };
    } catch (error) {
      this.connectionState = 'DISCONNECTED';
      if (error instanceof Error && /abort/i.test(error.message)) {
        return {
          success: false,
          errorCode: 'WHATSAPP_PROVIDER_UNAVAILABLE',
          errorMessage: 'Meta API text send timed out.',
        };
      }
      return {
        success: false,
        errorCode: 'WHATSAPP_PROVIDER_UNAVAILABLE',
        errorMessage: 'Could not reach the Meta API (network error).',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Phase 6.0C — uploads a local media file to Meta's media endpoint.
   * POST {apiBaseUrl}/{apiVersion}/{phoneNumberId}/media (multipart/form-data)
   * with messaging_product, type (mime), and the binary file.
   * Response: { id: '<media-id>' }.
   *
   * Local file paths cannot be passed to the Cloud API, so this upload step is
   * REQUIRED before any image message send. Reuses sendText()'s sanitized
   * error mapping — no second error system. The access token travels only in
   * the Authorization header; never logged or returned.
   */
  private async uploadMedia(
    filePath: string,
    mimeType: string
  ): Promise<{ ok: true; mediaId: string } | { ok: false; result: SendResult }> {
    if (!this.config.accessToken || !this.config.phoneNumberId || !this.config.businessAccountId) {
      return {
        ok: false,
        result: {
          success: false,
          errorCode: 'WHATSAPP_CONFIGURATION_INVALID',
          errorMessage: 'Official WhatsApp provider configuration is incomplete.',
        },
      };
    }
    if (typeof this.fetchImpl !== 'function') {
      return {
        ok: false,
        result: {
          success: false,
          errorCode: 'WHATSAPP_PROVIDER_UNAVAILABLE',
          errorMessage: 'WhatsApp send transport is unavailable.',
        },
      };
    }
    let fileBytes: Buffer;
    try {
      fileBytes = await fsp.readFile(filePath);
    } catch {
      return {
        ok: false,
        result: {
          success: false,
          errorCode: 'WHATSAPP_CONFIGURATION_INVALID',
          errorMessage: 'Media file could not be read from local storage.',
        },
      };
    }
    const base = (this.config.apiBaseUrl || 'https://graph.facebook.com').replace(/\/+$/, '');
    const version = (this.config.apiVersion || 'v20.0').replace(/^\/+/, '');
    const url = base + '/' + version + '/' + encodeURIComponent(this.config.phoneNumberId) + '/media';
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append('file', new Blob([new Uint8Array(fileBytes)], { type: mimeType }));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      // Token is passed straight to fetch; never logged or returned.
      const headers: Record<string, string> = {};
      headers['Authorization'] = ['Bearer', this.config.accessToken].join(' ');
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: form,
        signal: controller.signal,
      });
      if (response.ok) {
        let parsed: unknown = null;
        try {
          parsed = await response.json();
        } catch {
          parsed = null;
        }
        const mediaId = extractMediaId(parsed);
        if (!mediaId) {
          return {
            ok: false,
            result: {
              success: false,
              errorCode: 'WHATSAPP_SEND_FAILED',
              errorMessage: 'Meta media upload returned an unexpected response.',
              metaError: extractMetaError(parsed, response.status),
            },
          };
        }
        return { ok: true, mediaId };
      }
      let errorBody: unknown = null;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = null;
      }
      const metaError = extractMetaError(errorBody, response.status);
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          result: {
            success: false,
            errorCode: 'WHATSAPP_PROVIDER_UNAVAILABLE',
            errorMessage: 'Meta rejected the configured credentials (unauthorized).',
            metaError,
          },
        };
      }
      return {
        ok: false,
        result: {
          success: false,
          errorCode: 'WHATSAPP_SEND_FAILED',
          errorMessage: 'Meta media upload failed with status ' + response.status + '.',
          metaError,
        },
      };
    } catch (error) {
      if (error instanceof Error && /abort/i.test(error.message)) {
        return {
          ok: false,
          result: {
            success: false,
            errorCode: 'WHATSAPP_PROVIDER_UNAVAILABLE',
            errorMessage: 'Meta media upload timed out.',
          },
        };
      }
      return {
        ok: false,
        result: {
          success: false,
          errorCode: 'WHATSAPP_PROVIDER_UNAVAILABLE',
          errorMessage: 'Could not reach the Meta API (network error).',
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Sends a media message via WhatsApp Cloud API.
   *
   * Phase 6.0C — IMAGE + optional CAPTION only.
   *   1. uploadMedia() → Meta media ID (local paths cannot be sent directly).
   *   2. POST {phoneNumberId}/messages:
   *      { messaging_product:'whatsapp', to, type:'image', image:{ id, caption? } }
   * Caption: existing message body passed through when present; never invented.
   * Reuses the Phase 5.3 error classification and sanitized metaError.
   */
  async sendMedia(
    recipient: string,
    media: MediaPayload,
    caption?: string
  ): Promise<SendResult> {
    const to = (recipient ?? '').trim();
    if (!to) {
      return {
        success: false,
        errorCode: 'WHATSAPP_CONFIGURATION_INVALID',
        errorMessage: 'Recipient phone number is required.',
      };
    }
    const trimmedCaption = (caption ?? '').trim();
    if (trimmedCaption.length > MAX_CAPTION_LENGTH) {
      return {
        success: false,
        errorCode: 'WHATSAPP_CONFIGURATION_INVALID',
        errorMessage: 'Caption exceeds maximum length.',
      };
    }
    if (!media || !media.path || !media.path.trim()) {
      return {
        success: false,
        errorCode: 'WHATSAPP_CONFIGURATION_INVALID',
        errorMessage: 'Media file path is required.',
      };
    }
    // Step 1 — resolve the Meta media ID. A pre-uploaded ID is used as-is;
    // otherwise the local file must be uploaded first (Cloud API requirement).
    let mediaId: string;
    if (media.metaMediaId && media.metaMediaId.trim()) {
      mediaId = media.metaMediaId.trim();
    } else {
      const upload = await this.uploadMedia(media.path.trim(), media.mimeType || 'application/octet-stream');
      if (!upload.ok) {
        return upload.result;
      }
      mediaId = upload.mediaId;
    }
    // Step 2 — send the image message referencing the uploaded media ID.
    const base = (this.config.apiBaseUrl || 'https://graph.facebook.com').replace(/\/+$/, '');
    const version = (this.config.apiVersion || 'v20.0').replace(/^\/+/, '');
    const url = base + '/' + version + '/' + encodeURIComponent(this.config.phoneNumberId) + '/messages';
    const imageField: { id: string; caption?: string } = { id: mediaId };
    if (trimmedCaption) {
      imageField.caption = trimmedCaption;
    }
    const payload = JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: imageField,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      // Token is passed straight to fetch; never logged or returned.
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      headers['Authorization'] = ['Bearer', this.config.accessToken].join(' ');
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: payload,
        signal: controller.signal,
      });
      if (response.ok) {
        let parsed: unknown = null;
        try {
          parsed = await response.json();
        } catch {
          parsed = null;
        }
        const providerMessageId = extractProviderMessageId(parsed);
        this.connectionState = 'CONNECTED';
        return { success: true, providerMessageId };
      }
      this.connectionState = 'DISCONNECTED';
      let errorBody: unknown = null;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = null;
      }
      const metaError = extractMetaError(errorBody, response.status);
      if (response.status === 401 || response.status === 403) {
        return {
          success: false,
          errorCode: 'WHATSAPP_PROVIDER_UNAVAILABLE',
          errorMessage: 'Meta rejected the configured credentials (unauthorized).',
          metaError,
        };
      }
      return {
        success: false,
        errorCode: 'WHATSAPP_SEND_FAILED',
        errorMessage: 'Meta API image send failed with status ' + response.status + '.',
        metaError,
      };
    } catch (error) {
      this.connectionState = 'DISCONNECTED';
      if (error instanceof Error && /abort/i.test(error.message)) {
        return {
          success: false,
          errorCode: 'WHATSAPP_PROVIDER_UNAVAILABLE',
          errorMessage: 'Meta API image send timed out.',
        };
      }
      return {
        success: false,
        errorCode: 'WHATSAPP_PROVIDER_UNAVAILABLE',
        errorMessage: 'Could not reach the Meta API (network error).',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Gets the delivery status of a message from WhatsApp Cloud API.
   *
   * NOT IMPLEMENTED in this phase.
   */
  async getMessageStatus(providerMessageId: string): Promise<MessageStatus> {
    throw new WhatsAppProviderNotConfiguredError(
      'Official WhatsApp provider getMessageStatus() is not implemented. Message status tracking is out of scope.'
    );
  }

  /**
   * Returns the provider configuration (without sensitive data).
   * Useful for diagnostics.
   */
  getConfigSummary(): Readonly<{
    provider: 'official';
    phoneNumberId: string;
    apiVersion: string;
    apiBaseUrl: string;
  }> {
    return {
      provider: 'official',
      phoneNumberId: this.config.phoneNumberId,
      apiVersion: this.config.apiVersion,
      apiBaseUrl: this.config.apiBaseUrl,
    };
  }
}