import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { validateCampaignReadiness, CampaignIssue } from '../utils/campaignReadiness.util';
import { recordAuditSafe } from '../services/audit.service';

/**
 * Phase 4.3 — Campaign review & finalization.
 *
 * "READY" means only that the campaign configuration passed CMS validation.
 * It says nothing about execution, delivery or WhatsApp acceptance — those
 * belong to later phases.
 */

const campaignIdFrom = (req: Request): string | null => {
  const { id } = req.params;
  const campaignId = Array.isArray(id) ? id[0] : id;
  return typeof campaignId === 'string' && campaignId.trim().length > 0 && campaignId.length <= 200 ? campaignId.trim() : null;
};

const notFound = (res: Response) =>
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Campaign not found' } });

const notReady = (res: Response, issues: CampaignIssue[]) =>
  res.status(400).json({
    success: false,
    error: {
      code: 'CAMPAIGN_NOT_READY',
      message: 'Campaign is not ready',
      issues,
    },
  });

// Authoritative readiness snapshot for the review screen.
export const getCampaignReadiness = async (req: Request, res: Response) => {
  try {
    const campaignId = campaignIdFrom(req);
    if (!campaignId) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid campaign ID' } });
    }
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true },
    });
    if (!campaign) {
      return notFound(res);
    }

    const validation = await validateCampaignReadiness(campaignId);
    const audienceCount = await prisma.campaignRecipient.count({ where: { campaignId } });

    return res.json({ success: true, data: { ...validation, audienceCount } });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to check campaign readiness' } });
  }
};

// DRAFT -> READY. The only mutation ever performed here is the campaign
// status field; Message, Recipient, CampaignRecipient and Media rows are
// never created or modified by finalization.
export const finalizeCampaign = async (req: Request, res: Response) => {
  try {
    const campaignId = campaignIdFrom(req);
    if (!campaignId) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid campaign ID' } });
    }
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) {
      return notFound(res);
    }

    const validation = await validateCampaignReadiness(campaignId);

    // An archived campaign can never be finalized.
    if (campaign.status === 'ARCHIVED') {
      return notReady(res, [
        { code: 'CAMPAIGN_ARCHIVED', message: 'Archived campaigns cannot be finalized.' },
        ...validation.issues,
      ]);
    }

    if (!validation.valid) {
      return notReady(res, validation.issues);
    }

    // Idempotent: an already-READY campaign is returned unchanged.
    const previousStatus = campaign.status;
    if (campaign.status !== 'READY') {
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { status: 'READY' },
      });
    }

    if (previousStatus !== 'READY') {
      recordAuditSafe('CAMPAIGN_FINALIZE', req, { campaignId, previousStatus, status: 'READY' });
    }

    const finalCampaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        message: { select: { id: true, name: true, status: true } },
      },
    });

    return res.json({
      success: true,
      data: {
        campaign: finalCampaign,
        validation: { valid: true, issues: [] },
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to finalize campaign' } });
  }
};