import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { prisma } from '../../config/db';
import { recordAudit, recordAuditSafe } from '../audit.service';
import {
  analyzeArchiveEntries,
  createArchive,
  extractArchiveSafely,
  findEntry,
  listArchive,
  normalizeEntryName,
  readArchiveManifestText,
  sha256Buffer,
  sha256File,
  walkFiles,
} from './backup.archive';
import type { ArchiveListingResult } from './backup.archive';
import {
  assertBackupId,
  assertInside,
  backupIdFromArchiveFileName,
  describeBackupDirectory,
  isBackupArtifactFileName,
  isPathInside,
  mediaRootLabel,
  removeDirectoryQuietly,
  repoRoot,
  resolveArchivePath,
  resolveBackupDirectory,
  resolveDatabaseFilePath,
  resolveUploadsDirectory,
  safeMkdtemp,
  toSqlitePathLiteral,
} from './backup.paths';
import { checkManifestSafety, isSqliteBuffer, validateManifest } from './backup.validation';
import {
  BACKUP_ARCHIVE_EXTENSION,
  BACKUP_CHECKSUM_EXTENSION,
  BACKUP_DATABASE_DIR,
  BACKUP_DATABASE_FILE,
  BACKUP_FORMAT_VERSION,
  BACKUP_MANIFEST_ENTRY,
  BACKUP_MEDIA_DIR,
  BACKUP_METADATA_EXTENSION,
  BACKUP_RESTORE_JOURNAL_DIR,
  BACKUP_RESTORE_MARKER_FILE,
  BACKUP_RESTORE_TMP_PREFIX,
  BACKUP_STAGING_PREFIX,
  BackupAuditContext,
  BackupError,
  BackupErrorInfo,
  BackupKind,
  BackupLockState,
  BackupManifest,
  BackupMediaFileEntry,
  BackupOperationKind,
  BackupRestoreResult,
  BackupRetentionResult,
  BackupServiceStatus,
  BackupSummary,
  BackupVerificationChecks,
  BackupVerificationResult,
  DEFAULT_APP_VERSION,
  PendingRestoreMarker,
  describeError,
  isBackupError,
  readBackupRetentionCount,
} from './backup.types';

/**
 * Phase 5.12 — Backup & Recovery service.
 *
 * Responsibilities (local-first, single-instance):
 * - create a consistent SQLite snapshot (`VACUUM INTO`) + a media copy
 * - publish both as one portable `backup-<timestamp>.tar.gz`
 * - list / verify / delete backups
 * - restore a backup with a mandatory pre-restore safety backup and rollback
 * - enforce retention and a single process-local backup/restore lock
 *
 * Boundaries: this service does not touch the WhatsApp adapter, the delivery
 * worker, the campaign scheduler or the retry logic. During a restore it merely
 * asks the application (via an injected hook) to pause background writers.
 */

/** Audit action names used by this subsystem (Phase 5.11 audit service). */
export const BACKUP_AUDIT_ACTIONS = {
  CREATED: 'BACKUP_CREATED',
  VERIFIED: 'BACKUP_VERIFIED',
  RESTORE_STARTED: 'BACKUP_RESTORE_STARTED',
  RESTORE_COMPLETED: 'BACKUP_RESTORE_COMPLETED',
  RESTORE_FAILED: 'BACKUP_RESTORE_FAILED',
  DELETED: 'BACKUP_DELETED',
  RETENTION_CLEANUP: 'BACKUP_RETENTION_CLEANUP',
} as const;

/**
 * Process-local lock. Only one backup/restore operation may run at a time.
 *
 * Multi-instance/distributed locking is explicitly out of scope for the
 * current local-first, single-process architecture (documented limitation).
 */
export class BackupOperationLock {
  private operation: BackupOperationKind | null = null;
  private startedAt: string | null = null;
  private backupId: string | null = null;

  acquire(operation: BackupOperationKind, backupId?: string): () => void {
    if (this.operation) {
      throw new BackupError(
        'BACKUP_OPERATION_IN_PROGRESS',
        `Another backup operation (${this.operation}) is already running`,
        409,
        { runningOperation: this.operation, backupId: this.backupId }
      );
    }
    this.operation = operation;
    this.startedAt = new Date().toISOString();
    this.backupId = backupId ?? null;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.operation = null;
      this.startedAt = null;
      this.backupId = null;
    };
  }

  isHeld(): boolean {
    return this.operation !== null;
  }

  state(): BackupLockState {
    return { operation: this.operation, startedAt: this.startedAt, backupId: this.backupId };
  }
}

export const backupOperationLock = new BackupOperationLock();

/** Reads the first bytes of a file (used for the SQLite magic header check). */
function readFileHeader(filePath: string, length = 16): Buffer {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, '');
}

/** backup-<UTC timestamp>-<random suffix> — safe for filenames and URLs. */
export function createBackupId(date = new Date()): string {
  return `backup-${compactTimestamp(date)}-${crypto.randomBytes(3).toString('hex')}`;
}

function readAppVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'package.json'), 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : DEFAULT_APP_VERSION;
  } catch {
    return DEFAULT_APP_VERSION;
  }
}

export interface CreateBackupOptions {
  kind?: BackupKind;
  includeMedia?: boolean;
  /** Run retention cleanup after publishing the archive (default: true). */
  retention?: boolean;
  /** Set by callers that already hold the process-local lock (restore). */
  assumeLocked?: boolean;
  audit?: BackupAuditContext;
}

export interface BackupServiceOptions {
  /**
   * Called immediately before the current database/media are replaced.
   * The returned function resumes whatever the hook paused (worker/scheduler).
   */
  pauseBackgroundWriters?: () => Promise<() => Promise<void>>;
}

export interface RestoreBackupOptions {
  /** Explicit confirmation; a restore without it is rejected. */
  confirmed: boolean;
  audit?: BackupAuditContext;
}

interface MediaStagingResult {
  files: BackupMediaFileEntry[];
  totalSizeBytes: number;
  skippedLinks: string[];
}

/**
 * Phase 5.12 backup service. A single instance is exported below and shared by
 * the HTTP controller and the backup scheduler.
 */
export class BackupService {
  private readonly lock = backupOperationLock;
  private pauseWriters: (() => Promise<() => Promise<void>>) | null = null;

  constructor(options: BackupServiceOptions = {}) {
    this.pauseWriters = options.pauseBackgroundWriters ?? null;
  }

  /** Wired from index.ts so restore can pause/resume the existing worker + scheduler. */
  setPauseBackgroundWriters(hook: (() => Promise<() => Promise<void>>) | null): void {
    this.pauseWriters = hook;
  }

  getBackupDirectory(): string {
    return resolveBackupDirectory();
  }

  getRetentionCount(): number {
    return readBackupRetentionCount();
  }

  getLockState(): BackupLockState {
    return this.lock.state();
  }

  private ensureBackupDirectory(): string {
    const directory = this.getBackupDirectory();
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  }

  /**
   * SQLite-safe database snapshot. `VACUUM INTO` is executed by SQLite itself,
   * so the produced file is a transactionally consistent copy even while other
   * reads/writes are happening through Prisma (no raw copy of a live database).
   */
  private async snapshotDatabase(targetFile: string): Promise<{ sizeBytes: number; sha256: string }> {
    const databaseFile = resolveDatabaseFilePath();
    if (!databaseFile) {
      throw new BackupError('DATABASE_PATH_UNKNOWN', 'DATABASE_URL does not point to a local SQLite file', 500);
    }
    if (!fs.existsSync(databaseFile)) {
      throw new BackupError('DATABASE_FILE_MISSING', 'SQLite database file was not found', 500);
    }
    if (fs.existsSync(targetFile)) {
      throw new BackupError('DATABASE_SNAPSHOT_TARGET_EXISTS', 'Snapshot target already exists', 500);
    }

    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    try {
      await prisma.$executeRawUnsafe(`VACUUM INTO '${toSqlitePathLiteral(targetFile)}'`);
    } catch (error) {
      throw new BackupError('DATABASE_SNAPSHOT_FAILED', `SQLite snapshot failed: ${describeError(error)}`, 500);
    }
    if (!fs.existsSync(targetFile)) {
      throw new BackupError('DATABASE_SNAPSHOT_FAILED', 'SQLite snapshot did not produce a file', 500);
    }
    if (!isSqliteBuffer(readFileHeader(targetFile))) {
      throw new BackupError('DATABASE_SNAPSHOT_INVALID', 'SQLite snapshot header is invalid', 500);
    }
    const stat = fs.statSync(targetFile);
    return { sizeBytes: stat.size, sha256: await sha256File(targetFile) };
  }

  /** Copies media (relative paths preserved) and hashes every file. */
  private async stageMedia(mediaRoot: string, mediaStageDir: string): Promise<MediaStagingResult> {
    const { files, skippedLinks } = walkFiles(mediaRoot);
    const staged: BackupMediaFileEntry[] = [];
    let totalSizeBytes = 0;

    for (const file of files) {
      const target = assertInside(
        mediaStageDir,
        path.join(mediaStageDir, ...file.relativePath.split('/')),
        'MEDIA_STAGING_PATH_ESCAPE'
      );
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file.absolutePath, target);
      const stat = fs.statSync(target);
      staged.push({
        path: file.relativePath,
        sizeBytes: stat.size,
        sha256: await sha256File(file.absolutePath),
      });
      totalSizeBytes += stat.size;
    }

    return { files: staged, totalSizeBytes, skippedLinks };
  }

  private async resolveSummaries(): Promise<BackupSummary[]> {
    const directory = this.getBackupDirectory();
    if (!fs.existsSync(directory)) return [];

    const summaries: BackupSummary[] = [];
    for (const fileName of fs.readdirSync(directory)) {
      const backupId = backupIdFromArchiveFileName(fileName);
      if (!backupId) continue; // never inspect or touch unrelated files
      const summary = await this.readBackupSummary(directory, backupId, fileName);
      if (summary) summaries.push(summary);
    }

    summaries.sort((a, b) => {
      const aKey = a.createdAt ?? new Date(0).toISOString();
      const bKey = b.createdAt ?? new Date(0).toISOString();
      if (aKey === bKey) return a.backupId.localeCompare(b.backupId);
      return aKey < bKey ? 1 : -1;
    });
    return summaries;
  }

  private async readBackupSummary(
    directory: string,
    backupId: string,
    fileName: string
  ): Promise<BackupSummary | null> {
    const archivePath = assertInside(directory, path.join(directory, fileName), 'PATH_ESCAPE');
    let sizeBytes = 0;
    let archiveSha256: string | null = null;
    let manifest: BackupManifest | null = null;
    let manifestError: string | null = null;

    try {
      sizeBytes = fs.statSync(archivePath).size;
    } catch {
      return null;
    }

    const checksumPath = `${archivePath}${BACKUP_CHECKSUM_EXTENSION}`;
    if (fs.existsSync(checksumPath)) {
      archiveSha256 = fs.readFileSync(checksumPath, 'utf8').trim() || null;
    }

    const sidecarPath = `${archivePath}${BACKUP_METADATA_EXTENSION}`;
    if (fs.existsSync(sidecarPath)) {
      try {
        const parsed = validateManifest(JSON.parse(fs.readFileSync(sidecarPath, 'utf8')));
        if (parsed.valid) manifest = parsed.manifest;
        else manifestError = parsed.errors[0]?.message ?? 'Manifest is invalid';
      } catch (error) {
        manifestError = describeError(error);
      }
    } else {
      manifestError = 'Backup metadata sidecar is missing';
    }

    return {
      backupId,
      fileName,
      createdAt: manifest?.createdAt ?? null,
      kind: manifest?.kind ?? null,
      sizeBytes,
      archiveSha256,
      databaseSizeBytes: manifest?.database.sizeBytes ?? null,
      mediaFileCount: manifest?.media.fileCount ?? null,
      manifest,
      manifestError,
    };
  }

  async listBackups(): Promise<BackupSummary[]> {
    return this.resolveSummaries();
  }

  async getBackup(backupId: string): Promise<BackupSummary | null> {
    const id = assertBackupId(backupId);
    const directory = this.getBackupDirectory();
    const archivePath = resolveArchivePath(directory, id);
    if (!fs.existsSync(archivePath)) return null;
    return this.readBackupSummary(directory, id, path.basename(archivePath));
  }

  /**
   * Deletes a backup archive and its sidecars. Only files inside the backup
   * directory that match the backup artifact naming contract are ever removed.
   */
  async deleteBackup(
    backupId: string,
    auditContext?: BackupAuditContext
  ): Promise<{ backupId: string; deletedFiles: string[] }> {
    const directory = this.getBackupDirectory();
    const id = assertBackupId(backupId);
    const archivePath = resolveArchivePath(directory, id);
    if (!fs.existsSync(archivePath)) {
      throw new BackupError('BACKUP_NOT_FOUND', `Backup ${id} was not found`, 404);
    }
    if (this.lock.state().backupId === id) {
      throw new BackupError(
        'BACKUP_IN_USE',
        'This backup is currently used by a running backup/restore operation',
        409
      );
    }

    const deletedFiles = this.removeArtifacts(directory, id);
    this.audit(BACKUP_AUDIT_ACTIONS.DELETED, auditContext, {
      backupId: id,
      result: 'SUCCESS',
      deletedFiles,
    });
    return { backupId: id, deletedFiles };
  }

  /** Removes the artifact files of one backup id; returns the deleted file names. */
  private removeArtifacts(directory: string, backupId: string): string[] {
    const archivePath = resolveArchivePath(directory, backupId);
    const deletedFiles: string[] = [];
    const targets = [
      archivePath,
      `${archivePath}${BACKUP_CHECKSUM_EXTENSION}`,
      `${archivePath}${BACKUP_METADATA_EXTENSION}`,
    ];
    for (const target of targets) {
      const safeTarget = assertInside(directory, target, 'PATH_ESCAPE');
      if (!isBackupArtifactFileName(path.basename(safeTarget))) continue;
      if (!fs.existsSync(safeTarget)) continue;
      fs.unlinkSync(safeTarget);
      deletedFiles.push(path.basename(safeTarget));
    }
    return deletedFiles;
  }

  /**
   * Retention cleanup: keep the newest N backups, delete only backup artifacts
   * inside the backup directory, never delete a protected/running backup and
   * never touch files that the backup subsystem did not create.
   */
  async runRetention(options: {
    keepCount?: number;
    protectedIds?: string[];
    audit?: BackupAuditContext;
  } = {}): Promise<BackupRetentionResult> {
    const keepCount = options.keepCount ?? this.getRetentionCount();
    const protectedIds = Array.from(new Set(options.protectedIds ?? []));
    const summaries = await this.resolveSummaries();
    const result: BackupRetentionResult = {
      keepCount,
      examined: summaries.length,
      kept: [],
      deleted: [],
      protectedIds,
      skipped: [],
    };

    if (keepCount <= 0) {
      result.kept = summaries.map((summary) => summary.backupId);
      result.skipped.push('retention-disabled');
      return result;
    }

    const runningBackupId = this.lock.state().backupId;
    if (runningBackupId) protectedIds.push(runningBackupId);
    const protectedSet = new Set(protectedIds);

    const keepIds = new Set(summaries.slice(0, keepCount).map((summary) => summary.backupId));
    for (const summary of summaries) {
      if (keepIds.has(summary.backupId) || protectedSet.has(summary.backupId)) {
        result.kept.push(summary.backupId);
        continue;
      }
      try {
        this.removeArtifacts(this.getBackupDirectory(), summary.backupId);
        result.deleted.push(summary.backupId);
      } catch (error) {
        result.skipped.push(`${summary.backupId}:${describeError(error)}`);
      }
    }

    if (result.deleted.length > 0) {
      this.audit(BACKUP_AUDIT_ACTIONS.RETENTION_CLEANUP, options.audit, {
        result: 'SUCCESS',
        keepCount,
        deletedCount: result.deleted.length,
        deletedBackupIds: result.deleted,
        retainedCount: result.kept.length,
      });
    }

    return result;
  }

  /**
   * Creates one backup archive (SQLite snapshot + media copy + manifest) inside
   * the configured backup directory and applies retention afterwards.
   */
  async createBackup(options: CreateBackupOptions = {}): Promise<BackupSummary> {
    const kind: BackupKind = options.kind ?? 'MANUAL';
    const includeMedia = options.includeMedia !== false;
    const startedAt = Date.now();
    const release = options.assumeLocked ? null : this.lock.acquire('BACKUP');
    const directory = this.ensureBackupDirectory();
    const createdAt = new Date();
    const backupId = createBackupId(createdAt);

    let stagingDir: string | null = null;
    try {
      stagingDir = safeMkdtemp(`${BACKUP_STAGING_PREFIX}${backupId}-`, directory);
      const databaseStagePath = path.join(stagingDir, BACKUP_DATABASE_DIR, BACKUP_DATABASE_FILE);
      const databaseSnapshot = await this.snapshotDatabase(databaseStagePath);

      const media = includeMedia
        ? await this.stageMedia(resolveUploadsDirectory(), path.join(stagingDir, BACKUP_MEDIA_DIR))
        : { files: [] as BackupMediaFileEntry[], totalSizeBytes: 0, skippedLinks: [] as string[] };

      const archiveFileName = `${backupId}${BACKUP_ARCHIVE_EXTENSION}`;
      const manifest: BackupManifest = {
        backupFormatVersion: BACKUP_FORMAT_VERSION,
        backupId,
        createdAt: createdAt.toISOString(),
        kind,
        appVersion: readAppVersion(),
        application: {
          nodeVersion: process.version,
          platform: process.platform,
        },
        mediaRootLabel: mediaRootLabel(),
        database: {
          fileName: BACKUP_DATABASE_FILE,
          sizeBytes: databaseSnapshot.sizeBytes,
          sha256: databaseSnapshot.sha256,
          sqliteHeaderValid: true,
        },
        media: {
          included: includeMedia,
          fileCount: media.files.length,
          totalSizeBytes: media.totalSizeBytes,
          files: media.files,
        },
        archiveFileName,
      };

      const safetyIssues = checkManifestSafety(manifest);
      if (safetyIssues.length > 0) {
        throw new BackupError('MANIFEST_UNSAFE', 'Backup manifest would contain unsafe metadata', 500, {
          issues: safetyIssues.map((issue) => issue.code),
        });
      }

      fs.writeFileSync(path.join(stagingDir, BACKUP_MANIFEST_ENTRY), JSON.stringify(manifest, null, 2), 'utf8');

      const entries = [BACKUP_MANIFEST_ENTRY, BACKUP_DATABASE_DIR];
      if (includeMedia) entries.push(BACKUP_MEDIA_DIR);

      const stagedArchivePath = path.join(stagingDir, archiveFileName);
      const archive = await createArchive({ cwd: stagingDir, archivePath: stagedArchivePath, entries });

      // Publish by rename: the archive appears in the backup directory complete.
      const finalArchivePath = resolveArchivePath(directory, backupId);
      fs.renameSync(stagedArchivePath, finalArchivePath);

      const sidecarManifest: BackupManifest = {
        ...manifest,
        archiveSizeBytes: archive.sizeBytes,
        archiveSha256: archive.sha256,
      };
      fs.writeFileSync(
        `${finalArchivePath}${BACKUP_METADATA_EXTENSION}`,
        JSON.stringify(sidecarManifest, null, 2),
        'utf8'
      );
      fs.writeFileSync(`${finalArchivePath}${BACKUP_CHECKSUM_EXTENSION}`, `${archive.sha256}\n`, 'utf8');

      const summary = await this.readBackupSummary(directory, backupId, archiveFileName);
      if (!summary) {
        throw new BackupError('BACKUP_PUBLISH_FAILED', 'Backup was created but could not be read back', 500);
      }

      this.audit(BACKUP_AUDIT_ACTIONS.CREATED, options.audit, {
        backupId,
        kind,
        result: 'SUCCESS',
        trigger: options.audit?.trigger ?? kind,
        databaseSizeBytes: databaseSnapshot.sizeBytes,
        mediaIncluded: includeMedia,
        mediaFileCount: media.files.length,
        archiveSizeBytes: archive.sizeBytes,
        durationMs: Date.now() - startedAt,
      });

      if (options.retention !== false) {
        await this.runRetention({ audit: options.audit });
      }

      return summary;
    } finally {
      if (stagingDir) removeDirectoryQuietly(stagingDir);
      if (release) release();
    }
  }

  /**
   * Full integrity verification. The archive is streamed, never extracted, so
   * verification is safe to run on an untrusted archive.
   */
  async verifyBackup(backupId: string, auditContext?: BackupAuditContext): Promise<BackupVerificationResult> {
    const directory = this.getBackupDirectory();
    const id = assertBackupId(backupId);
    const archivePath = resolveArchivePath(directory, id);
    const checks: BackupVerificationChecks = {
      archivePresent: false,
      archiveChecksumPresent: false,
      archiveChecksumValid: false,
      archiveReadable: false,
      manifestPresent: false,
      manifestValid: false,
      manifestMatchesSidecar: false,
      archivePathsSafe: false,
      databasePresent: false,
      databaseChecksumValid: false,
      databaseHeaderValid: false,
      mediaPresent: false,
      mediaChecksumValid: false,
    };
    const errors: BackupErrorInfo[] = [];
    const warnings: BackupErrorInfo[] = [];
    let createdAt: string | null = null;
    let manifest: BackupManifest | null = null;
    let listing: ArchiveListingResult | null = null;

    try {
      if (!fs.existsSync(archivePath)) {
        errors.push({ code: 'ARCHIVE_MISSING', message: `Backup archive ${id} was not found` });
        return this.finishVerification(id, null, null, errors, warnings, checks, auditContext);
      }
      checks.archivePresent = true;

      const checksumPath = `${archivePath}${BACKUP_CHECKSUM_EXTENSION}`;
      if (fs.existsSync(checksumPath)) {
        checks.archiveChecksumPresent = true;
        const expected = fs.readFileSync(checksumPath, 'utf8').trim();
        const actual = await sha256File(archivePath);
        checks.archiveChecksumValid = expected.length === 64 && expected === actual;
        if (!checks.archiveChecksumValid) {
          errors.push({ code: 'ARCHIVE_CHECKSUM_MISMATCH', message: 'Archive checksum does not match the stored value' });
        }
      } else {
        errors.push({ code: 'ARCHIVE_CHECKSUM_MISSING', message: 'Archive checksum sidecar is missing' });
      }

      let listingLocal: ArchiveListingResult | null = null;
      try {
        listingLocal = await listArchive(archivePath);
        checks.archiveReadable = true;
      } catch (error) {
        errors.push({
          code: isBackupError(error) ? error.code : 'ARCHIVE_CORRUPTED',
          message: `Archive could not be read: ${describeError(error)}`,
        });
        return this.finishVerification(id, null, null, errors, warnings, checks, auditContext);
      }
      listing = listingLocal;

      checks.archivePathsSafe = listing.unsafe.length === 0;
      if (!checks.archivePathsSafe) {
        errors.push({ code: 'UNSAFE_ARCHIVE_PATHS', message: 'Archive contains unsafe entry paths' });
        for (const unsafeEntry of listing.unsafe.slice(0, 5)) {
          errors.push({ code: unsafeEntry.code, message: `Unsafe archive entry: ${unsafeEntry.entryPath}` });
        }
      }

      const manifestEntry = findEntry(listing.entries, BACKUP_MANIFEST_ENTRY);
      if (!manifestEntry) {
        errors.push({ code: 'MANIFEST_MISSING', message: 'Backup manifest is missing from the archive' });
      } else {
        checks.manifestPresent = true;
        const manifestText = await readArchiveManifestText(archivePath);
        if (manifestText === null) {
          errors.push({ code: 'MANIFEST_MISSING', message: 'Backup manifest could not be read' });
        } else {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(manifestText);
          } catch (error) {
            errors.push({ code: 'MANIFEST_MALFORMED', message: `Manifest is not valid JSON: ${describeError(error)}` });
          }
          if (parsed !== null) {
            const validated = validateManifest(parsed);
            checks.manifestValid = validated.valid;
            if (!validated.valid) {
              errors.push(...validated.errors.slice(0, 5));
            } else if (validated.manifest) {
              manifest = validated.manifest;
              createdAt = validated.manifest.createdAt;
              if (validated.manifest.backupId !== id) {
                errors.push({ code: 'MANIFEST_ID_MISMATCH', message: 'Manifest backupId does not match the archive' });
              }
            }
            errors.push(...checkManifestSafety(parsed));
          }
        }
      }
    } catch (error) {
      errors.push({ code: 'VERIFY_FAILED', message: describeError(error) });
    }

    if (listing) {
      try {
        await this.checkBackupPayloads(id, archivePath, listing, manifest, errors, warnings, checks);
      } catch (error) {
        errors.push({ code: 'VERIFY_FAILED', message: describeError(error) });
      }
    }

    return this.finishVerification(id, createdAt, manifest, errors, warnings, checks, auditContext);
  }

  /**
   * Verifies the database and media payloads declared by the manifest:
   * presence, size, SHA-256 and the SQLite magic header.
   */
  private async checkBackupPayloads(
    id: string,
    archivePath: string,
    listing: ArchiveListingResult,
    manifest: BackupManifest | null,
    errors: BackupErrorInfo[],
    warnings: BackupErrorInfo[],
    checks: BackupVerificationChecks
  ): Promise<void> {
    const databaseEntry = findEntry(listing.entries, `${BACKUP_DATABASE_DIR}/${BACKUP_DATABASE_FILE}`);
    if (!databaseEntry) {
      errors.push({ code: 'DATABASE_PAYLOAD_MISSING', message: 'Backup does not contain the database payload' });
    } else {
      checks.databasePresent = true;
    }

    const mediaEntries = listing.entries.filter(
      (entry) => normalizeEntryName(entry.path).startsWith(`${BACKUP_MEDIA_DIR}/`) && entry.type === 'File'
    );
    if (manifest) {
      if (manifest.media.included && manifest.media.fileCount !== mediaEntries.length) {
        errors.push({
          code: 'MEDIA_PAYLOAD_COUNT_MISMATCH',
          message: `Backup contains ${mediaEntries.length} media files but the manifest declares ${manifest.media.fileCount}`,
        });
      }
      if (!manifest.media.included && mediaEntries.length > 0) {
        warnings.push({ code: 'MEDIA_PAYLOAD_UNEXPECTED', message: 'Backup contains media although the manifest excludes it' });
      }
      checks.mediaPresent = manifest.media.fileCount === 0 || mediaEntries.length > 0;
      if (!checks.mediaPresent) {
        errors.push({ code: 'MEDIA_PAYLOAD_MISSING', message: 'Backup does not contain the media payload' });
      }
    } else {
      checks.mediaPresent = mediaEntries.length > 0;
    }

    const wantedPaths = new Set<string>();
    if (databaseEntry) wantedPaths.add(`${BACKUP_DATABASE_DIR}/${BACKUP_DATABASE_FILE}`);
    for (const entry of mediaEntries) wantedPaths.add(normalizeEntryName(entry.path));

    const analyzed = await analyzeArchiveEntries(archivePath, (entryPath) => wantedPaths.has(entryPath));

    if (databaseEntry) {
      const databaseKey = `${BACKUP_DATABASE_DIR}/${BACKUP_DATABASE_FILE}`;
      const analysis = analyzed.get(databaseKey);
      if (!analysis) {
        errors.push({ code: 'DATABASE_PAYLOAD_MISSING', message: 'Database payload could not be read from the archive' });
        checks.databasePresent = false;
      } else {
        checks.databaseChecksumValid = manifest ? analysis.sha256 === manifest.database.sha256 : true;
        checks.databaseHeaderValid = isSqliteBuffer(analysis.header);
        if (manifest && !checks.databaseChecksumValid) {
          errors.push({ code: 'DATABASE_CHECKSUM_MISMATCH', message: 'Database payload checksum does not match the manifest' });
        }
        if (manifest && analysis.sizeBytes !== manifest.database.sizeBytes) {
          errors.push({ code: 'DATABASE_SIZE_MISMATCH', message: 'Database payload size does not match the manifest' });
        }
        if (!checks.databaseHeaderValid) {
          errors.push({ code: 'DATABASE_HEADER_INVALID', message: 'Database payload is not a SQLite database file' });
        }
      }
    }

    if (manifest && manifest.media.files.length > 0) {
      let mismatches = 0;
      const seen = new Set<string>();
      for (const file of manifest.media.files) {
        const entryPath = `${BACKUP_MEDIA_DIR}/${file.path}`;
        seen.add(entryPath);
        const analysis = analyzed.get(entryPath);
        if (!analysis) {
          mismatches++;
          continue;
        }
        if (analysis.sha256 !== file.sha256 || analysis.sizeBytes !== file.sizeBytes) mismatches++;
      }
      checks.mediaChecksumValid = mismatches === 0;
      if (mismatches > 0) {
        errors.push({
          code: 'MEDIA_CHECKSUM_MISMATCH',
          message: `${mismatches} media file(s) do not match the manifest checksums`,
        });
      }
      for (const entryPath of seen) wantedPaths.delete(entryPath);
    } else {
      checks.mediaChecksumValid = true;
    }

    // Anything in media/ that is not listed in the manifest is unexpected.
    const unlisted = mediaEntries.filter(
      (entry) => !manifest || !manifest.media.files.some((file) => `${BACKUP_MEDIA_DIR}/${file.path}` === normalizeEntryName(entry.path))
    );
    if (manifest && unlisted.length > 0) {
      warnings.push({
        code: 'MEDIA_PAYLOAD_UNLISTED',
        message: `${unlisted.length} media file(s) are not listed in the manifest`,
      });
    }

    if (warnings.length > 20) warnings.length = 20;
  }

  /** Builds the final verification result and records the audit event. */
  private finishVerification(
    id: string,
    createdAt: string | null,
    manifest: BackupManifest | null,
    errors: BackupErrorInfo[],
    warnings: BackupErrorInfo[],
    checks: BackupVerificationChecks,
    auditContext?: BackupAuditContext
  ): BackupVerificationResult {
    const result: BackupVerificationResult = {
      valid: errors.length === 0,
      backupId: id,
      createdAt,
      errors,
      warnings,
      checks,
      manifest,
    };

    this.audit(BACKUP_AUDIT_ACTIONS.VERIFIED, auditContext, {
      backupId: id,
      result: result.valid ? 'VALID' : 'INVALID',
      errorCodes: result.errors.map((entry) => entry.code).slice(0, 10),
    });

    return result;
  }

  /**
   * Safe restore.
   *
   * Order of operations (documented behaviour):
   *  1. verify the backup (checksums, manifest, archive paths, payloads)
   *  2. extract into a temporary directory (every entry validated)
   *  3. create a fresh PRE_RESTORE safety backup of the CURRENT database + media
   *  4. copy media back in place (existing files are overwritten from a journal
   *     copy; media files that are not part of the backup are never deleted)
   *  5. replace the SQLite database last (atomic rename, verified by checksum)
   *  6. drop the restore journal on success, roll everything back on failure
   *
   * A marker file stays behind only when a rollback could not be completed, so a
   * half-restored state is always detectable (surfaced by GET /api/settings).
   */
  async restoreBackup(backupId: string, options: RestoreBackupOptions): Promise<BackupRestoreResult> {
    const id = assertBackupId(backupId);
    const startedAt = Date.now();
    if (options.confirmed !== true) {
      throw new BackupError('CONFIRMATION_REQUIRED', 'Restore requires explicit confirmation', 400);
    }

    const directory = this.ensureBackupDirectory();
    const pendingRestore = this.readPendingRestore();
    if (pendingRestore) {
      throw new BackupError(
        'PENDING_RESTORE_DETECTED',
        'A previous restore did not complete cleanly and must be reviewed before another restore',
        409,
        { restoreId: pendingRestore.restoreId, backupId: pendingRestore.backupId }
      );
    }

    const databaseFile = resolveDatabaseFilePath();
    if (!databaseFile) {
      throw new BackupError('DATABASE_PATH_UNKNOWN', 'DATABASE_URL does not point to a local SQLite file', 500);
    }

    const release = this.lock.acquire('RESTORE', id);
    const restoreId = `${id}-${Date.now()}`;
    let stage = 'validate';
    let tempRoot: string | null = null;
    let safetyBackupId: string | null = null;

    try {
      // 1–6: verify, validate the archive structure, confirm both payloads
      const verification = await this.verifyBackup(id, options.audit);
      const manifest = verification.manifest;
      if (!verification.valid || !manifest) {
        throw new BackupError('BACKUP_INVALID', 'Backup failed verification and cannot be restored', 400, {
          errors: verification.errors.map((entry) => entry.code).slice(0, 5),
        });
      }

      stage = 'extract';
      tempRoot = safeMkdtemp(`${BACKUP_RESTORE_TMP_PREFIX}${id}-`);
      await extractArchiveSafely(resolveArchivePath(directory, id), tempRoot);

      const extractedDatabase = assertInside(
        tempRoot,
        path.join(tempRoot, BACKUP_DATABASE_DIR, manifest.database.fileName),
        'RESTORE_PATH_ESCAPE'
      );
      if (!fs.existsSync(extractedDatabase)) {
        throw new BackupError('DATABASE_PAYLOAD_MISSING', 'Backup does not contain a database payload', 400);
      }
      if (!isSqliteBuffer(readFileHeader(extractedDatabase))) {
        throw new BackupError('DATABASE_HEADER_INVALID', 'Backup database payload is not a SQLite database', 400);
      }
      if ((await sha256File(extractedDatabase)) !== manifest.database.sha256) {
        throw new BackupError('DATABASE_CHECKSUM_MISMATCH', 'Database payload checksum does not match the manifest', 400);
      }
      const extractedMediaRoot = path.join(tempRoot, BACKUP_MEDIA_DIR);
      if (manifest.media.included && manifest.media.fileCount > 0 && !fs.existsSync(extractedMediaRoot)) {
        throw new BackupError('MEDIA_PAYLOAD_MISSING', 'Backup does not contain the declared media payload', 400);
      }

      // 7: fresh safety backup of the CURRENT state before anything is replaced
      stage = 'safety-backup';
      const safetySummary = await this.createBackup({
        kind: 'PRE_RESTORE',
        includeMedia: true,
        retention: false,
        assumeLocked: true,
        audit: options.audit,
      });
      safetyBackupId = safetySummary.backupId;

      return await this.applyRestore({
        id,
        manifest,
        extractedDatabase,
        extractedMediaRoot,
        databaseFile,
        backupDirectory: directory,
        safetyBackupId,
        restoreId,
        startedAt,
        options,
      });
    } catch (error) {
      const code = isBackupError(error) ? error.code : 'RESTORE_FAILED';
      this.audit(BACKUP_AUDIT_ACTIONS.RESTORE_FAILED, options.audit, {
        backupId: id,
        restoreId,
        safetyBackupId,
        result: 'FAILED',
        stage,
        errorCode: code,
        errorMessage: describeError(error),
        rollbackDatabaseRestored: false,
        rollbackMediaRestored: false,
        rollbackErrorCount: 0,
      });
      if (isBackupError(error)) throw error;
      throw new BackupError('RESTORE_FAILED', `Restore failed: ${describeError(error)}`, 500, { stage });
    } finally {
      if (tempRoot) removeDirectoryQuietly(tempRoot);
      release();
    }
  }

  /**
   * Mutation phase of a restore: journal, media copy, database swap.
   * Rolls everything back when any step fails and always audited.
   */
  private async applyRestore(input: {
    id: string;
    manifest: BackupManifest;
    extractedDatabase: string;
    extractedMediaRoot: string;
    databaseFile: string;
    backupDirectory: string;
    safetyBackupId: string;
    restoreId: string;
    startedAt: number;
    options: RestoreBackupOptions;
  }): Promise<BackupRestoreResult> {
    const { id, manifest, options } = input;
    let stage = 'journal';
    let journalDir: string | null = path.join(input.backupDirectory, BACKUP_RESTORE_JOURNAL_DIR, input.restoreId);
    let dbSwapped = false;
    let resume: (() => Promise<void>) | null = null;
    let movedSidecars: { from: string; to: string }[] = [];
    let copiedMedia: { target: string; journal: string | null }[] = [];
    let addedMedia: string[] = [];
    let mediaRestoredFiles = 0;
    let mediaOverwrittenFiles = 0;

    try {
      fs.mkdirSync(journalDir, { recursive: true });
      const marker: PendingRestoreMarker = {
        restoreId: input.restoreId,
        backupId: id,
        safetyBackupId: input.safetyBackupId,
        startedAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(journalDir, BACKUP_RESTORE_MARKER_FILE), JSON.stringify(marker, null, 2), 'utf8');

      this.audit(BACKUP_AUDIT_ACTIONS.RESTORE_STARTED, options.audit, {
        backupId: id,
        restoreId: input.restoreId,
        safetyBackupId: input.safetyBackupId,
        result: 'STARTED',
        trigger: options.audit?.trigger ?? 'MANUAL',
      });

      // Media first: additive/overwriting only, never a blind delete.
      stage = 'media';
      if (manifest.media.included && fs.existsSync(input.extractedMediaRoot)) {
        const mediaDetail = this.restoreMedia(input.extractedMediaRoot, journalDir);
        mediaRestoredFiles = mediaDetail.restoredFiles;
        mediaOverwrittenFiles = mediaDetail.overwrittenFiles;
        copiedMedia = mediaDetail.copied;
        addedMedia = mediaDetail.added;
      }

      // Database last: this is the commit point of the restore.
      stage = 'database';
      await this.snapshotDatabase(path.join(journalDir, 'database.sqlite.original'));
      if (this.pauseWriters) {
        resume = await this.pauseWriters();
      }

      await prisma.$disconnect();
      try {
        movedSidecars = this.moveDatabaseSidecars(input.databaseFile, journalDir);
        const stagedFile = path.join(
          path.dirname(input.databaseFile),
          `.${path.basename(input.databaseFile)}.restore-${Date.now()}.tmp`
        );
        fs.copyFileSync(input.extractedDatabase, stagedFile);
        try {
          fs.renameSync(stagedFile, input.databaseFile);
        } catch {
          // Fallback when the platform refuses an atomic replace.
          fs.copyFileSync(stagedFile, input.databaseFile);
          try {
            fs.unlinkSync(stagedFile);
          } catch {
            // leftover temporary file is harmless
          }
        }
        dbSwapped = true;

        if ((await sha256File(input.databaseFile)) !== manifest.database.sha256) {
          throw new BackupError('DATABASE_REPLACE_MISMATCH', 'Restored database does not match the backup checksum', 500);
        }
        await prisma.$connect();
        await prisma.$queryRawUnsafe('SELECT 1 AS ok');
      } finally {
        await prisma.$connect().catch(() => undefined);
      }

      // Success: the journal is no longer needed. The PRE_RESTORE backup stays in
      // the backup directory and remains the rollback source.
      removeDirectoryQuietly(journalDir);
      journalDir = null;

      // Audit continuity: the pre-swap database (which held the
      // BACKUP_RESTORE_STARTED record) has just been replaced. Re-record
      // STARTED against the restored database when it is missing there so a
      // successful restore leaves a complete audit trail in the new state.
      try {
        const startedRow = await prisma.auditLog.findFirst({
          where: { action: BACKUP_AUDIT_ACTIONS.RESTORE_STARTED, metadata: { contains: input.restoreId } },
          orderBy: { createdAt: 'desc' },
        });
        if (!startedRow) {
          await recordAudit(BACKUP_AUDIT_ACTIONS.RESTORE_STARTED, options.audit?.req, {
            backupId: id,
            restoreId: input.restoreId,
            safetyBackupId: input.safetyBackupId,
            result: 'STARTED',
            trigger: options.audit?.trigger ?? 'MANUAL',
            reRecordedAfterRestore: true,
          });
        }
      } catch {
        // Audit continuity is best-effort and must never fail the restore.
      }

      const result: BackupRestoreResult = {
        restored: true,
        backupId: id,
        safetyBackupId: input.safetyBackupId,
        databaseRestored: true,
        mediaRestoredFiles,
        mediaOverwrittenFiles,
        durationMs: Date.now() - input.startedAt,
      };

      this.audit(BACKUP_AUDIT_ACTIONS.RESTORE_COMPLETED, options.audit, {
        backupId: id,
        restoreId: input.restoreId,
        safetyBackupId: input.safetyBackupId,
        result: 'SUCCESS',
        databaseRestored: true,
        mediaRestoredFiles,
        mediaOverwrittenFiles,
        durationMs: result.durationMs,
      });

      return result;
    } catch (error) {
      const rollback = await this.attemptRollback({
        databaseFile: input.databaseFile,
        dbSwapped,
        journalDir,
        movedSidecars,
        copiedMedia,
        addedMedia,
      });
      const code = isBackupError(error) ? error.code : 'RESTORE_FAILED';

      this.audit(BACKUP_AUDIT_ACTIONS.RESTORE_FAILED, options.audit, {
        backupId: id,
        restoreId: input.restoreId,
        safetyBackupId: input.safetyBackupId,
        result: 'FAILED',
        stage,
        errorCode: code,
        errorMessage: describeError(error),
        rollbackDatabaseRestored: rollback.databaseRestored,
        rollbackMediaRestored: rollback.mediaRestored,
        rollbackErrorCount: rollback.errors.length,
      });

      if (isBackupError(error)) throw error;
      throw new BackupError('RESTORE_FAILED', `Restore failed at ${stage}: ${describeError(error)}`, 500, { stage });
    } finally {
      if (resume) {
        try {
          await resume();
        } catch {
          // background writers are restarted best-effort
        }
      }
    }
  }

  /**
   * Copies media from the extracted archive back into the local media root.
   * Existing files are journaled first (so they can be restored), files that are
   * not part of the backup are left untouched.
   */
  private restoreMedia(
    extractedMediaRoot: string,
    journalDir: string
  ): {
    restoredFiles: number;
    overwrittenFiles: number;
    copied: { target: string; journal: string | null }[];
    added: string[];
  } {
    const uploadsDir = resolveUploadsDirectory();
    const mediaJournalDir = path.join(journalDir, BACKUP_MEDIA_DIR);
    const { files } = walkFiles(extractedMediaRoot);
    const copied: { target: string; journal: string | null }[] = [];
    const added: string[] = [];
    let restoredFiles = 0;
    let overwrittenFiles = 0;

    for (const file of files) {
      const target = assertInside(
        uploadsDir,
        path.join(uploadsDir, ...file.relativePath.split('/')),
        'MEDIA_RESTORE_PATH_ESCAPE'
      );
      fs.mkdirSync(path.dirname(target), { recursive: true });

      let journal: string | null = null;
      if (fs.existsSync(target)) {
        journal = assertInside(
          mediaJournalDir,
          path.join(mediaJournalDir, ...file.relativePath.split('/')),
          'MEDIA_JOURNAL_PATH_ESCAPE'
        );
        fs.mkdirSync(path.dirname(journal), { recursive: true });
        fs.copyFileSync(target, journal);
        overwrittenFiles++;
      } else {
        added.push(target);
      }

      fs.copyFileSync(file.absolutePath, target);
      copied.push({ target, journal });
      restoredFiles++;
    }

    return { restoredFiles, overwrittenFiles, copied, added };
  }

  /** Parks SQLite sidecar files (-journal/-wal/-shm) so a stale journal cannot be replayed. */
  private moveDatabaseSidecars(databaseFile: string, journalDir: string): { from: string; to: string }[] {
    const moved: { from: string; to: string }[] = [];
    for (const suffix of ['-journal', '-wal', '-shm']) {
      const from = `${databaseFile}${suffix}`;
      if (!fs.existsSync(from)) continue;
      const to = path.join(journalDir, `${path.basename(databaseFile)}${suffix}`);
      fs.renameSync(from, to);
      moved.push({ from, to });
    }
    return moved;
  }

  /**
   * Best-effort rollback of a partially applied restore. Media is restored from
   * the journal copy, the database from the consistent pre-restore snapshot.
   * Never deletes anything outside the journal/target files it created.
   */
  private async attemptRollback(context: {
    databaseFile: string;
    dbSwapped: boolean;
    journalDir: string | null;
    movedSidecars: { from: string; to: string }[];
    copiedMedia: { target: string; journal: string | null }[];
    addedMedia: string[];
  }): Promise<{ attempted: boolean; databaseRestored: boolean; mediaRestored: boolean; errors: string[] }> {
    const errors: string[] = [];
    let mediaRestored = false;
    let databaseRestored = false;

    try {
      for (const entry of context.copiedMedia) {
        if (entry.journal && fs.existsSync(entry.journal)) fs.copyFileSync(entry.journal, entry.target);
      }
      for (const target of context.addedMedia) {
        // Only files that this restore created are removed again.
        if (fs.existsSync(target)) fs.unlinkSync(target);
      }
      mediaRestored = true;
    } catch (error) {
      errors.push(`media: ${describeError(error)}`);
    }

    if (context.dbSwapped) {
      try {
        await prisma.$disconnect().catch(() => undefined);
        const journalOriginal = context.journalDir
          ? path.join(context.journalDir, 'database.sqlite.original')
          : null;

        if (journalOriginal && fs.existsSync(journalOriginal)) {
          for (const suffix of ['-journal', '-wal', '-shm']) {
            const current = `${context.databaseFile}${suffix}`;
            if (fs.existsSync(current) && context.journalDir) {
              try {
                fs.renameSync(current, path.join(context.journalDir, `rejected${suffix}`));
              } catch {
                // ignore: the parked file is not required for the rollback
              }
            }
          }
          fs.copyFileSync(journalOriginal, context.databaseFile);
          for (const moved of context.movedSidecars) {
            if (fs.existsSync(moved.to)) {
              try {
                fs.renameSync(moved.to, moved.from);
              } catch (error) {
                errors.push(`sidecar: ${describeError(error)}`);
              }
            }
          }
          databaseRestored = fs.existsSync(context.databaseFile);
          if (databaseRestored) {
            await prisma.$connect().catch(() => undefined);
            await prisma.$queryRawUnsafe('SELECT 1 AS ok');
          }
        } else {
          errors.push('database: the pre-restore snapshot is unavailable');
        }
      } catch (error) {
        errors.push(`database: ${describeError(error)}`);
      } finally {
        await prisma.$connect().catch(() => undefined);
      }
    } else {
      databaseRestored = true;
    }

    return { attempted: true, databaseRestored, mediaRestored, errors };
  }

  /** Reads a leftover restore marker (only present when a rollback failed). */
  readPendingRestore(): PendingRestoreMarker | null {
    const journalRoot = path.join(this.getBackupDirectory(), BACKUP_RESTORE_JOURNAL_DIR);
    if (!fs.existsSync(journalRoot)) return null;

    for (const entry of fs.readdirSync(journalRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const markerPath = path.join(journalRoot, entry.name, BACKUP_RESTORE_MARKER_FILE);
      if (!fs.existsSync(markerPath)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as PendingRestoreMarker;
        if (parsed && typeof parsed.restoreId === 'string' && typeof parsed.backupId === 'string') return parsed;
      } catch {
        // ignore malformed markers
      }
    }
    return null;
  }

  /** Status summary used by the Settings API and the backup scheduler. */
  async getStatus(): Promise<BackupServiceStatus> {
    const summaries = await this.resolveSummaries();
    return {
      backupDirectoryLabel: describeBackupDirectory(this.getBackupDirectory()),
      retentionCount: this.getRetentionCount(),
      backupCount: summaries.length,
      totalSizeBytes: summaries.reduce((total, summary) => total + (summary.sizeBytes ?? 0), 0),
      newestBackupAt: summaries.length > 0 ? summaries[0].createdAt : null,
      lock: this.getLockState(),
      pendingRestore: this.readPendingRestore(),
    };
  }

  private audit(action: string, context: BackupAuditContext | undefined, metadata: Record<string, unknown>): void {
    void recordAudit(action, context?.req, metadata).catch(() => {
      // Auditing must never break a backup/restore operation.
    });
  }
}

/** Shared instance used by the HTTP controller and the backup scheduler. */
export const backupService = new BackupService();
