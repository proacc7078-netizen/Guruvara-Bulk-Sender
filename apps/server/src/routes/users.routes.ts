import { Router } from 'express';
import { createUser, listUsers, updateUserRole, updateMyProfile, bulkDeleteUsers } from '../controllers/users.controller';
import { requireAuth, requireRole } from '../middleware/auth.middleware';
import { ROLE } from '../utils/roles.util';

/**
 * Phase 8.1 — user management. ADMIN only: PRO sessions receive 403 FORBIDDEN
 * even when they construct the request manually.
 */
const router = Router();

router.use(requireAuth, requireRole(ROLE.ADMIN));

router.get('/', listUsers);
router.post('/', createUser);
// Literal paths are registered before '/:id' so they always win.
router.patch('/me/profile', updateMyProfile);
router.delete('/', bulkDeleteUsers);
router.patch('/:id/role', updateUserRole);

export default router;
