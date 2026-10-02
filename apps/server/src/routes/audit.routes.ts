import { Router } from 'express';
import { listAuditLogs } from '../controllers/audit.controller';
import { requireAuth, requireRole } from '../middleware/auth.middleware';
import { ROLE } from '../utils/roles.util';

/**
 * Phase 8.1 — audit / system administration. ADMIN only.
 */
const router = Router();

router.use(requireAuth, requireRole(ROLE.ADMIN));

router.get('/', listAuditLogs);

export default router;
