import { Router } from 'express';
import { listHistory, getHistoryDetail, listHistoryCampaigns, listHistoryExecutionRecipients } from '../controllers/history.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

// All history endpoints require an authenticated session.
// History is a read-only view of the immutable CampaignExecution /
// CampaignExecutionRecipient snapshot models.
router.use(requireAuth);

// GET /api/history — paginated, filterable list (recipient-level, unchanged contract)
router.get('/', listHistory);
// Grouped + drill-down routes MUST be registered before '/:executionRecipientId',
// otherwise Express would capture "/campaigns" and "/executions/..." as an id.
router.get('/campaigns', listHistoryCampaigns);
router.get('/executions/:executionId', listHistoryExecutionRecipients);
// GET /api/history/:executionRecipientId — snapshot + current context
router.get('/:executionRecipientId', getHistoryDetail);

export default router;
