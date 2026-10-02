import { Router } from 'express';
import { getStatus, sendTest } from '../controllers/whatsapp.controller';
import { requireAuth, requireRole } from '../middleware/auth.middleware';
import { ROLE } from '../utils/roles.util';

const router = Router();

// Phase 8.1 — WhatsApp provider configuration surface (status + test send):
// ADMIN only.
router.get('/status', requireAuth, requireRole(ROLE.ADMIN), getStatus);
router.post('/send-test', requireAuth, requireRole(ROLE.ADMIN), sendTest);

export default router;
