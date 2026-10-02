import { Router } from 'express';
import { uploadMedia, getMedia, getPublicMedia, deleteMedia } from '../controllers/media.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

// Deliberately outside session auth: OpenWA fetches this single signed media resource.
// The route resolves only a Media id after token verification; it never accepts paths.
router.get('/public/:id', getPublicMedia);

router.use(requireAuth);

router.post('/', uploadMedia);
router.get('/:id', getMedia);
router.delete('/:id', deleteMedia);

export default router;
