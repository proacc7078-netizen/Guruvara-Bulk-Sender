import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { prisma } from '../config/db';
import { recordAuditSafe } from '../services/audit.service';
import { denyUnlessAdmin } from '../middleware/auth.middleware';
import { MessageNotFoundError, deleteMessageForce } from '../services/messageDelete.service';

const ALLOWED_STATUSES = ['DRAFT', 'READY', 'ARCHIVED'];
const MAX_NAME_LENGTH = 200;
const MAX_BODY_LENGTH = 4096;
const MAX_LANGUAGE_LENGTH = 50;

function validationError(res: Response, message: string) {
  return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message } });
}

function idParam(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200 ? value.trim() : null;
}

function requiredText(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength ? value.trim() : null;
}

function optionalText(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > maxLength) return undefined;
  return value.trim();
}

function isStoragePathSafe(storagePath: string): boolean {
  const root = path.resolve(__dirname, '..', '..', '..', '..', 'storage', 'uploads');
  const relative = path.relative(root, path.resolve(storagePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export const getMessages = async (req: Request, res: Response) => {
  try {
    const messages = await prisma.message.findMany({
      orderBy: { createdAt: 'desc' }
    });

    return res.json({ success: true, data: messages });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch messages' } });
  }
};

export const getMessageById = async (req: Request, res: Response) => {
  try {
    const messageId = idParam(req.params.id);
    if (!messageId) {
      return validationError(res, 'Message ID is required');
    }

    const message = await prisma.message.findUnique({
      where: { id: messageId },
      include: { media: true },
    });

    if (!message) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Message not found' } });
    }

    return res.json({ success: true, data: message });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch message' } });
  }
};

export const createMessage = async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      return validationError(res, 'Request body must be an object');
    }
    const { name, body: messageBody, language, status } = body;
    const normalizedName = requiredText(name, MAX_NAME_LENGTH);
    const normalizedBody = requiredText(messageBody, MAX_BODY_LENGTH);
    const normalizedLanguage = language === undefined || language === null || language === ''
      ? null
      : optionalText(language, MAX_LANGUAGE_LENGTH);

    if (!normalizedName) {
      return validationError(res, 'Name is required and must be at most 200 characters');
    }
    if (!normalizedBody) {
      return validationError(res, 'Body is required and must be at most 4096 characters');
    }
    if (language !== undefined && language !== null && language !== '' && normalizedLanguage === undefined) {
      return validationError(res, 'Language must be at most 50 characters');
    }
    if (status !== undefined && (typeof status !== 'string' || !ALLOWED_STATUSES.includes(status))) {
      return validationError(res, `Status must be one of: ${ALLOWED_STATUSES.join(', ')}`);
    }

    const message = await prisma.message.create({
      data: {
        name: normalizedName,
        body: normalizedBody,
        language: normalizedLanguage,
        status: status || 'DRAFT'
      }
    });

    recordAuditSafe('MESSAGE_CREATE', req, { messageId: message.id, status: message.status });

    return res.status(201).json({ success: true, data: message });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create message' } });
  }
};

export const updateMessage = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const messageId = Array.isArray(id) ? id[0] : id;
    const { name, body, language, status } = req.body;

    // Check message exists
    const existing = await prisma.message.findUnique({ where: { id: messageId } });
    if (!existing) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Message not found' } });
    }

    // Validate status if provided
    if (status && !ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `Status must be one of: ${ALLOWED_STATUSES.join(', ')}` } });
    }

    const updateData: Record<string, unknown> = {};
    if (name !== undefined) {
      if (typeof name !== 'string' || !String(name).trim()) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Name cannot be empty' } });
      }
      if (String(name).trim().length > MAX_NAME_LENGTH) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `Name must be at most ${MAX_NAME_LENGTH} characters` } });
      }
      updateData.name = String(name).trim();
    }
    if (body !== undefined) {
      if (typeof body !== 'string' || !String(body).trim()) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Body cannot be empty' } });
      }
      if (String(body).length > MAX_BODY_LENGTH) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `Body must be at most ${MAX_BODY_LENGTH} characters` } });
      }
      updateData.body = String(body).trim();
    }
    if (language !== undefined) {
      updateData.language = language ? String(language).trim() : null;
    }
    if (status !== undefined) {
      updateData.status = status;
    }

    const message = await prisma.message.update({
      where: { id: messageId },
      data: updateData
    });

    recordAuditSafe('MESSAGE_UPDATE', req, { messageId: message.id, previousStatus: existing.status, status: message.status });

    return res.json({ success: true, data: message });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update message' } });
  }
};

/**
 * Counts the campaigns that still depend on a message, i.e. every campaign
 * that is not ARCHIVED (DRAFT, READY, SCHEDULED work alike).
 *
 * A message referenced by such a campaign must not be physically deleted, or
 * the campaign would be stranded without its content. An ARCHIVED campaign does
 * NOT block: its execution snapshot is immutable and keeps its own messageBody,
 * so execution history alone never prevents a delete.
 *
 * Shared by the single-message DELETE and the bulk delete so both enforce
 * exactly the same rule.
 */
async function countLiveCampaignsForMessage(messageId: string): Promise<number> {
  return prisma.campaign.count({
    where: { messageId, status: { not: 'ARCHIVED' } },
  });
}

/** Identical copy for both delete paths, so the two stay indistinguishable. */
function messageInCampaignError(liveCampaigns: number): string {
  return `Message is used by ${liveCampaigns} active campaign${liveCampaigns === 1 ? '' : 's'}. Archive those campaigns or the message instead.`;
}

/**
 * POST /api/messages/bulk-archive
 * ARCHIVED is the safe lifecycle action for a Message and never removes media
 * or breaks campaign/history references (those use onDelete: SetNull and the
 * execution snapshot is immutable).
 */
export const bulkArchiveMessages = async (req: Request, res: Response) => {
  return bulkMessageAction(req, res, 'ARCHIVE');
};

/**
 * POST /api/messages/bulk-delete
 *
 * Deletes each selected message one at a time, reusing the single-delete rules.
 * A message is refused when it is still attached to a live campaign, so deleting
 * it can never strand a scheduled/ready campaign. Campaign execution history is
 * unaffected: executions keep their own immutable messageBody snapshot and the
 * message reference is cleared by the schema's SetNull relation.
 */
export const bulkDeleteMessages = async (req: Request, res: Response) => {
  // Permanent deletion is ADMIN-only. Archive (the safe sibling below) and all
  // normal CRUD stay available to PRO.
  if (!(await denyUnlessAdmin(req, res))) return;
  return bulkMessageAction(req, res, 'DELETE');
};

type BulkMessageMode = 'ARCHIVE' | 'DELETE';

async function bulkMessageAction(req: Request, res: Response, mode: BulkMessageMode) {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawIds = Array.isArray(body.ids) ? body.ids : Array.isArray(body.messageIds) ? body.messageIds : null;
    const confirmRaw = (req.query as Record<string, unknown> | undefined)?.confirm ?? body.confirm;
    const confirmValue = Array.isArray(confirmRaw) ? confirmRaw[0] : confirmRaw;
    const confirmed = mode === 'DELETE' && confirmValue === 'true';
    if (!rawIds) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'ids must be an array of message ids' } });
    }
    if (rawIds.length === 0) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Select at least one message' } });
    }
    if (rawIds.length > 1000) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Too many messages selected (max 1000)' } });
    }
    const ids: string[] = [];
    for (const item of rawIds) {
      if (typeof item !== 'string' || !item.trim() || item.length > 200) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid message ID in selection' } });
      }
      const id = item.trim();
      if (!ids.includes(id)) ids.push(id);
    }

    const succeeded: string[] = [];
    const failed: { id: string; code: string; message: string }[] = [];

    for (const id of ids) {
      const existing = await prisma.message.findUnique({ where: { id } });
      if (!existing) {
        failed.push({ id, code: 'NOT_FOUND', message: 'Message not found' });
        continue;
      }
      try {
        if (mode === 'ARCHIVE') {
          await prisma.message.update({ where: { id }, data: { status: 'ARCHIVED' } });
        } else {
          // Do not delete a message that a live (non-archived) campaign still
          // depends on — unless the exact confirm=true unlocks deleteMessageForce.
          const liveCampaigns = await countLiveCampaignsForMessage(id);
          if (liveCampaigns > 0 && !confirmed) {
            failed.push({
              id,
              code: 'MESSAGE_IN_CAMPAIGN',
              message: messageInCampaignError(liveCampaigns),
            });
            continue;
          }
          if (confirmed) {
            try {
              const result = await deleteMessageForce(id);
              recordAuditSafe('MESSAGE_DELETE_FORCE', req, {
                messageId: id,
                detachedCampaignCount: result.counts.detachedCampaigns,
                mediaId: result.counts.mediaId,
              });
            } catch (error) {
              if (error instanceof MessageNotFoundError) {
                failed.push({ id, code: 'NOT_FOUND', message: 'Message not found' });
              } else {
                failed.push({ id, code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'Failed to delete message' });
              }
              continue;
            }
            succeeded.push(id);
            continue;
          }
          const media = await prisma.media.findFirst({ where: { messageId: id } });
          await prisma.message.delete({ where: { id } });
          if (media) {
            try { await prisma.media.delete({ where: { id: media.id } }); } catch { /* already removed */ }
            try { if (fs.existsSync(media.storagePath)) fs.unlinkSync(media.storagePath); } catch { /* already gone */ }
          }
        }
        succeeded.push(id);
      } catch (error) {
        failed.push({ id, code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : `Failed to ${mode.toLowerCase()} message` });
      }
    }

    recordAuditSafe(mode === 'ARCHIVE' ? 'MESSAGE_BULK_ARCHIVE' : 'MESSAGE_BULK_DELETE', req, {
      requested: ids.length, succeeded: succeeded.length, failed: failed.length,
    });

    return res.json({
      success: true,
      data: { requested: ids.length, mode, succeeded, failed, partial: failed.length > 0 && succeeded.length > 0 },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: `Failed to ${mode.toLowerCase()} messages` } });
  }
}

export const deleteMessage = async (req: Request, res: Response) => {
  // Permanent deletion is ADMIN-only (PRO keeps archive + full CRUD).
  if (!(await denyUnlessAdmin(req, res))) return;
  try {
    const { id } = req.params;
    const messageId = Array.isArray(id) ? id[0] : id;

    const existing = await prisma.message.findUnique({ where: { id: messageId } });
    if (!existing) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Message not found' } });
    }

    // Explicit, opt-in destructive path. Only the exact string "true" is
    // accepted; anything else leaves the default guard below untouched.
    const confirmRawSingle = (req.query as Record<string, unknown> | undefined)?.confirm ?? (req.body as Record<string, unknown> | undefined)?.confirm;
    const confirmSingle = Array.isArray(confirmRawSingle) ? confirmRawSingle[0] : confirmRawSingle;
    if (confirmSingle === 'true') {
      try {
        const result = await deleteMessageForce(messageId);
        recordAuditSafe('MESSAGE_DELETE_FORCE', req, {
          messageId,
          detachedCampaignCount: result.counts.detachedCampaigns,
          mediaId: result.counts.mediaId,
        });
        return res.json({ success: true, data: {} });
      } catch (error) {
        if (error instanceof MessageNotFoundError) {
          return res.status(404).json({ success: false, error: { code: error.code, message: error.message } });
        }
        return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to permanently delete message' } });
      }
    }

    // Same rule as the bulk delete: a message still referenced by a
    // non-ARCHIVED campaign must not be physically deleted, or the campaign
    // would be stranded. Without this the single-row delete bypassed the
    // protection the bulk path enforces and nulled campaign.messageId through
    // the schema's onDelete: SetNull.
    const liveCampaigns = await countLiveCampaignsForMessage(messageId);
    if (liveCampaigns > 0) {
      return res.status(409).json({
        success: false,
        error: { code: 'MESSAGE_IN_CAMPAIGN', message: messageInCampaignError(liveCampaigns) },
      });
    }

    const media = await prisma.media.findFirst({ where: { messageId } });

    await prisma.message.delete({ where: { id: messageId } });

    recordAuditSafe('MESSAGE_DELETE', req, { messageId, previousStatus: existing.status, mediaId: media?.id ?? null });

    if (media) {
      try {
        await prisma.media.delete({ where: { id: media.id } });
      } catch {
        // media record already removed, continue
      }
      try {
        if (fs.existsSync(media.storagePath)) {
          fs.unlinkSync(media.storagePath);
        }
      } catch {
        // file already gone, continue
      }
    }

    return res.json({ success: true, data: {} });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete message' } });
  }
};
