import { Router } from 'express';
import multer from 'multer';
import { previewImport, confirmImport } from '../controllers/imports.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit

router.use(requireAuth);

router.post('/preview', upload.single('file'), previewImport);
router.post('/confirm', confirmImport);

export default router;
