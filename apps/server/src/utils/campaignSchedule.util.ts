/**
 * Phase 4.4 — Campaign schedule validation utilities.
 *
 * The schedule layer answers WHEN a campaign is planned to run. It stores and
 * manages that plan only: nothing here executes, dispatches, retries or reports
 * delivery — those belong to later phases.
 *
 * Timezone handling: the API receives a wall-clock datetime plus an IANA
 * timezone name. The wall clock is resolved *in that timezone* to the real
 * instant, and that instant is what gets stored (Prisma DateTime). The timezone
 * name is stored alongside it so the UI can render the same wall clock back to
 * the administrator instead of silently switching to the browser's zone.
 */

import { prisma } from '../config/db';

export interface ScheduleIssue {
  code: string;
  message: string;
}

export interface ScheduleInput {
  scheduledAt: Date;
  timezone: string;
}

export interface ScheduleValidation {
  valid: boolean;
  issues: ScheduleIssue[];
  value: ScheduleInput | null;
}

// Phase 4.4 vocabulary only. Execution/history states (SENT, RUNNING, FAILED,
// COMPLETED, …) belong to later phases and are intentionally not accepted.
export const SCHEDULE_STATUSES = ['SCHEDULED', 'CANCELLED'];

// Small allowance so a request that is a few seconds "late" by the time it
// reaches the server is not rejected as a past timestamp.
const PAST_TOLERANCE_MS = 30_000;

const NAIVE_WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/;
const EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

const issue = (code: string, message: string): ScheduleIssue => ({ code, message });

const failure = (issueList: ScheduleIssue[]): ScheduleValidation => ({
  valid: false,
  issues: issueList,
  value: null,
});

/**
 * A timezone is valid when the runtime's ICU data can format a date with it.
 * This accepts every Intl-supported identifier (Asia/Kolkata, UTC, …) instead
 * of a hard-coded list.
 */
export const isValidTimezone = (timezone: unknown): boolean => {
  if (typeof timezone !== 'string') return false;
  const value = timezone.trim();
  if (!value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const wallClockIn = (date: Date, timezone: string): WallClock => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const read = (type: string): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : 0;
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // Some environments render midnight as hour "24".
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
};

// Offset (ms) of `timezone` at the given instant. Positive values are east of UTC.
const zoneOffsetMs = (instant: Date, timezone: string): number => {
  const whole = new Date(Math.floor(instant.getTime() / 1000) * 1000);
  const parts = wallClockIn(whole, timezone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - whole.getTime();
};

const sameWallClock = (a: WallClock, b: WallClock): boolean =>
  a.year === b.year && a.month === b.month && a.day === b.day &&
  a.hour === b.hour && a.minute === b.minute && a.second === b.second;

/**
 * Resolve a submitted `scheduledAt` + `timezone` pair to the real instant.
 *
 * - "2026-09-25T18:30:00" with timezone "Asia/Kolkata" means 18:30 *in Kolkata*.
 * - An explicit offset ("…Z", "…+05:30") is already an instant and is accepted
 *   as such.
 */
export const resolveScheduledInstant = (
  scheduledAt: unknown,
  timezone: string
): { ok: true; instant: Date } | { ok: false; issue: ScheduleIssue } => {
  if (typeof scheduledAt !== 'string' || !scheduledAt.trim()) {
    return {
      ok: false,
      issue: issue('INVALID_SCHEDULED_AT', 'scheduledAt is required and must be a datetime string.'),
    };
  }
  const raw = scheduledAt.trim();

  if (EXPLICIT_OFFSET.test(raw)) {
    const instant = new Date(raw);
    if (Number.isNaN(instant.getTime())) {
      return { ok: false, issue: issue('INVALID_SCHEDULED_AT', 'scheduledAt is not a valid datetime.') };
    }
    return { ok: true, instant };
  }

  const match = NAIVE_WALL_CLOCK.exec(raw);
  if (!match) {
    return {
      ok: false,
      issue: issue(
        'INVALID_SCHEDULED_AT',
        'scheduledAt must look like YYYY-MM-DDTHH:mm (local time in the supplied timezone).'
      ),
    };
  }

  const target: WallClock = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: match[6] ? Number(match[6]) : 0,
  };
  if (target.month < 1 || target.month > 12 || target.day < 1 || target.day > 31 ||
    target.hour > 23 || target.minute > 59 || target.second > 59) {
    return { ok: false, issue: issue('INVALID_SCHEDULED_AT', 'scheduledAt is not a valid datetime.') };
  }

  // Interpret the wall clock as if it were UTC, then correct by the zone offset.
  // The offset is re-read once at the corrected instant so the result is stable
  // across daylight-saving boundaries.
  const asIfUtc = Date.UTC(
    target.year, target.month - 1, target.day, target.hour, target.minute, target.second
  );
  const firstOffset = zoneOffsetMs(new Date(asIfUtc), timezone);
  let instantMs = asIfUtc - firstOffset;
  const secondOffset = zoneOffsetMs(new Date(instantMs), timezone);
  if (secondOffset !== firstOffset) {
    instantMs = asIfUtc - secondOffset;
  }
  const instant = new Date(instantMs);

  // Round-trip guarantee: the stored instant must render back as the wall clock
  // that was requested. A daylight-saving gap cannot satisfy this, so it is
  // rejected explicitly instead of being silently shifted.
  if (!sameWallClock(wallClockIn(instant, timezone), target)) {
    return {
      ok: false,
      issue: issue(
        'INVALID_SCHEDULED_AT',
        `scheduledAt does not exist in ${timezone} (daylight-saving transition).`
      ),
    };
  }

  return { ok: true, instant };
};

/** Validate a schedule request body. */
export const validateScheduleInput = (body: Record<string, unknown>): ScheduleValidation => {
  const timezone = typeof body.timezone === 'string' ? body.timezone.trim() : '';
  if (!timezone) {
    return failure([issue('INVALID_TIMEZONE', 'timezone is required.')]);
  }
  if (!isValidTimezone(timezone)) {
    return failure([issue('INVALID_TIMEZONE', `"${timezone}" is not a recognised timezone.`)]);
  }

  const resolved = resolveScheduledInstant(body.scheduledAt, timezone);
  if (!resolved.ok) {
    return failure([resolved.issue]);
  }

  if (resolved.instant.getTime() < Date.now() - PAST_TOLERANCE_MS) {
    return failure([issue('SCHEDULE_IN_PAST', 'scheduledAt must be in the future.')]);
  }

  return { valid: true, issues: [], value: { scheduledAt: resolved.instant, timezone } };
};

export type CampaignSchedulability =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string; issues: ScheduleIssue[] };

/**
 * Only a READY campaign can be scheduled. This never changes the campaign
 * status — the schedule layer stores WHEN, not WHAT.
 */
export const checkCampaignSchedulable = async (campaignId: string): Promise<CampaignSchedulability> => {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, status: true },
  });

  if (!campaign) {
    return { ok: false, status: 404, code: 'CAMPAIGN_NOT_FOUND', message: 'Campaign not found', issues: [] };
  }

  if (campaign.status === 'ARCHIVED') {
    return {
      ok: false,
      status: 400,
      code: 'CAMPAIGN_NOT_READY',
      message: 'Archived campaigns cannot be scheduled',
      issues: [issue('CAMPAIGN_ARCHIVED', 'Archived campaigns cannot be scheduled.')],
    };
  }

  if (campaign.status !== 'READY') {
    return {
      ok: false,
      status: 400,
      code: 'CAMPAIGN_NOT_READY',
      message: 'Campaign is not ready',
      issues: [issue('CAMPAIGN_NOT_READY', 'Finalize the campaign before scheduling it.')],
    };
  }

  return { ok: true };
};

export const findCampaignSchedule = (campaignId: string) =>
  prisma.campaignSchedule.findUnique({ where: { campaignId } });

// The schedule exactly as the API exposes it: the instant plus the zone it was
// planned in, so the client can render the original wall clock.
export interface SerializedSchedule {
  id: string;
  campaignId: string;
  scheduledAt: string;
  timezone: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export const serializeSchedule = (schedule: {
  id: string;
  campaignId: string;
  scheduledAt: Date;
  timezone: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): SerializedSchedule => ({
  id: schedule.id,
  campaignId: schedule.campaignId,
  scheduledAt: schedule.scheduledAt.toISOString(),
  timezone: schedule.timezone,
  status: schedule.status,
  createdAt: schedule.createdAt.toISOString(),
  updatedAt: schedule.updatedAt.toISOString(),
});