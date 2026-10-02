import { Router } from 'express';
import { getCampaigns, getCampaignById, createCampaign, updateCampaign, deleteCampaign, bulkArchiveCampaigns, bulkDeleteCampaigns } from '../controllers/campaigns.controller';
import { getCampaignAudience, updateCampaignAudience } from '../controllers/campaignAudience.controller';
import { getCampaignReadiness, finalizeCampaign } from '../controllers/campaignFinalize.controller';
import {
  getCampaignSchedule,
  createCampaignSchedule,
  updateCampaignSchedule,
  cancelCampaignSchedule,
} from '../controllers/campaignSchedule.controller';
import { getExecution, createExecution, rerunExecution, cancelExecutionRoute, sendExecutionRecipient } from '../controllers/campaignExecution.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);

router.get('/', getCampaigns);
router.post('/', createCampaign);
// Bulk actions. Registered before '/:id' so the literal path always wins.
router.post('/bulk-archive', bulkArchiveCampaigns);
router.post('/bulk-delete', bulkDeleteCampaigns);
// Phase 4.2: campaign audience composition (membership only)
router.get('/:id/audience', getCampaignAudience);
router.put('/:id/audience', updateCampaignAudience);
// Phase 4.3: review readiness snapshot + finalization
router.get('/:id/readiness', getCampaignReadiness);
router.post('/:id/finalize', finalizeCampaign);
// Phase 4.4: schedule persistence + management (WHEN, no execution)
router.get('/:id/schedule', getCampaignSchedule);
router.post('/:id/schedule', createCampaignSchedule);
router.patch('/:id/schedule', updateCampaignSchedule);
router.post('/:id/schedule/cancel', cancelCampaignSchedule);
// Phase 4.5: execution foundation (internal, no sending/dispatching)
router.get('/:id/execution', getExecution);
router.post('/:id/execution', createExecution);
// Reusable campaigns: create another execution without touching previous ones.
router.post('/:id/execution/rerun', rerunExecution);
router.post('/:id/execution/cancel', cancelExecutionRoute);
router.post('/:id/execution/:executionRecipientId/send', sendExecutionRecipient);
router.get('/:id', getCampaignById);
router.patch('/:id', updateCampaign);
router.delete('/:id', deleteCampaign);

export default router;
