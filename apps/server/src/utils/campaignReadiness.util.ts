import { prisma } from '../config/db';

/**
 * Phase 4.3 — Campaign readiness validation.
 *
 * Single authoritative server-side check used by the review screen and the
 * finalize endpoint. "READY" means: the campaign configuration has passed CMS
 * validation. It says nothing about execution, delivery or WhatsApp acceptance
 * — those meanings belong to later phases.
 */

export interface CampaignIssue {
  code: string;
  message: string;
}

export interface CampaignReadiness {
  valid: boolean;
  issues: CampaignIssue[];
}

const CAMPAIGN_STATUSES = ['DRAFT', 'READY', 'ARCHIVED'];

export async function validateCampaignReadiness(campaignId: string): Promise<CampaignReadiness> {
  const issues: CampaignIssue[] = [];

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { message: { include: { media: true } } },
  });

  if (!campaign) {
    return {
      valid: false,
      issues: [{ code: 'CAMPAIGN_NOT_FOUND', message: 'Campaign not found' }],
    };
  }

  // CAMPAIGN checks
  if (!campaign.name || !campaign.name.trim()) {
    issues.push({ code: 'NAME_REQUIRED', message: 'Campaign name is required.' });
  }
  if (!CAMPAIGN_STATUSES.includes(campaign.status)) {
    issues.push({ code: 'STATUS_INVALID', message: 'Campaign status is invalid.' });
  }

  // MESSAGE checks
  if (!campaign.messageId) {
    issues.push({ code: 'MESSAGE_REQUIRED', message: 'Select a message.' });
  } else if (!campaign.message) {
    issues.push({ code: 'MESSAGE_NOT_FOUND', message: 'The selected message no longer exists.' });
  } else {
    if (campaign.message.status === 'ARCHIVED') {
      issues.push({ code: 'MESSAGE_ARCHIVED', message: 'The selected message is archived.' });
    }
    if (!campaign.message.body || !campaign.message.body.trim()) {
      issues.push({ code: 'MESSAGE_EMPTY', message: 'The selected message has no content.' });
    }
    // MEDIA is optional. If a media record is associated it is verified through
    // the relation above; a dangling media row cannot exist (FK + SetNull).
  }

  // AUDIENCE checks — every membership must resolve to a real recipient.
  const memberships = await prisma.campaignRecipient.findMany({
    where: { campaignId },
    select: { recipientId: true },
  });
  if (memberships.length === 0) {
    issues.push({ code: 'AUDIENCE_EMPTY', message: 'Add at least one recipient.' });
  } else {
    const recipientIds = memberships.map((membership) => membership.recipientId);
    const found = await prisma.recipient.findMany({
      where: { id: { in: recipientIds } },
      select: { id: true },
    });
    if (found.length !== recipientIds.length) {
      issues.push({
        code: 'AUDIENCE_RECIPIENT_MISSING',
        message: 'One or more audience recipients no longer exist.',
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Prisma operation that returns a READY campaign to DRAFT. Lives here (not in
 * the audience controller) so the audience save transaction can demote a
 * modified READY campaign without owning campaign mutation logic.
 */
export const campaignStatusResetOperation = (campaignId: string) =>
  prisma.campaign.update({ where: { id: campaignId }, data: { status: 'DRAFT' } });