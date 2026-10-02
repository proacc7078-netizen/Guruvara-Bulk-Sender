import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { Prisma } from '@prisma/client';
import { resolveDeliveryStatus } from '../services/whatsapp/whatsappWebhook.service';

/**
 * Phase 5.9 — Messaging History (read-only view of execution state).
 *
 * History reuses the existing immutable CampaignExecution +
 * CampaignExecutionRecipient snapshot models. It does NOT create a parallel
 * delivery log and does NOT alter queue / scheduler / retry / webhook behavior.
 *
 * Recipient phone/name come from the CampaignExecutionRecipient snapshot
 * (frozen at execution creation), NOT from the live Recipient row. The live
 * Recipient is only surfaced on the detail endpoint, for explicit contrast.
 */

const ALLOWED_RECIPIENT_STATUSES = ['PENDING', 'RUNNING', 'SENT', 'DELIVERED', 'READ', 'FAILED'];
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const PREVIEW_LEN = 250;

type QueryValue = string | string[] | undefined;

export type { QueryValue };

function singleQuery(req: Request, key: string): string | undefined {
  // Note: `req.params` is intentionally NOT consulted here — the list
  // endpoint's filter keys live in the query string only.
  const raw: unknown = (req.query as Record<string, unknown>)[key];
  if (Array.isArray(raw)) return typeof raw[0] === 'string' && raw[0].length > 0 ? raw[0] : undefined;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function parsePositiveInt(value: string | undefined, fallback: number, max?: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return max ? Math.min(n, max) : n;
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? new Date(NaN) : d;
}

function toISO(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  const d = typeof v === 'string' ? new Date(v) : v;
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function safePreview(body: string | null | undefined): string | null {
  if (!body) return null;
  const s = String(body);
  if (s.length <= PREVIEW_LEN) return s;
  return s.slice(0, PREVIEW_LEN) + '…';
}
/**
 * Build the list DTO for a single CampaignExecutionRecipient row.
 * All delivery fields are read straight from the immutable snapshot row.
 */
function serializeHistoryItem(row: {
  executionId: string;
  recipientId: string;
  name: string | null;
  whatsappNumber: string;
  status: string;
  attemptCount: number;
  providerMessageId: string | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  webhookErrorCode: string | null;
  webhookErrorMessage: string | null;
  nextAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  execution: {
    id: string;
    campaign: { id: string; name: string };
    messageBody: string;
    messageName: string | null;
    messageId: string | null;
    status: string;
    scheduledAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    failedAt: Date | null;
    attemptCount: number;
    createdAt: Date;
    updatedAt: Date;
  };
}) {
  return {
    executionRecipientId: `${row.executionId}:${row.recipientId}`,
    executionId: row.executionId,
    campaignId: row.execution.campaign.id,
    campaignName: row.execution.campaign.name,
    recipientId: row.recipientId,
    recipientName: row.name,
    recipientPhone: row.whatsappNumber,
    status: resolveDeliveryStatus({
      status: row.status,
      sentAt: row.sentAt,
      deliveredAt: row.deliveredAt,
      readAt: row.readAt,
    }).status,
    attemptCount: row.attemptCount,
    providerMessageId: row.providerMessageId,
    sentAt: toISO(row.sentAt),
    deliveredAt: toISO(row.deliveredAt),
    readAt: toISO(row.readAt),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    webhookErrorCode: row.webhookErrorCode,
    webhookErrorMessage: row.webhookErrorMessage,
    nextAttemptAt: toISO(row.nextAttemptAt),
    retryPending: row.status === 'PENDING' && row.nextAttemptAt !== null,
    messagePreview: safePreview(row.execution.messageBody),
    createdAt: toISO(row.createdAt),
    updatedAt: toISO(row.updatedAt),
  };
}

/**
 * Delivery-status evidence columns used to derive a recipient's status.
 * `status` alone is NOT enough: the derived status is the strongest evidence
 * (readAt > deliveredAt > sentAt > stored status).
 */
const DELIVERY_EVIDENCE_SELECT = {
  status: true,
  sentAt: true,
  deliveredAt: true,
  readAt: true,
} as const;

/** The single, strongest status for one recipient record (never double counted). */
function derivedStatusOf(r: { status: string; sentAt: Date | null; deliveredAt: Date | null; readAt: Date | null }): string {
  return resolveDeliveryStatus({ status: r.status, sentAt: r.sentAt, deliveredAt: r.deliveredAt, readAt: r.readAt }).status;
}

const DELIVERY_STATUSES = ['PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED'] as const;

/**
 * Translates a requested delivery status into the equivalent evidence predicate.
 * This mirrors resolveDeliveryStatus exactly, so filtering and aggregation can
 * never disagree:
 *   READ      -> readAt set
 *   DELIVERED -> deliveredAt set, readAt not set
 *   SENT      -> sentAt set, neither deliveredAt nor readAt
 *   FAILED    -> no delivery evidence, stored status FAILED
 *   PENDING   -> no delivery evidence, stored status PENDING/RUNNING
 */
function deliveryStatusCondition(status: string): Prisma.CampaignExecutionRecipientWhereInput {
  switch (status) {
    case 'READ':
      return { readAt: { not: null } };
    case 'DELIVERED':
      return { deliveredAt: { not: null }, readAt: null };
    case 'SENT':
      return { sentAt: { not: null }, deliveredAt: null, readAt: null };
    case 'FAILED':
      return { sentAt: null, deliveredAt: null, readAt: null, status: 'FAILED' };
    case 'PENDING':
      return { sentAt: null, deliveredAt: null, readAt: null, status: { in: ['PENDING', 'RUNNING'] } };
    default:
      return {};
  }
}

/**
 * Shared recipient-record filters for the grouped + detail history queries.
 * Mirrors the existing list endpoint's filters so nothing is lost.
 */
function recipientFilterConditions(q: {
  campaign?: string; recipient?: string; status?: string;
  providerId?: string; startDate?: Date | null; endDate?: Date | null;
}): Prisma.CampaignExecutionRecipientWhereInput[] {
  const conditions: Prisma.CampaignExecutionRecipientWhereInput[] = [];
  if (q.campaign) conditions.push({ execution: { campaign: { name: { contains: q.campaign } } } });
  if (q.recipient) {
    conditions.push({ OR: [{ name: { contains: q.recipient } }, { whatsappNumber: { contains: q.recipient } }] });
  }
  if (q.status) conditions.push(deliveryStatusCondition(q.status));
  if (q.providerId) conditions.push({ providerMessageId: { contains: q.providerId } });
  if (q.startDate) conditions.push({ createdAt: { gte: q.startDate } });
  if (q.endDate) conditions.push({ createdAt: { lte: q.endDate } });
  return conditions;
}

/**
 * GET /api/history/campaigns
 *
 * Campaign-grouped history: one row per CAMPAIGN EXECUTION (never merged
 * across executions), with aggregate delivery counts calculated from the real
 * CampaignExecutionRecipient snapshot rows.
 *
 * Filtering happens at the recipient-record level first, so a group only
 * appears when it actually contains matching recipient records. Pagination is
 * applied at the EXECUTION level on the server, so a large history is never
 * pulled into the browser to be grouped client-side.
 */
export const listHistoryCampaigns = async (req: Request, res: Response) => {
  try {
    const page = parsePositiveInt(singleQuery(req, 'page'), DEFAULT_PAGE);
    const limit = parsePositiveInt(singleQuery(req, 'limit'), DEFAULT_LIMIT, MAX_LIMIT);
    const skip = (page - 1) * limit;

    const status = singleQuery(req, 'status');
    if (status && !ALLOWED_RECIPIENT_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: `Status must be one of: ${ALLOWED_RECIPIENT_STATUSES.join(', ')}` },
      });
    }
    const start = singleQuery(req, 'start');
    const end = singleQuery(req, 'end');
    const startDate = start ? parseDate(start) : null;
    const endDate = end ? parseDate(end) : null;
    if ((start && isNaN(startDate!.getTime())) || (end && isNaN(endDate!.getTime()))) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'start/end must be ISO date strings' } });
    }

    const conditions = recipientFilterConditions({
      campaign: singleQuery(req, 'campaign'),
      recipient: singleQuery(req, 'recipient'),
      status,
      providerId: singleQuery(req, 'providerId'),
      startDate,
      endDate,
    });
    const matchWhere: Prisma.CampaignExecutionRecipientWhereInput = conditions.length ? { AND: conditions } : {};

    // Only executions that actually contain at least one matching record.
    const matched = await prisma.campaignExecutionRecipient.findMany({
      where: matchWhere,
      select: { executionId: true },
      distinct: ['executionId'],
      orderBy: { executionId: 'asc' },
    });
    const executionIds = matched.map((m) => m.executionId);

    const total = executionIds.length;
    if (total === 0) {
      return res.json({ success: true, data: { items: [], page, limit, total: 0, totalPages: 1, hasMore: false } });
    }

    const executions = await prisma.campaignExecution.findMany({
      where: { id: { in: executionIds } },
      select: EXECUTION_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip,
      take: limit,
    });

    // Aggregates come from the REAL snapshot rows (never the campaign audience
    // size). Counts are mutually exclusive: a READ row counts as READ only.
    const rows = await prisma.campaignExecutionRecipient.findMany({
      where: { executionId: { in: executions.map((e) => e.id) } },
      select: { executionId: true, ...DELIVERY_EVIDENCE_SELECT },
    });
    const byExecution = new Map<string, { total: number; counts: Record<string, number> }>();
    for (const exec of executions) {
      byExecution.set(exec.id, { total: 0, counts: Object.fromEntries(DELIVERY_STATUSES.map((s) => [s, 0])) });
    }
    for (const row of rows) {
      const bucket = byExecution.get(row.executionId);
      if (!bucket) continue;
      bucket.total += 1;
      const s = derivedStatusOf(row);
      if (s in bucket.counts) bucket.counts[s] += 1;
    }

    const items = executions.map((exec) => {
      const b = byExecution.get(exec.id)!;
      return {
        executionId: exec.id,
        campaignId: exec.campaign.id,
        campaignName: exec.campaign.name,
        messageName: exec.messageName,
        /** Execution status — deliberately NOT labelled "campaign status". */
        executionStatus: exec.status,
        executionStartedAt: toISO(exec.startedAt ?? exec.scheduledAt),
        scheduledAt: toISO(exec.scheduledAt),
        completedAt: toISO(exec.completedAt),
        failedAt: toISO(exec.failedAt),
        recipientCount: b.total,
        counts: b.counts,
        sentCount: b.counts.SENT ?? 0,
        deliveredCount: b.counts.DELIVERED ?? 0,
        readCount: b.counts.READ ?? 0,
        failedCount: b.counts.FAILED ?? 0,
        pendingCount: b.counts.PENDING ?? 0,
      };
    });

    const totalPages = Math.max(1, Math.ceil(total / limit));
    return res.json({ success: true, data: { items, page, limit, total, totalPages, hasMore: page < totalPages } });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch history' } });
  }
};

const EXECUTION_SELECT = {
  id: true,
  campaign: { select: { id: true, name: true } },
  messageBody: true,
  messageName: true,
  messageId: true,
  status: true,
  scheduledAt: true,
  startedAt: true,
  completedAt: true,
  failedAt: true,
  attemptCount: true,
  createdAt: true,
  updatedAt: true,
} as const;
/**
 * GET /api/history
 * Authenticated, paginated, filterable list of execution-recipient rows.
 */
export const listHistory = async (req: Request, res: Response) => {
  try {
    const page = parsePositiveInt(singleQuery(req, 'page'), DEFAULT_PAGE);
    const limit = parsePositiveInt(singleQuery(req, 'limit'), DEFAULT_LIMIT, MAX_LIMIT);
    const skip = (page - 1) * limit;

    const campaign = singleQuery(req, 'campaign');
    const recipient = singleQuery(req, 'recipient');
    const status = singleQuery(req, 'status');
    const providerId = singleQuery(req, 'providerId');
    const start = singleQuery(req, 'start');
    const end = singleQuery(req, 'end');

    if (status && !ALLOWED_RECIPIENT_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: `Status must be one of: ${ALLOWED_RECIPIENT_STATUSES.join(', ')}` },
      });
    }

    const startDate = start ? parseDate(start) : null;
    const endDate = end ? parseDate(end) : null;
    if ((start && isNaN(startDate!.getTime())) || (end && isNaN(endDate!.getTime()))) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'start/end must be ISO date strings' },
      });
    }

    const conditions: Prisma.CampaignExecutionRecipientWhereInput[] = [];

    if (campaign) {
      conditions.push({
        execution: { campaign: { name: { contains: campaign } } },
      });
    }
    if (recipient) {
      conditions.push({
        OR: [
          { name: { contains: recipient } },
          { whatsappNumber: { contains: recipient } },
        ],
      });
    }
    if (status) {
      conditions.push({ status });
    }
    if (providerId) {
      conditions.push({ providerMessageId: { contains: providerId } });
    }
    if (startDate) {
      conditions.push({ createdAt: { gte: startDate } });
    }
    if (endDate) {
      conditions.push({ createdAt: { lte: endDate } });
    }

    const where: Prisma.CampaignExecutionRecipientWhereInput =
      conditions.length ? { AND: conditions } : {};

    const [total, rows] = await Promise.all([
      prisma.campaignExecutionRecipient.count({ where }),
      prisma.campaignExecutionRecipient.findMany({
        where,
        include: { execution: { select: EXECUTION_SELECT } },
        orderBy: [{ createdAt: 'desc' }, { executionId: 'asc' }],
        skip,
        take: limit,
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));

    return res.json({
      success: true,
      data: {
        items: rows.map(serializeHistoryItem),
        page,
        limit,
        total,
        totalPages,
        hasMore: page < totalPages,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch history' } });
  }
};
/**
 * GET /api/history/:executionRecipientId
 * Authenticated detail view. The `:id` is `executionId:recipientId` (the same
 * composite form used by the send route), making the immutable snapshot
 * explicit and contrasting it with the live recipient record.
 */
export const getHistoryDetail = async (req: Request, res: Response) => {
  try {
    const raw = singleQuery(req, 'executionRecipientId') ?? req.params.executionRecipientId;
    const parts = String(raw ?? '').split(':');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Execution recipient not found' },
      });
    }
    const [executionId, recipientId] = parts;

    const row = await prisma.campaignExecutionRecipient.findUnique({
      where: { executionId_recipientId: { executionId, recipientId } },
      include: { execution: { select: EXECUTION_SELECT } },
    });

    if (!row) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Execution recipient not found' },
      });
    }

    const currentRecipient = await prisma.recipient.findUnique({
      where: { id: row.recipientId },
      select: { id: true, name: true, whatsappNumber: true, status: true, updatedAt: true },
    });

    return res.json({
      success: true,
      data: {
        executionRecipientId: `${row.executionId}:${row.recipientId}`,
        source: 'execution_snapshot',
        snapshot: {
          executionId: row.executionId,
          recipientId: row.recipientId,
          recipientName: row.name,
          recipientPhone: row.whatsappNumber,
          status: resolveDeliveryStatus({
            status: row.status,
            sentAt: row.sentAt,
            deliveredAt: row.deliveredAt,
            readAt: row.readAt,
          }).status,
          attemptCount: row.attemptCount,
          providerMessageId: row.providerMessageId,
          sentAt: toISO(row.sentAt),
          deliveredAt: toISO(row.deliveredAt),
          readAt: toISO(row.readAt),
          errorCode: row.errorCode,
          errorMessage: row.errorMessage,
          webhookErrorCode: row.webhookErrorCode,
          webhookErrorMessage: row.webhookErrorMessage,
          nextAttemptAt: toISO(row.nextAttemptAt),
          retryPending: row.status === 'PENDING' && row.nextAttemptAt !== null,
          createdAt: toISO(row.createdAt),
          updatedAt: toISO(row.updatedAt),
        },
        execution: {
          id: row.execution.id,
          status: row.execution.status,
          campaignId: row.execution.campaign.id,
          campaignName: row.execution.campaign.name,
          messageId: row.execution.messageId,
          messageName: row.execution.messageName,
          messageBody: row.execution.messageBody,
          messagePreview: safePreview(row.execution.messageBody),
          scheduledAt: toISO(row.execution.scheduledAt),
          startedAt: toISO(row.execution.startedAt),
          completedAt: toISO(row.execution.completedAt),
          failedAt: toISO(row.execution.failedAt),
          attemptCount: row.execution.attemptCount,
          createdAt: toISO(row.execution.createdAt),
          updatedAt: toISO(row.execution.updatedAt),
        },
        currentRecipient: currentRecipient
          ? {
              id: currentRecipient.id,
              name: currentRecipient.name,
              whatsappNumber: currentRecipient.whatsappNumber,
              status: currentRecipient.status,
              updatedAt: toISO(currentRecipient.updatedAt),
            }
          : null,
        note:
          'recipientName, recipientPhone and messageBody are the immutable execution-time snapshot (frozen when the execution was created). currentRecipient reflects the live record for comparison only.',
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch history detail' } });
  }
};



/**
 * GET /api/history/executions/:executionId
 *
 * Recipient-level drill-down for ONE campaign execution, reusing the exact same
 * serialization as the existing list endpoint so no detail is lost. Paginated at
 * the recipient level (server-side).
 */
export const listHistoryExecutionRecipients = async (req: Request, res: Response) => {
  try {
    const executionId = req.params.executionId;
    if (typeof executionId !== 'string' || !executionId) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Execution not found' } });
    }
    const page = parsePositiveInt(singleQuery(req, 'page'), DEFAULT_PAGE);
    const limit = parsePositiveInt(singleQuery(req, 'limit'), DEFAULT_LIMIT, MAX_LIMIT);
    const skip = (page - 1) * limit;

    const status = singleQuery(req, 'status');
    if (status && !ALLOWED_RECIPIENT_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: `Status must be one of: ${ALLOWED_RECIPIENT_STATUSES.join(', ')}` },
      });
    }
    const start = singleQuery(req, 'start');
    const end = singleQuery(req, 'end');
    const startDate = start ? parseDate(start) : null;
    const endDate = end ? parseDate(end) : null;
    if ((start && isNaN(startDate!.getTime())) || (end && isNaN(endDate!.getTime()))) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'start/end must be ISO date strings' } });
    }

    const conditions = recipientFilterConditions({
      campaign: singleQuery(req, 'campaign'),
      recipient: singleQuery(req, 'recipient'),
      status,
      providerId: singleQuery(req, 'providerId'),
      startDate,
      endDate,
    });
    const where: Prisma.CampaignExecutionRecipientWhereInput = {
      executionId,
      ...(conditions.length ? { AND: conditions } : {}),
    };

    const execution = await prisma.campaignExecution.findUnique({ where: { id: executionId }, select: EXECUTION_SELECT });
    if (!execution) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Execution not found' } });
    }

    const [total, rows] = await Promise.all([
      prisma.campaignExecutionRecipient.count({ where }),
      prisma.campaignExecutionRecipient.findMany({
        where,
        include: { execution: { select: EXECUTION_SELECT } },
        orderBy: [{ createdAt: 'asc' }, { recipientId: 'asc' }],
        skip,
        take: limit,
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));
    return res.json({
      success: true,
      data: {
        execution: {
          executionId: execution.id,
          campaignId: execution.campaign.id,
          campaignName: execution.campaign.name,
          messageName: execution.messageName,
          executionStatus: execution.status,
          executionStartedAt: toISO(execution.startedAt ?? execution.scheduledAt),
          scheduledAt: toISO(execution.scheduledAt),
          completedAt: toISO(execution.completedAt),
          failedAt: toISO(execution.failedAt),
        },
        items: rows.map(serializeHistoryItem),
        page,
        limit,
        total,
        totalPages,
        hasMore: page < totalPages,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch history' } });
  }
};
