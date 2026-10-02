import { Router } from 'express';
import { getMessages, getMessageById, createMessage, updateMessage, deleteMessage, bulkArchiveMessages, bulkDeleteMessages } from '../controllers/messages.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);

router.get('/', getMessages);
// Bulk actions. Registered before '/:id' so the literal path always wins.
router.post('/bulk-archive', bulkArchiveMessages);
router.post('/bulk-delete', bulkDeleteMessages);
router.get('/:id', getMessageById);
router.post('/', createMessage);
router.patch('/:id', updateMessage);
router.delete('/:id', deleteMessage);

export default router;
