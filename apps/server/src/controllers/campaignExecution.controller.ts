import { Request, Response } from 'express';
import { prisma } from '../config/db';
import {
  createExecutionSnapshot,
  markExecutionRunning,
  markExecutionCompleted,
  markExecutionFailed,
  cancelExecution,
  serializeExecution,
  SerializedExecution,
  ExecutionSnapshotOutcome,
  isAlreadyDeliveredRecipient,
} from '../utils/campaignExecution.util';
import { ExecutionDeliveryService } from '../services/executionDelivery.service';
import { recalculateExecutionStatus } from '../services/whatsapp/whatsappWebhook.service';
import { Prisma } from '@prisma/client';
import { recordAuditSafe } from '../services/audit.service';

const CANCELLABLE_STATUSES = new Set(['PENDING']);

function isCancellable(status: string | null | undefined): boolean {
  return Boolean(status) && CANCELLABLE_STATUSES.has(String(status));
}

const campaignIdFrom = (req: Request): string | null => {
  const { id } = req.params;
  const campaignId = Array.isArray(id) ? id[0] : id;
  return typeof campaignId === 'string' && campaignId.trim().length > 0 && campaignId.length <= 200 ? campaignId.trim() : null;
};

const notFound = (res: Response) =>
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Campaign not found' } });

const errorResponse = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ success: false, error: { code, message } });

const successResponse = (res: Response, data: Record<string, unknown>, status = 200) =>
  res.status(status).json({ success: true, data });

export const getExecution = async (req: Request, res: Response) => {
  try {
    const campaignId = campaignIdFrom(req);
    if (!campaignId) {
      return errorResponse(res, 400, 'VALIDATION_ERROR', 'Invalid campaign ID');
    }

    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true },
    });
    if (!campaign) {
      return notFound(res);
    }

    const execution = await prisma.campaignExecution.findFirst({
      where: { campaignId },
      orderBy: { createdAt: 'desc' },
    });

    if (!execution) {
      return successResponse(res, { execution: null });
    }

    return successResponse(res, { execution: serializeExecution(execution) });
  } catch (error) {
    return errorResponse(res, 500, 'INTERNAL_ERROR', 'Failed to fetch execution');
  }
};

export const createExecution = async (req: Request, res: Response) => {
  try {
    const campaignId = campaignIdFrom(req);
    if (!campaignId) {
      return errorResponse(res, 400, 'VALIDATION_ERROR', 'Invalid campaign ID');
    }

    const result = await createExecutionSnapshot(campaignId);

    if (!result.ok) {
      const err = result.error;
      const statusMap: Record<string, number> = {
        CAMPAIGN_NOT_FOUND: 404,
        CAMPAIGN_NOT_READY: 400,
        SCHEDULE_NOT_FOUND: 404,
        SCHEDULE_NOT_SCHEDULED: 400,
        SCHEDULE_MISMATCH: 400,
        MESSAGE_NOT_FOUND: 404,
        MESSAGE_ARCHIVED: 400,
        MESSAGE_EMPTY: 400,
        AUDIENCE_EMPTY: 400,
        AUDIENCE_RECIPIENT_MISSING: 400,
      };
      return errorResponse(res, statusMap[err.code] ?? 400, err.code, err.message);
    }

    // result.ok === true
    const executionResult = result as
      | { ok: true; execution: Prisma.CampaignExecutionGetPayload<{}>; alreadyExisted: boolean };

    if (executionResult.alreadyExisted) {
      return successResponse(
        res,
        {
          execution: serializeExecution(executionResult.execution),
          message: 'EXECUTION_ALREADY_EXISTS',
        },
        200
      );
    }

    recordAuditSafe('EXECUTION_CREATE', req, {
      campaignId,
      executionId: executionResult.execution.id,
    });

    return successResponse(res, { execution: serializeExecution(executionResult.execution) }, 201);
  } catch (error) {
    return errorResponse(res, 500, 'INTERNAL_ERROR', 'Failed to create execution');
  }
};

/**
 * POST /:id/execution/rerun
 *
 * "Run Again" for a reusable campaign. Creates a NEW execution (and its own
 * immutable recipient/message/media snapshot) alongside the previous ones, so
 * earlier runs and their history remain completely untouched. The campaign
 * record itself is never cloned.
 *
 * The new execution inherits the campaign's current schedule, so the existing
 * scheduled-time gate in the queue worker still prevents early delivery.
 */
export const rerunExecution = async (req: Request, res: Response) => {
  try {
    const campaignId = campaignIdFrom(req);
    if (!campaignId) {
      return errorResponse(res, 400, 'VALIDATION_ERROR', 'Invalid campaign ID');
    }

    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, status: true },
    });
    if (!campaign) {
      return notFound(res);
    }
    if (campaign.status === 'ARCHIVED') {
      return errorResponse(res, 400, 'CAMPAIGN_NOT_READY', 'Archived campaigns cannot be run');
    }

    const before = await prisma.campaignExecution.count({ where: { campaignId } });
    const result = await createExecutionSnapshot(campaignId, { allowRerun: true });

    if (!result.ok) {
      const err = result.error;
      const statusMap: Record<string, number> = {
        CAMPAIGN_NOT_FOUND: 404,
        CAMPAIGN_NOT_READY: 400,
        SCHEDULE_NOT_FOUND: 404,
        SCHEDULE_NOT_SCHEDULED: 400,
        MESSAGE_NOT_FOUND: 404,
        MESSAGE_ARCHIVED: 400,
        MESSAGE_EMPTY: 400,
        AUDIENCE_EMPTY: 400,
        AUDIENCE_RECIPIENT_MISSING: 400,
      };
      return errorResponse(res, statusMap[err.code] ?? 400, err.code, err.message);
    }

    const created = result as { ok: true; execution: Prisma.CampaignExecutionGetPayload<{}>; alreadyExisted?: boolean };
    if (created.alreadyExisted) {
      return successResponse(res, {
        execution: serializeExecution(created.execution),
        message: 'EXECUTION_ALREADY_EXISTS',
      }, 200);
    }

    recordAuditSafe('EXECUTION_RERUN', req, { campaignId, executionId: created.execution.id, previousExecutions: before });

    return successResponse(res, {
      execution: serializeExecution(created.execution),
      previousExecutions: before,
    }, 201);
  } catch (error) {
    return errorResponse(res, 500, 'INTERNAL_ERROR', 'Failed to create a new execution for this campaign');
  }
};

export const cancelExecutionRoute = async (req: Request, res: Response) => {
  try {
    const campaignId = campaignIdFrom(req);
    if (!campaignId) {
      return errorResponse(res, 400, 'VALIDATION_ERROR', 'Invalid campaign ID');
    }

    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, status: true, messageId: true },
    });
    if (!campaign) {
      return notFound(res);
    }

    if (campaign.status === 'ARCHIVED') {
      return errorResponse(res, 400, 'CAMPAIGN_NOT_READY', 'Archived campaigns cannot be cancelled');
    }

    let execution = await prisma.campaignExecution.findFirst({
      where: { campaignId },
      orderBy: { createdAt: 'desc' },
    });

    if (!execution || !isCancellable(execution.status)) {
      if (campaign.status !== 'READY') {
        return errorResponse(res, 400, 'CAMPAIGN_NOT_READY', 'Only ready campaigns can have an execution cancelled');
      }
      if (execution && !isCancellable(execution.status)) {
        await prisma.campaignExecutionRecipient.deleteMany({ where: { executionId: execution.id } });
        await prisma.campaignExecution.delete({ where: { id: execution.id } }).catch(() => {});
      }
      const snapshot = await createExecutionSnapshot(campaignId);
      if (!snapshot.ok) {
        const statusMap: Record<string, number> = {
          CAMPAIGN_NOT_READY: 400,
          SCHEDULE_NOT_FOUND: 404,
          SCHEDULE_NOT_SCHEDULED: 400,
          MESSAGE_NOT_FOUND: 404,
          MESSAGE_ARCHIVED: 400,
          MESSAGE_EMPTY: 400,
          AUDIENCE_EMPTY: 400,
          AUDIENCE_RECIPIENT_MISSING: 400,
        };
        return errorResponse(res, statusMap[snapshot.error.code] ?? 500, snapshot.error.code, snapshot.error.message);
      }
      execution = snapshot.execution;
    }

    const updated = await cancelExecution(execution.id);
    recordAuditSafe('EXECUTION_CANCEL', req, { campaignId, executionId: updated.id, status: updated.status });
    return successResponse(res, { execution: serializeExecution(updated) });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    const statusMap: Record<string, number> = {
      'Cannot cancel a RUNNING execution': 409,
      'Cannot cancel a COMPLETED execution': 409,
      'Cannot cancel a FAILED execution': 409,
    };
    return errorResponse(res, statusMap[msg] ?? 500, 'CANCEL_ERROR', msg);
  }
};

export const sendExecutionRecipient = async (req: Request, res: Response) => {
  try {
    const campaignId = campaignIdFrom(req);
    if (!campaignId) {
      return errorResponse(res, 400, 'VALIDATION_ERROR', 'Invalid campaign ID');
    }

    const { id, executionRecipientId } = req.params;
    const campaignIdParam = Array.isArray(id) ? id[0] : id;
    const executionRecipientIdParam = Array.isArray(executionRecipientId) ? executionRecipientId[0] : executionRecipientId;

    // Verify the campaign exists
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignIdParam },
      select: { id: true },
    });

    if (!campaign) {
      return notFound(res);
    }

    // Parse the executionRecipientId which should be in the format "executionId:recipientId"
    // This is how Prisma represents composite IDs in the API
    const [executionId, recipientId] = executionRecipientIdParam.split(':');
    
    if (!executionId || !recipientId) {
      return errorResponse(res, 400, 'INVALID_ID_FORMAT', 'Invalid execution recipient ID format');
    }

    // Verify the execution recipient exists and belongs to the campaign
    const executionRecipient = await prisma.campaignExecutionRecipient.findUnique({
      where: {
        executionId_recipientId: {
          executionId,
          recipientId,
        },
      },
      include: {
        execution: {
          select: {
            id: true,
            campaignId: true,
          },
        },
      },
    });

    if (!executionRecipient) {
      return notFound(res);
    }

    // Verify the execution belongs to the campaign
    if (executionRecipient.execution.campaignId !== campaignIdParam) {
      return errorResponse(res, 400, 'INVALID_RELATIONSHIP', 'Execution recipient does not belong to the specified campaign');
    }

    // Prevent sending a recipient whose message was already handed to the
    // provider. SENT alone is not enough: a webhook advances it to DELIVERED
    // and then READ, and re-sending those would duplicate the message and
    // overwrite providerMessageId. FAILED stays sendable (retry semantics).
    if (isAlreadyDeliveredRecipient(executionRecipient.status)) {
      return errorResponse(res, 409, 'ALREADY_SENT', 'Execution recipient has already been sent');
    }

    // Send the execution recipient using the delivery service
    const deliveryService = new ExecutionDeliveryService();
    const result = await deliveryService.sendExecutionRecipient(executionRecipientIdParam);

    // Keep the parent execution in step with the recipient that was just sent.
    // The delivery service only updates the recipient row, and the manual send
    // endpoint does not pass through the queue worker, so without this the
    // execution would stay PENDING even though the message was sent.
    let executionStatus: string | null = null;
    try {
      executionStatus = await recalculateExecutionStatus(executionId);
    } catch {
      // A reconciliation failure must not mask a successful send.
      executionStatus = null;
    }

    recordAuditSafe('EXECUTION_RECIPIENT_SEND', req, {
      campaignId: campaignIdParam,
      executionId,
      recipientId,
      success: result.success,
      providerMessageId: result.providerMessageId,
      errorCode: result.errorCode,
    });

    // Return sanitized result
    return successResponse(res, {
      success: result.success,
      providerMessageId: result.providerMessageId,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      executionRecipientId: result.executionRecipientId,
      executionStatus,
    });
  } catch (error) {
    return errorResponse(res, 500, 'INTERNAL_ERROR', 'Failed to send execution recipient');
  }
};

export {
  markExecutionRunning,
  markExecutionCompleted,
  markExecutionFailed,
  cancelExecution,
};
