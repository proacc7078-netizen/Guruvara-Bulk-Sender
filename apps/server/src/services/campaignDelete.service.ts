import { prisma } from '../config/db';

/**
 * Campaign permanent ("force") deletion.
 *
 * The normal DELETE /api/campaigns/:id path refuses any campaign that has
 * execution history and points the operator at Archive, which is the correct
 * non-destructive default. This service implements the *explicitly confirmed*
 * destructive alternative, reached only via ?confirm=true.
 *
 * Product decision: a confirmed permanent deletion removes the campaign, its
 * schedule, its audience memberships, its executions and its
 * execution-recipient delivery history. Archive remains available and is
 * unchanged.
 *
 * Safety rules enforced here:
 *  - Runs as ONE prisma.$transaction, so a failure leaves nothing partially
 *    deleted. There is no intermediate state where history is gone but the
 *    campaign remains.
 *  - Refuses outright while any execution is PENDING or RUNNING: deleting a
 *    live delivery would drop queued messages on the floor. Nothing is
 *    modified in that case.
 *  - Only ever removes records that belong to THIS campaign. Message, Media,
 *    Recipient and RecipientTag are shared records and are never touched.
 *    CampaignSchedule and CampaignRecipient cascade from the campaign via the
 *    existing schema rules.
 */

const ACTIVE_EXECUTION_STATUSES = ['PENDING', 'RUNNING'];

export interface CampaignForceDeleteCounts {
  campaignId: string;
  executions: number;
  executionRecipients: number;
  audience: number;
  schedule: number;
}

export interface CampaignForceDeleteResult {
  deleted: true;
  counts: CampaignForceDeleteCounts;
}

export class CampaignDeliveryInProgressError extends Error {
  readonly code = 'CAMPAIGN_DELIVERY_IN_PROGRESS';
  readonly statusCode = 409;
  readonly activeExecutionCount: number;
  readonly activeExecutionIds: string[];

  constructor(activeExecutionIds: string[]) {
    const count = activeExecutionIds.length;
    super(
      `Campaign cannot be permanently deleted because ${count} execution${count === 1 ? ' is' : 's are'} still pending or running. ` +
        'Wait for delivery to finish, or archive the campaign instead.'
    );
    this.name = 'CampaignDeliveryInProgressError';
    this.activeExecutionCount = count;
    this.activeExecutionIds = activeExecutionIds;
  }
}

export class CampaignNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  readonly statusCode = 404;

  constructor() {
    super('Campaign not found');
    this.name = 'CampaignNotFoundError';
  }
}

/**
 * Permanently deletes a campaign and everything that belongs exclusively to it.
 *
 * Order matters and is deliberate:
 *   1. Inspect executions; abort (unchanged) if any are PENDING/RUNNING.
 *   2. Mark remaining non-terminal executions CANCELLED so the queue worker
 *      (which selects `status: { not: 'CANCELLED' }`) cannot pick one up while
 *      the transaction is in flight.
 *   3. Delete CampaignExecutionRecipient rows first — they are the delivery /
 *      read history and the deepest children.
 *   4. Delete CampaignExecution rows, releasing the Restrict FK on campaignId.
 *   5. Delete the Campaign. CampaignSchedule and CampaignRecipient are removed
 *      by the existing Cascade rules; we never delete them by hand so we cannot
 *      drift from the schema.
 */
export async function deleteCampaignForce(campaignId: string): Promise<CampaignForceDeleteResult> {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { id: true } });
  if (!campaign) {
    throw new CampaignNotFoundError();
  }

  const executions = await prisma.campaignExecution.findMany({
    where: { campaignId },
    select: { id: true, status: true },
  });

  const activeExecutions = executions.filter((e) => ACTIVE_EXECUTION_STATUSES.includes(e.status));
  if (activeExecutions.length > 0) {
    // Nothing has been modified at this point.
    throw new CampaignDeliveryInProgressError(activeExecutions.map((e) => e.id));
  }

  const executionIds = executions.map((e) => e.id);

  // Counts are snapshotted before the transaction so the audit metadata reflects
  // what is about to be removed; the actual deletes run atomically below.
  const [executionRecipientCount, audienceCount, scheduleCount] = await Promise.all([
    executionIds.length > 0
      ? prisma.campaignExecutionRecipient.count({ where: { executionId: { in: executionIds } } })
      : Promise.resolve(0),
    prisma.campaignRecipient.count({ where: { campaignId } }),
    prisma.campaignSchedule.count({ where: { campaignId } }),
  ]);

  await prisma.$transaction(async (tx) => {
    // Step 2: neutralise anything the worker could still consider runnable.
    if (executionIds.length > 0) {
      await tx.campaignExecution.updateMany({
        where: { campaignId, status: { notIn: ['CANCELLED'] } },
        data: { status: 'CANCELLED' },
      });

      // Step 3: delivery / read history for this campaign only.
      await tx.campaignExecutionRecipient.deleteMany({
        where: { executionId: { in: executionIds } },
      });

      // Step 4: release the Restrict FK on CampaignExecution.campaignId.
      await tx.campaignExecution.deleteMany({ where: { campaignId } });
    }

    // Step 5: the campaign itself (schedule + audience cascade).
    await tx.campaign.delete({ where: { id: campaignId } });
  });

  return {
    deleted: true,
    counts: {
      campaignId,
      executions: executions.length,
      executionRecipients: executionRecipientCount,
      audience: audienceCount,
      schedule: scheduleCount,
    },
  };
}