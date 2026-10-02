import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { recordAuditSafe } from '../services/audit.service';
import { denyUnlessAdmin } from '../middleware/auth.middleware';
import {
  CampaignDeliveryInProgressError,
  CampaignNotFoundError,
  deleteCampaignForce,
} from '../services/campaignDelete.service';

const ALLOWED_STATUSES = ['DRAFT', 'READY', 'ARCHIVED'];
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;

// Fields that belong to later phases (scheduling, audience, sending, queue, Google).
// They are rejected explicitly so the Campaign foundation stays minimal.
const FORBIDDEN_FIELDS = [
  'scheduledAt',
  'timezone',
  'recurrence',
  'recipientIds',
  'recipients',
  'audience',
  'deliveryStatus',
  'sentAt',
  'completedAt',
  'queueId',
  'whatsappMessageId',
  'media',
  'googleSheetId',
  'googleFormId',
];

// Minimal message information a campaign list/editor needs.
const CAMPAIGN_INCLUDE = {
  message: {
    select: {
      id: true,
      name: true,
      status: true,
    },
  },
  executions: {
    select: { id: true },
  },
};

const findForbiddenField = (body: Record<string, unknown>): string | null => {
  for (const field of FORBIDDEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) return field;
  }
  return null;
};

const forbiddenResponse = (res: Response, field: string) =>
  res.status(400).json({
    success: false,
    error: { code: 'VALIDATION_ERROR', message: `Field "${field}" is not supported for campaigns` },
  });

const messageExists = async (messageId: unknown): Promise<boolean> => {
  const message = await prisma.message.findUnique({ where: { id: String(messageId) } });
  return message !== null;
};

const hasMessageId = (messageId: unknown): boolean =>
  messageId !== undefined && messageId !== null && String(messageId).trim() !== '';

export const getCampaigns = async (req: Request, res: Response) => {
  try {
    const campaigns = await prisma.campaign.findMany({
      include: CAMPAIGN_INCLUDE,
      orderBy: { createdAt: 'desc' }
    });

    return res.json({ success: true, data: campaigns });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch campaigns' } });
  }
};

export const getCampaignById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const campaignId = Array.isArray(id) ? id[0] : id;
    if (!campaignId || typeof campaignId !== 'string' || !campaignId.trim() || campaignId.length > 200) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid campaign ID' } });
    }

    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: CAMPAIGN_INCLUDE,
    });

    if (!campaign) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Campaign not found' } });
    }

    return res.json({ success: true, data: campaign });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch campaign' } });
  }
};

export const createCampaign = async (req: Request, res: Response) => {
  try {
    const { name, description, messageId, status } = req.body;

    const forbidden = findForbiddenField(req.body);
    if (forbidden) {
      return forbiddenResponse(res, forbidden);
    }

    // Validate required fields
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Name is required' } });
    }
    if (String(name).trim().length > MAX_NAME_LENGTH) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `Name must be at most ${MAX_NAME_LENGTH} characters` } });
    }
    if (description !== undefined && description !== null && String(description).length > MAX_DESCRIPTION_LENGTH) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters` } });
    }

    // Validate optional status
    if (status && !ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `Status must be one of: ${ALLOWED_STATUSES.join(', ')}` } });
    }

    // Validate optional message association (a message is never created implicitly)
    if (hasMessageId(messageId) && !(await messageExists(messageId))) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Message not found' } });
    }

    const campaign = await prisma.campaign.create({
      data: {
        name: String(name).trim(),
        description: description !== undefined && description !== null ? String(description) : null,
        messageId: hasMessageId(messageId) ? String(messageId) : null,
        status: status || 'DRAFT'
      },
      include: CAMPAIGN_INCLUDE
    });

    recordAuditSafe('CAMPAIGN_CREATE', req, { campaignId: campaign.id, status: campaign.status });

    return res.status(201).json({ success: true, data: campaign });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create campaign' } });
  }
};
export const updateCampaign = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const campaignId = Array.isArray(id) ? id[0] : id;
    if (!campaignId || typeof campaignId !== 'string' || !campaignId.trim() || campaignId.length > 200) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid campaign ID' } });
    }

    const { name, description, messageId, status } = req.body;

    const forbidden = findForbiddenField(req.body);
    if (forbidden) {
      return forbiddenResponse(res, forbidden);
    }

    // Check campaign exists
    const existing = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!existing) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Campaign not found' } });
    }

    // Validate status if provided
    if (status !== undefined && !ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `Status must be one of: ${ALLOWED_STATUSES.join(', ')}` } });
    }

    const updateData: Record<string, unknown> = {};
    if (name !== undefined) {
      if (!String(name).trim()) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Name cannot be empty' } });
      }
      if (String(name).trim().length > MAX_NAME_LENGTH) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `Name must be at most ${MAX_NAME_LENGTH} characters` } });
      }
      updateData.name = String(name).trim();
    }
    if (description !== undefined) {
      if (description !== null && String(description).length > MAX_DESCRIPTION_LENGTH) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters` } });
      }
      updateData.description = description !== null ? String(description) : null;
    }
    if (messageId !== undefined) {
      // null (or an empty string) clears the association safely
      if (hasMessageId(messageId)) {
        if (!(await messageExists(messageId))) {
          return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Message not found' } });
        }
        updateData.messageId = String(messageId);
      } else {
        updateData.messageId = null;
      }
    }
    if (status !== undefined) {
      updateData.status = status;
    }

    // Phase 4.3: readiness invalidation. A READY campaign whose reviewed
    // configuration (name or message association) actually changes no longer
    // matches what was reviewed, so it is demoted to DRAFT. Description-only
    // edits do not affect readiness and keep the campaign READY. An explicit
    // ARCHIVED status still wins.
    if (existing.status === 'READY') {
      const nameChanged = name !== undefined && String(name).trim() !== existing.name;
      const messageChanged =
        messageId !== undefined &&
        (hasMessageId(messageId) ? String(messageId) : null) !== existing.messageId;
      if (nameChanged || messageChanged) {
        updateData.status = status === 'ARCHIVED' ? 'ARCHIVED' : 'DRAFT';
      }
    }

    const campaign = await prisma.campaign.update({
      where: { id: campaignId },
      data: updateData,
      include: CAMPAIGN_INCLUDE
    });

    recordAuditSafe('CAMPAIGN_UPDATE', req, { campaignId: campaign.id, status: campaign.status });

    return res.json({ success: true, data: campaign });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update campaign' } });
  }
};

/**
 * POST /api/campaigns/bulk-archive
 *
 * Sets ARCHIVED on each selected campaign that still allows it. Archiving never
 * destroys execution history, so this is always safe.
 */
export const bulkArchiveCampaigns = async (req: Request, res: Response) => {
  return bulkCampaignAction(req, res, 'ARCHIVE');
};

/**
 * POST /api/campaigns/bulk-delete
 *
 * Attempts a physical delete for each selected campaign, one at a time, using
 * the same execution-history guard as DELETE /api/campaigns/:id. Campaigns
 * that have execution history are refused with the reason and must be
 * archived instead; no history is ever destroyed to make a delete succeed.
 */
export const bulkDeleteCampaigns = async (req: Request, res: Response) => {
  // Permanent deletion is ADMIN-only. Archive stays available to PRO.
  if (!(await denyUnlessAdmin(req, res))) return;
  return bulkCampaignAction(req, res, 'DELETE');
};

type BulkCampaignMode = 'ARCHIVE' | 'DELETE';

async function bulkCampaignAction(req: Request, res: Response, mode: BulkCampaignMode) {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawIds = Array.isArray(body.ids) ? body.ids : Array.isArray(body.campaignIds) ? body.campaignIds : null;
    const confirmRaw = (req.query as Record<string, unknown> | undefined)?.confirm ?? body.confirm;
    const confirmValue = Array.isArray(confirmRaw) ? confirmRaw[0] : confirmRaw;
    const confirmed = mode === 'DELETE' && confirmValue === 'true';
    if (!rawIds) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'ids must be an array of campaign ids' } });
    }
    if (rawIds.length === 0) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Select at least one campaign' } });
    }
    if (rawIds.length > 1000) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Too many campaigns selected (max 1000)' } });
    }
    const ids: string[] = [];
    for (const item of rawIds) {
      if (typeof item !== 'string' || !item.trim() || item.length > 200) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid campaign ID in selection' } });
      }
      const id = item.trim();
      if (!ids.includes(id)) ids.push(id);
    }

    const succeeded: string[] = [];
    const failed: { id: string; code: string; message: string }[] = [];

    for (const id of ids) {
      const existing = await prisma.campaign.findUnique({ where: { id } });
      if (!existing) {
        failed.push({ id, code: 'NOT_FOUND', message: 'Campaign not found' });
        continue;
      }
      try {
        if (mode === 'ARCHIVE') {
          await prisma.campaign.update({ where: { id }, data: { status: 'ARCHIVED' } });
        } else {
          // Identical guard to DELETE /api/campaigns/:id — only the exact
          // confirm=true unlocks the destructive cascade via deleteCampaignForce.
          const executionCount = await prisma.campaignExecution.count({ where: { campaignId: id } });
          if (executionCount > 0 && !confirmed) {
            failed.push({
              id,
              code: 'CAMPAIGN_HAS_EXECUTION_HISTORY',
              message: `Campaign cannot be deleted because it has ${executionCount} execution record${executionCount === 1 ? '' : 's'}. Archive it instead; execution history will be preserved.`,
            });
            continue;
          }
          if (confirmed) {
            try {
              const result = await deleteCampaignForce(id);
              recordAuditSafe('CAMPAIGN_DELETE_FORCE', req, {
                campaignId: id,
                executionCount: result.counts.executions,
                executionRecipientCount: result.counts.executionRecipients,
                audienceCount: result.counts.audience,
                scheduleCount: result.counts.schedule,
              });
            } catch (error) {
              if (error instanceof CampaignDeliveryInProgressError) {
                failed.push({ id, code: error.code, message: error.message });
              } else if (error instanceof CampaignNotFoundError) {
                failed.push({ id, code: 'NOT_FOUND', message: 'Campaign not found' });
              } else {
                failed.push({ id, code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'Failed to delete campaign' });
              }
              continue;
            }
            succeeded.push(id);
            continue;
          }
          await prisma.campaign.delete({ where: { id } });
        }
        succeeded.push(id);
      } catch (error) {
        failed.push({ id, code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : `Failed to ${mode.toLowerCase()} campaign` });
      }
    }

    recordAuditSafe(mode === 'ARCHIVE' ? 'CAMPAIGN_BULK_ARCHIVE' : 'CAMPAIGN_BULK_DELETE', req, {
      requested: ids.length, succeeded: succeeded.length, failed: failed.length,
    });

    return res.json({
      success: true,
      data: { requested: ids.length, mode, succeeded, failed, partial: failed.length > 0 && succeeded.length > 0 },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: `Failed to ${mode.toLowerCase()} campaigns` } });
  }
}

export const deleteCampaign = async (req: Request, res: Response) => {
  // Permanent deletion is ADMIN-only. Archive stays available to PRO.
  if (!(await denyUnlessAdmin(req, res))) return;
  try {
    const { id } = req.params;
    const campaignId = Array.isArray(id) ? id[0] : id;
    if (!campaignId || typeof campaignId !== 'string' || !campaignId.trim() || campaignId.length > 200) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid campaign ID' } });
    }

    const existing = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!existing) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Campaign not found' } });
    }

    // Explicit, opt-in destructive path. Only the exact string "true" is
    // accepted; anything else (including "1", "yes", "TRUE") leaves the
    // default guard below completely untouched.
    const confirmRaw = req.query?.confirm;
    const confirmValue = Array.isArray(confirmRaw) ? confirmRaw[0] : confirmRaw;
    if (confirmValue === 'true') {
      try {
        const result = await deleteCampaignForce(campaignId);
        recordAuditSafe('CAMPAIGN_DELETE_FORCE', req, {
          campaignId,
          executionCount: result.counts.executions,
          executionRecipientCount: result.counts.executionRecipients,
          audienceCount: result.counts.audience,
          scheduleCount: result.counts.schedule,
        });
        return res.json({ success: true, data: {} });
      } catch (error) {
        if (error instanceof CampaignDeliveryInProgressError) {
          return res.status(409).json({
            success: false,
            error: {
              code: error.code,
              message: error.message,
              data: { activeExecutionCount: error.activeExecutionCount },
            },
          });
        }
        if (error instanceof CampaignNotFoundError) {
          return res.status(404).json({ success: false, error: { code: error.code, message: error.message } });
        }
        return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to permanently delete campaign' } });
      }
    }

    // Execution history is immutable and must remain linked to its campaign for History.
    // Do not delete a campaign that has any execution, regardless of execution status.
    const executionCount = await prisma.campaignExecution.count({ where: { campaignId } });
    if (executionCount > 0) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'CAMPAIGN_HAS_EXECUTION_HISTORY',
          message: `Campaign cannot be deleted because it has ${executionCount} execution record${executionCount === 1 ? '' : 's'}. Archive it instead; execution history will be preserved.`,
        },
      });
    }

    // Only the campaign is removed. A schedule with no execution is removed by the
    // existing CampaignSchedule -> Campaign cascade. Message, media and recipients
    // are never touched by this endpoint.
    await prisma.campaign.delete({ where: { id: campaignId } });

    recordAuditSafe('CAMPAIGN_DELETE', req, { campaignId });

    return res.json({ success: true, data: {} });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete campaign' } });
  }
};

