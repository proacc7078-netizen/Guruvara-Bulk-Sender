import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { campaignStatusResetOperation } from '../utils/campaignReadiness.util';
import { recordAuditSafe } from '../services/audit.service';

/**
 * Phase 4.2 — Campaign audience (membership) endpoints.
 *
 * The audience is a snapshot of *which* recipients were selected for a campaign.
 * Only the recipient ID is stored (see the CampaignRecipient model); recipient
 * personal data stays in the Recipient table and is read live on GET.
 *
 * This controller deliberately contains no scheduling, sending, queue or
 * delivery logic — those belong to later phases.
 */

// Protects the endpoint from absurd payloads without limiting real usage.
const MAX_CAMPAIGN_RECIPIENTS = 5000;

// Fields reserved for later campaign execution / queue phases.
const FORBIDDEN_FIELDS = [
  'sentAt',
  'deliveryStatus',
  'providerMessageId',
  'retryCount',
  'errorMessage',
  'scheduledAt',
  'queueId',
  'whatsappMessageId',
];

// Only what the audience selector needs — no consent/notes/timestamps.
const RECIPIENT_SUMMARY_SELECT = {
  id: true,
  name: true,
  whatsappNumber: true,
  normalizedPhone: true,
  language: true,
  category: true,
  status: true,
  source: true,
  tags: { include: { tag: true } },
} as const;

const findForbiddenField = (body: Record<string, unknown>): string | null => {
  for (const field of FORBIDDEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) return field;
  }
  return null;
};

const validationError = (res: Response, message: string) =>
  res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message } });

const notFound = (res: Response) =>
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Campaign not found' } });

const internalError = (res: Response) =>
  res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update campaign audience' } });

const campaignIdFrom = (req: Request): string | null => {
  const { id } = req.params;
  const campaignId = Array.isArray(id) ? id[0] : id;
  return typeof campaignId === 'string' && campaignId.trim().length > 0 && campaignId.length <= 200 ? campaignId.trim() : null;
};

const loadAudience = async (campaignId: string) => {
  const memberships = await prisma.campaignRecipient.findMany({
    where: { campaignId },
    orderBy: { createdAt: 'asc' },
    select: { recipient: { select: RECIPIENT_SUMMARY_SELECT } },
  });
  return memberships.map((membership) => membership.recipient);
};

export const getCampaignAudience = async (req: Request, res: Response) => {
  try {
    const campaignId = campaignIdFrom(req);
    if (!campaignId) {
      return validationError(res, 'Invalid campaign ID');
    }

    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true },
    });
    if (!campaign) {
      return notFound(res);
    }

    const audience = await loadAudience(campaignId);
    return res.json({ success: true, data: audience });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch campaign audience' } });
  }
};

export const updateCampaignAudience = async (req: Request, res: Response) => {
  try {
    const campaignId = campaignIdFrom(req);
    if (!campaignId) {
      return validationError(res, 'Invalid campaign ID');
    }
    const body = (req.body ?? {}) as Record<string, unknown>;

    const forbidden = findForbiddenField(body);
    if (forbidden) {
      return validationError(res, `Field "${forbidden}" is not supported for campaign audiences`);
    }

    // 1. The campaign must exist.
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, status: true },
    });
    if (!campaign) {
      return notFound(res);
    }

    // 2. Validate the payload shape before touching any membership row.
    const { recipientIds } = body;
    if (!Array.isArray(recipientIds)) {
      return validationError(res, 'recipientIds must be an array');
    }
    if (recipientIds.length > MAX_CAMPAIGN_RECIPIENTS) {
      return validationError(res, `Audience cannot contain more than ${MAX_CAMPAIGN_RECIPIENTS} recipients`);
    }

    const normalizedIds: string[] = [];
    for (const value of recipientIds) {
      if (typeof value !== 'string' || !value.trim()) {
        return validationError(res, 'Every recipient ID must be a non-empty string');
      }
      normalizedIds.push(value.trim());
    }

    // Deduplicate — the submitted set is what matters, not how it was typed.
    const uniqueIds = Array.from(new Set(normalizedIds));

    // 3. Every recipient must exist (all-or-nothing: no partial update).
    if (uniqueIds.length > 0) {
      const found = await prisma.recipient.findMany({
        where: { id: { in: uniqueIds } },
        select: { id: true },
      });
      if (found.length !== uniqueIds.length) {
        const foundIds = new Set(found.map((recipient) => recipient.id));
        const missingIds = uniqueIds.filter((id) => !foundIds.has(id));
        return validationError(
          res,
          `Unknown recipient ID${missingIds.length === 1 ? '' : 's'}: ${missingIds.slice(0, 5).join(', ')}`
        );
      }
    }

    // 4. Replace the membership atomically. An empty array clears the audience.
    const current = await prisma.campaignRecipient.findMany({
      where: { campaignId },
      select: { recipientId: true },
    });
    const currentIds = new Set(current.map((membership) => membership.recipientId));
    const nextIds = new Set(uniqueIds);
    const audienceChanged =
      currentIds.size !== nextIds.size ||
      Array.from(nextIds).some((recipientId) => !currentIds.has(recipientId));

    const operations: Prisma.PrismaPromise<unknown>[] = [prisma.campaignRecipient.deleteMany({ where: { campaignId } })];
    if (uniqueIds.length > 0) {
      operations.push(
        prisma.campaignRecipient.createMany({
          data: uniqueIds.map((recipientId) => ({ campaignId, recipientId })),
        })
      );
    }
    // Phase 4.3: saving a different audience on a READY campaign invalidates
    // its reviewed configuration — demote to DRAFT inside the same transaction.
    if (audienceChanged && campaign.status === 'READY') {
      operations.push(campaignStatusResetOperation(campaignId));
    }
    await prisma.$transaction(operations);

    recordAuditSafe('CAMPAIGN_AUDIENCE_UPDATE', req, {
      campaignId,
      recipientCount: uniqueIds.length,
      audienceChanged,
    });

    const audience = await loadAudience(campaignId);
    return res.json({ success: true, data: audience });
  } catch (error) {
    return internalError(res);
  }
};