import { Router } from 'express';
import { verifyWebhook, receiveWebhook, receiveOpenWAWebhook } from '../controllers/webhook.controller';

// Webhook routes must use raw body for signature verification
const router = Router();

// GET /api/webhooks/whatsapp - Meta verification endpoint
router.get('/whatsapp', verifyWebhook);

// POST /api/webhooks/whatsapp - Meta status updates
// Note: This route requires raw body parsing for signature verification
// The raw body parser is added in index.ts for this specific route
router.post('/whatsapp', receiveWebhook);

// POST /api/webhooks/whatsapp/openwa - OpenWA delivery-status updates (Phase 7.3)
// Reuses the same raw-body middleware as the Meta endpoint so signature
// verification can work against the raw request body. OpenWA-specific auth
// (X-OpenWA-Signature) is handled inside receiveOpenWAWebhook.
router.post('/whatsapp/openwa', receiveOpenWAWebhook);

export default router;