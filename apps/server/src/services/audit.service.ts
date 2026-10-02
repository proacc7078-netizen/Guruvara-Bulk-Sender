import { Request } from 'express';
import { prisma } from '../config/db';

const SENSITIVE_KEYS = new Set([
  'password',
  'currentPassword',
  'newPassword',
  'accessToken',
  'appSecret',
  'webhookSecret',
  'webhookToken',
  'verifyToken',
  'authorization',
  'cookie',
  'session',
]);

function sanitizeMetadata(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEYS.has(key.toLowerCase())) {
    return '[REDACTED]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMetadata(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeMetadata(entryValue, entryKey),
      ])
    );
  }
  return value;
}

export async function recordAudit(
  action: string,
  req?: Request,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      action,
      actorUserId: req?.session?.userId ?? null,
      actorEmail: metadata.actorEmail && typeof metadata.actorEmail === 'string'
        ? metadata.actorEmail
        : null,
      ipAddress: req?.ip ?? null,
      metadata: JSON.stringify(sanitizeMetadata(metadata)),
    },
  });
}

export function recordAuditSafe(
  action: string,
  req?: Request,
  metadata: Record<string, unknown> = {}
): void {
  void recordAudit(action, req, metadata).catch(() => {});
}
