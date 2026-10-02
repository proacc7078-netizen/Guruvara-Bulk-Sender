import { Request, Response, RequestHandler } from 'express';
import { prisma } from '../config/db';
import { recordAuditSafe } from '../services/audit.service';
import { publicStatus } from '../services/google-sync.service';
import { resolveWhatsAppConfigState, isProviderConfigured, isWebhookConfigured, getWhatsAppMaxRetries } from '../services/whatsapp/config';
import { createWhatsAppAdapterForConfig } from '../services/whatsapp/whatsappProvider';
import { getWebhookConfigState } from '../services/whatsapp/whatsappWebhook.service';
import { backupService } from '../services/backup/backup.service';
import { backupScheduler } from '../services/backup/backup.scheduler';
import { DEFAULT_BACKUP_DIRECTORY, DEFAULT_BACKUP_INTERVAL_HOURS, DEFAULT_BACKUP_RETENTION_COUNT } from '../services/backup/backup.types';
import type { WhatsAppVerificationResult } from '../services/whatsapp/types';

function getWhatsAppTokenConfigured(): boolean {
  return !!process.env.WHATSAPP_ACCESS_TOKEN;
}

/**
 * Phase 5.12 — safe, non-secret backup metadata for the Settings page.
 * Only the backup directory *label* is exposed (never an absolute path) and no
 * credential-like value is included.
 */
async function readBackupSettingsSection(): Promise<Record<string, unknown>> {
  try {
    const status = await backupService.getStatus();
    const schedulerState = backupScheduler.getState();
    const scheduleConfig = backupScheduler.getConfig();
    const lastBackupStatus =
      schedulerState.lastStatus !== 'NEVER'
        ? schedulerState.lastStatus
        : status.newestBackupAt
          ? 'AVAILABLE'
          : 'NEVER';

    return {
      enabled: scheduleConfig.enabled,
      backupDirectory: status.backupDirectoryLabel,
      retentionCount: status.retentionCount,
      intervalHours: scheduleConfig.intervalHours,
      lastBackupAt: schedulerState.lastRunAt ?? status.newestBackupAt,
      lastBackupStatus,
      lastBackupError: schedulerState.lastError,
      backupCount: status.backupCount,
      totalSizeBytes: status.totalSizeBytes,
      operationInProgress: status.lock.operation !== null,
      operation: status.lock.operation,
      pendingRestore: status.pendingRestore,
      schedulerState: backupScheduler.isRunning() ? 'running' : 'stopped',
      schedulerEnabled: scheduleConfig.enabled,
    };
  } catch {
    return {
      enabled: false,
      backupDirectory: DEFAULT_BACKUP_DIRECTORY,
      retentionCount: DEFAULT_BACKUP_RETENTION_COUNT,
      intervalHours: DEFAULT_BACKUP_INTERVAL_HOURS,
      lastBackupAt: null,
      lastBackupStatus: 'NEVER',
      lastBackupError: null,
      backupCount: 0,
      totalSizeBytes: 0,
      operationInProgress: false,
      operation: null,
      pendingRestore: null,
      schedulerState: 'stopped',
      schedulerEnabled: false,
    };
  }
}

export const getSettings: RequestHandler = async (req, res, next) => {
  try {
    const { rawProvider, config, error } = resolveWhatsAppConfigState();
    const configured = isProviderConfigured(config ?? { provider: 'none' });

    let connectionStatus = 'DISCONNECTED';
    let verification: WhatsAppVerificationResult = { verified: false, reason: 'NOT_CONFIGURED', message: 'WhatsApp provider is not configured.' };
    let phoneInfo: { id?: string; displayPhoneNumber?: string; verifiedName?: string } | null = null;
    let apiVersion: string | undefined;

    if (error) {
      // A provider was selected but its environment is incomplete/invalid.
      // resolveWhatsAppConfigState() returns config=null alongside the error,
      // so this is checked on `error` (not `config && error`).
      connectionStatus = 'DISCONNECTED';
      verification = {
        verified: false,
        reason: 'CONFIG_INVALID',
        message:
          rawProvider === 'openwa'
            ? 'OpenWA provider configuration is incomplete.'
            : 'Official WhatsApp provider configuration is incomplete.',
      };
    } else if (config && (rawProvider === 'official' || rawProvider === 'openwa')) {
      // Any successfully resolved provider (official Meta or OpenWA) is
      // verified through the existing adapter infrastructure. No provider
      // specific HTTP call is made here.
      if (rawProvider === 'official') {
        apiVersion = (config as { apiVersion: string }).apiVersion;
      }
      const adapter = createWhatsAppAdapterForConfig(config);
      try {
        if (typeof adapter.verifyConnection === 'function') {
          verification = await adapter.verifyConnection();
        }
      } catch {
        verification = { verified: false, reason: 'API_ERROR', message: 'Verification failed.' };
      }
      // Derive the reported connection status from the verification result so
      // the response reflects the live provider state (for example an OpenWA
      // session reporting "ready") rather than the adapter's local state from
      // before verification ran.
      try {
        const status = await adapter.getStatus();
        connectionStatus =
          status === 'CONNECTED' || status === 'CONNECTING'
            ? status
            : verification.verified
              ? 'CONNECTED'
              : 'DISCONNECTED';
      } catch {
        connectionStatus = verification.verified ? 'CONNECTED' : 'DISCONNECTED';
      }
      if (verification.phoneNumber) {
        phoneInfo = verification.phoneNumber;
      }
      try {
        const summary = adapter.getConfigSummary?.();
        if (summary?.apiVersion) {
          apiVersion = summary.apiVersion;
        }
      } catch {
        // use env-based apiVersion
      }
    } else {
      // Explicit fallback: no provider is configured (WHATSAPP_PROVIDER=none),
      // so no adapter is built and the safe unconfigured result is reported.
      connectionStatus = 'DISCONNECTED';
      verification = { verified: false, reason: 'NOT_CONFIGURED', message: 'WhatsApp provider is not configured.' };
    }

    const webhookState = getWebhookConfigState();
    const webhookTokenConfigured = !!(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN && process.env.WHATSAPP_APP_SECRET);

    const maxRetries = getWhatsAppMaxRetries();

    const serverApp = req.app as any;
    const workerRunning = serverApp?.worker?.isRunning?.() ?? false;
    const schedulerRunning = serverApp?.scheduler?.isRunning?.() ?? false;
    const pollIntervalMs = Number(process.env.SCHEDULER_POLL_INTERVAL_MS) || 60000;
    const batchSize = Number(process.env.SCHEDULER_BATCH_SIZE) || 25;
    const sessionMaxAgeMs = Number(process.env.SESSION_MAX_AGE_MS) || 24 * 60 * 60 * 1000;
    const actorUserId = typeof req.session?.userId === 'string' ? req.session.userId : null;
    const actorUser = actorUserId
      ? await prisma.user.findUnique({ where: { id: actorUserId }, select: { lastLoginAt: true } })
      : null;

    return res.json({
      success: true,
      data: {
        whatsapp: {
          provider: rawProvider,
          configured,
          connectionStatus,
          verification: {
            verified: verification.verified,
            reason: verification.reason,
            message: verification.message,
          },
          phoneInfo,
          apiVersion,
          tokenConfigured: getWhatsAppTokenConfigured(),
          webhookConfigured: isWebhookConfigured(),
          webhookVerificationStatus: {
            configured: webhookState.configured,
            error: webhookState.error ? webhookState.error.message : null,
          },
          webhookTokenConfigured,
        },
        sending: {
          maxRetries,
          retryBackoff: {
            baseDelayMs: 30_000,
            maxDelayMs: 60 * 60 * 1000,
            multiplier: 2,
            jitterPercent: 25,
          },
        },
        scheduler: {
          state: schedulerRunning ? 'running' : 'stopped',
          pollIntervalMs,
          batchSize,
          workerState: workerRunning ? 'running' : 'stopped',
        },
        security: {
          twoFactorEnabled: false,
          sessionActive: Boolean(actorUserId),
          sessionExpiry: actorUserId ? new Date(Date.now() + sessionMaxAgeMs).toISOString() : undefined,
          lastLoginAt: actorUser?.lastLoginAt?.toISOString(),
          activeSessionCount: actorUserId ? 1 : 0,
        },
        storage: {
          uploadPath: 'storage/uploads',
          mediaLimits: {
            maxFileSizeBytes: 5 * 1024 * 1024,
            allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
          },
        },
        backup: await readBackupSettingsSection(),
        googleSheets: publicStatus(),
        system: {
          version: '1.0.0',
          database: 'connected',
          health: 'ok',
        },
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch settings' } });
  }
};

export const verifyConnection: RequestHandler = async (req, res, next) => {
  try {
    const { rawProvider, config, error } = resolveWhatsAppConfigState();

    if (!config || error || !isProviderConfigured(config)) {
      return res.status(409).json({
        success: false,
        errorCode: 'WHATSAPP_PROVIDER_NOT_CONFIGURED',
        errorMessage: 'WhatsApp provider is not configured.',
      });
    }

    const adapter = createWhatsAppAdapterForConfig(config);
    const verifyFn = adapter.verifyConnection as (() => Promise<WhatsAppVerificationResult>) | undefined;
    if (!verifyFn) {
      return res.json({
        success: true,
        data: {
          verified: false,
          reason: 'API_ERROR',
          message: 'Verification is not supported by this provider.',
          httpStatus: undefined,
          phoneInfo: null,
        },
      });
    }
    const result = await verifyFn();
    recordAuditSafe('SETTINGS_VERIFY_CONNECTION', req, {
      verified: result.verified,
      reason: result.reason,
    });

    return res.json({
      success: true,
      data: {
        verified: result.verified,
        reason: result.reason,
        message: result.message,
        httpStatus: result.httpStatus,
        phoneInfo: result.phoneNumber ?? null,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Verification failed' } });
  }
};
