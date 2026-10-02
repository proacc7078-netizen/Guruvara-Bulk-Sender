import { prisma } from '../config/db';

/**
 * Recipient permanent ("force") deletion.
 *
 * The normal DELETE /api/recipients/:id path refuses any recipient that still
 * belongs to a campaign audience. This service implements the *explicitly
 * confirmed* destructive alternative, reached only via confirm=true.
 *
 * Safety rules enforced here:
 *  - Runs as ONE prisma.$transaction, so a failure leaves nothing partially
 *    deleted.
 *  - Refuses outright while any related CampaignExecutionRecipient row is
 *    PENDING or RUNNING: deleting a live delivery's recipient would drop
 *    queued sends. Nothing is modified in that case.
 *  - Only ever removes records that belong to THIS recipient:
 *      CampaignRecipient memberships and CampaignExecutionRecipient history
 *      rows for that recipient. RecipientTag cascades from the recipient via
 *      the existing schema rules. Campaigns, Messages, Media and other
 *      recipients are never touched.
 */

const ACTIVE_RECIPIENT_STATUSES = ['PENDING', 'RUNNING'];

export interface RecipientForceDeleteCounts {
  recipientId: string;
  memberships: number;
  executionRecipients: number;
}

export interface RecipientForceDeleteResult {
  deleted: true;
  counts: RecipientForceDeleteCounts;
}

export class RecipientDeliveryInProgressError extends Error {
  readonly code = 'RECIPIENT_DELIVERY_IN_PROGRESS';
  readonly statusCode = 409;

  constructor() {
    super(
      'Recipient cannot be permanently deleted while delivery is still pending or running. ' +
        'Wait for delivery to finish, then try again.'
    );
    this.name = 'RecipientDeliveryInProgressError';
  }
}

export class RecipientNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  readonly statusCode = 404;

  constructor() {
    super('Recipient not found');
    this.name = 'RecipientNotFoundError';
  }
}

/**
 * Permanently deletes a recipient and only its own dependency rows.
 *
 * Order matters and is deliberate:
 *   1. Inspect CampaignExecutionRecipient rows; abort (unchanged) if any are
 *      PENDING/RUNNING.
 *   2. Delete CampaignRecipient memberships for this recipient only.
 *   3. Delete CampaignExecutionRecipient history rows for this recipient only.
 *   4. Delete the Recipient. RecipientTag rows cascade via the schema.
 */
export async function deleteRecipientForce(recipientId: string): Promise<RecipientForceDeleteResult> {
  const recipient = await prisma.recipient.findUnique({ where: { id: recipientId }, select: { id: true } });
  if (!recipient) {
    throw new RecipientNotFoundError();
  }

  const activeHistory = await prisma.campaignExecutionRecipient.count({
    where: { recipientId, status: { in: ACTIVE_RECIPIENT_STATUSES } },
  });
  if (activeHistory > 0) {
    // Nothing has been modified at this point.
    throw new RecipientDeliveryInProgressError();
  }

  const [membershipCount, historyCount] = await Promise.all([
    prisma.campaignRecipient.count({ where: { recipientId } }),
    prisma.campaignExecutionRecipient.count({ where: { recipientId } }),
  ]);

  await prisma.$transaction(async (tx) => {
    await tx.campaignRecipient.deleteMany({ where: { recipientId } });
    await tx.campaignExecutionRecipient.deleteMany({ where: { recipientId } });
    await tx.recipient.delete({ where: { id: recipientId } });
  });

  return {
    deleted: true,
    counts: { recipientId, memberships: membershipCount, executionRecipients: historyCount },
  };
}
