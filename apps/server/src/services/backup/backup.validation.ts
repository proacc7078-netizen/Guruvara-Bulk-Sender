import {
  BackupErrorInfo,
  BackupManifest,
  BackupMediaFileEntry,
} from './backup.types';

/**
 * Phase 5.12 — Backup & Recovery: manifest and archive-content validation.
 *
 * The manifest is untrusted input when a backup archive is verified or restored,
 * so it is validated structurally AND scanned for secrets/absolute paths before
 * it is trusted.
 */

/** SQLite database files start with this 16-byte magic header. */
export const SQLITE_HEADER = 'SQLite format 3\0';

export const SUPPORTED_BACKUP_FORMAT_VERSIONS = [1];

/**
 * Patterns that must never appear in a manifest or backup archive metadata:
 * credentials, tokens, session secrets and authorization material.
 */
export const FORBIDDEN_MANIFEST_PATTERNS: { code: string; pattern: RegExp }[] = [
  { code: 'SECRET_ACCESS_TOKEN', pattern: /access[_-]?token/i },
  { code: 'SECRET_APP_SECRET', pattern: /app[_-]?secret/i },
  { code: 'SECRET_PASSWORD', pattern: /password/i },
  { code: 'SECRET_WEBHOOK', pattern: /webhook[_-]?(secret|verify[_-]?token)/i },
  { code: 'SECRET_AUTHORIZATION', pattern: /authorization/i },
  { code: 'SECRET_BEARER', pattern: /\bbearer\s+[A-Za-z0-9._-]+/i },
  { code: 'SECRET_SESSION', pattern: /session[_-]?secret/i },
  { code: 'SECRET_META_TOKEN', pattern: /EAA[A-Za-z0-9]{12}/ },
  { code: 'SECRET_PROVIDER_URL', pattern: /graph\.facebook\.com|api\.whatsapp\.com/i },
];

const WINDOWS_ABSOLUTE_PATH = /[A-Za-z]:[\\/]/;
const UNC_PATH = /\\\\[^\\]+\\/;

export function isSqliteBuffer(buffer: Buffer): boolean {
  if (buffer.length < SQLITE_HEADER.length) return false;
  return buffer.subarray(0, SQLITE_HEADER.length).toString('latin1') === SQLITE_HEADER;
}

export interface ManifestValidationResult {
  valid: boolean;
  manifest: BackupManifest | null;
  errors: BackupErrorInfo[];
  warnings: BackupErrorInfo[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validateMediaFileEntry(
  raw: unknown,
  index: number,
  errors: BackupErrorInfo[]
): BackupMediaFileEntry | null {
  if (!raw || typeof raw !== 'object') {
    errors.push({ code: 'MANIFEST_INVALID', message: `media.files[${index}] is not an object` });
    return null;
  }
  const entry = raw as Record<string, unknown>;
  const relativePath = entry.path;
  if (
    !isNonEmptyString(relativePath) ||
    relativePath.includes('\\') ||
    relativePath.startsWith('/') ||
    relativePath.split('/').includes('..')
  ) {
    errors.push({ code: 'MANIFEST_INVALID', message: `media.files[${index}].path is not a safe relative path` });
    return null;
  }
  if (typeof entry.sizeBytes !== 'number' || entry.sizeBytes < 0) {
    errors.push({ code: 'MANIFEST_INVALID', message: `media.files[${index}].sizeBytes is invalid` });
    return null;
  }
  if (!isSha256(entry.sha256)) {
    errors.push({ code: 'MANIFEST_INVALID', message: `media.files[${index}].sha256 is invalid` });
    return null;
  }
  return { path: relativePath, sizeBytes: entry.sizeBytes, sha256: entry.sha256 };
}

/** Structural validation of an (untrusted) manifest object. */
export function validateManifest(raw: unknown): ManifestValidationResult {
  const errors: BackupErrorInfo[] = [];
  const warnings: BackupErrorInfo[] = [];

  if (!raw || typeof raw !== 'object') {
    return {
      valid: false,
      manifest: null,
      errors: [{ code: 'MANIFEST_INVALID', message: 'Manifest is not a JSON object' }],
      warnings,
    };
  }

  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.backupFormatVersion !== 'number') {
    errors.push({ code: 'MANIFEST_INVALID', message: 'Manifest backupFormatVersion is missing' });
  } else if (!SUPPORTED_BACKUP_FORMAT_VERSIONS.includes(candidate.backupFormatVersion)) {
    errors.push({
      code: 'MANIFEST_UNSUPPORTED_VERSION',
      message: `Manifest backupFormatVersion ${candidate.backupFormatVersion} is not supported`,
    });
  }
  if (!isNonEmptyString(candidate.backupId)) {
    errors.push({ code: 'MANIFEST_INVALID', message: 'Manifest backupId is missing' });
  }
  if (!isNonEmptyString(candidate.createdAt) || Number.isNaN(Date.parse(String(candidate.createdAt)))) {
    errors.push({ code: 'MANIFEST_INVALID', message: 'Manifest createdAt is missing or invalid' });
  }
  if (candidate.kind !== 'MANUAL' && candidate.kind !== 'SCHEDULED' && candidate.kind !== 'PRE_RESTORE') {
    errors.push({ code: 'MANIFEST_INVALID', message: 'Manifest kind is invalid' });
  }
  if (!isNonEmptyString(candidate.archiveFileName) || !candidate.archiveFileName.endsWith('.tar.gz')) {
    errors.push({ code: 'MANIFEST_INVALID', message: 'Manifest archiveFileName is invalid' });
  }

  const database = candidate.database as Record<string, unknown> | undefined;
  if (!database || typeof database !== 'object') {
    errors.push({ code: 'MANIFEST_INVALID', message: 'Manifest database section is missing' });
  } else {
    if (!isNonEmptyString(database.fileName)) {
      errors.push({ code: 'MANIFEST_INVALID', message: 'Manifest database.fileName is missing' });
    }
    if (typeof database.sizeBytes !== 'number' || database.sizeBytes <= 0) {
      errors.push({ code: 'MANIFEST_INVALID', message: 'Manifest database.sizeBytes is invalid' });
    }
    if (!isSha256(database.sha256)) {
      errors.push({ code: 'MANIFEST_INVALID', message: 'Manifest database.sha256 is invalid' });
    }
  }

  const media = candidate.media as Record<string, unknown> | undefined;
  let validatedFiles: BackupMediaFileEntry[] = [];
  if (!media || typeof media !== 'object') {
    errors.push({ code: 'MANIFEST_INVALID', message: 'Manifest media section is missing' });
  } else {
    if (typeof media.included !== 'boolean') {
      errors.push({ code: 'MANIFEST_INVALID', message: 'Manifest media.included is invalid' });
    }
    if (typeof media.fileCount !== 'number' || media.fileCount < 0) {
      errors.push({ code: 'MANIFEST_INVALID', message: 'Manifest media.fileCount is invalid' });
    }
    if (!Array.isArray(media.files)) {
      errors.push({ code: 'MANIFEST_INVALID', message: 'Manifest media.files is invalid' });
    } else {
      const files: BackupMediaFileEntry[] = [];
      media.files.forEach((entry, index) => {
        const validated = validateMediaFileEntry(entry, index, errors);
        if (validated) files.push(validated);
      });
      validatedFiles = files;
      if (typeof media.fileCount === 'number' && media.fileCount !== files.length) {
        errors.push({
          code: 'MANIFEST_INVALID',
          message: 'Manifest media.fileCount does not match media.files length',
        });
      }
    }
    if (typeof media.totalSizeBytes !== 'number' || media.totalSizeBytes < 0) {
      errors.push({ code: 'MANIFEST_INVALID', message: 'Manifest media.totalSizeBytes is invalid' });
    }
  }

  if (errors.length > 0) return { valid: false, manifest: null, errors, warnings };

  const application = (candidate.application ?? {}) as Record<string, unknown>;
  const databaseSection = database as Record<string, unknown>;
  const mediaSection = media as Record<string, unknown>;

  const manifest: BackupManifest = {
    backupFormatVersion: candidate.backupFormatVersion as number,
    backupId: candidate.backupId as string,
    createdAt: candidate.createdAt as string,
    kind: candidate.kind as BackupManifest['kind'],
    appVersion: isNonEmptyString(candidate.appVersion) ? candidate.appVersion : 'unknown',
    application: {
      nodeVersion: isNonEmptyString(application.nodeVersion) ? application.nodeVersion : 'unknown',
      platform: isNonEmptyString(application.platform) ? application.platform : 'unknown',
    },
    mediaRootLabel: isNonEmptyString(candidate.mediaRootLabel) ? candidate.mediaRootLabel : 'storage/uploads',
    database: {
      fileName: databaseSection.fileName as string,
      sizeBytes: databaseSection.sizeBytes as number,
      sha256: databaseSection.sha256 as string,
      sqliteHeaderValid: databaseSection.sqliteHeaderValid === true,
    },
    media: {
      included: mediaSection.included === true,
      fileCount: mediaSection.fileCount as number,
      totalSizeBytes: mediaSection.totalSizeBytes as number,
      files: validatedFiles,
    },
    archiveFileName: candidate.archiveFileName as string,
    archiveSizeBytes: typeof candidate.archiveSizeBytes === 'number' ? candidate.archiveSizeBytes : undefined,
    archiveSha256: isSha256(candidate.archiveSha256) ? (candidate.archiveSha256 as string) : undefined,
  };

  return { valid: true, manifest, errors, warnings };
}

/**
 * Scans a manifest for anything that must never be stored in a backup:
 * credentials, provider URLs, secrets or absolute filesystem paths.
 */
export function checkManifestSafety(manifest: unknown): BackupErrorInfo[] {
  const issues: BackupErrorInfo[] = [];
  let serialized: string;
  try {
    serialized = JSON.stringify(manifest ?? {});
  } catch {
    return [{ code: 'MANIFEST_UNSAFE', message: 'Manifest could not be inspected' }];
  }

  for (const { code, pattern } of FORBIDDEN_MANIFEST_PATTERNS) {
    if (pattern.test(serialized)) {
      issues.push({
        code,
        message: `Manifest must not contain ${code.replace('SECRET_', '').toLowerCase()} material`,
      });
    }
  }
  if (WINDOWS_ABSOLUTE_PATH.test(serialized) || UNC_PATH.test(serialized)) {
    issues.push({ code: 'MANIFEST_UNSAFE_PATH', message: 'Manifest must not contain absolute filesystem paths' });
  }
  return issues;
}
