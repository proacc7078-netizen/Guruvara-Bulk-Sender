import { RequestHandler, Response } from 'express';
import { backupService } from '../services/backup/backup.service';
import { backupScheduler } from '../services/backup/backup.scheduler';
import { describeError, isBackupError } from '../services/backup/backup.types';

/**
 * Phase 5.12 — Backup & Recovery HTTP layer.
 *
 * Every route is mounted behind `requireAuth` (see routes/backups.routes.ts).
 * No filesystem path is ever accepted from the client: backups are addressed by
 * backup id only and always resolved inside the configured backup directory.
 */

function failure(res: Response, error: unknown, fallbackCode: string, fallbackMessage: string): Response {
  if (isBackupError(error)) {
    return res.status(error.httpStatus).json({
      success: false,
      error: { code: error.code, message: error.message, details: error.details },
    });
  }
  return res.status(500).json({ success: false, error: { code: fallbackCode, message: fallbackMessage } });
}

export const listBackups: RequestHandler = async (_req, res) => {
  try {
    const [backups, status] = await Promise.all([backupService.listBackups(), backupService.getStatus()]);
    return res.json({
      success: true,
      data: {
        backups,
        total: backups.length,
        backupDirectory: status.backupDirectoryLabel,
        retentionCount: status.retentionCount,
        backupCount: status.backupCount,
        totalSizeBytes: status.totalSizeBytes,
        lock: status.lock,
        pendingRestore: status.pendingRestore,
      },
    });
  } catch (error) {
    return failure(res, error, 'BACKUP_LIST_FAILED', 'Failed to list backups');
  }
};

export const createBackup: RequestHandler = async (req, res) => {
  try {
    const includeMedia = (req.body as { includeMedia?: unknown } | undefined)?.includeMedia;
    const backup = await backupService.createBackup({
      kind: 'MANUAL',
      includeMedia: includeMedia !== false,
      audit: { req, trigger: 'MANUAL' },
    });
    return res.status(201).json({ success: true, data: { backup } });
  } catch (error) {
    return failure(res, error, 'BACKUP_CREATE_FAILED', 'Failed to create backup');
  }
};

export const getBackup: RequestHandler = async (req, res) => {
  try {
    const backup = await backupService.getBackup(String(req.params.id));
    if (!backup) {
      return res
        .status(404)
        .json({ success: false, error: { code: 'BACKUP_NOT_FOUND', message: 'Backup not found' } });
    }
    return res.json({ success: true, data: { backup } });
  } catch (error) {
    return failure(res, error, 'BACKUP_READ_FAILED', 'Failed to read backup');
  }
};

export const verifyBackup: RequestHandler = async (req, res) => {
  try {
    const result = await backupService.verifyBackup(String(req.params.id), { req, trigger: 'MANUAL' });
    return res.json({ success: true, data: result });
  } catch (error) {
    return failure(res, error, 'BACKUP_VERIFY_FAILED', 'Failed to verify backup');
  }
};

export const deleteBackup: RequestHandler = async (req, res) => {
  try {
    const result = await backupService.deleteBackup(String(req.params.id), { req, trigger: 'MANUAL' });
    return res.json({ success: true, data: result });
  } catch (error) {
    return failure(res, error, 'BACKUP_DELETE_FAILED', 'Failed to delete backup');
  }
};

export const restoreBackup: RequestHandler = async (req, res) => {
  const backupId = String(req.params.id);
  try {
    const body = (req.body ?? {}) as { confirmRestore?: unknown; confirmBackupId?: unknown };
    if (body.confirmRestore !== true) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'CONFIRMATION_REQUIRED',
          message: 'Restore requires confirmRestore: true because it replaces application data',
        },
      });
    }
    if (body.confirmBackupId !== undefined && body.confirmBackupId !== backupId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'CONFIRMATION_MISMATCH',
          message: 'Confirmed backup id does not match the requested backup',
        },
      });
    }

    const result = await backupService.restoreBackup(backupId, {
      confirmed: true,
      audit: { req, trigger: 'MANUAL' },
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    if (isBackupError(error)) {
      return res.status(error.httpStatus).json({
        success: false,
        error: { code: error.code, message: error.message, details: error.details },
        restoreFailed: true,
      });
    }
    return res.status(500).json({
      success: false,
      error: { code: 'BACKUP_RESTORE_FAILED', message: `Restore failed: ${describeError(error)}` },
      restoreFailed: true,
    });
  }
};

export const getBackupStatus: RequestHandler = async (_req, res) => {
  try {
    const status = await backupService.getStatus();
    return res.json({
      success: true,
      data: {
        ...status,
        scheduler: {
          enabled: backupScheduler.getConfig().enabled,
          running: backupScheduler.isRunning(),
          intervalHours: backupScheduler.getConfig().intervalHours,
          lastRunAt: backupScheduler.getState().lastRunAt,
          lastStatus: backupScheduler.getState().lastStatus,
        },
      },
    });
  } catch (error) {
    return failure(res, error, 'BACKUP_STATUS_FAILED', 'Failed to read backup status');
  }
};

export const runRetentionCleanup: RequestHandler = async (req, res) => {
  try {
    const result = await backupService.runRetention({ audit: { req } });
    return res.json({
      success: true,
      data: {
        removedCount: result.deleted.length,
        retainedCount: result.kept.length,
      },
    });
  } catch (error) {
    return failure(res, error, 'BACKUP_RETENTION_FAILED', 'Retention cleanup failed');
  }
};