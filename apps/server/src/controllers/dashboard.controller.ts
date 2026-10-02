import { Request, Response } from 'express';
import { prisma } from '../config/db';

/**
 * GET /api/dashboard
 *
 * Minimal operational summary built entirely from real rows. No stored
 * counters, no mock values, no new analytics architecture: every number is a
 * count or a read of the tables the rest of the CMS already uses.
 */
export const getDashboardSummary = async (req: Request, res: Response) => {
  try {
    // Local calendar day for "today" in the server's own timezone, which is how
    // the rest of the app renders dates. The window is inclusive/exclusive so a
    // row is counted exactly once.
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfTomorrow = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);

    const [
      totalRecipients,
      activeRecipients,
      scheduledCampaigns,
      sentToday,
      deliveredToday,
      readToday,
      failedToday,
      nextSchedule,
      recentActivity,
    ] = await Promise.all([
      prisma.recipient.count(),
      prisma.recipient.count({ where: { status: 'ACTIVE' } }),
      // "Scheduled" means genuinely upcoming: a SCHEDULED plan whose send time
      // is still in the future. Stale development/test schedules whose
      // scheduledAt has already passed are NOT upcoming work and must not be
      // counted, otherwise the dashboard reports scheduled campaigns that can
      // never run.
      prisma.campaignSchedule.count({ where: { status: 'SCHEDULED', scheduledAt: { gt: now } } }),
      prisma.campaignExecutionRecipient.count({ where: { sentAt: { gte: startOfToday, lt: startOfTomorrow } } }),
      prisma.campaignExecutionRecipient.count({ where: { deliveredAt: { gte: startOfToday, lt: startOfTomorrow } } }),
      prisma.campaignExecutionRecipient.count({ where: { readAt: { gte: startOfToday, lt: startOfTomorrow } } }),
      prisma.campaignExecutionRecipient.count({ where: { status: 'FAILED', updatedAt: { gte: startOfToday, lt: startOfTomorrow } } }),
      // The nearest genuinely future SCHEDULED plan (stale past plans are skipped).
      prisma.campaignSchedule.findFirst({
        where: { status: 'SCHEDULED', scheduledAt: { gt: now } },
        orderBy: { scheduledAt: 'asc' },
        select: {
          id: true,
          scheduledAt: true,
          timezone: true,
          campaign: { select: { id: true, name: true, status: true } },
        },
      }),
      // A small, read-only slice of the existing History model.
      prisma.campaignExecutionRecipient.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 8,
        select: {
          executionId: true,
          recipientId: true,
          name: true,
          whatsappNumber: true,
          status: true,
          sentAt: true,
          deliveredAt: true,
          readAt: true,
          updatedAt: true,
          execution: { select: { id: true, campaign: { select: { name: true } } } },
        },
      }),
    ]);

    return res.json({
      success: true,
      data: {
        generatedAt: now.toISOString(),
        today: {
          from: startOfToday.toISOString(),
          to: startOfTomorrow.toISOString(),
        },
        totals: { totalRecipients, activeRecipients, scheduledCampaigns },
        todayCounts: { sentToday, deliveredToday, readToday, failedToday },
        nextScheduledCampaign: nextSchedule
          ? {
            scheduleId: nextSchedule.id,
            campaignId: nextSchedule.campaign.id,
            campaignName: nextSchedule.campaign.name,
            campaignStatus: nextSchedule.campaign.status,
            scheduledAt: nextSchedule.scheduledAt.toISOString(),
            timezone: nextSchedule.timezone,
          }
          : null,
        recentActivity: recentActivity.map((row) => ({
          executionId: row.executionId,
          campaignId: row.execution.id,
          campaignName: row.execution.campaign.name,
          recipientName: row.name,
          recipientPhone: row.whatsappNumber,
          status: row.status,
          sentAt: row.sentAt ? row.sentAt.toISOString() : null,
          deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
          readAt: row.readAt ? row.readAt.toISOString() : null,
          updatedAt: row.updatedAt.toISOString(),
        })),
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load dashboard summary' } });
  }
};
