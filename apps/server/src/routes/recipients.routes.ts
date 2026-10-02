import { Router } from 'express';
import { getRecipients, getRecipientById, createRecipient, updateRecipient, deleteRecipient, bulkDeleteRecipients, updateRecipientStatus, assignTagToRecipient, removeTagFromRecipient, checkImportDuplicates, importRecipients } from '../controllers/recipients.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);

router.get('/', getRecipients);
// Bulk action. Registered before '/:id' so the literal path always wins.
router.post('/bulk-delete', bulkDeleteRecipients);
// Step 12D: read-only duplicate lookup for the import wizard (no recipient is created or modified)
router.post('/import-duplicates', checkImportDuplicates);
// Step 12F: the final import confirmation. Only the rows the user explicitly
// marked IMPORT in Step 12E are submitted here; the handler only ever CREATES
// new recipients (see importRecipients in recipients.controller).
router.post('/import', importRecipients);
router.get('/:id', getRecipientById);
router.post('/', createRecipient);
router.patch('/:id/status', updateRecipientStatus);
router.post('/:id/tags', assignTagToRecipient);
router.delete('/:id/tags/:tagId', removeTagFromRecipient);
router.patch('/:id', updateRecipient);
router.put('/:id', updateRecipient);
router.delete('/:id', deleteRecipient);

export default router;
