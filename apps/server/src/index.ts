import express from 'express';
import cors from 'cors';
import session from 'express-session';
import dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';

import authRoutes from './routes/auth.routes';
import dashboardRoutes from './routes/dashboard.routes';
import recipientsRoutes from './routes/recipients.routes';
import tagsRoutes from './routes/tags.routes';
import importsRoutes from './routes/imports.routes';
import messagesRoutes from './routes/messages.routes';
import mediaRoutes from './routes/media.routes';
import campaignsRoutes from './routes/campaigns.routes';
import whatsappRoutes from './routes/whatsapp.routes';
import googleSheetsRoutes from './routes/google-sheets.routes';
import webhookRoutes from './routes/webhook.routes';
import historyRoutes from './routes/history.routes';
import settingsRoutes from './routes/settings.routes';
import backupsRoutes from './routes/backups.routes';
import usersRoutes from './routes/users.routes';
import auditRoutes from './routes/audit.routes';
import { ExecutionQueueWorker } from './services/executionQueueWorker';
import { CampaignSchedulerService, readSchedulerPollIntervalMs } from './services/campaignScheduler.service';
import { backupService } from './services/backup/backup.service';
import { backupScheduler } from './services/backup/backup.scheduler';
import { initializeSqliteRuntime } from './config/db';

dotenv.config({ path: path.join(__dirname, '../../../.env') });

const app = express();
const port = process.env.PORT || 3000;
// Optional bind address. When HOST is unset the listen call keeps the previous
// signature, so the effective binding is unchanged (all interfaces, as before).
const host = process.env.HOST?.trim() || undefined;
const isProduction = process.env.NODE_ENV === 'production';
const configuredSessionSecret = process.env.SESSION_SECRET;
const sessionSecret =
  configuredSessionSecret && configuredSessionSecret.length >= 32
    ? configuredSessionSecret
    : isProduction
      ? undefined
      : crypto.randomBytes(32).toString('hex');

if (!sessionSecret) {
  throw new Error('SESSION_SECRET must be set to at least 32 characters in production');
}

const sessionMaxAgeMs = Number(process.env.SESSION_MAX_AGE_MS) || 24 * 60 * 60 * 1000;
const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173';

app.disable('x-powered-by');

// Production deployment terminates TLS at a reverse proxy, so the browser reaches
// Express over plain HTTP with X-Forwarded-Proto: https. Without trusting that
// hop, `req.protocol` stays "http", `req.secure` is false, and express-session
// silently refuses to emit the session cookie whenever cookie.secure is true
// (NODE_ENV=production) — every login would succeed and immediately be lost.
//
// `1` trusts exactly one proxy hop (the reverse proxy) and is NOT `true`, so a
// client can never spoof X-Forwarded-For/Proto to bypass IP-based lockout.
// This only affects protocol/ip resolution: cookie HttpOnly, Secure and SameSite
// semantics are unchanged.
app.set('trust proxy', 1);

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use(cors({
  origin: corsOrigin,
  credentials: true,
}));

// Webhook routes need raw body for signature verification.
app.use('/api/webhooks', express.raw({ type: 'application/json', limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

app.use(
  session({
    name: 'connect.sid',
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: isProduction,
      maxAge: sessionMaxAgeMs,
    },
  })
);

app.get('/api/health', (req, res) => {
  res.json({ success: true, data: { status: 'ok', timestamp: new Date().toISOString() } });
});

app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/recipients', recipientsRoutes);
app.use('/api/tags', tagsRoutes);
app.use('/api/imports', importsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/campaigns', campaignsRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/google-sheets', googleSheetsRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/backups', backupsRoutes);
// Phase 8.1 — ADMIN-only administration surfaces: user management and audit.
app.use('/api/users', usersRoutes);
app.use('/api/audit', auditRoutes);

app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (error instanceof SyntaxError && 'body' in (error as object)) {
    res.status(400).json({ success: false, error: { code: 'INVALID_JSON', message: 'Request body contains invalid JSON' } });
    return;
  }
  if ((error as { type?: string })?.type === 'entity.too.large') {
    res.status(413).json({ success: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } });
    return;
  }
  next(error);
});

export const worker = new ExecutionQueueWorker(Number(process.env.WORKER_POLL_INTERVAL_MS) || 5000);

// Phase 5.6 — persistent campaign scheduler. It only turns due CampaignSchedule
// rows into CampaignExecution snapshots (via the existing Phase 4.5 logic) and
// hands them to the worker above; all delivery stays inside the worker.
export const scheduler = new CampaignSchedulerService(
  readSchedulerPollIntervalMs(),
  async () => {
    await worker.processCycle();
  }
);

// Phase 5.12 — Backup & Recovery. The backup service only pauses the existing
// worker/scheduler during a restore (never replaces or competes with them), and
// the backup scheduler is a separate, additive timer (disabled by default).
backupService.setPauseBackgroundWriters(async () => {
  const workerWasRunning = worker.isRunning();
  const schedulerWasRunning = scheduler.isRunning();
  // Stop the scheduler before the worker (same graceful order as shutdown):
  // no new executions are handed off while the worker drains and pauses.
  await scheduler.stop();
  await worker.stop();
  return async () => {
    if (workerWasRunning) worker.start();
    if (schedulerWasRunning) scheduler.start();
  };
});

backupScheduler.start();

const startBackgroundWork = () => {
  console.log(`Server is running on port ${port}${host ? ` (bound to ${host})` : ''}`);
  worker.start();
  scheduler.start();
  (app as any).worker = worker;
  (app as any).scheduler = scheduler;
  (app as any).backupScheduler = backupScheduler;
  (app as any).backupService = backupService;
};

// SQLite runtime configuration (journal_mode=WAL + busy_timeout) runs once,
// before any background work begins, so the scheduler and the worker never
// write before the pragmas are applied. A failure here is logged and tolerated:
// the application already works with SQLite's default journal mode, so a PRAGMA
// failure must never be the reason the server refuses to start.
initializeSqliteRuntime()
  .then((info) => {
    console.log(
      `SQLite runtime ready (journal_mode=${info.journalMode}, busy_timeout=${info.busyTimeoutMs}ms)`,
    );
  })
  .catch((error) => {
    console.error('SQLite runtime initialisation failed; continuing with SQLite defaults:', describeFailure(error));
  })
  .finally(() => {
    // Pass a host only when HOST is configured, so the default binding is
    // byte-for-byte the previous behaviour. The cast is compile-time only
    // (PORT keeps its exact runtime value) and exists solely to satisfy the
    // (port, hostname, callback) overload, which is typed as `number`.
    if (host) {
      app.listen(port as number, host, startBackgroundWork);
    } else {
      app.listen(port, startBackgroundWork);
    }
  });

/**
 * Renders an unknown thrown value for a log line without risking disclosure.
 * Only the error name, message and stack are emitted — never environment
 * values, credentials or request payloads. Non-Error rejections (strings,
 * objects) are coerced to their type name so nothing is dumped blindly.
 */
function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`;
  }
  return `Non-error thrown (${error === null ? 'null' : typeof error}).`;
}

/**
 * Single graceful shutdown path shared by SIGTERM/SIGINT and by the
 * process-level failure handlers below.
 *
 * The `shutdownStarted` latch makes the function idempotent, so a SIGTERM
 * arriving while an uncaughtException is already shutting down cannot start a
 * second, interleaved shutdown.
 *
 * A bounded watchdog guarantees the process terminates even if one of the
 * stop() calls hangs; it is cleared on the happy path.
 */
let shutdownStarted = false;
const SHUTDOWN_WATCHDOG_MS = 15_000;

async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`Shutting down (${reason})...`);

  const watchdog = setTimeout(() => {
    console.error(
      `Graceful shutdown exceeded ${SHUTDOWN_WATCHDOG_MS}ms; forcing exit with code ${exitCode}.`,
    );
    process.exit(exitCode);
  }, SHUTDOWN_WATCHDOG_MS);

  try {
    await backupScheduler.stop();
    await scheduler.stop();
    await worker.stop();
  } catch (error) {
    console.error('Error during graceful shutdown:', describeFailure(error));
  } finally {
    clearTimeout(watchdog);
  }

  process.exit(exitCode);
}

const handleSignal = (signal: NodeJS.Signals) => {
  void shutdown(signal, 0);
};

// Existing signal behaviour is preserved: a clean stop still exits 0.
process.on('SIGTERM', handleSignal);
process.on('SIGINT', handleSignal);

// Process-level failures are NOT swallowed. Continuing to serve traffic,
// schedule campaigns or send WhatsApp messages from a process whose internal
// state is unknown is the worse outcome, so the process logs, shuts down
// gracefully and exits non-zero, leaving the restart to the supervisor.
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', describeFailure(error));
  void shutdown('uncaughtException', 1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', describeFailure(reason));
  void shutdown('unhandledRejection', 1);
});
