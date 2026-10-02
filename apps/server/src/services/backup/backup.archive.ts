import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { create as tarCreate, extract as tarExtract, list as tarList } from 'tar';
import type { ReadEntry } from 'tar';
import { BACKUP_MANIFEST_ENTRY, BackupError, describeError } from './backup.types';
import {
  isSafeArchiveEntryType,
  removeDirectoryQuietly,
  resolveExtractionTarget,
  safeMkdtemp,
  validateArchiveEntryPath,
} from './backup.paths';

/**
 * Phase 5.12 — Backup & Recovery: portable `tar.gz` archive helpers.
 *
 * All archive reads are treated as untrusted input: entries are validated
 * (path + type) before anything is extracted, and extraction always targets a
 * freshly created temporary directory that is removed afterwards.
 */

export interface ArchiveEntryInfo {
  path: string;
  type: string;
  sizeBytes: number;
  linkpath: string | null;
}

export interface RelFileInfo {
  /** POSIX-style path relative to the walked root. */
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
}

export interface WalkResult {
  files: RelFileInfo[];
  skippedLinks: string[];
}

/** SHA-256 of a file, streamed so large media never has to be buffered. */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function sha256Buffer(buffer: Buffer | string): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Recursively lists regular files below `rootDir`.
 * Symbolic links are never followed (they are reported, never traversed), which
 * also prevents escaping the intended storage directory.
 */
export function walkFiles(rootDir: string): WalkResult {
  const files: RelFileInfo[] = [];
  const skippedLinks: string[] = [];
  if (!fs.existsSync(rootDir)) return { files, skippedLinks };

  const visit = (currentDir: string): void => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(currentDir, entry.name);
      const relative = path.relative(rootDir, absolute).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        skippedLinks.push(relative);
        continue;
      }
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(absolute);
      files.push({ relativePath: relative, absolutePath: absolute, sizeBytes: stat.size });
    }
  };

  visit(rootDir);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { files, skippedLinks };
}

/** Creates a gzipped tar archive from explicit relative entries under `cwd`. */
export async function createArchive(options: {
  cwd: string;
  archivePath: string;
  entries: string[];
}): Promise<{ sizeBytes: number; sha256: string }> {
  fs.mkdirSync(path.dirname(options.archivePath), { recursive: true });
  await tarCreate(
    {
      cwd: options.cwd,
      file: options.archivePath,
      gzip: true,
      portable: true,
      follow: false,
      noMtime: true,
      // `preservePaths` stays false: archive entry names are always relative to cwd.
      preservePaths: false,
    },
    options.entries
  );
  const stat = fs.statSync(options.archivePath);
  return { sizeBytes: stat.size, sha256: await sha256File(options.archivePath) };
}

export interface ArchiveListingResult {
  entries: ArchiveEntryInfo[];
  unsafe: { code: string; message: string; entryPath: string }[];
}

export interface BackupManifestLike {
  backupId?: unknown;
  [key: string]: unknown;
}

/**
 * Lists an archive without extracting it and validates every entry path/type.
 */
export async function listArchive(archivePath: string): Promise<ArchiveListingResult> {
  const entries: ArchiveEntryInfo[] = [];
  const unsafe: { code: string; message: string; entryPath: string }[] = [];

  try {
    await tarList({
      file: archivePath,
      onReadEntry: (entry: ReadEntry) => {
        const entryPath = String(entry.path ?? '');
        const entryType = String(entry.type ?? 'Unknown');
        entries.push({
          path: entryPath,
          type: entryType,
          sizeBytes: Number(entry.size ?? 0),
          linkpath: entry.linkpath ? String(entry.linkpath) : null,
        });

        const validated = validateArchiveEntryPath(entryPath);
        if (!validated.safe) {
          unsafe.push({
            code: validated.code ?? 'UNSAFE_ENTRY_PATH',
            message: validated.message ?? 'Unsafe archive entry path',
            entryPath,
          });
          return;
        }
        if (!isSafeArchiveEntryType(entryType)) {
          unsafe.push({
            code: 'UNSAFE_ENTRY_TYPE',
            message: `Archive entry type "${entryType}" is not extractable`,
            entryPath,
          });
          return;
        }
        if (entry.linkpath) {
          unsafe.push({
            code: 'UNSAFE_ENTRY_LINK',
            message: 'Archive entry declares a link target',
            entryPath,
          });
        }
      },
    });
  } catch (error) {
    throw new BackupError('ARCHIVE_UNREADABLE', `Archive could not be read: ${describeError(error)}`, 400);
  }

  return { entries, unsafe };
}

/** Reads the manifest entry content from the archive (into a temporary directory). */
export async function readArchiveManifestText(archivePath: string): Promise<string | null> {
  const tempDir = safeMkdtemp('japa-backup-manifest-');
  try {
    await tarExtract({
      file: archivePath,
      cwd: tempDir,
      preservePaths: false,
      filter: (entryPath: string) => normalizeEntryName(entryPath) === BACKUP_MANIFEST_ENTRY,
    });
    const manifestPath = path.join(tempDir, BACKUP_MANIFEST_ENTRY);
    if (!fs.existsSync(manifestPath)) return null;
    return fs.readFileSync(manifestPath, 'utf8');
  } catch (error) {
    throw new BackupError('ARCHIVE_UNREADABLE', `Archive could not be read: ${describeError(error)}`, 400);
  } finally {
    removeDirectoryQuietly(tempDir);
  }
}

/** Extracts a single entry from the archive into `targetFile`. */
export async function extractArchiveEntryTo(
  archivePath: string,
  entryPath: string,
  targetFile: string
): Promise<void> {
  const tempDir = safeMkdtemp('japa-backup-entry-');
  try {
    await tarExtract({
      file: archivePath,
      cwd: tempDir,
      preservePaths: false,
      filter: (candidate: string) => normalizeEntryName(candidate) === entryPath,
    });
    const extracted = path.join(tempDir, ...entryPath.split('/'));
    if (!fs.existsSync(extracted)) {
      throw new BackupError('ARCHIVE_ENTRY_MISSING', `Archive entry ${entryPath} is missing`, 400);
    }
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.copyFileSync(extracted, targetFile);
  } finally {
    removeDirectoryQuietly(tempDir);
  }
}

/**
 * Extracts a full archive into `targetDir` after validating every entry.
 * The archive is listed first; any unsafe entry aborts the extraction.
 */
export async function extractArchiveSafely(
  archivePath: string,
  targetDir: string
): Promise<ArchiveEntryInfo[]> {
  const listing = await listArchive(archivePath);
  if (listing.unsafe.length > 0) {
    throw new BackupError('UNSAFE_ARCHIVE_PATHS', 'Archive contains unsafe paths and was rejected', 400, {
      entries: listing.unsafe.slice(0, 5).map((entry) => ({ code: entry.code, path: entry.entryPath })),
      count: listing.unsafe.length,
    });
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const extractionRoot = path.resolve(targetDir);
  await tarExtract({
    file: archivePath,
    cwd: extractionRoot,
    preservePaths: false,
    noChmod: true,
    filter: (entryPath: string, entry: fs.Stats | ReadEntry) => {
      const validated = validateArchiveEntryPath(entryPath);
      if (!validated.safe || !validated.normalized) return false;
      const type = (entry as ReadEntry).type;
      if (typeof type === 'string' && !isSafeArchiveEntryType(type)) return false;
      try {
        // Defence in depth: the resolved target must stay inside the temp root.
        resolveExtractionTarget(extractionRoot, validated.normalized);
      } catch {
        return false;
      }
      return true;
    },
  });

  // Post-extraction verification: every accepted entry must resolve inside the
  // temporary extraction root.
  for (const entry of listing.entries) {
    const validated = validateArchiveEntryPath(entry.path);
    if (!validated.safe || !validated.normalized) continue;
    resolveExtractionTarget(extractionRoot, validated.normalized);
  }

  return listing.entries;
}

export function normalizeEntryName(entryPath: string): string {
  return entryPath.replace(/^\.\//, '').replace(/\/+$/, '');
}

export interface ArchiveEntryAnalysis {
  path: string;
  sizeBytes: number;
  sha256: string;
  header: Buffer;
}

/**
 * Streams the archive once and hashes the contents of the selected entries.
 * Nothing is written to disk, so verification never extracts an untrusted
 * archive just to be able to report on its integrity.
 */
export async function analyzeArchiveEntries(
  archivePath: string,
  wanted: (entryPath: string) => boolean
): Promise<Map<string, ArchiveEntryAnalysis>> {
  const results = new Map<string, ArchiveEntryAnalysis>();
  const pending: Promise<void>[] = [];

  await tarList({
    file: archivePath,
    noResume: true,
    onReadEntry: (entry: ReadEntry) => {
      const entryPath = normalizeEntryName(String(entry.path ?? ''));
      const type = String(entry.type ?? '');
      if ((type !== 'File' && type !== 'OldFile') || !wanted(entryPath)) {
        entry.resume();
        return;
      }

      pending.push(
        new Promise<void>((resolve, reject) => {
          const hash = crypto.createHash('sha256');
          let sizeBytes = 0;
          let header: Buffer | null = null;
          entry.on('data', (chunk: Buffer) => {
            if (!header) header = Buffer.from(chunk.subarray(0, 16));
            hash.update(chunk);
            sizeBytes += chunk.length;
          });
          entry.on('error', reject);
          entry.on('end', () => {
            results.set(entryPath, {
              path: entryPath,
              sizeBytes,
              sha256: hash.digest('hex'),
              header: header ?? Buffer.alloc(0),
            });
            resolve();
          });
          entry.resume();
        })
      );
    },
  });

  await Promise.all(pending);
  return results;
}

export function findEntry(entries: ArchiveEntryInfo[], wanted: string): ArchiveEntryInfo | null {
  return entries.find((entry) => normalizeEntryName(entry.path) === wanted) ?? null;
}
