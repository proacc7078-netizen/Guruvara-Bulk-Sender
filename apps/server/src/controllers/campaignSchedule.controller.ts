import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import {
  checkCampaignSchedulable,
  findCampaignSchedule,
  serializeSchedule,
  validateScheduleInput,
  SerializedSchedule,
  ScheduleIssue,
} from '../utils/campaignSchedule.util';
import { recordAuditSafe } from '../services/audit.service';

/**
 * Phase 4.4 — Campaign scheduling (persistence + management only).
 *
 * This controller stores WHEN a campaign is planned to run. It never sends,
 * dispatches, retries or tracks anything, and it never changes the campaign's
 * own status: a READY campaign stays READY once a schedule exists.
 *
 * A campaign has at most one schedule row (`campaignId` is unique). Cancelling
 * keeps that row as CANCELLED so the plan's history survives; scheduling again
 * reuses it.
 */

const campaignIdFrom = (req: Request): string | null => {
  const { id } = req.params;
  const campaignId = Array.isArray(id) ? id[0] : id;
  return typeof campaignId === 'string' && campaignId.trim().length > 0 && campaignId.length <= 200 ? campaignId.trim() : null;
};

// The project-wide response envelope is preserved, and the schedule is also
// exposed as a top-level `schedule` key so the documented contract
// ({ schedule: {...} } / { schedule: null }) is satisfied directly.
const scheduleResponse = (res: Response, schedule: SerializedSchedule | null, status = 200) =>
  res.status(status).json({
    success: true,
    data: { schedule },
    schedule,
  });

const scheduleError = (
  res: Response,
  status: number,
  code: string,
  message: string,
  issues: ScheduleIssue[] = []
) =>
  res.status(status).json({
    success: false,
    error: issues.length > 0 ? { code, message, issues } : { code, message },
  });

const conflictError = (res: Response, schedule: SerializedSchedule) =>
  res.status(409).json({
    success: false,
    error: {
      code: 'CAMPAIGN_ALREADY_SCHEDULED',
      message: 'Campaign already has an active schedule',
      issues: [
        {
          code: 'CAMPAIGN_ALREADY_SCHEDULED',
          message: 'Cancel the existing schedule before creating a new one.',
        },
      ],
    },
    schedule,
  });

export const getCampaignSchedule = async (req: Request, res: Response) => {
  try {
    const campaignId = campaignIdFrom(req);
    if (!campaignId) {
      return scheduleError(res, 400, 'VALIDATION_ERROR', 'Invalid campaign ID');
    }

    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true },
    });
    if (!campaign) {
      return scheduleError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
    }

    const schedule = await findCampaignSchedule(campaignId);
    // "No schedule yet" is a normal state, not an error.
    return scheduleResponse(res, schedule ? serializeSchedule(schedule) : null);
  } catch (error) {
    return scheduleError(res, 500, 'INTERNAL_ERROR', 'Failed to fetch campaign schedule');
  }
};

export const createCampaignSchedule = async (req: Request, res: Response) => {
  try {
    const campaignId = campaignIdFrom(req);
    if (!campaignId) {
      return scheduleError(res, 400, 'VALIDATION_ERROR', 'Invalid campaign ID');
    }
    const body = (req.body ?? {}) as Record<string, unknown>;

    // 1. The campaign must exist and be READY (ARCHIVED is rejected too).
    const schedulable = await checkCampaignSchedulable(campaignId);
    if (!schedulable.ok) {
      return scheduleError(res, schedulable.status, schedulable.code, schedulable.message, schedulable.issues);
    }

    // 2. The requested date/time + timezone must be valid and in the future.
    const validation = validateScheduleInput(body);
    if (!validation.valid || !validation.value) {
      const first = validation.issues[0];
      return scheduleError(res, 400, first.code, first.message, validation.issues);
    }

    // 3. At most one schedule row per campaign. An active schedule is a
    //    conflict; a CANCELLED one is reused so history stays simple.
    const existing = await findCampaignSchedule(campaignId);
    if (existing && existing.status === 'SCHEDULED') {
      return conflictError(res, serializeSchedule(existing));
    }

    const data = {
      scheduledAt: validation.value.scheduledAt,
      timezone: validation.value.timezone,
      status: 'SCHEDULED',
    };

    if (existing) {
      // Rescheduling a cancelled plan: same row, refreshed values, SCHEDULED.
      const revived = await prisma.campaignSchedule.update({ where: { id: existing.id }, data });
      recordAuditSafe('CAMPAIGN_SCHEDULE_CREATE', req, { campaignId, scheduleId: revived.id, status: revived.status });
      return scheduleResponse(res, serializeSchedule(revived), 200);
    }

    const created = await prisma.campaignSchedule.create({ data: { campaignId, ...data } });
    recordAuditSafe('CAMPAIGN_SCHEDULE_CREATE', req, { campaignId, scheduleId: created.id, status: created.status });
    return scheduleResponse(res, serializeSchedule(created), 201);
  } catch (error) {
    return scheduleError(res, 500, 'INTERNAL_ERROR', 'Failed to schedule campaign');
  }
};

export const updateCampaignSchedule = async (req: Request, res: Response) => {
  try {
    const campaignId = campaignIdFrom(req);
    if (!campaignId) {
      return scheduleError(res, 400, 'VALIDATION_ERROR', 'Invalid campaign ID');
    }
    const body = (req.body ?? {}) as Record<string, unknown>;

    const schedulable = await checkCampaignSchedulable(campaignId);
    if (!schedulable.ok) {
      return scheduleError(res, schedulable.status, schedulable.code, schedulable.message, schedulable.issues);
    }

    const existing = await findCampaignSchedule(campaignId);
    if (!existing) {
      return scheduleError(res, 404, 'SCHEDULE_NOT_FOUND', 'This campaign has no schedule to update');
    }

    // A cancelled schedule is history. Reactivating it is an explicit action
    // performed by scheduling again, never by a silent PATCH.
    if (existing.status !== 'SCHEDULED') {
      return scheduleError(
        res,
        400,
        'SCHEDULE_CANCELLED',
        'Cancelled schedules cannot be edited. Schedule the campaign again instead.',
        [{ code: 'SCHEDULE_CANCELLED', message: 'Cancelled schedules cannot be edited.' }]
      );
    }

    // Partial update: only the supplied field(s) change, and the stored value is
    // re-validated together with them so the future-date rule always holds.
    const validation = validateScheduleInput({
      scheduledAt: body.scheduledAt !== undefined ? body.scheduledAt : existing.scheduledAt.toISOString(),
      timezone: body.timezone !== undefined ? body.timezone : existing.timezone,
    });
    if (!validation.valid || !validation.value) {
      const first = validation.issues[0];
      return scheduleError(res, 400, first.code, first.message, validation.issues);
    }

    const data: Prisma.CampaignScheduleUpdateInput = {};
    if (body.scheduledAt !== undefined) data.scheduledAt = validation.value.scheduledAt;
    if (body.timezone !== undefined) data.timezone = validation.value.timezone;

    if (Object.keys(data).length === 0) {
      return scheduleError(
        res,
        400,
        'VALIDATION_ERROR',
        'Provide scheduledAt and/or timezone to update the schedule.'
      );
    }

    const updated = await prisma.campaignSchedule.update({ where: { id: existing.id }, data });
    recordAuditSafe('CAMPAIGN_SCHEDULE_UPDATE', req, { campaignId, scheduleId: updated.id, status: updated.status });
    return scheduleResponse(res, serializeSchedule(updated));
  } catch (error) {
    return scheduleError(res, 500, 'INTERNAL_ERROR', 'Failed to update campaign schedule');
  }
};

export const cancelCampaignSchedule = async (req: Request, res: Response) => {
  try {
    const campaignId = campaignIdFrom(req);
    if (!campaignId) {
      return scheduleError(res, 400, 'VALIDATION_ERROR', 'Invalid campaign ID');
    }

    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true },
    });
    if (!campaign) {
      return scheduleError(res, 404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
    }

    const existing = await findCampaignSchedule(campaignId);
    if (!existing) {
      return scheduleError(res, 404, 'SCHEDULE_NOT_FOUND', 'This campaign has no schedule to cancel');
    }

    // Cancelling an already-cancelled schedule is a clear, idempotent success —
    // the record is kept either way so the plan's history survives.
    if (existing.status === 'CANCELLED') {
      return scheduleResponse(res, serializeSchedule(existing));
    }

    const cancelled = await prisma.campaignSchedule.update({
      where: { id: existing.id },
      data: { status: 'CANCELLED' },
    });
    recordAuditSafe('CAMPAIGN_SCHEDULE_CANCEL', req, { campaignId, scheduleId: cancelled.id });
    return scheduleResponse(res, serializeSchedule(cancelled));
  } catch (error) {
    return scheduleError(res, 500, 'INTERNAL_ERROR', 'Failed to cancel campaign schedule');
  }
};