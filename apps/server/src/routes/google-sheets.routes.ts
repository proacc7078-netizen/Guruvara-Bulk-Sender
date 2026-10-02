import { Router } from 'express';
import { getGoogleSheetsStatus, syncGoogleSheetsNow, verifyGoogleSheets } from '../controllers/google-sheets.controller';
import { requireAuth, requireRole } from '../middleware/auth.middleware';
import { ROLE } from '../utils/roles.util';

const router = Router();

// Phase 8.1 — Google Sheets configuration/sync settings are administrative: ADMIN only.
router.use(requireAuth, requireRole(ROLE.ADMIN));

router.get('/status', getGoogleSheetsStatus);
router.post('/verify', verifyGoogleSheets);
router.post('/sync', syncGoogleSheetsNow);

export default router;
