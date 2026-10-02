import { prisma } from '../config/db';
import { Prisma } from '@prisma/client';

export const EXECUTION_STATUSES = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/**
 * CampaignExecutionRecipient statuses that prove the message was ALREADY handed
 * to the WhatsApp provider. A row in one of these states must never be sent
 * again: the provider has accepted it, so a second send would deliver a
 * duplicate message and overwrite providerMessageId, orphaning the original
 * message's webhook linkage.
 *
 * A provider webhook advances SENT to DELIVERED and then READ, so a narrow
 * `status === 'SENT'` check lets a delivered/read message be re-sent.
 *
 * FAILED is deliberately NOT included. A FAILED row means the provider never
 * accepted the message, and the application relies on being able to send it
 * again: the automatic retry path resets a retryable failure to PENDING with a
 * nextAttemptAt (executionDelivery.service.ts), and the manual send path is
 * documented and tested to re-send a FAILED recipient.
 *
 * This is deliberately NOT the queue worker's TERMINAL_RECIPIENT_STATUSES. That
 * set answers "may this parent EXECUTION be finalized?" and is only consulted
 * after delivery; the worker never re-sends because its query filters
 * `status: 'PENDING'`. This set answers the different question "has this
 * message already been sent?".
 */
export const ALREADY_DELIVERED_RECIPIENT_STATUSES = ['SENT', 'DELIVERED', 'READ'] as const;

export function isAlreadyDeliveredRecipient(
  status: string | null | undefined
): boolean {
  return (
    typeof status === 'string' &&
    (ALREADY_DELIVERED_RECIPIENT_STATUSES as readonly string[]).includes(status)
  );
}

const LEGAL_TRANSITIONS: Record<ExecutionStatus, ExecutionStatus[]> = {
  PENDING: ['RUNNING', 'CANCELLED'],
  RUNNING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: ['PENDING'],
  CANCELLED: [],
};

export interface InvalidTransitionError {
  code: 'INVALID_EXECUTION_TRANSITION';
  message: string;
  currentStatus: ExecutionStatus;
  targetStatus: ExecutionStatus;
  allowedNext: ExecutionStatus[];
}

export function validateTransition(currentStatus: ExecutionStatus, targetStatus: ExecutionStatus):
  | { ok: true }
  | { ok: false; error: InvalidTransitionError } {
  const allowed = LEGAL_TRANSITIONS[currentStatus] ?? [];
  if (allowed.includes(targetStatus)) {
    return { ok: true };
  }
  return {
    ok: false,
    error: {
      code: 'INVALID_EXECUTION_TRANSITION',
      message: `Cannot transition from ${currentStatus} to ${targetStatus}`,
      currentStatus,
      targetStatus,
      allowedNext: allowed,
    },
  };
}

type ExecutionError = { code: string; message: string };

export interface ExecutionSnapshotResult {
  ok: true;
  execution: Prisma.CampaignExecutionGetPayload<{}>;
}

export interface ExecutionAlreadyExistsResult {
  ok: true;
  execution: Prisma.CampaignExecutionGetPayload<{}>;
  alreadyExisted: true;
}

export interface ExecutionCreatedResult {
  ok: true;
  execution: Prisma.CampaignExecutionGetPayload<{}>;
  alreadyExisted: false;
}

export type ExecutionSnapshotOutcome =
  | ExecutionSnapshotResult
  | ExecutionAlreadyExistsResult
  | ExecutionCreatedResult
  | { ok: false; error: ExecutionError };

/**
 * Creates the immutable execution snapshot for a campaign's current schedule.
 *
 * `allowRerun` supports "Run Again": a campaign is reusable, so several
 * executions may exist for the same campaign (and for the same schedule row).
 * Without it, the previous behaviour applies — an existing execution for this
 * schedule is returned instead of creating a duplicate, which is what keeps the
 * scheduler idempotent. Each execution keeps its own recipient/message/media
 * snapshot, so earlier runs are never modified or destroyed.
 */
export async function createExecutionSnapshot(
  campaignId: string,
  options: { allowRerun?: boolean } = {}
): Promise<ExecutionSnapshotOutcome> {
  const allowRerun = options.allowRerun === true;

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
  });
  if (!campaign) {
    return { ok: false, error: { code: 'CAMPAIGN_NOT_FOUND', message: 'Campaign not found' } };
  }

  if (campaign.status !== 'READY') {
    return { ok: false, error: { code: 'CAMPAIGN_NOT_READY', message: 'Campaign is not READY' } };
  }

  const schedule = await prisma.campaignSchedule.findUnique({
    where: { campaignId },
  });
  if (!schedule) {
    return { ok: false, error: { code: 'SCHEDULE_NOT_FOUND', message: 'Campaign has no schedule' } };
  }

  if (schedule.status !== 'SCHEDULED') {
    return { ok: false, error: { code: 'SCHEDULE_NOT_SCHEDULED', message: 'Schedule is not SCHEDULED' } };
  }

  // Reuse guard. When re-running, an existing execution for this schedule is
  // intentionally ignored so a NEW execution is created. Otherwise the
  // existing row is returned, which is the scheduler's idempotency guarantee.
  if (!allowRerun) {
    const existing = await prisma.campaignExecution.findFirst({
      where: { scheduleId: schedule.id },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      return { ok: true, execution: existing, alreadyExisted: true };
    }
  }

  const message = await prisma.message.findUnique({
    where: { id: campaign.messageId ?? '' },
    include: { media: true },
  });
  if (!message) {
    return { ok: false, error: { code: 'MESSAGE_NOT_FOUND', message: 'Campaign message not found' } };
  }

  if (message.status === 'ARCHIVED') {
    return { ok: false, error: { code: 'MESSAGE_ARCHIVED', message: 'Campaign message is archived' } };
  }

  if (!message.body || !message.body.trim()) {
    return { ok: false, error: { code: 'MESSAGE_EMPTY', message: 'Campaign message body is empty' } };
  }

  const audienceMemberships = await prisma.campaignRecipient.findMany({
    where: { campaignId },
    include: { recipient: true },
  });

  if (audienceMemberships.length === 0) {
    return { ok: false, error: { code: 'AUDIENCE_EMPTY', message: 'Campaign has no audience recipients' } };
  }

  const recipientIds = audienceMemberships.map((m) => m.recipientId);
  const foundRecipients = await prisma.recipient.findMany({
    where: { id: { in: recipientIds } },
    select: { id: true },
  });
  if (foundRecipients.length !== recipientIds.length) {
    return { ok: false, error: { code: 'AUDIENCE_RECIPIENT_MISSING', message: 'One or more audience recipients no longer exist' } };
  }

  const execution = await prisma.$transaction(async (tx) => {
    const created = await tx.campaignExecution.create({
      data: {
        campaignId,
        scheduleId: schedule.id,
        status: 'PENDING',
        scheduledAt: schedule.scheduledAt,
        messageId: campaign.messageId ?? null,
        messageName: message.name,
        messageBody: message.body,
        messageLanguage: message.language ?? null,
        mediaId: message.media?.id ?? null,
        mediaPath: message.media?.storagePath ?? null,
      },
    });

    const recipientRows = audienceMemberships.map((membership) => ({
      executionId: created.id,
      recipientId: membership.recipientId,
      whatsappNumber: membership.recipient.whatsappNumber,
      name: membership.recipient.name,
    }));

    if (recipientRows.length > 0) {
      await tx.campaignExecutionRecipient.createMany({
        data: recipientRows,
      });
    }

    return created;
  });

  return { ok: true, execution, alreadyExisted: false };
}

export async function markExecutionRunning(executionId: string): Promise<Prisma.CampaignExecutionGetPayload<{}>> {
  const execution = await prisma.campaignExecution.findUnique({ where: { id: executionId } });
  if (!execution) {
    throw new Error('Execution not found');
  }
  const validation = validateTransition(execution.status as ExecutionStatus, 'RUNNING');
  if (!validation.ok) {
    throw new Error(validation.error.message);
  }
  return prisma.campaignExecution.update({
    where: { id: executionId },
    data: {
      status: 'RUNNING',
      startedAt: new Date(),
      attemptCount: { increment: 1 },
    },
  });
}

export async function markExecutionCompleted(executionId: string): Promise<Prisma.CampaignExecutionGetPayload<{}>> {
  const execution = await prisma.campaignExecution.findUnique({ where: { id: executionId } });
  if (!execution) {
    throw new Error('Execution not found');
  }
  const validation = validateTransition(execution.status as ExecutionStatus, 'COMPLETED');
  if (!validation.ok) {
    throw new Error(validation.error.message);
  }
  return prisma.campaignExecution.update({
    where: { id: executionId },
    data: {
      status: 'COMPLETED',
      completedAt: new Date(),
    },
  });
}

export async function markExecutionFailed(executionId: string, errorMessage?: string): Promise<Prisma.CampaignExecutionGetPayload<{}>> {
  const execution = await prisma.campaignExecution.findUnique({ where: { id: executionId } });
  if (!execution) {
    throw new Error('Execution not found');
  }
  const validation = validateTransition(execution.status as ExecutionStatus, 'FAILED');
  if (!validation.ok) {
    throw new Error(validation.error.message);
  }
  return prisma.campaignExecution.update({
    where: { id: executionId },
    data: {
      status: 'FAILED',
      failedAt: new Date(),
      errorMessage: errorMessage ?? null,
    },
  });
}

export async function retryExecution(executionId: string): Promise<Prisma.CampaignExecutionGetPayload<{}>> {
  const execution = await prisma.campaignExecution.findUnique({ where: { id: executionId } });
  if (!execution) {
    throw new Error('Execution not found');
  }
  const validation = validateTransition(execution.status as ExecutionStatus, 'PENDING');
  if (!validation.ok) {
    throw new Error(validation.error.message);
  }
  return prisma.campaignExecution.update({
    where: { id: executionId },
    data: {
      status: 'PENDING',
      attemptCount: { increment: 1 },
      errorMessage: null,
    },
  });
}

export async function cancelExecution(executionId: string): Promise<Prisma.CampaignExecutionGetPayload<{}>> {
  const execution = await prisma.campaignExecution.findUnique({ where: { id: executionId } });
  if (!execution) {
    throw new Error('Execution not found');
  }
  if (execution.status === 'CANCELLED') {
    return execution;
  }
  if (execution.status === 'RUNNING') {
    throw new Error('Cannot cancel a RUNNING execution');
  }
  if (execution.status === 'COMPLETED') {
    throw new Error('Cannot cancel a COMPLETED execution');
  }
  if (execution.status === 'FAILED') {
    throw new Error('Cannot cancel a FAILED execution');
  }
  return prisma.campaignExecution.update({
    where: { id: executionId },
    data: { status: 'CANCELLED' },
  });
}

export interface SerializedExecution {
  id: string;
  campaignId: string;
  scheduleId: string | null;
  status: string;
  scheduledAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  errorMessage: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

export const serializeExecution = (execution: {
  id: string;
  campaignId: string;
  scheduleId: string | null;
  status: string;
  scheduledAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  errorMessage: string | null;
  attemptCount: number;
  createdAt: Date;
  updatedAt: Date;
}): SerializedExecution => ({
  id: execution.id,
  campaignId: execution.campaignId,
  scheduleId: execution.scheduleId,
  status: execution.status,
  scheduledAt: execution.scheduledAt.toISOString(),
  startedAt: execution.startedAt ? execution.startedAt.toISOString() : null,
  completedAt: execution.completedAt ? execution.completedAt.toISOString() : null,
  failedAt: execution.failedAt ? execution.failedAt.toISOString() : null,
  errorMessage: execution.errorMessage,
  attemptCount: execution.attemptCount,
  createdAt: execution.createdAt.toISOString(),
  updatedAt: execution.updatedAt.toISOString(),
});
