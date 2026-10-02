import { prisma } from '../../config/db';
import { validateWebhookConfig, loadWhatsAppWebhookConfig } from './config';

export type WhatsAppWebhookStatus = 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

export interface NormalizedWebhookEvent {
  providerMessageId: string;
  status: WhatsAppWebhookStatus;
  recipientPhone?: string;
  timestamp?: Date;
  errorCode?: string;
  errorMessage?: string;
}

export interface WebhookProcessResult {
  success: boolean;
  executionRecipientId?: string;
  statusUpdated?: boolean;
  executionStatusUpdated?: boolean;
  error?: string;
}

/**
 * Normalizes Meta Cloud API webhook status events.
 * Returns an array of normalized events from the raw webhook payload.
 */
export function normalizeWebhookEvents(payload: unknown): NormalizedWebhookEvent[] {
  const events: NormalizedWebhookEvent[] = [];

  if (!payload || typeof payload !== 'object') {
    return events;
  }

  const root = payload as Record<string, unknown>;
  const entry = root.entry;

  if (!Array.isArray(entry)) {
    return events;
  }

  for (const entryItem of entry) {
    if (!entryItem || typeof entryItem !== 'object') continue;
    const changes = (entryItem as Record<string, unknown>).changes;

    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      if (!change || typeof change !== 'object') continue;
      const value = (change as Record<string, unknown>).value;

      if (!value || typeof value !== 'object') continue;
      const statuses = (value as Record<string, unknown>).statuses;

      if (!Array.isArray(statuses)) continue;

      for (const statusItem of statuses) {
        if (!statusItem || typeof statusItem !== 'object') continue;

        const id = (statusItem as Record<string, unknown>).id;
        const status = (statusItem as Record<string, unknown>).status;
        const timestamp = (statusItem as Record<string, unknown>).timestamp;
        const recipientId = (statusItem as Record<string, unknown>).recipient_id;
        const errors = (statusItem as Record<string, unknown>).errors;

        if (typeof id !== 'string' || typeof status !== 'string') continue;

        const normalizedStatus = normalizeStatus(status);
        if (!normalizedStatus) continue;

        let errorCode: string | undefined;
        let errorMessage: string | undefined;

        if (Array.isArray(errors) && errors.length > 0) {
          const firstError = errors[0] as Record<string, unknown>;
          errorCode = typeof firstError.code === 'string' ? firstError.code : undefined;
          errorMessage = typeof firstError.title === 'string' ? firstError.title :
            typeof firstError.message === 'string' ? firstError.message : undefined;
        }

        events.push({
          providerMessageId: id,
          status: normalizedStatus,
          recipientPhone: typeof recipientId === 'string' ? recipientId : undefined,
          timestamp: typeof timestamp === 'string' ? new Date(parseInt(timestamp, 10) * 1000) :
            timestamp instanceof Date ? timestamp : undefined,
          errorCode,
          errorMessage,
        });
      }
    }
  }

  return events;
}

function normalizeStatus(status: string): WhatsAppWebhookStatus | null {
  const upper = status.toUpperCase();
  if (upper === 'SENT' || upper === 'DELIVERED' || upper === 'READ' || upper === 'FAILED') {
    return upper as WhatsAppWebhookStatus;
  }
  return null;
}

/**
 * Delivery-status invariant (single source of truth).
 *
 * The stored `status` must always reflect the strongest known delivery
 * evidence. Timestamps are the evidence; the status is derived from them:
 *
 *   readAt      != null  -> READ       (wins outright)
 *   deliveredAt != null  -> DELIVERED
 *   sentAt      != null  -> SENT
 *   otherwise            -> keep the current status (PENDING/RUNNING/FAILED)
 *
 * OpenWA can emit READ without a preceding DELIVERED event, so DELIVERED is
 * NOT required before READ. A record must never show SENT together with a
 * populated readAt.
 */
export interface DeliveryStatusEvidence {
  status: string;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
}

export function resolveDeliveryStatus(e: DeliveryStatusEvidence): { status: string } {
  if (e.readAt) return { status: 'READ' };
  if (e.deliveredAt) return { status: 'DELIVERED' };
  if (e.sentAt) return { status: 'SENT' };
  return { status: e.status };
}

/**
 * Monotonic status progression check.
 * Returns true if the transition is allowed (forward or same state).
 */
export function isValidStatusTransition(currentStatus: string, newStatus: WhatsAppWebhookStatus): boolean {
  const current = currentStatus.toUpperCase();
  const target = newStatus;

  // Same status is always allowed (idempotent)
  if (current === target) return true;

  // Define allowed forward transitions
  const order: Record<WhatsAppWebhookStatus, number> = {
    SENT: 1,
    DELIVERED: 2,
    READ: 3,
    FAILED: 4, // FAILED is terminal but we allow it to be set from any state
  };

  const currentOrder = order[current as WhatsAppWebhookStatus];
  const targetOrder = order[target];

  // If current status is not in our order, allow transition (unknown/legacy)
  if (currentOrder === undefined) return true;

  // FAILED can be set from any state
  if (target === 'FAILED') return true;

  // Only allow forward transitions
  return targetOrder > currentOrder;
}

/**
 * Finds an execution recipient by provider message ID.
 */
export async function findRecipientByProviderMessageId(
  providerMessageId: string
): Promise<{ executionId: string; recipientId: string; status: string } | null> {
  const recipient = await prisma.campaignExecutionRecipient.findFirst({
    where: { providerMessageId },
    select: { executionId: true, recipientId: true, status: true },
  });

  if (!recipient) return null;

  return {
    executionId: recipient.executionId,
    recipientId: recipient.recipientId,
    status: recipient.status,
  };
}

/**
 * Updates the execution recipient with the webhook status.
 * Returns true if the status was actually updated.
 */
export async function updateRecipientStatus(
  executionId: string,
  recipientId: string,
  event: NormalizedWebhookEvent
): Promise<{ updated: boolean; oldStatus: string; newStatus: string }> {
  const current = await prisma.campaignExecutionRecipient.findUnique({
    where: { executionId_recipientId: { executionId, recipientId } },
    select: { status: true, attemptCount: true, nextAttemptAt: true, sentAt: true, deliveredAt: true, readAt: true },
  });

  if (!current) {
    return { updated: false, oldStatus: '', newStatus: '' };
  }

  const currentStatus = current.status.toUpperCase();

  // Check monotonic progression
  if (!isValidStatusTransition(currentStatus, event.status)) {
    // Ignore backward transition, but still return current status
    return { updated: false, oldStatus: current.status, newStatus: current.status };
  }

  // Prepare update data
  const updateData: Record<string, unknown> = {
    status: event.status,
  };

  // Clear retry scheduling on any terminal webhook status
  if (event.status === 'SENT' || event.status === 'DELIVERED' || event.status === 'READ') {
    updateData.nextAttemptAt = null;
    updateData.errorCode = null;
    updateData.errorMessage = null;
  } else if (event.status === 'FAILED') {
    // Preserve webhook error information
    updateData.webhookErrorCode = event.errorCode ?? null;
    updateData.webhookErrorMessage = event.errorMessage ?? null;
    updateData.nextAttemptAt = null;
  }

  // Add timestamps. An already-recorded delivery/read instant is never
  // overwritten: duplicate or replayed webhooks (OpenWA retries) and stale
  // out-of-order events must not rewrite the original observation. First wins.
  if (event.status === 'DELIVERED' && !current.deliveredAt) {
    updateData.deliveredAt = event.timestamp ?? new Date();
  }
  if (event.status === 'READ' && !current.readAt) {
    updateData.readAt = event.timestamp ?? new Date();
  }

  // Enforce the status invariant against the timestamps that will be persisted.
  // A READ event with no prior DELIVERED still yields READ, and the status can
  // never end up weaker than the evidence already recorded.
  //
  // `event.status` (NOT the previous status) is passed in as the fallback: a
  // terminal FAILED event never carries sentAt/deliveredAt/readAt, so
  // resolveDeliveryStatus() falls through to this value. Passing the previous
  // status here made FAILED a no-op — the error was captured but the status
  // stayed at its old value (SENT/PENDING) and the execution never failed.
  updateData.status = resolveDeliveryStatus({
    status: event.status,
    sentAt: current.sentAt ?? (event.status === 'SENT' || event.status === 'DELIVERED' || event.status === 'READ'
      ? (event.timestamp ?? new Date())
      : null),
    deliveredAt: (updateData.deliveredAt as Date | undefined) ?? current.deliveredAt,
    readAt: (updateData.readAt as Date | undefined) ?? current.readAt,
  }).status;

  await prisma.campaignExecutionRecipient.update({
    where: { executionId_recipientId: { executionId, recipientId } },
    data: updateData,
  });

  return { updated: true, oldStatus: current.status, newStatus: event.status };
}

/**
 * Recalculates execution status based on recipient states.
 * Returns the new execution status if changed, null otherwise.
 */
export async function recalculateExecutionStatus(executionId: string): Promise<string | null> {
  const recipients = await prisma.campaignExecutionRecipient.findMany({
    where: { executionId },
    select: { status: true },
  });

  if (recipients.length === 0) return null;

  // Check if any recipient is still in a pending state (PENDING or RUNNING)
  const anyPendingOrRunning = recipients.some((r) =>
    r.status === 'PENDING' || r.status === 'RUNNING'
  );

  if (anyPendingOrRunning) {
    return null; // Execution still in progress
  }

  // Check for FAILED recipients
  const anyFailed = recipients.some((r) => r.status === 'FAILED');
  const allTerminal = recipients.every((r) =>
    r.status === 'SENT' || r.status === 'DELIVERED' || r.status === 'READ' || r.status === 'FAILED'
  );

  const execution = await prisma.campaignExecution.findUnique({
    where: { id: executionId },
    select: { status: true },
  });

  if (!execution) return null;

  let currentExecStatus = execution.status;

  // If all recipients are in terminal states, finalize the execution. The
  // parent may still be PENDING when delivery happened through the manual
  // send endpoint (which never marks the parent RUNNING), so promote it to
  // RUNNING first rather than leaving a sent execution stuck at PENDING.
  if (allTerminal && (currentExecStatus === 'PENDING' || currentExecStatus === 'RUNNING')) {
    if (currentExecStatus === 'PENDING') {
      const promoted = await prisma.campaignExecution.update({
        where: { id: executionId },
        data: { status: 'RUNNING', startedAt: new Date() },
      });
      currentExecStatus = promoted.status;
    }

    if (anyFailed) {
      // Some failed - execution is FAILED
      await prisma.campaignExecution.update({
        where: { id: executionId },
        data: {
          status: 'FAILED',
          failedAt: new Date(),
          errorMessage: 'One or more recipients failed (webhook)',
        },
      });
      return 'FAILED';
    } else {
      // All successful (SENT, DELIVERED, or READ) - execution is COMPLETED
      await prisma.campaignExecution.update({
        where: { id: executionId },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
        },
      });
      return 'COMPLETED';
    }
  }

  return null;
}

/**
 * Processes a batch of normalized webhook events.
 */
export async function processWebhookEvents(events: NormalizedWebhookEvent[]): Promise<WebhookProcessResult[]> {
  const results: WebhookProcessResult[] = [];

  for (const event of events) {
    try {
      const recipient = await findRecipientByProviderMessageId(event.providerMessageId);

      if (!recipient) {
        // Unknown provider message ID - silently ignore (idempotent)
        results.push({ success: true, error: 'Unknown provider message ID' });
        continue;
      }

      const updateResult = await updateRecipientStatus(
        recipient.executionId,
        recipient.recipientId,
        event
      );

      let executionStatusUpdated = false;
      if (updateResult.updated) {
        const newExecStatus = await recalculateExecutionStatus(recipient.executionId);
        executionStatusUpdated = !!newExecStatus;
      }

      results.push({
        success: true,
        executionRecipientId: `${recipient.executionId}:${recipient.recipientId}`,
        statusUpdated: updateResult.updated,
        executionStatusUpdated,
      });
    } catch (error) {
      results.push({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return results;
}

/**
 * Validates the webhook configuration is present.
 * Used by the controller to return appropriate errors.
 */
export function getWebhookConfigState(): { configured: boolean; error: Error | null } {
  const config = loadWhatsAppWebhookConfig();
  return validateWebhookConfig(config);
}

export { loadWhatsAppWebhookConfig };