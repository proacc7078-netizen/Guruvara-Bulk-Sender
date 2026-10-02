import { Router } from 'express';
import { changePassword, login, logout, me } from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.post('/login', login);
router.post('/logout', requireAuth, logout);
router.post('/change-password', requireAuth, changePassword);
router.get('/me', requireAuth, me);

export default router;
