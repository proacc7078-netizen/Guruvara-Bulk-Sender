import { Request, Response, RequestHandler } from 'express';
import crypto from 'crypto';
import {
  normalizeWebhookEvents,
  processWebhookEvents,
  getWebhookConfigState,
  loadWhatsAppWebhookConfig,
} from '../services/whatsapp/whatsappWebhook.service';
import {
  normalizeOpenWAWebhookEvents,
  verifyOpenWAWebhookSignature,
  loadOpenWAWebhookConfig,
} from '../services/whatsapp';

/**
 * GET /api/webhooks/whatsapp
 * Meta webhook verification endpoint.
 * 
 * Meta sends a verification request with:
 * - hub.mode: 'subscribe'
 * - hub.verify_token: the configured verify token
 * - hub.challenge: a random string to echo back
 * 
 * Returns 200 with the challenge if verification succeeds, 403 otherwise.
 */
export const verifyWebhook: RequestHandler = async (req, res) => {
  const { configured, error } = getWebhookConfigState();

  if (!configured) {
    res.status(403).json({
      success: false,
      errorCode: 'WEBHOOK_NOT_CONFIGURED',
      errorMessage: 'WhatsApp webhook verification is not configured.',
    });
    return;
  }

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode !== 'subscribe') {
    res.status(403).json({
      success: false,
      errorCode: 'WEBHOOK_INVALID_MODE',
      errorMessage: 'Invalid hub.mode. Expected "subscribe".',
    });
    return;
  }

  const config = loadWhatsAppWebhookConfig();
  if (!config || token !== config.verifyToken) {
    res.status(403).json({
      success: false,
      errorCode: 'WEBHOOK_INVALID_TOKEN',
      errorMessage: 'Invalid verify token.',
    });
    return;
  }

  if (typeof challenge !== 'string') {
    res.status(403).json({
      success: false,
      errorCode: 'WEBHOOK_MISSING_CHALLENGE',
      errorMessage: 'Missing hub.challenge parameter.',
    });
    return;
  }

  // Return the challenge as plain text (Meta expects this)
  res.set('Content-Type', 'text/plain');
  res.status(200).send(challenge);
};

/**
 * Verifies the X-Hub-Signature-256 header against the raw request body.
 * Returns true if valid, false otherwise.
 */
function verifySignature(rawBody: Buffer, signature: string | undefined, appSecret: string): boolean {
  if (!signature || !signature.startsWith('sha256=')) {
    return false;
  }

  const expectedSignature = signature.slice(7); // Remove 'sha256=' prefix
  const hmac = crypto.createHmac('sha256', appSecret);
  hmac.update(rawBody);
  const calculatedSignature = hmac.digest('hex');

  // Use timing-safe comparison
  return crypto.timingSafeEqual(
    Buffer.from(expectedSignature, 'hex'),
    Buffer.from(calculatedSignature, 'hex')
  );
}

/**
 * POST /api/webhooks/whatsapp
 * Meta webhook delivery status endpoint.
 * 
 * Receives status updates for sent messages and updates the execution records.
 * Requires valid X-Hub-Signature-256 header when app secret is configured.
 */
export const receiveWebhook: RequestHandler = async (req, res) => {
  const { configured, error } = getWebhookConfigState();

  if (!configured) {
    res.status(403).json({
      success: false,
      errorCode: 'WEBHOOK_NOT_CONFIGURED',
      errorMessage: 'WhatsApp webhook is not configured.',
    });
    return;
  }

  const config = loadWhatsAppWebhookConfig();
  if (!config) {
    res.status(403).json({
      success: false,
      errorCode: 'WEBHOOK_NOT_CONFIGURED',
      errorMessage: 'WhatsApp webhook is not configured.',
    });
    return;
  }

  // Verify signature
  const signature = req.get('X-Hub-Signature-256');
  // Use raw body from express.raw() middleware (Buffer) or fallback to stringified parsed body
  const rawBody = req.body instanceof Buffer ? req.body : Buffer.from(JSON.stringify(req.body));

  if (!verifySignature(rawBody, signature, config.appSecret)) {
    res.status(403).json({
      success: false,
      errorCode: 'WEBHOOK_INVALID_SIGNATURE',
      errorMessage: 'Invalid webhook signature.',
    });
    return;
  }

  // Parse and normalize events. express.raw() leaves req.body as a Buffer, so
  // parse it (defensively) into a JSON object before normalizing.
  let parsedBody = req.body;
  if (Buffer.isBuffer(parsedBody)) {
    try {
      parsedBody = JSON.parse(parsedBody.toString('utf8'));
    } catch {
      parsedBody = null;
    }
  }
  const events = normalizeWebhookEvents(parsedBody);

  if (events.length === 0) {
    // No valid status events - still return 200 to acknowledge receipt
    res.json({ success: true, processed: 0 });
    return;
  }

  // Process events
  const results = await processWebhookEvents(events);

  const successCount = results.filter((r) => r.success).length;
  const failureCount = results.filter((r) => !r.success).length;

  res.json({
    success: true,
    processed: events.length,
    succeeded: successCount,
    failed: failureCount,
  });
};

/**
 * POST /api/webhooks/whatsapp/openwa
 * OpenWA delivery-status webhook endpoint.
 *
 * OpenWA sends POST with:
 *   - X-OpenWA-Signature: sha256=<hex> (HMAC-SHA256 over the raw body using
 *     WHATSAPP_OPENWA_WEBHOOK_SECRET)
 *   - JSON body: { event, timestamp, sessionId, idempotencyKey, deliveryId, data: { id, status?, ... } }
 *
 * Supports three events: message.sent, message.ack, message.failed.
 * Authentication IS the HMAC signature and the endpoint fails closed: when
 * WHATSAPP_OPENWA_WEBHOOK_SECRET is not configured, no CMS session is required
 * but no event is processed either (503 WEBHOOK_NOT_CONFIGURED). No webhook is
 * ever registered with OpenWA automatically by this CMS.
 */
export const receiveOpenWAWebhook: RequestHandler = async (req, res) => {
  const openwaConfig = loadOpenWAWebhookConfig();

  // The OpenWA authorization model for this endpoint is the HMAC signature, and
  // it fails CLOSED. If no WHATSAPP_OPENWA_WEBHOOK_SECRET is configured the
  // endpoint cannot authenticate anything, so the event is rejected instead of
  // being processed. No secret value is ever logged or returned.
  if (!openwaConfig) {
    res.status(503).json({
      success: false,
      errorCode: 'WEBHOOK_NOT_CONFIGURED',
      errorMessage: 'OpenWA webhook is not configured. Set WHATSAPP_OPENWA_WEBHOOK_SECRET to enable signed delivery-status events.',
    });
    return;
  }

  // Verify the X-OpenWA-Signature header against the raw request body.
  const signature = req.get('X-OpenWA-Signature');
  // The raw-body middleware must be active. Never reconstruct a body from
  // parsed JSON: HMAC verification must cover the exact bytes received.
  if (!Buffer.isBuffer(req.body)) {
    res.status(400).json({
      success: false,
      errorCode: 'WEBHOOK_RAW_BODY_REQUIRED',
      errorMessage: 'OpenWA webhook requires the exact raw request body.',
    });
    return;
  }
  const rawBody = req.body;

  if (!verifyOpenWAWebhookSignature(rawBody, signature, openwaConfig.secret)) {
    res.status(403).json({
      success: false,
      errorCode: 'WEBHOOK_INVALID_SIGNATURE',
      errorMessage: 'Invalid OpenWA webhook signature.',
    });
    return;
  }

  // Parse the body. express.raw() leaves req.body as a Buffer for
  // application/json when the raw middleware is active.
  let parsedBody: unknown = req.body;
  if (Buffer.isBuffer(parsedBody)) {
    try {
      parsedBody = JSON.parse(parsedBody.toString('utf8'));
    } catch {
      parsedBody = null;
    }
  }

  if (!parsedBody || typeof parsedBody !== 'object') {
    // Malformed — acknowledge safely, do not process.
    res.json({ success: true, processed: 0 });
    return;
  }

  const events = normalizeOpenWAWebhookEvents(parsedBody);

  if (events.length === 0) {
    // No recognizable OpenWA delivery event — acknowledge safely.
    res.json({ success: true, processed: 0 });
    return;
  }

  const results = await processWebhookEvents(events);

  const successCount = results.filter((r) => r.success).length;
  const failureCount = results.filter((r) => !r.success).length;

  res.json({
    success: true,
    processed: events.length,
    succeeded: successCount,
    failed: failureCount,
  });
};
