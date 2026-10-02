import fs from 'fs';
import path from 'path';
import { BackupService, backupService } from './backup.service';
import { resolveBackupDirectory } from './backup.paths';
import {
  BACKUP_SCHEDULER_STATE_FILE,
  BackupScheduleConfig,
  BackupScheduleCycleResult,
  BackupScheduleState,
  describeError,
  isBackupError,
  readBackupIntervalHours,
  readBackupRetentionCount,
  readBackupScheduleEnabled,
  readBackupSchedulerPollIntervalMs,
} from './backup.types';

/**
 * Phase 5.12 — automatic backup scheduling.
 *
 * This is a dedicated, additive service: it never touches campaign scheduling,
 * the delivery worker or the retry logic. It only calls the backup service.
 *
 * Design notes:
 * - Automatic backups are OFF unless `BACKUP_SCHEDULE_ENABLED=true`.
 * - The due-check is persisted in `<backup dir>/.backup-scheduler-state.json`,
 *   so the schedule survives a normal application restart (the in-memory timer
 *   is only the polling mechanism, never the source of truth).
 * - Only one backup/restore runs at a time (shared process-local lock), so a
 *   manual backup and a scheduled backup can never collide.
 * - Failures are logged and recorded in the state file; the next attempt waits a
 *   full interval instead of retrying in a tight loop.
 */

export function readBackupScheduleConfig(env: NodeJS.ProcessEnv = process.env): BackupScheduleConfig {
  return {
    enabled: readBackupScheduleEnabled(env),
    intervalHours: readBackupIntervalHours(env),
    retentionCount: readBackupRetentionCount(env),
    pollIntervalMs: readBackupSchedulerPollIntervalMs(env),
    directory: resolveBackupDirectory(env),
  };
}

export function createEmptyBackupScheduleState(): BackupScheduleState {
  return {
    lastRunAt: null,
    lastAttemptAt: null,
    lastStatus: 'NEVER',
    lastBackupId: null,
    lastError: null,
    lastRetentionDeleted: 0,
  };
}

export function readBackupScheduleState(stateFilePath: string): BackupScheduleState {
  const empty = createEmptyBackupScheduleState();
  try {
    if (!fs.existsSync(stateFilePath)) return empty;
    const parsed = JSON.parse(fs.readFileSync(stateFilePath, 'utf8')) as Partial<BackupScheduleState>;
    return {
      lastRunAt: typeof parsed.lastRunAt === 'string' ? parsed.lastRunAt : null,
      lastAttemptAt: typeof parsed.lastAttemptAt === 'string' ? parsed.lastAttemptAt : null,
      lastStatus:
        parsed.lastStatus === 'SUCCESS' || parsed.lastStatus === 'FAILED' ? parsed.lastStatus : 'NEVER',
      lastBackupId: typeof parsed.lastBackupId === 'string' ? parsed.lastBackupId : null,
      lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
      lastRetentionDeleted:
        typeof parsed.lastRetentionDeleted === 'number' ? parsed.lastRetentionDeleted : 0,
    };
  } catch {
    return empty;
  }
}

export function writeBackupScheduleState(stateFilePath: string, state: BackupScheduleState): void {
  try {
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    const tempFile = `${stateFilePath}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tempFile, stateFilePath);
  } catch (error) {
    console.error('[backup-scheduler] could not persist scheduler state:', describeError(error));
  }
}

export class BackupSchedulerService {
  private interval: NodeJS.Timeout | null = null;
  private running = false;
  private processing = false;
  private state: BackupScheduleState;

  constructor(
    private readonly service: BackupService = backupService,
    private readonly config: BackupScheduleConfig = readBackupScheduleConfig(),
    private readonly tickIntervalMs: number = config.pollIntervalMs
  ) {
    this.state = readBackupScheduleState(this.getStateFilePath());
  }

  getStateFilePath(): string {
    return path.join(this.config.directory, BACKUP_SCHEDULER_STATE_FILE);
  }

  getConfig(): BackupScheduleConfig {
    return this.config;
  }

  getState(): BackupScheduleState {
    return this.state;
  }

  isRunning(): boolean {
    return this.running;
  }

  isProcessing(): boolean {
    return this.processing;
  }

  start(): void {
    if (this.running) return;
    if (!this.config.enabled) {
      // Automatic backups stay off: nothing is scheduled and no state is written.
      return;
    }
    this.running = true;
    this.interval = setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);
    void this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    while (this.processing) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private async tick(): Promise<void> {
    if (!this.running || this.processing) return;
    try {
      await this.runCycle();
    } catch (error) {
      console.error('[backup-scheduler] cycle error:', describeError(error));
    }
  }

  private isDue(now: Date): boolean {
    const lastAttempt = this.state.lastAttemptAt ?? this.state.lastRunAt;
    if (!lastAttempt) return true;
    const last = Date.parse(lastAttempt);
    if (Number.isNaN(last)) return true;
    return now.getTime() - last >= this.config.intervalHours * 60 * 60 * 1000;
  }

  /**
   * Runs one scheduler cycle. Duplicate prevention is deterministic: a second
   * concurrent call observes `processing === true` and returns immediately.
   */
  async runCycle(options: { force?: boolean } = {}): Promise<BackupScheduleCycleResult> {
    if (this.processing) return { ran: false, reason: 'already-running' };
    if (!this.config.enabled && options.force !== true) return { ran: false, reason: 'disabled' };

    const now = new Date();
    if (options.force !== true && !this.isDue(now)) return { ran: false, reason: 'not-due' };

    this.processing = true;
    try {
      const summary = await this.service.createBackup({
        kind: 'SCHEDULED',
        retention: false,
        audit: { trigger: 'SCHEDULED' },
      });

      const retention = await this.service.runRetention({ audit: { trigger: 'SCHEDULED' } });

      this.state = {
        lastRunAt: now.toISOString(),
        lastAttemptAt: now.toISOString(),
        lastStatus: 'SUCCESS',
        lastBackupId: summary.backupId,
        lastError: null,
        lastRetentionDeleted: retention.deleted.length,
      };
      writeBackupScheduleState(this.getStateFilePath(), this.state);

      return { ran: true, backupId: summary.backupId, retentionDeleted: retention.deleted.length };
    } catch (error) {
      const errorCode = isBackupError(error) ? error.code : 'BACKUP_FAILED';
      const errorMessage = describeError(error);
      this.state = {
        ...this.state,
        lastAttemptAt: now.toISOString(),
        lastStatus: 'FAILED',
        lastError: errorMessage,
      };
      writeBackupScheduleState(this.getStateFilePath(), this.state);
      console.error('[backup-scheduler] scheduled backup failed:', errorCode, errorMessage);
      return { ran: false, reason: 'failed', errorCode, errorMessage };
    } finally {
      this.processing = false;
    }
  }
}

/** Shared scheduler instance used by index.ts and the Settings API. */
export const backupScheduler = new BackupSchedulerService();