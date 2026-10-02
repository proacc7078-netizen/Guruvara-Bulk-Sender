import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { normalizePhoneNumber } from '../utils/phone.util';
import { recordAuditSafe } from '../services/audit.service';
import { denyUnlessAdmin } from '../middleware/auth.middleware';
import {
  RecipientDeliveryInProgressError,
  RecipientNotFoundError,
  deleteRecipientForce,
} from '../services/recipientDelete.service';

const ALLOWED_STATUSES = ['ACTIVE', 'PAUSED', 'UNSUBSCRIBED', 'INVALID', 'BLOCKED'];
const ALLOWED_CONSENT_STATUSES = ['GRANTED', 'PENDING', 'REVOKED'];
const MAX_TAG_IDS = 100;
const MAX_TEXT_LENGTH = 500;
const MAX_NOTES_LENGTH = 2000;

function validationError(res: Response, message: string) {
  return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message } });
}

function nonEmptyString(value: unknown, maxLength = MAX_TEXT_LENGTH): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength ? value.trim() : null;
}

function optionalString(value: unknown, maxLength = 500): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > maxLength) return undefined;
  return value.trim();
}

function optionalDate(value: unknown): Date | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function validateTagIds(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TAG_IDS) return null;
  const ids: string[] = [];
  for (const item of value) {
    const id = nonEmptyString(item, 200);
    if (!id) return null;
    ids.push(id);
  }
  return Array.from(new Set(ids));
}

async function tagsExist(tagIds: string[]): Promise<boolean> {
  if (tagIds.length === 0) return true;
  const found = await prisma.tag.findMany({ where: { id: { in: tagIds } }, select: { id: true } });
  return found.length === tagIds.length;
}

function validateConsentStatus(value: unknown, optional = true): boolean {
  if (value === undefined || value === null || value === '') return optional;
  return typeof value === 'string' && ALLOWED_CONSENT_STATUSES.includes(value);
}

function idParam(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200 ? value.trim() : null;
}

function queryText(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : null;
}

export const getRecipients = async (req: Request, res: Response) => {
  try {
    const searchValue = queryText(req.query.search, 200);
    const statusValue = queryText(req.query.status, 50);
    const languageValue = queryText(req.query.language, 100);
    const tagIdValue = queryText(req.query.tagId, 200);
    if (searchValue === null || statusValue === null || languageValue === null || tagIdValue === null) {
      return validationError(res, 'Recipient filters must be strings within their maximum length');
    }

    const search = searchValue ?? '';
    const status = statusValue ?? '';
    const language = languageValue ?? '';
    const tagId = tagIdValue ?? '';

    // Validate the status against the existing Recipient status values
    if (status && !ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `Status must be one of: ${ALLOWED_STATUSES.join(', ')}` } });
    }

    const recipients = await prisma.recipient.findMany({
      select: {
        id: true,
        name: true,
        whatsappNumber: true,
        normalizedPhone: true,
        language: true,
        category: true,
        consentStatus: true,
        consentTimestamp: true,
        notes: true,
        source: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        tags: {
          include: { tag: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Apply filters (search, status, language, tagId) — they combine together
    if (tagId && !idParam(tagId)) {
      return validationError(res, 'tagId must be a non-empty string');
    }
    const lowerSearch = search ? search.toLowerCase() : '';
    const digitsSearch = search ? search.replace(/\D/g, '') : '';

    const filtered = recipients.filter((r) => {
      // Search: case-insensitive name match; phone match works against the
      // stored number and the canonical number using digits only.
      if (search) {
        const nameMatch = r.name.toLowerCase().includes(lowerSearch);
        const phoneMatch = digitsSearch
          ? r.whatsappNumber.replace(/\D/g, '').includes(digitsSearch) ||
            r.normalizedPhone.includes(digitsSearch)
          : false;
        if (!(nameMatch || phoneMatch)) return false;
      }

      // Status filter
      if (status && r.status !== status) return false;

      // Language filter
      if (language && (r.language || '') !== language) return false;

      // Tag filter: recipient must have the given tag assigned
      if (tagId && !r.tags.some((rt) => rt.tag?.id === tagId)) return false;

      return true;
    });

    return res.json({ success: true, data: filtered });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch recipients' } });
  }
};

export const getRecipientById = async (req: Request, res: Response) => {
  try {
    const recipientId = idParam(req.params.id);
    if (!recipientId) {
      return validationError(res, 'Recipient ID is required');
    }

    const recipient = await prisma.recipient.findUnique({
      where: { id: recipientId },
      select: {
        id: true,
        name: true,
        whatsappNumber: true,
        language: true,
        category: true,
        consentStatus: true,
        consentTimestamp: true,
        notes: true,
        source: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        tags: {
          include: { tag: true }
        }
      }
    });

    if (!recipient) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Recipient not found' } });
    }

    return res.json({ success: true, data: recipient });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch recipient' } });
  }
};

export const createRecipient = async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      return validationError(res, 'Request body must be an object');
    }

    const { name, whatsappNumber, language, category, status, source, consentStatus, consentTimestamp, notes, tagIds } = body;
    const normalizedName = nonEmptyString(name, 200);
    const rawPhone = typeof whatsappNumber === 'string' ? whatsappNumber.trim() : '';
    const normalizedPhone = normalizePhoneNumber(rawPhone);
    const digits = normalizedPhone.replace(/\D/g, '');

    if (!normalizedName || !rawPhone || !normalizedPhone || digits.length < 7 || digits.length > 15) {
      return validationError(res, 'Name and a valid WhatsApp number are required');
    }
    if (status !== undefined && (typeof status !== 'string' || !ALLOWED_STATUSES.includes(status))) {
      return validationError(res, `Status must be one of: ${ALLOWED_STATUSES.join(', ')}`);
    }
    if (source !== undefined && source !== null && (typeof source !== 'string' || source.trim().length > 100)) {
      return validationError(res, 'Source must be at most 100 characters');
    }
    if (!validateConsentStatus(consentStatus)) {
      return validationError(res, 'Consent status must be GRANTED, PENDING, or REVOKED');
    }
    const parsedConsentTimestamp = optionalDate(consentTimestamp);
    if (parsedConsentTimestamp === undefined) {
      return validationError(res, 'Consent timestamp must be a valid date');
    }
    const parsedTagIds = validateTagIds(tagIds);
    if (parsedTagIds === null || !(await tagsExist(parsedTagIds))) {
      return validationError(res, 'tagIds must reference existing tags');
    }

    const existing = await prisma.recipient.findUnique({ where: { normalizedPhone } });
    if (existing) {
      return res.status(400).json({ success: false, error: { code: 'DUPLICATE_RECIPIENT', message: 'A recipient with this phone number already exists' } });
    }

    const parsedLanguage = optionalString(language, 100);
    const parsedCategory = optionalString(category, 100);
    const parsedSource = optionalString(source, 100);
    const parsedNotes = optionalString(notes, MAX_NOTES_LENGTH);
    if ((language !== undefined && language !== null && parsedLanguage === undefined) ||
      (category !== undefined && category !== null && parsedCategory === undefined) ||
      (source !== undefined && source !== null && parsedSource === undefined) ||
      (notes !== undefined && notes !== null && parsedNotes === undefined)) {
      return validationError(res, 'Optional text fields exceed their maximum length');
    }

    const recipient = await prisma.recipient.create({
      data: {
        name: normalizedName,
        whatsappNumber: rawPhone,
        normalizedPhone,
        language: parsedLanguage,
        category: parsedCategory,
        status: status || 'ACTIVE',
        source: parsedSource ?? 'MANUAL',
        consentStatus: consentStatus || null,
        consentTimestamp: parsedConsentTimestamp,
        notes: parsedNotes,
        tags: {
          create: parsedTagIds.map((tagId) => ({ tagId }))
        }
      },
      include: {
        tags: { include: { tag: true } }
      }
    });

    recordAuditSafe('RECIPIENT_CREATE', req, { recipientId: recipient.id, status: recipient.status });

    return res.json({ success: true, data: recipient });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create recipient' } });
  }
};

export const updateRecipient = async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      return validationError(res, 'Request body must be an object');
    }

    const recipientId = idParam(req.params.id);
    if (!recipientId) {
      return validationError(res, 'Recipient ID is required');
    }

    const existingRecipient = await prisma.recipient.findUnique({ where: { id: recipientId } });
    if (!existingRecipient) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Recipient not found' } });
    }

    const { name, whatsappNumber, language, category, status, consentStatus, consentTimestamp, notes, tagIds } = body;
    const dataToUpdate: any = {};

    if (name !== undefined) {
      const normalizedName = nonEmptyString(name, 200);
      if (!normalizedName) {
        return validationError(res, 'Name must be a non-empty string of at most 200 characters');
      }
      dataToUpdate.name = normalizedName;
    }

    if (whatsappNumber !== undefined) {
      if (typeof whatsappNumber !== 'string') {
        return validationError(res, 'WhatsApp number must be a string');
      }
      const rawPhone = whatsappNumber.trim();
      const normalizedPhone = normalizePhoneNumber(rawPhone);
      const digits = normalizedPhone.replace(/\D/g, '');
      if (!rawPhone || !normalizedPhone || digits.length < 7 || digits.length > 15) {
        return validationError(res, 'WhatsApp number must be valid');
      }
      const existing = await prisma.recipient.findUnique({ where: { normalizedPhone } });
      if (existing && existing.id !== recipientId) {
        return res.status(400).json({ success: false, error: { code: 'DUPLICATE_RECIPIENT', message: 'A recipient with this phone number already exists' } });
      }
      dataToUpdate.whatsappNumber = rawPhone;
      dataToUpdate.normalizedPhone = normalizedPhone;
    }

    if (language !== undefined) {
      if (language !== null && (typeof language !== 'string' || language.trim().length > 100)) {
        return validationError(res, 'Language must be at most 100 characters');
      }
      dataToUpdate.language = typeof language === 'string' ? language.trim() || null : null;
    }

    if (category !== undefined) {
      if (category !== null && (typeof category !== 'string' || category.trim().length > 100)) {
        return validationError(res, 'Category must be at most 100 characters');
      }
      dataToUpdate.category = typeof category === 'string' ? category.trim() || null : null;
    }

    if (status !== undefined) {
      if (typeof status !== 'string' || !ALLOWED_STATUSES.includes(status)) {
        return validationError(res, `Status must be one of: ${ALLOWED_STATUSES.join(', ')}`);
      }
      dataToUpdate.status = status;
    }

    if (consentStatus !== undefined) {
      if (consentStatus !== null && !validateConsentStatus(consentStatus, false)) {
        return validationError(res, 'Consent status must be GRANTED, PENDING, REVOKED, or null');
      }
      dataToUpdate.consentStatus = consentStatus || null;
    }

    if (consentTimestamp !== undefined) {
      const parsedConsentTimestamp = optionalDate(consentTimestamp);
      if (parsedConsentTimestamp === undefined) {
        return validationError(res, 'Consent timestamp must be a valid date or null');
      }
      dataToUpdate.consentTimestamp = parsedConsentTimestamp;
    }

    if (notes !== undefined) {
      if (notes !== null && (typeof notes !== 'string' || notes.trim().length > MAX_NOTES_LENGTH)) {
        return validationError(res, 'Notes must be at most 2000 characters');
      }
      dataToUpdate.notes = typeof notes === 'string' ? notes.trim() || null : null;
    }

    if (tagIds !== undefined) {
      const parsedTagIds = validateTagIds(tagIds);
      if (parsedTagIds === null || !(await tagsExist(parsedTagIds))) {
        return validationError(res, 'tagIds must reference existing tags');
      }
      dataToUpdate.tags = {
        set: [],
        create: parsedTagIds.map((tagId) => ({ tagId }))
      };
    }

    const recipient = await prisma.recipient.update({
      where: { id: recipientId },
      data: dataToUpdate,
      include: { tags: { include: { tag: true } } }
    });

    recordAuditSafe('RECIPIENT_UPDATE', req, { recipientId: recipient.id, status: recipient.status });

    return res.json({ success: true, data: recipient });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update recipient' } });
  }
};

/**
 * POST /api/recipients/bulk-delete
 *
 * Deletes each requested recipient by id, one at a time, and reports the exact
 * outcome per id. This deliberately reuses the same per-recipient guard as the
 * single delete endpoint (campaign-reference protection) instead of issuing a
 * bulk Prisma delete, so a referenced recipient is never silently removed and
 * no backend guard is bypassed. Nothing is hidden: every id is reported as
 * deleted, skipped or failed, with a reason.
 */
export const bulkDeleteRecipients = async (req: Request, res: Response) => {
  // Permanent deletion is ADMIN-only. PRO keeps the existing operational
  // recipient-management workflow (status/archive + edit), which is the safe
  // sibling of this action.
  if (!(await denyUnlessAdmin(req, res))) return;
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawIds = Array.isArray(body.ids) ? body.ids : Array.isArray(body.recipientIds) ? body.recipientIds : null;
    const confirmRaw = (req.query as Record<string, unknown> | undefined)?.confirm ?? body.confirm;
    const confirmValue = Array.isArray(confirmRaw) ? confirmRaw[0] : confirmRaw;
    const confirmed = confirmValue === 'true';
    if (!rawIds) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'ids must be an array of recipient ids' } });
    }
    if (rawIds.length === 0) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Select at least one recipient' } });
    }
    if (rawIds.length > 1000) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Too many recipients selected (max 1000)' } });
    }
    const ids: string[] = [];
    for (const item of rawIds) {
      const id = idParam(item);
      if (!id) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid recipient ID in selection' } });
      }
      if (!ids.includes(id)) ids.push(id);
    }

    const deleted: string[] = [];
    const failed: { id: string; code: string; message: string }[] = [];

    for (const id of ids) {
      const existing = await prisma.recipient.findUnique({ where: { id } });
      if (!existing) {
        failed.push({ id, code: 'NOT_FOUND', message: 'Recipient not found' });
        continue;
      }
      // Same protection as DELETE /api/recipients/:id — only the exact
      // confirm=true unlocks the destructive cascade via deleteRecipientForce.
      const memberships = await prisma.campaignRecipient.count({ where: { recipientId: id } });
      if (memberships > 0 && !confirmed) {
        failed.push({
          id,
          code: 'RECIPIENT_IN_CAMPAIGN',
          message: `Recipient belongs to ${memberships} campaign audience${memberships === 1 ? '' : 's'}. Remove the recipient from those campaigns before deleting.`,
        });
        continue;
      }
      try {
        if (confirmed) {
          const result = await deleteRecipientForce(id);
          recordAuditSafe('RECIPIENT_DELETE_FORCE', req, {
            recipientId: id,
            membershipCount: result.counts.memberships,
            executionRecipientCount: result.counts.executionRecipients,
          });
          deleted.push(id);
        } else {
          await prisma.recipient.delete({ where: { id } });
          deleted.push(id);
        }
      } catch (error) {
        if (error instanceof RecipientNotFoundError) {
          failed.push({ id, code: 'NOT_FOUND', message: 'Recipient not found' });
        } else if (error instanceof RecipientDeliveryInProgressError) {
          failed.push({ id, code: error.code, message: error.message });
        } else {
          failed.push({ id, code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'Failed to delete recipient' });
        }
      }
    }

    recordAuditSafe('RECIPIENT_BULK_DELETE', req, { requested: ids.length, deleted: deleted.length, failed: failed.length });

    return res.json({
      success: true,
      data: {
        requested: ids.length,
        deleted,
        failed,
        // Explicit so the UI can never imply everything succeeded.
        partial: failed.length > 0 && deleted.length > 0,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete recipients' } });
  }
};

export const deleteRecipient = async (req: Request, res: Response) => {
  // Permanent deletion is ADMIN-only. PRO keeps status/archive + edit.
  if (!(await denyUnlessAdmin(req, res))) return;
  try {
    const recipientId = idParam(req.params.id);
    if (!recipientId) {
      return validationError(res, 'Recipient ID is required');
    }

    // Validate the recipient exists
    const existingRecipient = await prisma.recipient.findUnique({ where: { id: recipientId } });
    if (!existingRecipient) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Recipient not found' } });
    }

    // Phase 4.2: a recipient that belongs to a campaign audience is protected.
    // Deleting it would silently shrink that campaign's audience snapshot, so the
    // membership must be removed from those campaigns first (explicit + safe).
    // Only the exact confirm=true unlocks the destructive cascade.
    const confirmRawSingle = (req.query as Record<string, unknown> | undefined)?.confirm ?? (req.body as Record<string, unknown> | undefined)?.confirm;
    const confirmSingle = Array.isArray(confirmRawSingle) ? confirmRawSingle[0] : confirmRawSingle;
    if (confirmSingle === 'true') {
      try {
        const result = await deleteRecipientForce(recipientId);
        recordAuditSafe('RECIPIENT_DELETE_FORCE', req, {
          recipientId,
          membershipCount: result.counts.memberships,
          executionRecipientCount: result.counts.executionRecipients,
        });
        return res.json({ success: true, data: {} });
      } catch (error) {
        if (error instanceof RecipientNotFoundError) {
          return res.status(404).json({ success: false, error: { code: error.code, message: error.message } });
        }
        if (error instanceof RecipientDeliveryInProgressError) {
          return res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
        }
        return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to permanently delete recipient' } });
      }
    }

    const audienceMemberships = await prisma.campaignRecipient.count({ where: { recipientId } });
    if (audienceMemberships > 0) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'RECIPIENT_IN_CAMPAIGN',
          message: `Recipient belongs to ${audienceMemberships} campaign audience${audienceMemberships === 1 ? '' : 's'}. Remove the recipient from those campaigns before deleting.`
        }
      });
    }

    // Delete the recipient. RecipientTag records are cascade-deleted automatically
    // via the onDelete: Cascade relation in the Prisma schema.
    await prisma.recipient.delete({ where: { id: recipientId } });
    recordAuditSafe('RECIPIENT_DELETE', req, { recipientId });
    return res.json({ success: true, data: {} });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete recipient' } });
  }
};

// Assign a tag to a recipient
export const assignTagToRecipient = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const recipientId = Array.isArray(id) ? id[0] : id;
    const { tagId } = req.body;

    if (!tagId) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Tag ID is required' } });
    }

    // Validate the recipient exists
    const recipient = await prisma.recipient.findUnique({ where: { id: recipientId } });
    if (!recipient) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Recipient not found' } });
    }

    // Validate the tag exists
    const tag = await prisma.tag.findUnique({ where: { id: tagId } });
    if (!tag) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Tag not found' } });
    }

    // Check if already assigned — do not create duplicate relationships
    const existingRelation = await prisma.recipientTag.findUnique({
      where: { recipientId_tagId: { recipientId, tagId } }
    });
    if (existingRelation) {
      // Idempotent: return the recipient with tags, no duplicate created
      const updated = await prisma.recipient.findUnique({
        where: { id: recipientId },
        include: { tags: { include: { tag: true } } }
      });
      return res.json({ success: true, data: updated, alreadyAssigned: true });
    }

    await prisma.recipientTag.create({ data: { recipientId, tagId } });

    recordAuditSafe('RECIPIENT_TAG_ASSIGN', req, { recipientId, tagId });

    const updated = await prisma.recipient.findUnique({
      where: { id: recipientId },
      include: { tags: { include: { tag: true } } }
    });

    return res.json({ success: true, data: updated });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to assign tag' } });
  }
};

// Remove a tag from a recipient
export const removeTagFromRecipient = async (req: Request, res: Response) => {
  try {
    const { id, tagId } = req.params;
    const recipientId = Array.isArray(id) ? id[0] : id;
    const tagIdValue = Array.isArray(tagId) ? tagId[0] : tagId;

    // Validate the recipient exists
    const recipient = await prisma.recipient.findUnique({ where: { id: recipientId } });
    if (!recipient) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Recipient not found' } });
    }

    // Validate the tag exists
    const tag = await prisma.tag.findUnique({ where: { id: tagIdValue } });
    if (!tag) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Tag not found' } });
    }

    // Remove only this relationship
    await prisma.recipientTag.deleteMany({ where: { recipientId, tagId: tagIdValue } });

    recordAuditSafe('RECIPIENT_TAG_REMOVE', req, { recipientId, tagId: tagIdValue });

    const updated = await prisma.recipient.findUnique({
      where: { id: recipientId },
      include: { tags: { include: { tag: true } } }
    });

    return res.json({ success: true, data: updated });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to remove tag' } });
  }
};

export const updateRecipientStatus = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const recipientId = Array.isArray(id) ? id[0] : id;
    const { status } = req.body;

    // Validate the recipient exists
    const existingRecipient = await prisma.recipient.findUnique({ where: { id: recipientId } });
    if (!existingRecipient) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Recipient not found' } });
    }

    // Validate the status
    if (!status || !ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `Status must be one of: ${ALLOWED_STATUSES.join(', ')}` } });
    }

    // Update only the status field
    const recipient = await prisma.recipient.update({
      where: { id: recipientId },
      data: { status },
      include: { tags: { include: { tag: true } } }
    });

    recordAuditSafe('RECIPIENT_STATUS_UPDATE', req, { recipientId: recipient.id, status: recipient.status });

    return res.json({ success: true, data: recipient });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update recipient status' } });
  }
};
// Step 12D: read-only duplicate lookup for the import wizard.
// Receives the canonical normalized phones produced by Step 12C and reports
// which of them already exist as recipients. This handler never writes.
const MAX_DUPLICATE_LOOKUP_PHONES = 5000;

export const checkImportDuplicates = async (req: Request, res: Response) => {
  try {
    const normalizedPhones = req.body?.normalizedPhones;

    if (!Array.isArray(normalizedPhones)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'normalizedPhones must be an array of normalized phone numbers' } });
    }

    if (normalizedPhones.length > MAX_DUPLICATE_LOOKUP_PHONES) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `At most ${MAX_DUPLICATE_LOOKUP_PHONES} normalized phone numbers can be checked in one request` } });
    }

    // De-duplicate and drop blanks so the batch results in a single lookup
    const uniquePhones = new Set<string>();
    for (const value of normalizedPhones) {
      if (typeof value !== 'string') {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'normalizedPhones must contain only normalized phone number strings' } });
      }
      const phone = value.trim();
      if (phone) uniquePhones.add(phone);
    }

    if (uniquePhones.size === 0) {
      return res.json({ success: true, data: { duplicates: [], checkedCount: 0 } });
    }

    // READ ONLY: a single select of the canonical phone numbers that already exist
    const existingRecipients = await prisma.recipient.findMany({
      where: { normalizedPhone: { in: Array.from(uniquePhones) } },
      select: { normalizedPhone: true }
    });

    return res.json({
      success: true,
      data: {
        duplicates: existingRecipients.map((recipient) => ({ normalizedPhone: recipient.normalizedPhone })),
        checkedCount: uniquePhones.size
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to check for duplicate recipients' } });
  }
};
// Step 12F: the final import confirmation. This is the only import handler that
// writes to the recipient table, and it only ever CREATES new recipients.
// Existing recipients are never updated, overwritten, deleted or re-activated
// by this endpoint.
const MAX_IMPORT_ROWS = 5000;

type ImportRowStatus = 'CREATED' | 'SKIPPED' | 'FAILED';

type ImportRowResult = {
  rowNumber: number;
  status: ImportRowStatus;
  name?: string;
  whatsappNumber?: string;
  normalizedPhone?: string;
  reason?: string;
};

type PreparedImportRow = {
  rowNumber: number;
  name: string;
  whatsappNumber: string;
  normalizedPhone: string;
  language: string | null;
  category: string | null;
  consentStatus: string | null;
  consentTimestamp: Date | null;
  notes: string | null;
  source: string;
};

function optionalImportString(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > maxLength) return undefined;
  return value.trim();
}

/** Prisma's unique-constraint violation (P2002), detected without Prisma types. */
function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

export const importRecipients = async (req: Request, res: Response) => {
  try {
    const rows = req.body?.rows;

    if (!Array.isArray(rows)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'rows must be an array of selected import rows' } });
    }
    if (rows.length === 0) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'At least one selected row is required' } });
    }
    if (rows.length > MAX_IMPORT_ROWS) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `At most ${MAX_IMPORT_ROWS} rows can be imported at once` } });
    }

    // ---- Phase 1: validate + normalize every row. No database write happens here. ----
    const seenRowNumbers = new Set<number>();
    const prepared: PreparedImportRow[] = [];
    const results: ImportRowResult[] = [];
    // Canonical phone -> the row number that claimed it first (within-request duplicates)
    const claimedInRequest = new Map<string, number>();

    for (const raw of rows as unknown[]) {
      if (typeof raw !== 'object' || raw === null) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Every row must be an object' } });
      }
      const row = raw as Record<string, unknown>;

      const rowNumber = typeof row.rowNumber === 'number' ? row.rowNumber : Number(row.rowNumber);
      if (!Number.isInteger(rowNumber) || rowNumber < 1) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Every row must include a valid numeric rowNumber' } });
      }
      if (seenRowNumbers.has(rowNumber)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `Row ${rowNumber} appears more than once in the request` } });
      }
      seenRowNumbers.add(rowNumber);

      const name = typeof row.name === 'string' ? row.name.trim() : '';
      const whatsappNumber = typeof row.whatsappNumber === 'string' ? row.whatsappNumber.trim() : '';
      const suppliedNormalizedPhone = typeof row.normalizedPhone === 'string' ? row.normalizedPhone.trim() : '';

      const baseResult: ImportRowResult = {
        rowNumber,
        name: name || undefined,
        whatsappNumber: whatsappNumber || undefined,
        status: 'SKIPPED'
      };

      // Required fields are re-validated server-side: the browser is never trusted.
      if (!name || name.length > 200) {
        results.push({ ...baseResult, status: 'FAILED', reason: name ? 'Name must be at most 200 characters.' : 'Name is required.' });
        continue;
      }
      if (!whatsappNumber || whatsappNumber.length > 100) {
        results.push({ ...baseResult, status: 'FAILED', reason: whatsappNumber ? 'WhatsApp number must be at most 100 characters.' : 'WhatsApp number is required.' });
        continue;
      }
      if (!suppliedNormalizedPhone) {
        results.push({ ...baseResult, status: 'FAILED', reason: 'Normalized phone is required.' });
        continue;
      }

      // The server-calculated canonical value is authoritative, so a differing
      // value supplied by the browser can never bypass normalization.
      const normalizedPhone = normalizePhoneNumber(whatsappNumber);
      const phoneDigits = normalizedPhone.replace(/\D/g, '');
      if (!normalizedPhone || phoneDigits.length < 7 || phoneDigits.length > 15) {
        results.push({ ...baseResult, status: 'FAILED', normalizedPhone, reason: 'Invalid WhatsApp number.' });
        continue;
      }

      let consentTimestamp: Date | null = null;
      const rawConsentTimestamp = row.consentTimestamp;
      if (rawConsentTimestamp !== undefined && rawConsentTimestamp !== null && rawConsentTimestamp !== '') {
        if (typeof rawConsentTimestamp !== 'string') {
          results.push({ ...baseResult, status: 'FAILED', normalizedPhone, reason: 'Invalid consent timestamp.' });
          continue;
        }
        const parsed = new Date(rawConsentTimestamp.trim());
        if (Number.isNaN(parsed.getTime())) {
          results.push({ ...baseResult, status: 'FAILED', normalizedPhone, reason: 'Invalid consent timestamp.' });
          continue;
        }
        consentTimestamp = parsed;
      }

      const rawConsentStatus = row.consentStatus;
      const consentStatus = rawConsentStatus === undefined || rawConsentStatus === null || rawConsentStatus === ''
        ? null
        : (typeof rawConsentStatus === 'string' && ALLOWED_CONSENT_STATUSES.includes(rawConsentStatus.trim()) ? rawConsentStatus.trim() : undefined);
      if (rawConsentStatus !== undefined && rawConsentStatus !== null && rawConsentStatus !== '' && consentStatus === undefined) {
        results.push({ ...baseResult, status: 'FAILED', normalizedPhone, reason: 'Invalid consent status.' });
        continue;
      }

      const language = optionalImportString(row.language, 100);
      const category = optionalImportString(row.category, 100);
      const notes = optionalImportString(row.notes, MAX_NOTES_LENGTH);
      const source = optionalImportString(row.source, 100);
      if (language === undefined || category === undefined || notes === undefined || source === undefined) {
        results.push({ ...baseResult, status: 'FAILED', normalizedPhone, reason: 'Optional field exceeds its maximum length.' });
        continue;
      }

      // Within-request duplicates: only the first row claiming a canonical phone
      // may be created; later rows are reported as SKIPPED with a clear reason.
      const claimedBy = claimedInRequest.get(normalizedPhone);
      if (claimedBy !== undefined) {
        results.push({ ...baseResult, status: 'SKIPPED', normalizedPhone, reason: `Duplicate phone number in this import (same as row ${claimedBy}).` });
        continue;
      }
      claimedInRequest.set(normalizedPhone, rowNumber);

      const validatedConsentStatus = consentStatus ?? null;

      prepared.push({
        rowNumber,
        name,
        whatsappNumber,
        normalizedPhone,
        language,
        category,
        consentStatus: validatedConsentStatus,
        consentTimestamp,
        notes,
        source: source ?? 'IMPORT'
      });
      results.push({ ...baseResult, status: 'SKIPPED', normalizedPhone, reason: 'Pending' });
    }
// ---- Phase 2: read-only duplicate check against the existing recipients ----
    const candidates = prepared.map((row) => row.normalizedPhone);
    const existingRecipients = candidates.length
      ? await prisma.recipient.findMany({
          where: { normalizedPhone: { in: candidates } },
          select: { normalizedPhone: true }
        })
      : [];
    const existingPhones = new Set(existingRecipients.map((recipient) => recipient.normalizedPhone));

    // ---- Phase 3: create ONLY genuinely new, valid recipients ----
    for (const row of prepared) {
      const index = results.findIndex((result) => result.rowNumber === row.rowNumber);
      if (index === -1) continue;

      if (existingPhones.has(row.normalizedPhone)) {
        results[index] = { ...results[index], status: 'SKIPPED', reason: 'Already exists in database.' };
        continue;
      }

      try {
        const created = await prisma.recipient.create({
          data: {
            name: row.name,
            whatsappNumber: row.whatsappNumber,
            normalizedPhone: row.normalizedPhone,
            language: row.language,
            category: row.category,
            consentStatus: row.consentStatus,
            consentTimestamp: row.consentTimestamp,
            notes: row.notes,
            source: row.source,
            status: 'ACTIVE'
          },
          select: { normalizedPhone: true }
        });
        existingPhones.add(created.normalizedPhone);
        results[index] = { ...results[index], status: 'CREATED', reason: undefined };
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          // Another writer created the same normalizedPhone between the duplicate
          // check and this insert. The unique constraint is the final safety net;
          // no Prisma detail is exposed to the client.
          results[index] = { ...results[index], status: 'SKIPPED', reason: 'Already exists in database.' };
          continue;
        }
        results[index] = { ...results[index], status: 'FAILED', reason: 'Could not be saved. Please try again.' };
      }
    }

    const summary = {
      total: rows.length,
      created: results.filter((result) => result.status === 'CREATED').length,
      skipped: results.filter((result) => result.status === 'SKIPPED').length,
      failed: results.filter((result) => result.status === 'FAILED').length
    };

    recordAuditSafe('RECIPIENT_IMPORT', req, { summary });

    return res.json({ success: true, data: { summary, results } });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to confirm import' } });
  }
};
