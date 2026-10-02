import type { Request } from 'express';

/**
 * Phase 5.12 — Backup & Recovery: shared types, constants and configuration.
 *
 * The backup subsystem is LOCAL-FIRST and FREE:
 * - the SQLite database is copied with a SQLite-safe `VACUUM INTO` snapshot
 * - uploaded media is copied from the local storage directory
 * - everything is published as a single portable `backup-<timestamp>.tar.gz`
 *
 * No cloud provider, no external API, no distributed locking is involved.
 */

/** Bumped whenever the on-disk archive layout or manifest contract changes. */
export const BACKUP_FORMAT_VERSION = 1;

/** Archive layout (relative entry names inside the tar.gz). */
export const BACKUP_MANIFEST_ENTRY = 'backup-manifest.json';
export const BACKUP_DATABASE_DIR = 'database';
export const BACKUP_DATABASE_FILE = 'database.sqlite';
export const BACKUP_MEDIA_DIR = 'media';

/** Entry names that a backup archive is allowed to contain. */
export const BACKUP_ALLOWED_ENTRY_PREFIXES = [
  BACKUP_MANIFEST_ENTRY,
  `${BACKUP_DATABASE_DIR}/`,
  `${BACKUP_MEDIA_DIR}/`,
];

/** Archive / identifier contract. */
export const BACKUP_ARCHIVE_EXTENSION = '.tar.gz';
export const BACKUP_CHECKSUM_EXTENSION = '.sha256';
export const BACKUP_METADATA_EXTENSION = '.manifest.json';
export const BACKUP_ID_PREFIX = 'backup-';
export const BACKUP_ID_PATTERN = /^backup-[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const BACKUP_ARCHIVE_FILE_PATTERN = /^backup-[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz$/;

/** Working directories inside the backup directory (dot-prefixed so retention skips them). */
export const BACKUP_STAGING_PREFIX = '.staging-';
export const BACKUP_RESTORE_TMP_PREFIX = '.restore-tmp-';
export const BACKUP_RESTORE_JOURNAL_DIR = '.restore-journal';
export const BACKUP_RESTORE_MARKER_FILE = 'restore-in-progress.json';
export const BACKUP_SCHEDULER_STATE_FILE = '.backup-scheduler-state.json';

/** Configuration defaults (conservative, local-first). */
export const DEFAULT_BACKUP_DIRECTORY = 'storage/backups';
export const DEFAULT_BACKUP_RETENTION_COUNT = 10;
export const DEFAULT_BACKUP_INTERVAL_HOURS = 24;
export const DEFAULT_BACKUP_SCHEDULER_POLL_INTERVAL_MS = 60_000;
export const MIN_BACKUP_SCHEDULER_POLL_INTERVAL_MS = 1_000;
export const MAX_BACKUP_ERROR_LENGTH = 500;
export const DEFAULT_APP_VERSION = '1.0.0';

export type BackupKind = 'MANUAL' | 'SCHEDULED' | 'PRE_RESTORE';

export type BackupOperationKind = 'BACKUP' | 'RESTORE';

export interface BackupMediaFileEntry {
  path: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * Non-secret manifest written inside the archive and mirrored to a sidecar file.
 * It must never contain credentials, tokens or secrets of any kind.
 */
export interface BackupManifest {
  backupFormatVersion: number;
  backupId: string;
  createdAt: string;
  kind: BackupKind;
  appVersion: string;
  application: {
    nodeVersion: string;
    platform: string;
  };
  /** Relative label of the media root (never an absolute filesystem path). */
  mediaRootLabel: string;
  database: {
    fileName: string;
    sizeBytes: number;
    sha256: string;
    sqliteHeaderValid: boolean;
  };
  media: {
    included: boolean;
    fileCount: number;
    totalSizeBytes: number;
    files: BackupMediaFileEntry[];
  };
  archiveFileName: string;
  /** Filled in on the sidecar copy only (an archive cannot contain its own size). */
  archiveSizeBytes?: number;
  archiveSha256?: string;
}

export interface BackupSummary {
  backupId: string;
  fileName: string;
  createdAt: string | null;
  kind: BackupKind | null;
  sizeBytes: number;
  archiveSha256: string | null;
  databaseSizeBytes: number | null;
  mediaFileCount: number | null;
  manifest: BackupManifest | null;
  manifestError: string | null;
}

export interface BackupErrorInfo {
  code: string;
  message: string;
}

export interface BackupVerificationChecks {
  archivePresent: boolean;
  archiveChecksumPresent: boolean;
  archiveChecksumValid: boolean;
  archiveReadable: boolean;
  manifestPresent: boolean;
  manifestValid: boolean;
  manifestMatchesSidecar: boolean;
  archivePathsSafe: boolean;
  databasePresent: boolean;
  databaseChecksumValid: boolean;
  databaseHeaderValid: boolean;
  mediaPresent: boolean;
  mediaChecksumValid: boolean;
}

export interface BackupVerificationResult {
  valid: boolean;
  backupId: string;
  createdAt: string | null;
  errors: BackupErrorInfo[];
  warnings: BackupErrorInfo[];
  checks: BackupVerificationChecks;
  /** Non-secret manifest as read from the archive (null when it could not be validated). */
  manifest?: BackupManifest | null;
}

export interface BackupRestoreResult {
  restored: boolean;
  backupId: string;
  safetyBackupId: string | null;
  databaseRestored: boolean;
  mediaRestoredFiles: number;
  mediaOverwrittenFiles: number;
  durationMs: number;
}

export interface BackupRetentionResult {
  keepCount: number;
  examined: number;
  kept: string[];
  deleted: string[];
  protectedIds: string[];
  skipped: string[];
}

export interface BackupLockState {
  operation: BackupOperationKind | null;
  startedAt: string | null;
  backupId: string | null;
}

export interface PendingRestoreMarker {
  restoreId: string;
  backupId: string;
  safetyBackupId: string | null;
  startedAt: string;
}

export interface BackupServiceStatus {
  backupDirectoryLabel: string;
  retentionCount: number;
  backupCount: number;
  totalSizeBytes: number;
  newestBackupAt: string | null;
  lock: BackupLockState;
  pendingRestore: PendingRestoreMarker | null;
}

export interface BackupScheduleConfig {
  enabled: boolean;
  intervalHours: number;
  retentionCount: number;
  pollIntervalMs: number;
  directory: string;
}

export type BackupScheduleStatus = 'NEVER' | 'SUCCESS' | 'FAILED';

export interface BackupScheduleState {
  lastRunAt: string | null;
  lastAttemptAt: string | null;
  lastStatus: BackupScheduleStatus;
  lastBackupId: string | null;
  lastError: string | null;
  lastRetentionDeleted: number;
}

export interface BackupScheduleCycleResult {
  ran: boolean;
  reason?: string;
  backupId?: string;
  retentionDeleted?: number;
  errorCode?: string;
  errorMessage?: string;
}

/** Error type used for every expected backup/restore failure. */
export class BackupError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, httpStatus = 400, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export function isBackupError(error: unknown): error is BackupError {
  return error instanceof BackupError;
}

/** Optional request context so audit records keep actor/IP information. */
export interface BackupAuditContext {
  req?: Request;
  trigger?: string;
}

function readBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function readNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) return fallback;
  return value;
}

/** `BACKUP_SCHEDULE_ENABLED` — automatic backups are OFF by default. */
export function readBackupScheduleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBoolean(env.BACKUP_SCHEDULE_ENABLED, false);
}

/**
 * `BACKUP_RETENTION_COUNT` — number of newest backups to keep.
 * A value <= 0 disables retention cleanup entirely.
 */
export function readBackupRetentionCount(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.BACKUP_RETENTION_COUNT);
  if (!Number.isFinite(value)) return DEFAULT_BACKUP_RETENTION_COUNT;
  return Math.floor(value);
}

/** `BACKUP_INTERVAL_HOURS` — interval used by the backup scheduler. */
export function readBackupIntervalHours(env: NodeJS.ProcessEnv = process.env): number {
  return readNumber(env.BACKUP_INTERVAL_HOURS, DEFAULT_BACKUP_INTERVAL_HOURS, 0.0001, 24 * 365);
}

/** `BACKUP_SCHEDULER_POLL_INTERVAL_MS` — how often the scheduler checks whether a backup is due. */
export function readBackupSchedulerPollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(
    readNumber(
      env.BACKUP_SCHEDULER_POLL_INTERVAL_MS,
      DEFAULT_BACKUP_SCHEDULER_POLL_INTERVAL_MS,
      MIN_BACKUP_SCHEDULER_POLL_INTERVAL_MS,
      24 * 60 * 60 * 1000
    )
  );
}

/** Truncates and flattens error text so audit metadata stays safe and bounded. */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, MAX_BACKUP_ERROR_LENGTH);
}
