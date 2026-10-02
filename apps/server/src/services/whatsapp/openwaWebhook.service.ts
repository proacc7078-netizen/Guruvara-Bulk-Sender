/**
 * Phase 7.3 — OpenWA delivery-status webhook normalization.
 *
 * Converts OpenWA webhook events into the existing NormalizedWebhookEvent shape
 * consumed by processWebhookEvents() / updateRecipientStatus() / recalculateExecutionStatus().
 *
 * OpenWA webhook envelope:
 *   { event, timestamp, sessionId, idempotencyKey, deliveryId, data: { waMessageId, ... } }
 *
 * Supported events:
 *   message.sent  -> SENT
 *   message.ack   -> status field inside data determines SENT / DELIVERED / READ
 *   message.failed -> FAILED
 *
 * Correlation key: data.waMessageId (with data.id accepted for compatibility) ==
 * CampaignExecutionRecipient.providerMessageId
 *
 * This module intentionally does NOT touch the database directly. It only
 * normalizes; the existing webhook service owns persistence and transition rules.
 */

import crypto from 'crypto';
import { NormalizedWebhookEvent, WhatsAppWebhookStatus } from './whatsappWebhook.service';

/** OpenWA event names that carry delivery status. */
type OpenWAEventType = 'message.sent' | 'message.ack' | 'message.failed';

export interface OpenWAWebhookEnvelope {
  event: string;
  timestamp?: string | number;
  sessionId?: string;
  idempotencyKey?: string;
  deliveryId?: string;
  data: {
    /** Documented OpenWA message identifier. */
    waMessageId?: string;
    /** Compatibility identifier used by some OpenWA payload variants. */
    id?: string;
    status?: string;
    /** Error information when event is message.failed. */
    error?: string | null;
    errorMessage?: string | null;
    [key: string]: unknown;
  };
}

/**
 * Normalize an OpenWA webhook payload into one or more NormalizedWebhookEvent
 * entries. Returns an empty array for unrecognized event types, malformed
 * payloads, or events that do not carry a usable message id.
 */
export function normalizeOpenWAWebhookEvents(payload: unknown): NormalizedWebhookEvent[] {
  if (!payload || typeof payload !== 'object') return [];

  const root = payload as Record<string, unknown>;

  const event = typeof root.event === 'string' ? root.event : '';
  if (event !== 'message.sent' && event !== 'message.ack' && event !== 'message.failed') {
    return [];
  }

  const data = root.data;
  if (!data || typeof data !== 'object') return [];

  const dataRecord = data as Record<string, unknown>;
  // OpenWA documents waMessageId as the message identifier. Some OpenWA
  // versions use data.id for the same value; accept either documented field.
  const providerMessageId =
    typeof dataRecord.waMessageId === 'string' && dataRecord.waMessageId
      ? dataRecord.waMessageId
      : typeof dataRecord.id === 'string' && dataRecord.id
        ? dataRecord.id
        : '';

  if (!providerMessageId) return [];

  const status = mapOpenWAEventToStatus(event, dataRecord);
  if (!status) return [];

  const timestamp = normalizeOpenWATimestamp(root.timestamp);

  let errorCode: string | undefined;
  let errorMessage: string | undefined;

  if (event === 'message.failed') {
    errorCode = 'OPENWA_MESSAGE_FAILED';
    if (typeof dataRecord.error === 'string' && dataRecord.error) {
      errorMessage = dataRecord.error;
    } else if (typeof dataRecord.errorMessage === 'string' && dataRecord.errorMessage) {
      errorMessage = dataRecord.errorMessage;
    }
  }

  return [
    {
      providerMessageId,
      status,
      timestamp,
      errorCode,
      errorMessage,
    },
  ];
}

/**
 * Map an OpenWA event + optional data.status to the existing CMS webhook status.
 *
 * OpenWA contract:
 *   message.sent  -> SENT
 *   message.ack   -> data.status carries the ack level: delivered | read | sent | failed
 *   message.failed -> FAILED
 */
function mapOpenWAEventToStatus(event: OpenWAEventType, data: Record<string, unknown>): WhatsAppWebhookStatus | null {
  switch (event) {
    case 'message.sent':
      return 'SENT';

    case 'message.failed':
      return 'FAILED';

    case 'message.ack': {
      const raw = typeof data.status === 'string' ? data.status.trim().toLowerCase() : '';
      switch (raw) {
        case 'sent':
          return 'SENT';
        case 'delivered':
          return 'DELIVERED';
        case 'read':
          return 'READ';
        case 'failed':
          return 'FAILED';
        default:
          return null;
      }
    }

    default:
      return null;
  }
}

/**
 * OpenWA timestamps may be ISO strings or Unix milliseconds/n seconds.
 * Normalize to a Date when parseable; otherwise undefined.
 */
function normalizeOpenWATimestamp(value: unknown): Date | undefined {
  if (value === undefined || value === null) return undefined;

  if (value instanceof Date) return value;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const iso = new Date(trimmed);
    if (!isNaN(iso.getTime())) return iso;
    const num = Number(trimmed);
    if (!isNaN(num)) {
      const d = new Date(num > 1e12 ? num : num * 1000);
      if (!isNaN(d.getTime())) return d;
    }
    return undefined;
  }

  if (typeof value === 'number') {
    const d = new Date(value > 1e12 ? value : value * 1000);
    return isNaN(d.getTime()) ? undefined : d;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// OpenWA webhook signature verification
// ---------------------------------------------------------------------------

/**
 * Verify an OpenWA webhook signature.
 *
 * OpenWA sends: X-OpenWA-Signature: sha256=<hex>
 * signed against the RAW request body using HMAC-SHA256 and the configured
 * WHATSAPP_OPENWA_WEBHOOK_SECRET.
 *
 * Uses timing-safe comparison. Returns false (fail-closed) when the secret is
 * missing/empty, the header is missing, malformed, or does not match.
 */
export function verifyOpenWAWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string | undefined,
): boolean {
  // Fail closed when verification is attempted without a configured secret.
  // Signature verification is impossible in that state, so the caller must not
  // treat the request as verified (and must never log or return the secret).
  if (typeof secret !== 'string' || secret.length === 0) return false;

  if (!Buffer.isBuffer(rawBody)) return false;

  if (!signatureHeader || typeof signatureHeader !== 'string') return false;

  const trimmed = signatureHeader.trim();
  if (!trimmed.startsWith('sha256=')) return false;

  const providedHex = trimmed.slice(7);
  if (!providedHex || !/^[0-9a-fA-F]{64}$/.test(providedHex)) return false;

  let expectedHex: string;
  try {
    expectedHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  } catch {
    return false;
  }

  try {
    return crypto.timingSafeEqual(Buffer.from(providedHex, 'hex'), Buffer.from(expectedHex, 'hex'));
  } catch {
    return false;
  }
}
