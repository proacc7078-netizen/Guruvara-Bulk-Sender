import { Request, Response } from 'express';
import { prisma } from '../config/db';

/**
 * Phase 8.1 — audit / system administration (ADMIN only).
 *
 * Read-only view over the existing AuditLog table so the administrator has a
 * system-administration surface; nothing here mutates audit history. Mounted
 * behind `requireAuth, requireRole(ROLE.ADMIN)` in routes/audit.routes.ts.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_ACTION_LENGTH = 200;

const parseIntOrDefault = (value: unknown): number => {
  if (typeof value !== 'string' || !value.trim()) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
};

const parseMetadata = (metadata: string | null): unknown => {
  if (!metadata) return null;
  try {
    return JSON.parse(metadata);
  } catch {
    return null;
  }
};

export const listAuditLogs = async (req: Request, res: Response) => {
  try {
    const limit = parseIntOrDefault(req.query.limit);
    const rawAction = req.query.action;
    const action =
      typeof rawAction === 'string' && rawAction.trim()
        ? rawAction.trim().slice(0, MAX_ACTION_LENGTH)
        : undefined;

    const logs = await prisma.auditLog.findMany({
      where: action ? { action } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return res.json({
      success: true,
      data: {
        limit,
        logs: logs.map((log) => ({
          id: log.id,
          action: log.action,
          actorUserId: log.actorUserId,
          actorEmail: log.actorEmail,
          ipAddress: log.ipAddress,
          metadata: parseMetadata(log.metadata),
          createdAt: log.createdAt,
        })),
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch audit logs' } });
  }
};
