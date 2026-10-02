import { prisma } from '../config/db';
import { Prisma } from '@prisma/client';
import { createExecutionSnapshot } from '../utils/campaignExecution.util';

/**
 * Phase 5.6 — Persistent campaign scheduler.
 *
 * Bridges the Phase 4.4 CampaignSchedule plan to the existing Phase 4.5/5.x
 * execution pipeline:
 *
 *   due CampaignSchedule (status SCHEDULED, campaign READY)
 *     -> existing createExecutionSnapshot()  (immutable message/recipient snapshot)
 *       -> hand-off to the existing ExecutionQueueWorker (which owns delivery)
 *
 * Design rules (Phase 5.6):
 * - This service never sends anything. It does not import the WhatsApp adapter,
 *   the delivery service or any HTTP client: all delivery stays in the worker /
 *   executionDelivery.service.ts.
 * - Idempotency comes from the database, not from timing: CampaignExecution has
 *   `scheduleId String? @unique`, so at most one execution row can ever exist for
 *   a schedule. A concurrent creation surfaces as a P2002 unique violation and is
 *   treated as "already consumed" instead of creating a duplicate.
 * - `scheduledAt` is already the normalized UTC instant produced by Phase 4.4's
 *   timezone resolution; the scheduler only compares that stored instant with the
 *   clock and never reinterprets the wall clock or the timezone.
 * - Consumption is recorded with `consumedAt` (additive nullable column). A failed
 *   attempt is never marked consumed: `lastAttemptAt`/`lastError` are preserved and
 *   the row stays due, so a future retry/recovery (or the next cycle) can pick it up
 *   without ever creating a second execution.
 */

export const SCHEDULER_POLL_INTERVAL_ENV = 'SCHEDULER_POLL_INTERVAL_MS';
export const SCHEDULER_BATCH_SIZE_ENV = 'SCHEDULER_BATCH_SIZE';

/** Conservative default: one cycle per minute, never a tight loop. */
export const DEFAULT_SCHEDULER_POLL_INTERVAL_MS = 60_000;

/** Bounded work per cycle so a single cycle can never run unbounded. */
export const DEFAULT_SCHEDULER_BATCH_SIZE = 25;

/** Upper bound for the preserved failure reason (no unbounded text). */
export const MAX_SCHEDULER_ERROR_LENGTH = 500;

/**
 * Hand-off hook. index.ts wires this to the existing ExecutionQueueWorker so a
 * freshly created execution is picked up immediately; without a hook the worker's
 * own polling still processes it.
 */
export type ExecutionHandoff = (executionIds: string[]) => void | Promise<void>;

export interface SchedulerCycleError {
  scheduleId: string;
  campaignId: string;
  code: string;
  message: string;
}

export interface SchedulerCycleResult {
  /** Due + eligible schedules examined in this cycle. */
  scanned: number;
  /** Executions created by this cycle. */
  executed: number;
  /** Due schedules whose execution already existed (raced/consumed earlier). */
  alreadyConsumed: number;
  /** Schedules whose execution creation failed (recorded, not consumed). */
  failed: number;
  /** Consumed markers repaired for schedules that already had an execution. */
  reconciled: number;
  /** Execution ids created in this cycle, in creation order. */
  executionIds: string[];
  errors: SchedulerCycleError[];
}

type ConsumeOutcome =
  | { status: 'EXECUTED'; executionId: string }
  | { status: 'ALREADY_CONSUMED'; executionId: string }
  | { status: 'FAILED'; code: string; message: string };

const readPositiveInt = (raw: unknown, fallback: number): number => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

export const readSchedulerPollIntervalMs = (): number =>
  readPositiveInt(process.env[SCHEDULER_POLL_INTERVAL_ENV], DEFAULT_SCHEDULER_POLL_INTERVAL_MS);

export const readSchedulerBatchSize = (): number =>
  readPositiveInt(process.env[SCHEDULER_BATCH_SIZE_ENV], DEFAULT_SCHEDULER_BATCH_SIZE);

const isUniqueConstraintFailure = (error: unknown): boolean =>
  Boolean(error) && typeof error === 'object' && (error as { code?: unknown }).code === 'P2002';

export class CampaignSchedulerService {
  private interval: NodeJS.Timeout | null = null;
  private running = false;
  private processing = false;
  private shuttingDown = false;

  constructor(
    private readonly pollIntervalMs: number = readSchedulerPollIntervalMs(),
    private readonly handoff: ExecutionHandoff = () => {},
    private readonly clock: () => Date = () => new Date(),
    private readonly batchSize: number = readSchedulerBatchSize()
  ) {}

  /** Starts the polling loop. A second call is a no-op (no duplicate loops). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.shuttingDown = false;
    this.interval = setInterval(() => {
      this.tick();
    }, this.pollIntervalMs);
    // Overdue schedules are picked up immediately on boot.
    this.tick();
  }

  /** Stops polling and waits for an in-flight cycle to finish. Never leaves a timer. */
  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    while (this.processing) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    this.running = false;
  }

  private tick(): void {
    if (this.shuttingDown || this.processing) return;
    this.processDueSchedules().catch((error) => {
      console.error('Scheduler tick error:', error instanceof Error ? error.message : error);
    });
  }

  /**
   * One scheduler cycle: repair consumption markers, consume every due schedule
   * that is SCHEDULED + READY + unconsumed, then hand the created executions to
   * the queue worker. Overlapping calls are ignored (the flag is the guard).
   */
  async processDueSchedules(): Promise<SchedulerCycleResult> {
    const result: SchedulerCycleResult = {
      scanned: 0,
      executed: 0,
      alreadyConsumed: 0,
      failed: 0,
      reconciled: 0,
      executionIds: [],
      errors: [],
    };

    if (this.processing) return result;
    this.processing = true;

    try {
      const now = this.clock();

      result.reconciled = await this.reconcileConsumedSchedules(now);

      const due = await prisma.campaignSchedule.findMany({
        where: {
          status: 'SCHEDULED',
          consumedAt: null,
          scheduledAt: { lte: now },
          campaign: { status: 'READY' },
        },
        orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
        take: this.batchSize,
        select: { id: true, campaignId: true },
      });

      result.scanned = due.length;

      for (const schedule of due) {
        if (this.shuttingDown) break;

        const outcome = await this.consumeSchedule(schedule.id, schedule.campaignId, now);

        if (outcome.status === 'EXECUTED') {
          result.executed++;
          result.executionIds.push(outcome.executionId);
        } else if (outcome.status === 'ALREADY_CONSUMED') {
          result.alreadyConsumed++;
        } else {
          result.failed++;
          result.errors.push({
            scheduleId: schedule.id,
            campaignId: schedule.campaignId,
            code: outcome.code,
            message: outcome.message,
          });
          console.warn(
            `[scheduler] schedule ${schedule.id} not consumed (${outcome.code}): ${outcome.message}`
          );
        }
      }

      if (result.executionIds.length > 0) {
        try {
          await this.handoff(result.executionIds);
        } catch (error) {
          // The worker also polls for PENDING work, so a failed hand-off is not
          // fatal — it only delays delivery until the worker's next cycle.
          console.error(
            'Scheduler hand-off error:',
            error instanceof Error ? error.message : error
          );
        }
      }
    } finally {
      this.processing = false;
    }

    return result;
  }

  /**
   * Creates the execution snapshot for one due schedule through the existing
   * Phase 4.5 logic, then marks the schedule consumed. On failure the schedule is
   * deliberately left unconsumed with the reason preserved.
   */
  private async consumeSchedule(
    scheduleId: string,
    campaignId: string,
    now: Date
  ): Promise<ConsumeOutcome> {
    let snapshot: Awaited<ReturnType<typeof createExecutionSnapshot>>;

    try {
      snapshot = await createExecutionSnapshot(campaignId);
    } catch (error) {
      if (isUniqueConstraintFailure(error)) {
        // A concurrent cycle (or the execution API) created the execution first.
        // The newest execution for this schedule is the one that won.
        const existing = await prisma.campaignExecution.findFirst({
          where: { scheduleId },
          orderBy: { createdAt: 'desc' },
        });
        if (existing) {
          await this.markConsumed(scheduleId, now);
          return { status: 'ALREADY_CONSUMED', executionId: existing.id };
        }
        const raceMessage = 'Concurrent execution creation did not persist a row';
        await this.recordFailure(scheduleId, now, 'EXECUTION_CREATE_RACE', raceMessage);
        return { status: 'FAILED', code: 'EXECUTION_CREATE_RACE', message: raceMessage };
      }

      const message = error instanceof Error ? error.message : String(error);
      await this.recordFailure(scheduleId, now, 'EXECUTION_CREATE_FAILED', message);
      return { status: 'FAILED', code: 'EXECUTION_CREATE_FAILED', message };
    }

    if (!snapshot.ok) {
      // Requirement: never mark a failed attempt consumed.
      await this.recordFailure(scheduleId, now, snapshot.error.code, snapshot.error.message);
      return { status: 'FAILED', code: snapshot.error.code, message: snapshot.error.message };
    }

    await this.markConsumed(scheduleId, now);

    // Mirrors the controller's handling of the shared snapshot outcome type:
    // ExecutionSnapshotResult has no `alreadyExisted` field, so the outcome is
    // narrowed structurally instead of changing the Phase 4.5 union.
    const created = snapshot as {
      ok: true;
      execution: Prisma.CampaignExecutionGetPayload<{}>;
      alreadyExisted?: boolean;
    };

    return created.alreadyExisted === true
      ? { status: 'ALREADY_CONSUMED', executionId: created.execution.id }
      : { status: 'EXECUTED', executionId: created.execution.id };
  }

  /**
   * Marks schedules that already have an execution but no consumed marker (for
   * example a crash between snapshot creation and marking). This keeps the marker
   * eventually consistent without ever touching an already-consumed row.
   */
  private async reconcileConsumedSchedules(now: Date): Promise<number> {
    const rows = await prisma.campaignSchedule.findMany({
      where: { status: 'SCHEDULED', consumedAt: null, executions: { some: {} } },
      select: { id: true },
      take: this.batchSize,
    });

    let repaired = 0;
    for (const row of rows) {
      if (await this.markConsumed(row.id, now)) repaired++;
    }
    return repaired;
  }

  /**
   * Sets the consumption marker exactly once (the `consumedAt: null` condition
   * makes the write idempotent and race-safe).
   */
  private async markConsumed(scheduleId: string, now: Date): Promise<boolean> {
    const updated = await prisma.campaignSchedule.updateMany({
      where: { id: scheduleId, consumedAt: null },
      data: { consumedAt: now, lastAttemptAt: now, lastError: null },
    });
    return updated.count > 0;
  }

  /** Preserves why nothing was created; the schedule stays due for a future retry. */
  private async recordFailure(
    scheduleId: string,
    now: Date,
    code: string,
    message: string
  ): Promise<void> {
    const lastError = `${code}: ${message}`.slice(0, MAX_SCHEDULER_ERROR_LENGTH);
    await prisma.campaignSchedule.updateMany({
      where: { id: scheduleId, consumedAt: null },
      data: { lastAttemptAt: now, lastError },
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  isProcessing(): boolean {
    return this.processing;
  }

  getPollIntervalMs(): number {
    return this.pollIntervalMs;
  }

  getBatchSize(): number {
    return this.batchSize;
  }
}
