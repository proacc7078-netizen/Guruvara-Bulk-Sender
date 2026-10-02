export type ConnectionStatus = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED';

export type MessageStatus =
  | 'UNKNOWN'
  | 'QUEUED'
  | 'SENT'
  | 'DELIVERED'
  | 'READ'
  | 'FAILED';

export interface SendResult {
  success: boolean;
  providerMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
  /**
   * Phase 5.3 diagnostic — sanitized, non-secret Meta error details when
   * the Graph API returned a structured error body. Never contains tokens,
   * Authorization headers, or request credentials.
   */
  metaError?: {
    code?: number | string;
    type?: string;
    message?: string;
    httpStatus?: number;
  };
}

/**
 * Result of a non-message connection verification against Meta Graph API.
 *
 * Phase 5.2B — CONNECTION VERIFICATION ONLY. No messages are sent.
 */
export interface WhatsAppVerificationResult {
  readonly verified: boolean;
  readonly reason:
    | 'VERIFIED'
    | 'NOT_CONFIGURED'
    | 'CONFIG_INVALID'
    | 'AUTH_FAILED'
    | 'NETWORK_ERROR'
    | 'API_ERROR';
  /** Sanitized human-readable detail. Never contains secrets. */
  readonly message: string;
  /** HTTP status from Meta when available. */
  readonly httpStatus?: number;
  /** Non-sensitive WhatsApp phone-number metadata returned by Meta. */
  readonly phoneNumber?: {
    readonly id?: string;
    readonly displayPhoneNumber?: string;
    readonly verifiedName?: string;
  };
  /**
   * Phase 7.1 — raw connection state reported by providers that expose one
   * (e.g. the OpenWA session status such as `ready`, `qr_ready`,
   * `disconnected`). Absent for the official Meta provider. Non-sensitive:
   * never contains credentials.
   */
  readonly providerStatus?: string;
}

export interface MediaPayload {
  path: string;
  mimeType: string;
  filename?: string;
  /**
   * Phase 6.0C — optional pre-uploaded Meta media ID. When present, the
   * OfficialWhatsAppAdapter sends the image directly with this ID and skips
   * the local-file upload step. Local `path` is still used as a fallback.
   */
  metaMediaId?: string;
  /**
   * Phase 7.1 — optional externally reachable media URL, for providers whose
   * API accepts a URL instead of a binary upload (OpenWA send-image). The
   * provider fetches this URL itself, so it must be reachable from the
   * provider host; local storage paths are never made public to satisfy this
   * field. Providers that upload local files ignore it.
   */
  url?: string;
}

export interface WhatsAppAdapter {
  getStatus(): Promise<ConnectionStatus>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  sendText(recipient: string, message: string): Promise<SendResult>;

  sendMedia(
    recipient: string,
    media: MediaPayload,
    caption?: string
  ): Promise<SendResult>;

  getMessageStatus(providerMessageId: string): Promise<MessageStatus>;

  /**
   * Phase 5.2B — safe non-message connection verification.
   *
   * Optional to preserve the provider abstraction: adapters that cannot
   * reach Meta (e.g. unconfigured) return a NOT_CONFIGURED result instead
   * of throwing. Must never send a message.
   */
  verifyConnection?(): Promise<WhatsAppVerificationResult>;

  /**
   * Returns a summary of the provider configuration for diagnostics.
   * Does not include sensitive credentials.
   */
  getConfigSummary?(): Readonly<{
    provider: string;
    phoneNumberId?: string;
    apiVersion?: string;
    apiBaseUrl?: string;
  }>;
}

/**
 * Provider-independent error codes.
 */
export type WhatsAppErrorCode =
  | 'WHATSAPP_PROVIDER_NOT_CONFIGURED'
  | 'WHATSAPP_PROVIDER_UNAVAILABLE'
  | 'WHATSAPP_SEND_FAILED'
  | 'WHATSAPP_CONFIGURATION_INVALID';

/**
 * Provider-independent error shape.
 */
export interface WhatsAppError {
  readonly code: WhatsAppErrorCode;
  readonly message: string;
}

/**
 * Factory function type that returns an adapter instance.
 *
 * Used by the provider registry to obtain the active adapter.
 */
export type WhatsAppAdapterFactory = () => WhatsAppAdapter;

/**
 * Provider registry contract.
 *
 * The application obtains the active adapter through this registry
 * rather than importing a concrete provider directly.
 */
export interface WhatsAppProviderRegistry {
  /**
   * Returns the currently configured WhatsAppAdapter.
   *
   * In Phase 5.1, this returns a safe unconfigured placeholder.
   */
  getAdapter(): WhatsAppAdapter;
}

