import { Router } from 'express';
import {
  createBackup,
  deleteBackup,
  getBackup,
  getBackupStatus,
  listBackups,
  restoreBackup,
  runRetentionCleanup,
  verifyBackup,
} from '../controllers/backups.controller';
import { requireAuth, requireRole } from '../middleware/auth.middleware';
import { ROLE } from '../utils/roles.util';

/**
 * Phase 5.12 — Backup & Recovery routes.
 * Phase 8.1 — backup management is administrative: ADMIN only.
 */
const router = Router();

router.use(requireAuth, requireRole(ROLE.ADMIN));

router.get('/', listBackups);
router.post('/', createBackup);
router.get('/status', getBackupStatus);
router.get('/:id', getBackup);
router.post('/:id/verify', verifyBackup);
router.post('/:id/restore', restoreBackup);
router.delete('/:id', deleteBackup);
router.post('/retention/cleanup', runRetentionCleanup);

export default router;