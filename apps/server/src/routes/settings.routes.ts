import { Router } from 'express';
import { getSettings, verifyConnection } from '../controllers/settings.controller';
import { requireAuth, requireRole } from '../middleware/auth.middleware';
import { ROLE } from '../utils/roles.util';

const router = Router();

// Phase 8.1 — provider (WhatsApp), Google Sheets and backup settings are
// administrative: system settings are ADMIN only.
router.use(requireAuth, requireRole(ROLE.ADMIN));

router.get('/', getSettings);
router.post('/verify-connection', verifyConnection);

export default router;
