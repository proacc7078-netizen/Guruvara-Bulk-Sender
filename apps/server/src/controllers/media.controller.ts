import { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../config/db';
import { recordAuditSafe } from '../services/audit.service';
import { verifyPublicMediaToken } from '../services/publicMedia.service';

const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE = 5 * 1024 * 1024;

function getStorageDir(): string {
  return path.resolve(__dirname, '..', '..', '..', '..', 'storage', 'uploads');
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = getStorageDir();
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    const safeName = uuidv4() + ext;
    cb(null, safeName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type. Only JPG, PNG, and WebP are allowed.'));
    }
  },
});

export const uploadMedia = (req: Request, res: Response) => {
  upload.single('file')(req, res, async (err: any) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'File exceeds maximum size of 5 MB' } });
      }
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } });
      }
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message || 'Upload failed' } });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No file provided' } });
    }

    const file = req.file;
    const messageId = req.body.messageId || null;

    try {
      let replacedMediaId: string | null = null;
      if (messageId) {
        if (typeof messageId !== 'string' || !messageId.trim() || messageId.length > 200) {
          return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid message ID' } });
        }
        const existingMedia = await prisma.media.findFirst({ where: { messageId: messageId.trim() } });
        if (existingMedia) {
          replacedMediaId = existingMedia.id;
          try {
            fs.unlinkSync(existingMedia.storagePath);
          } catch {
            // file already gone, continue
          }
          await prisma.media.delete({ where: { id: existingMedia.id } });
        }
      }

      const storagePath = file.path;
      const media = await prisma.media.create({
        data: {
          filename: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          storagePath,
          messageId: messageId || undefined,
        },
      });

      recordAuditSafe('MEDIA_UPLOAD', req, {
        mediaId: media.id,
        messageId: media.messageId,
        replacedMediaId,
        size: media.size,
        mimeType: media.mimeType,
      });

      return res.status(201).json({
        success: true,
        data: {
          id: media.id,
          filename: media.filename,
          mimeType: media.mimeType,
          size: media.size,
          messageId: media.messageId,
          storagePath: media.storagePath,
        },
      });
    } catch (error) {
      try {
        if (file.path && fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      } catch {
        // best effort cleanup
      }
      return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to upload media' } });
    }
  });
};

export const getPublicMedia = async (req: Request, res: Response) => {
  const mediaId = typeof req.params.id === 'string' ? req.params.id : '';
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!mediaId || !verifyPublicMediaToken(mediaId, token)) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Media not found' } });
  }
  const media = await prisma.media.findUnique({ where: { id: mediaId } });
  if (!media || !fs.existsSync(media.storagePath)) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Media not found' } });
  }
  return res.sendFile(media.storagePath, {
    headers: {
      'Content-Type': media.mimeType,
      'Content-Disposition': `inline; filename="${media.filename}"`,
    },
  });
};

export const getMedia = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const mediaId = Array.isArray(id) ? id[0] : id;
    if (!mediaId || typeof mediaId !== 'string' || !mediaId.trim() || mediaId.length > 200) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid media ID' } });
    }

    const media = await prisma.media.findUnique({ where: { id: mediaId.trim() } });

    if (!media) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Media not found' } });
    }

    if (!fs.existsSync(media.storagePath)) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Media file no longer exists' } });
    }

    return res.sendFile(media.storagePath, {
      headers: {
        'Content-Type': media.mimeType,
        'Content-Disposition': `inline; filename="${media.filename}"`,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch media' } });
  }
};

export const deleteMedia = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const mediaId = Array.isArray(id) ? id[0] : id;
    if (!mediaId || typeof mediaId !== 'string' || !mediaId.trim() || mediaId.length > 200) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid media ID' } });
    }

    const media = await prisma.media.findUnique({ where: { id: mediaId.trim() } });

    if (!media) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Media not found' } });
    }

    let fileDeleted = true;
    try {
      if (fs.existsSync(media.storagePath)) {
        fs.unlinkSync(media.storagePath);
      }
    } catch {
      fileDeleted = false;
    }

    await prisma.media.delete({ where: { id: mediaId } });

    recordAuditSafe('MEDIA_DELETE', req, { mediaId, messageId: media.messageId, fileDeleted });

    return res.json({ success: true, data: { fileDeleted } });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete media' } });
  }
};
