import { prisma } from '../config/db';
import { ExecutionDeliveryService } from './executionDelivery.service';
import {
  ExecutionStatus,
  markExecutionCompleted,
  markExecutionFailed,
  markExecutionRunning,
  validateTransition,
} from '../utils/campaignExecution.util';

/**
 * Recipient statuses that mean "delivery is still in flight". A parent
 * CampaignExecution must never be finalized while any of its recipients is in
 * one of these states. A recipient waiting for a scheduled retry counts as
 * in-flight (its status is PENDING with a future nextAttemptAt), so a retry
 * always keeps the execution open.
 */
const IN_FLIGHT_RECIPIENT_STATUSES: string[] = ['PENDING', 'RUNNING'];

/**
 * Recipient statuses that mean "delivery reached a final outcome". SENT is
 * terminal for the worker; the webhook may later refine it to DELIVERED/READ.
 */
const TERMINAL_RECIPIENT_STATUSES: string[] = ['SENT', 'DELIVERED', 'READ', 'FAILED'];

export interface WorkerResult {
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
  executionCompleted: number;
  executionFailed: number;
  recovered: number;
  retriesScheduled: number;
}

export class ExecutionQueueWorker {
  private interval: NodeJS.Timeout | null = null;
  private running = false;
  private processing = false;
  private shuttingDown = false;

  constructor(private readonly pollIntervalMs: number = 5000) {}

  start(): void {
    if (this.running) return;
    // A restart MUST clear the shutdown latch. Without this, start() after a
    // stop() (the backup-restore resume path in index.ts does exactly that)
    // would recreate the interval and report isRunning() === true while every
    // tick() short-circuits on the stale shuttingDown flag, so the worker would
    // silently never poll again. Mirrors CampaignSchedulerService.start().
    this.shuttingDown = false;
    this.running = true;
    this.interval = setInterval(() => {
      this.tick().catch((e) => console.error('Worker tick error:', e));
    }, this.pollIntervalMs);
    this.tick().catch((e) => console.error('Worker initial tick error:', e));
  }

  /**
   * Stops the polling loop and waits for an in-flight cycle to finish.
   *
   * Idempotent and safe to call when never started or already stopped. Clears
   * `running` so isRunning() reflects the real state instead of staying true
   * for the lifetime of the process. Mirrors
   * CampaignSchedulerService.stop().
   */
  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    while (this.processing) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this.running = false;
  }

  private async tick(): Promise<void> {
    if (this.shuttingDown || this.processing) return;
    await this.processCycle();
  }

  async processCycle(): Promise<WorkerResult> {
    if (this.shuttingDown) {
      // A stopped worker must not perform delivery work, even if a cycle is
      // requested directly. This makes stop() authoritative: nothing is sent
      // while the worker is paused (for example during a backup restore).
      // A worker that was never started has shuttingDown === false, so explicit
      // single-cycle callers (scheduler handoff, tests) are unaffected.
      return { processed: 0, sent: 0, failed: 0, skipped: 0, executionCompleted: 0, executionFailed: 0, recovered: 0, retriesScheduled: 0 };
    }
    if (this.processing) return { processed: 0, sent: 0, failed: 0, skipped: 0, executionCompleted: 0, executionFailed: 0, recovered: 0, retriesScheduled: 0 };
    this.processing = true;

    const result: WorkerResult = { processed: 0, sent: 0, failed: 0, skipped: 0, executionCompleted: 0, executionFailed: 0, recovered: 0, retriesScheduled: 0 };

    try {
      await this.recoverStaleRunning();
      result.recovered = this._recoveredCount;

      // Find PENDING recipients eligible for processing:
      // - status is PENDING
      // - nextAttemptAt is null (never attempted) OR nextAttemptAt <= now (retry due)
      // - execution is not CANCELLED
      // - execution.scheduledAt <= now (the scheduled send time has arrived)
      //
      // The scheduledAt filter is the authoritative "do not deliver early" gate.
      // An execution may legitimately be prepared in advance (the scheduler or
      // the "Prepare execution" action can snapshot it before the due time), so
      // the worker must never treat a PENDING row of a future execution as
      // sendable. Filtering here means such rows are simply not selected: no
      // adapter call, no attemptCount increment, no retry consumption, and no
      // busy loop — the normal poll interval makes the row eligible on its own
      // once the clock reaches scheduledAt. The delivery boundary re-checks
      // the same condition (see NOT_DUE_BELOW) so a row that turns out to be
      // in the future is still never passed to the WhatsApp adapter.
      const now = new Date();
      const pending = await prisma.campaignExecutionRecipient.findMany({
        where: {
          status: 'PENDING',
          OR: [
            { nextAttemptAt: null },
            { nextAttemptAt: { lte: now } },
          ],
          execution: {
            status: { not: 'CANCELLED' },
            scheduledAt: { lte: now },
          },
        },
        include: { execution: { select: { id: true, status: true, scheduledAt: true } } },
      });

      for (const recipient of pending) {
        if (this.shuttingDown) break;

        // Defensive delivery-boundary gate (NOT_DUE_BELOW). The query above
        // already filters future executions, but the send decision is repeated
        // here, immediately before the adapter is invoked, so a clock change or
        // a concurrently created future execution can never leak an early send.
        // Waiting is not a failure: the row keeps its PENDING status, its
        // nextAttemptAt is left untouched, attemptCount is not incremented and
        // no retry is consumed. The next normal poll re-evaluates eligibility,
        // which is the existing scheduler/queue mechanism — never a busy loop.
        if (recipient.execution.scheduledAt.getTime() > Date.now()) {
          result.skipped++;
          continue;
        }

        try {
          const deliveryService = new ExecutionDeliveryService();
          const execRecipientId = `${recipient.executionId}:${recipient.recipientId}`;
          const sendResult = await deliveryService.sendExecutionRecipient(execRecipientId);
          result.processed++;

          if (sendResult.success) {
            result.sent++;
          } else if (sendResult.retryScheduled) {
            result.retriesScheduled++;
          } else {
            result.failed++;
          }

          const execStatus = await this.updateExecutionStatus(recipient.executionId);
          if (execStatus === 'COMPLETED') result.executionCompleted++;
          if (execStatus === 'FAILED') result.executionFailed++;
        } catch {
          result.failed++;
          result.processed++;
          try {
            const execStatus = await this.updateExecutionStatus(recipient.executionId);
            if (execStatus === 'FAILED') result.executionFailed++;
          } catch { }
        }
      }

      // Reconcile executions whose recipients are all terminal but whose parent
      // row was never finalized (e.g. the worker was interrupted between the
      // last delivery and the aggregate update, or a row created before the
      // PENDING -> RUNNING transition existed). Executions that still have
      // PENDING/RUNNING recipients - including retry-scheduled ones - are never
      // touched here, so retries cannot finalize a parent prematurely.
      const reconciled = await this.finalizeTerminalExecutions();
      result.executionCompleted += reconciled.completed;
      result.executionFailed += reconciled.failed;
    } finally {
      this.processing = false;
    }

    return result;
  }

  private _recoveredCount = 0;

  /**
   * How long a recipient may sit in RUNNING before it is treated as abandoned.
   *
   * A RUNNING row means "a worker process is inside the provider send right
   * now". After a crash/restart that marker is stale and the row would
   * otherwise never be picked up again, because the worker's selection query
   * only looks at PENDING rows — the delivery would be silently lost and the
   * parent execution would stay RUNNING forever.
   *
   * The threshold must comfortably exceed the worst-case duration of a real
   * provider call, so a genuinely in-flight send on a healthy worker is never
   * stolen and double-sent. It is deliberately generous.
   */
  private static readonly STALE_RUNNING_MS = 10 * 60 * 1000;

  /**
   * Returns RUNNING recipients that no live worker can still be working on:
   * either the parent execution was CANCELLED (nothing will ever deliver it),
   * or the row has been RUNNING for longer than the staleness threshold
   * (the owning process is gone). Both are reset to PENDING with the retry
   * clock cleared, so the normal selection query picks them up again.
   *
   * `attemptCount` and `errorMessage` are intentionally preserved so the retry
   * budget already spent is not silently refunded.
   */
  async recoverStaleRunning(now: Date = new Date()): Promise<number> {
    const staleBefore = new Date(now.getTime() - ExecutionQueueWorker.STALE_RUNNING_MS);
    const stale = await prisma.campaignExecutionRecipient.findMany({
      where: {
        status: 'RUNNING',
        OR: [
          // Abandoned mid-flight: parent is still active but the row has not
          // been touched for longer than a legitimate send can take.
          { execution: { status: { not: 'CANCELLED' } }, updatedAt: { lte: staleBefore } },
          // Cancelled parent: never deliverable, recover immediately.
          { execution: { status: 'CANCELLED' } },
        ],
      },
      include: { execution: { select: { id: true, status: true } } },
    });

    let recovered = 0;
    for (const recipient of stale) {
      await prisma.campaignExecutionRecipient.update({
        where: {
          executionId_recipientId: {
            executionId: recipient.executionId,
            recipientId: recipient.recipientId,
          },
        },
        data: {
          status: 'PENDING',
          errorMessage: recipient.execution?.status === 'CANCELLED'
            ? 'Recovered from stale RUNNING due to cancelled execution'
            : 'Recovered from stale RUNNING after restart',
          nextAttemptAt: null,
        },
      });
      recovered++;
    }

    this._recoveredCount = recovered;
    return recovered;
  }

  /**
   * Reconciles the parent CampaignExecution with the aggregate state of its
   * recipients.
   *
   * Rules (existing lifecycle semantics preserved):
   *  - any recipient still PENDING/RUNNING (including retry-scheduled) ->
   *    the execution is in progress: transition the parent to RUNNING when it
   *    is still PENDING, and finalize nothing.
   *  - all recipients terminal with at least one FAILED -> RUNNING -> FAILED.
   *  - all recipients terminal and none FAILED -> RUNNING -> COMPLETED.
   *  - already terminal parents (COMPLETED/FAILED/CANCELLED) are left as-is.
   *
   * Returns the new execution status when it was finalized, otherwise null.
   */
  private async updateExecutionStatus(executionId: string): Promise<ExecutionStatus | null> {
    const recipients = await prisma.campaignExecutionRecipient.findMany({
      where: { executionId },
      select: { status: true },
    });

    if (recipients.length === 0) return null;

    const execution = await prisma.campaignExecution.findUnique({
      where: { id: executionId },
      select: { status: true },
    });

    if (!execution) return null;

    const currentStatus = execution.status as ExecutionStatus;

    const stillInFlight = recipients.some((r) =>
      IN_FLIGHT_RECIPIENT_STATUSES.includes(r.status)
    );

    if (stillInFlight) {
      // Delivery is in progress for at least one recipient: reflect that on the
      // parent, but never finalize it.
      await this.ensureExecutionRunning(executionId, currentStatus);
      return null;
    }

    const allTerminal = recipients.every((r) =>
      TERMINAL_RECIPIENT_STATUSES.includes(r.status)
    );

    if (!allTerminal) return null;

    // A parent may only reach a terminal status from RUNNING, so a parent that
    // is still PENDING must transition PENDING -> RUNNING first.
    const runnable = await this.ensureExecutionRunning(executionId, currentStatus);
    if (!runnable) return null;

    const anyFailed = recipients.some((r) => r.status === 'FAILED');

    try {
      if (anyFailed) {
        await markExecutionFailed(executionId, 'One or more recipients failed permanently');
        return 'FAILED';
      }
      await markExecutionCompleted(executionId);
      return 'COMPLETED';
    } catch {
      // A concurrent transition already finalized (or moved) this execution.
      return null;
    }
  }

  /**
   * Ensures the parent execution is RUNNING, performing the legal
   * PENDING -> RUNNING transition through the shared execution utility when
   * needed. Returns true when the execution is (now) RUNNING, false when it
   * cannot or should not be moved (terminal state, missing row, race).
   */
  private async ensureExecutionRunning(
    executionId: string,
    knownStatus?: ExecutionStatus
  ): Promise<boolean> {
    let currentStatus = knownStatus;

    if (!currentStatus) {
      const execution = await prisma.campaignExecution.findUnique({
        where: { id: executionId },
        select: { status: true },
      });
      if (!execution) return false;
      currentStatus = execution.status as ExecutionStatus;
    }

    if (currentStatus === 'RUNNING') return true;
    if (currentStatus !== 'PENDING') return false;

    const validation = validateTransition(currentStatus, 'RUNNING');
    if (!validation.ok) return false;

    try {
      await markExecutionRunning(executionId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Repairs executions whose recipients are all terminal but whose parent row
   * was never finalized. Only executions that still have at least one recipient
   * and no recipient left in PENDING/RUNNING are considered, so a recipient
   * scheduled for retry always keeps its execution open.
   */
  async finalizeTerminalExecutions(): Promise<{ completed: number; failed: number }> {
    const candidates = await prisma.campaignExecution.findMany({
      where: {
        status: { in: ['PENDING', 'RUNNING'] },
        recipients: {
          some: {},
          none: { status: { in: IN_FLIGHT_RECIPIENT_STATUSES } },
        },
      },
      select: { id: true },
    });

    let completed = 0;
    let failed = 0;

    for (const candidate of candidates) {
      const outcome = await this.updateExecutionStatus(candidate.id);
      if (outcome === 'COMPLETED') completed++;
      if (outcome === 'FAILED') failed++;
    }

    return { completed, failed };
  }

  /**
   * True only while the polling loop is genuinely active.
   *
   * `running` is set by start() and cleared by stop(), so a stopped worker
   * reports false instead of staying true for the lifetime of the process.
   * (Settings diagnostics surface this as `workerState`.)
   */
  isRunning(): boolean {
    return this.running;
  }

  isProcessing(): boolean {
    return this.processing;
  }
}
