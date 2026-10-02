import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

/**
 * Bounded SQLite busy timeout, in milliseconds.
 *
 * The CMS runs three concurrent writers inside a single process: the HTTP API,
 * the campaign scheduler and the execution queue worker (plus backup/restore,
 * which pauses the other two). SQLite writers serialise, so a writer that finds
 * the database locked waits up to this long for the lock instead of failing
 * immediately with SQLITE_BUSY. 5000 ms is a conservative value for a
 * single-server deployment: short enough that a genuinely stuck writer still
 * surfaces as an error, long enough to outlast a normal writer hand-off.
 *
 * CAVEAT — this is a PER-CONNECTION pragma. `busy_timeout` is a property of the
 * individual SQLite connection, not of the database file, so a single call at
 * startup only configures the pooled connection(s) Prisma happens to hold at
 * that moment. Prisma does not expose a hook to apply a PRAGMA to every future
 * connection, and re-running it per query was explicitly ruled out. Prisma's
 * own SQLite default busy timeout remains in effect for connections this call
 * does not reach. See `initializeSqliteRuntime` for the measured behaviour.
 *
 * By contrast `journal_mode=WAL` IS persisted in the database file, so the
 * single startup call below applies it to every connection, now and after every
 * restart.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

let sqliteRuntimePromise: Promise<SqliteRuntimeInfo> | null = null;

/**
 * Journal modes SQLite accepts for `PRAGMA journal_mode`. Only the first two are
 * meaningful for this application; the remainder are listed so an unexpected
 * configuration value is rejected instead of being passed through to SQLite.
 */
const ALLOWED_JOURNAL_MODES = ['delete', 'wal', 'truncate', 'persist', 'memory', 'off'] as const;

/**
 * Journal mode requested at startup, from SQLITE_JOURNAL_MODE. Defaults to
 * 'delete', SQLite's own default.
 *
 * WHY 'delete' RATHER THAN 'wal' (measured, see module notes):
 * WAL was trialled as the production default and REJECTED. It is technically
 * valid and reduces writer contention, but it is incompatible with this
 * application's existing restore implementation, which replaces the database by
 * renaming the file over it. While SQLite holds the WAL mapping, Windows refuses
 * the rename and the restore aborts:
 *
 *   RESTORE_FAILED ... EBUSY: resource busy or locked, rename '...\japa.db'
 *
 * Verified by controlled experiment against the backup suite (test-5-12, 134
 * checks): with journal_mode=WAL => 6 failures, all cascading from the failed
 * restore; with journal_mode=DELETE => ALL 134 CHECKS PASSED.
 *
 * WAL therefore stays opt-in behind this variable and is NOT the default.
 * Turning it on is safe only for deployments that do not use in-app restore on
 * Windows, or after the restore path is reworked (stop the process instead of
 * renaming under a live connection). Resolve that trade-off in Pass 4.
 */
export const DEFAULT_SQLITE_JOURNAL_MODE = 'delete';

function resolveRequestedJournalMode(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.SQLITE_JOURNAL_MODE ?? '').trim().toLowerCase();
  if (!raw) return DEFAULT_SQLITE_JOURNAL_MODE;
  if (!(ALLOWED_JOURNAL_MODES as readonly string[]).includes(raw)) {
    throw new Error(
      `SQLITE_JOURNAL_MODE must be one of: ${ALLOWED_JOURNAL_MODES.join(', ')} (got "${raw}")`,
    );
  }
  return raw;
}

export interface SqliteRuntimeInfo {
  /** Journal mode reported by SQLite after initialisation. */
  readonly journalMode: string;
  /** Whether WAL was requested and is active. */
  readonly walEnabled: boolean;
  /** The busy timeout applied to the connection used during initialisation. */
  readonly busyTimeoutMs: number;
}

/**
 * Applies the SQLite runtime configuration exactly once per process.
 *
 * Safe to call concurrently and repeatedly: the first call memoises its promise,
 * later calls return the same result without touching the database again.
 *
 * IMPORTANT: `PRAGMA` statements return a row, so they MUST go through
 * `$queryRawUnsafe`. Prisma rejects them on `$executeRawUnsafe` with
 * "Execute returned results, which is not allowed in SQLite." (verified).
 *
 * This changes no schema and migrates no data: `journal_mode` switches the
 * on-disk journal format only, and `busy_timeout` is an in-memory connection
 * setting. The default 'delete' journal mode is exactly what the application
 * used before this function existed, so the default configuration is
 * behaviour-preserving. `VACUUM INTO` (the backup snapshot) works under either
 * journal mode — verified.
 */
export function initializeSqliteRuntime(
  client: PrismaClient = prisma,
): Promise<SqliteRuntimeInfo> {
  if (!sqliteRuntimePromise) {
    sqliteRuntimePromise = (async (): Promise<SqliteRuntimeInfo> => {
      // Validated against an allowlist; never a raw pass-through of user input.
      const requestedJournalMode = resolveRequestedJournalMode();
      const modeRows = await client.$queryRawUnsafe(`PRAGMA journal_mode=${requestedJournalMode}`);
      const journalMode = String(
        (Array.isArray(modeRows) && modeRows.length ? Object.values(modeRows[0])[0] : modeRows) ?? '',
      );

      // Integers are inlined from a module constant, never from user input.
      await client.$queryRawUnsafe(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`);

      return {
        journalMode,
        walEnabled: journalMode.toLowerCase() === 'wal',
        busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS,
      };
    })().catch((error) => {
      // Do not memoise a failure: a transient error should not permanently
      // disable initialisation for the rest of the process lifetime.
      sqliteRuntimePromise = null;
      throw error;
    });
  }
  return sqliteRuntimePromise;
}
