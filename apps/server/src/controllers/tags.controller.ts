import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { recordAuditSafe } from '../services/audit.service';

export const getTags = async (req: Request, res: Response) => {
  try {
    const tags = await prisma.tag.findMany({
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: { recipients: true }
        }
      }
    });
    return res.json({ success: true, data: tags });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch tags' } });
  }
};

export const createTag = async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Tag name is required' } });
    }
    if (String(name).trim().length > 200) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Tag name must be at most 200 characters' } });
    }

    const trimmedName = String(name).trim();
    const existing = await prisma.tag.findUnique({ where: { name: trimmedName } });
    if (existing) {
      return res.status(400).json({ success: false, error: { code: 'DUPLICATE_TAG', message: 'A tag with this name already exists' } });
    }

    const tag = await prisma.tag.create({ data: { name: trimmedName } });
    recordAuditSafe('TAG_CREATE', req, { tagId: tag.id, name: tag.name });
    return res.json({ success: true, data: tag });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create tag' } });
  }
};

export const updateTag = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tagId = Array.isArray(id) ? id[0] : id;
    const { name } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Tag name is required' } });
    }
    if (String(name).trim().length > 200) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Tag name must be at most 200 characters' } });
    }

    // Validate the tag exists
    const existingTag = await prisma.tag.findUnique({ where: { id: tagId } });
    if (!existingTag) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Tag not found' } });
    }

    const trimmedName = String(name).trim();
    const existing = await prisma.tag.findUnique({ where: { name: trimmedName } });
    if (existing && existing.id !== tagId) {
      return res.status(400).json({ success: false, error: { code: 'DUPLICATE_TAG', message: 'A tag with this name already exists' } });
    }

    // Renaming preserves recipient relationships (RecipientTag rows reference tagId, which is unchanged)
    const tag = await prisma.tag.update({ where: { id: tagId }, data: { name: trimmedName } });
    recordAuditSafe('TAG_UPDATE', req, { tagId: tag.id, previousName: existingTag.name, name: tag.name });
    return res.json({ success: true, data: tag });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update tag' } });
  }
};

export const deleteTag = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tagId = Array.isArray(id) ? id[0] : id;

    // Validate the tag exists
    const existingTag = await prisma.tag.findUnique({ where: { id: tagId } });
    if (!existingTag) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Tag not found' } });
    }

    // RecipientTag records are cascade-deleted automatically via the
    // onDelete: Cascade relation in the Prisma schema.
    await prisma.tag.delete({ where: { id: tagId } });
    recordAuditSafe('TAG_DELETE', req, { tagId, name: existingTag.name });
    return res.json({ success: true, data: {} });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete tag' } });
  }
};