/**
 * Regression: ExecutionQueueWorker lifecycle (start/stop/restart).
 *
 * The confirmed defect: stop() latched shuttingDown = true and never cleared
 * `running`, while start() never cleared shuttingDown. So start() -> stop() ->
 * start() recreated the interval and reported isRunning() === true while every
 * tick() short-circuited, so the worker silently never polled again. index.ts
 * hits exactly that path when a backup restore resumes background writers.
 *
 * NO WhatsApp / OpenWA / Meta call is made. Delivery work is never reached:
 * processCycle is stubbed at the instance level and, when a real cycle is
 * allowed to run, it operates on an empty disposable database with the
 * provider pinned to an unconfigured adapter. The runner supplies DATABASE_URL.
 */
const path = require('path');
process.env.WHATSAPP_PROVIDER = 'none';
process.env.SCHEDULER_POLL_INTERVAL_MS = '999900';
process.env.WORKER_POLL_INTERVAL_MS = '999900';
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('tsx/cjs');

const { ExecutionQueueWorker } = require('./apps/server/src/services/executionQueueWorker');

let checks = 0, failures = 0;
function check(name, cond, extra) {
  checks++;
  if (!cond) failures++;
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (extra !== undefined ? ' | ' + String(extra) : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Counts cycles actually performed, without touching the provider. */
function instrument(w) {
  const state = { cycles: 0 };
  w.processCycle = async function () {
    state.cycles++;
    return { processed: 0, sent: 0, failed: 0, skipped: 0, executionCompleted: 0, executionFailed: 0, recovered: 0, retriesScheduled: 0 };
  };
  return state;
}

async function main() {
  console.log('=== ExecutionQueueWorker lifecycle regression ===\n');

  /* ---- 0. default polling interval preserved ---- */
  const probe = new ExecutionQueueWorker();
  check('0. Default poll interval is 5000ms', probe['pollIntervalMs'] === 5000, probe['pollIntervalMs']);

  const w = new ExecutionQueueWorker(20); // short interval, real timer
  const c = instrument(w);

  /* ---- 1. fresh worker is not running; start makes it run ---- */
  check('1a. Fresh worker not running', w.isRunning() === false);
  w.start();
  check('1b. After start, worker is running', w.isRunning() === true);
  await sleep(120);
  const afterStart = c.cycles;
  check('1c. Immediate tick + interval polling occurred', afterStart >= 2, 'cycles=' + afterStart);

  /* ---- 2. repeated start does not duplicate the interval ---- */
  w.start(); w.start(); w.start();
  const before = c.cycles;
  await sleep(210); // ~10 intervals at 20ms
  const delta = c.cycles - before;
  check('2. Repeated start does not duplicate polling', delta >= 5 && delta <= 20, 'cyclesIn210ms=' + delta);

  /* ---- 3. stop() clears running (the confirmed bug) ---- */
  await w.stop();
  check('3a. After stop, worker is NOT running', w.isRunning() === false);
  const afterStop = c.cycles;
  await sleep(210);
  check('3b. No polling work after stop', c.cycles === afterStop, 'cycles=' + c.cycles);

  /* ---- 4. repeated stop is safe / idempotent ---- */
  let stopThrew = null;
  try { await w.stop(); await w.stop(); } catch (e) { stopThrew = e; }
  check('4. Repeated stop is safe and idempotent', stopThrew === null, stopThrew ? String(stopThrew.message) : 'no throw');
  check('4b. Still not running after repeated stop', w.isRunning() === false);

  /* ---- 5. start -> stop -> start resumes polling (the core regression) ---- */
  w.start();
  check('5a. Worker running again after restart', w.isRunning() === true);
  const beforeResume = c.cycles;
  await sleep(210);
  check('5b. Polling RESUMES after restart', c.cycles > beforeResume, 'cycles=' + c.cycles);
  await w.stop();

  /* ---- 6. stop() before any start() is safe ---- */
  const never = new ExecutionQueueWorker(20);
  const nc = instrument(never);
  let t = null;
  try { await never.stop(); } catch (e) { t = e; }
  check('6. stop() on a never-started worker is safe', t === null && never.isRunning() === false);
  const nBefore = nc.cycles;
  await sleep(80);
  check('6b. A stopped, never-started worker does no work', nc.cycles === nBefore, 'cycles=' + nc.cycles);

  /* ---- 7. a real (unstubbed) cycle is refused while stopped ---- */
  const { prisma } = require('./apps/server/src/config/db');
  let dbQueries = 0;
  const realFindMany = prisma.campaignExecutionRecipient.findMany;
  prisma.campaignExecutionRecipient.findMany = function (...a) { dbQueries++; return realFindMany.apply(this, a); };
  try {
    const real = new ExecutionQueueWorker(999999);
    await real.stop();
    dbQueries = 0;
    const refused = await real.processCycle();
    check('7. processCycle() on a stopped worker performs NO work', refused.processed === 0 && dbQueries === 0, 'dbQueries=' + dbQueries);

    // A never-started worker (shuttingDown === false) still runs a real cycle.
    dbQueries = 0;
    const fresh = new ExecutionQueueWorker(999999);
    await fresh.processCycle();
    check('7b. A never-started worker still runs a real cycle', dbQueries > 0, 'dbQueries=' + dbQueries);
  } finally {
    prisma.campaignExecutionRecipient.findMany = realFindMany;
  }

  console.log('\nAssertions run: ' + checks + ' | failed: ' + failures);
  console.log('=== ' + (failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED') + ' ===');
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error('Error:', e && e.stack ? e.stack : e); process.exitCode = 1; });