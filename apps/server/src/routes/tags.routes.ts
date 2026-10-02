import { Router } from 'express';
import { getTags, createTag, updateTag, deleteTag } from '../controllers/tags.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);

router.get('/', getTags);
router.post('/', createTag);
router.patch('/:id', updateTag);
router.put('/:id', updateTag);
router.delete('/:id', deleteTag);

export default router;