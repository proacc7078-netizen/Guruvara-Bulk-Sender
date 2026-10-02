import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  BACKUP_ARCHIVE_FILE_PATTERN,
  BACKUP_ALLOWED_ENTRY_PREFIXES,
  BACKUP_ID_PATTERN,
  BackupError,
  DEFAULT_BACKUP_DIRECTORY,
} from './backup.types';

/**
 * Phase 5.12 — Backup & Recovery: filesystem path resolution and path safety.
 *
 * Every path that reaches the filesystem goes through this module:
 * - the backup directory, the media root and the SQLite database file
 * - archive entry names (untrusted input) before any extraction
 * - backup identifiers before any deletion
 */

/** Repository root (…/japa-message-cms). Works from src and from compiled dist. */
export function repoRoot(): string {
  return path.resolve(__dirname, '..', '..', '..', '..', '..');
}

/** Backup directory. `BACKUP_DIR` may be absolute or relative to the repo root. */
export function resolveBackupDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.BACKUP_DIR;
  if (configured && configured.trim().length > 0) {
    const raw = configured.trim();
    return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(repoRoot(), raw);
  }
  return path.resolve(repoRoot(), DEFAULT_BACKUP_DIRECTORY);
}

/**
 * Local media root. Matches the upload path used by media.controller.ts
 * (single source of truth for the local storage layout).
 */
export function resolveUploadsDirectory(): string {
  return path.resolve(repoRoot(), 'storage', 'uploads');
}

/** Relative, non-absolute label for the media root (safe to expose in APIs). */
export function mediaRootLabel(): string {
  return path.join('storage', 'uploads').split(path.sep).join('/');
}

/**
 * Resolves the SQLite file from DATABASE_URL.
 * Absolute paths (Windows or POSIX) are used as-is; relative paths follow
 * Prisma semantics (relative to the schema directory, i.e. `<root>/prisma`).
 */
export function resolveDatabaseFilePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = env.DATABASE_URL;
  if (!url || url.trim().length === 0) return null;

  let raw = url.trim();
  if (raw.startsWith('file:')) raw = raw.slice('file:'.length);
  const queryIndex = raw.indexOf('?');
  if (queryIndex >= 0) raw = raw.slice(0, queryIndex);
  if (raw.length === 0) return null;

  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }

  if (path.isAbsolute(decoded)) return path.resolve(decoded);

  const relative = decoded.replace(/^\.\//, '');
  const schemaRelative = path.resolve(repoRoot(), 'prisma', relative);
  const rootRelative = path.resolve(repoRoot(), relative);
  if (fs.existsSync(schemaRelative)) return schemaRelative;
  if (fs.existsSync(rootRelative)) return rootRelative;
  return schemaRelative;
}

/** True when `candidate` is the same as, or inside, `parent`. */
export function isPathInside(parent: string, candidate: string): boolean {
  const parentResolved = path.resolve(parent);
  const candidateResolved = path.resolve(candidate);
  if (candidateResolved === parentResolved) return true;
  const prefix = parentResolved.endsWith(path.sep) ? parentResolved : parentResolved + path.sep;
  return candidateResolved.startsWith(prefix);
}

/** Throws unless `candidate` stays inside `parent`. */
export function assertInside(parent: string, candidate: string, code = 'PATH_ESCAPE'): string {
  if (!isPathInside(parent, candidate)) {
    throw new BackupError(code, 'Resolved path is outside the expected directory', 400);
  }
  return path.resolve(candidate);
}

export function isValidBackupId(backupId: string): boolean {
  return typeof backupId === 'string' && BACKUP_ID_PATTERN.test(backupId);
}

/** Validates a backup id and rejects anything that could escape the backup directory. */
export function assertBackupId(backupId: unknown): string {
  if (typeof backupId !== 'string' || backupId.length === 0 || backupId.length > 200) {
    throw new BackupError('INVALID_BACKUP_ID', 'Backup id is invalid', 400);
  }
  if (backupId.includes('/') || backupId.includes('\\') || backupId.includes('..')) {
    throw new BackupError('INVALID_BACKUP_ID', 'Backup id must not contain path separators', 400);
  }
  if (!isValidBackupId(backupId)) {
    throw new BackupError('INVALID_BACKUP_ID', 'Backup id is invalid', 400);
  }
  return backupId;
}

/** Resolves the archive file for a backup id and guarantees it stays in the backup dir. */
export function resolveArchivePath(backupsDir: string, backupId: string): string {
  assertBackupId(backupId);
  const candidate = path.resolve(backupsDir, `${backupId}.tar.gz`);
  return assertInside(backupsDir, candidate, 'PATH_ESCAPE');
}

/** Converts a backup directory into a display label without exposing absolute paths. */
export function describeBackupDirectory(backupsDir: string): string {
  const relative = path.relative(repoRoot(), path.resolve(backupsDir));
  if (relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join('/');
  }
  return path.basename(path.resolve(backupsDir));
}

/** SQL string literal for `VACUUM INTO '<path>'` (forward slashes, escaped quotes). */
export function toSqlitePathLiteral(targetPath: string): string {
  return path.resolve(targetPath).replace(/\\/g, '/').replace(/'/g, "''");
}

export function safeMkdtemp(prefix: string, parentDir?: string): string {
  const parent = parentDir ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return path.resolve(fs.mkdtempSync(path.join(parent, prefix)));
}

export function removeDirectoryQuietly(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // best effort cleanup only
  }
}

export interface ArchivePathValidation {
  safe: boolean;
  normalized: string | null;
  code: string | null;
  message: string | null;
}

/**
 * Validates a single archive entry name (untrusted input).
 *
 * Rejected: empty names, NUL bytes, absolute POSIX paths, Windows drive letters,
 * UNC paths, backslash separators, `..` traversal, and any entry that is not
 * inside one of the expected archive roots.
 */
export function validateArchiveEntryPath(
  entryPath: string,
  allowedPrefixes: readonly string[] = BACKUP_ALLOWED_ENTRY_PREFIXES
): ArchivePathValidation {
  const reject = (code: string, message: string): ArchivePathValidation => ({
    safe: false,
    normalized: null,
    code,
    message,
  });

  if (typeof entryPath !== 'string' || entryPath.trim().length === 0) {
    return reject('UNSAFE_ENTRY_EMPTY_PATH', 'Archive entry has an empty path');
  }
  if (entryPath.includes('\0')) {
    return reject('UNSAFE_ENTRY_NUL_BYTE', 'Archive entry path contains a NUL byte');
  }

  const raw = entryPath.trim();
  if (raw.includes('\\')) {
    return reject('UNSAFE_ENTRY_BACKSLASH', 'Archive entry path contains a backslash separator');
  }
  if (/^[A-Za-z]:/.test(raw)) {
    return reject('UNSAFE_ENTRY_DRIVE_LETTER', 'Archive entry path uses a drive letter');
  }
  if (raw.startsWith('//')) {
    return reject('UNSAFE_ENTRY_UNC_PATH', 'Archive entry path is a UNC path');
  }
  if (raw.startsWith('/')) {
    return reject('UNSAFE_ENTRY_ABSOLUTE_PATH', 'Archive entry path is absolute');
  }

  const segments = raw.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.length === 0) {
    return reject('UNSAFE_ENTRY_EMPTY_PATH', 'Archive entry has an empty path');
  }
  if (segments.some((segment) => segment === '..')) {
    return reject('UNSAFE_ENTRY_PATH_TRAVERSAL', 'Archive entry path traverses outside its root');
  }
  if (segments.some((segment) => /^[A-Za-z]:$/.test(segment))) {
    return reject('UNSAFE_ENTRY_DRIVE_LETTER', 'Archive entry path uses a drive letter');
  }

  const normalized = segments.join('/');
  const allowed = allowedPrefixes.some((prefix) =>
    prefix.endsWith('/')
      ? // file/dir entries below the root (e.g. `media/...`) plus the root
        // directory entries themselves (`media/`, written with a trailing slash)
        normalized.startsWith(prefix) || normalized === prefix.slice(0, -1)
      : normalized === prefix
  );
  if (!allowed) {
    return reject('UNEXPECTED_ENTRY_PATH', 'Archive entry is outside the expected backup layout');
  }

  return { safe: true, normalized, code: null, message: null };
}

/** Only regular files and directories may be extracted (never links or devices). */
export function isSafeArchiveEntryType(entryType: string): boolean {
  return entryType === 'File' || entryType === 'Directory' || entryType === 'OldFile';
}

/** Resolves an extracted entry inside a temporary restore directory (defence in depth). */
export function resolveExtractionTarget(tempRoot: string, normalizedEntryPath: string): string {
  const target = path.resolve(tempRoot, ...normalizedEntryPath.split('/'));
  return assertInside(tempRoot, target, 'UNSAFE_EXTRACTION_PATH');
}

/** True when a filename is one of the artifacts belonging to a backup id. */
export function isBackupArtifactFileName(fileName: string): boolean {
  if (BACKUP_ARCHIVE_FILE_PATTERN.test(fileName)) return true;
  if (fileName.endsWith('.sha256')) {
    return BACKUP_ARCHIVE_FILE_PATTERN.test(fileName.slice(0, -'.sha256'.length));
  }
  if (fileName.endsWith('.manifest.json')) {
    return BACKUP_ARCHIVE_FILE_PATTERN.test(fileName.slice(0, -'.manifest.json'.length));
  }
  return false;
}

export function backupIdFromArchiveFileName(fileName: string): string | null {
  if (!BACKUP_ARCHIVE_FILE_PATTERN.test(fileName)) return null;
  return fileName.slice(0, -'.tar.gz'.length);
}
