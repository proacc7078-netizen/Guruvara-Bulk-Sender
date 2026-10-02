# Operations Runbook — Restart, Crash Behaviour, Backup & Restore

Reference procedure. **No restore was executed, and no production system was
touched, in producing this document.** All behaviour below was read from the
source code and confirmed during Passes 2–3.

---

# Part A — Restart and crash behaviour

Everything here is **existing behaviour**. Nothing was changed in Pass 3 beyond
adding crash handlers; no delivery, scheduling, or retry semantics were altered.

---

## A. Normal restart (planned)

**Operator action**

```powershell
# Windows (NSSM) — always use the service manager, never taskkill /F
nssm stop JapaCMS
nssm start JapaCMS
```

```bash
# PM2
pm2 restart japa-cms --update-env
```

**What happens**

| Step | Behaviour |
|---|---|
| Shutdown | `backupScheduler.stop()` → `scheduler.stop()` → `worker.stop()`, each awaiting any in-flight cycle |
| Exit code | `0` |
| Startup | `PRAGMA journal_mode` + `busy_timeout` applied once, then `worker.start()` and `scheduler.start()` |
| **Sessions** | ❌ **All users are logged out.** `express-session` `MemoryStore` lives in process memory |
| Pending campaigns | ✅ Resume on the next worker tick (`WORKER_POLL_INTERVAL_MS`, default 5 s) |
| Due schedules | ✅ Picked up on the next scheduler tick (default 60 s) |

> **MemoryStore is the single biggest operational constraint of this system.**
> Every restart logs out every user. Plan deploys accordingly. Replacing
> `MemoryStore` was explicitly out of scope for Pass 3.

---

## B. Unexpected crash (process-level failure)

**Detection**

```bash
curl -i https://<your-host>/api/health     # connection refused / 5xx
```

```powershell
Get-Service JapaCMS
Get-Content <logdir>\stderr.log -Tail 50
```

**What happens (Pass 3 behaviour)**

1. `uncaughtException` or `unhandledRejection` fires.
2. The error is logged **safely** — `name`, `message`, `stack` only; no
   environment values, tokens or request payloads.
3. `shutdown(...)` runs: `backupScheduler` → `scheduler` → `worker`, each
   drained. A 15-second watchdog force-exits if any step hangs.
4. The process exits with code **1**.

**Errors are deliberately NOT swallowed.** Continuing to serve traffic, schedule
campaigns or send WhatsApp messages from a process in an unknown state is worse
than an explicit stop.

**Supervisor response**

The configured restart policy (NSSM `AppExit Default Restart` with a 5 s delay,
or PM2 `autorestart`) brings the process back. **If no supervisor is installed,
nothing restarts it** — this is why `process-supervisor/` is a deployment
requirement, not optional.

**What survives the crash**

| State | Survives? |
|---|---|
| Recipients, messages, campaigns, history | ✅ In SQLite |
| Media files | ✅ On disk at absolute paths |
| Campaign execution rows in `PENDING` | ✅ Resumed by the worker |
| Schedules not yet due | ✅ Picked up by the scheduler |
| Recipients stuck in `RUNNING` | ⚠️ See scenario **G** |
| Sessions | ❌ All lost |

---

## C. OpenWA offline

OpenWA is contacted **only at delivery time**, never at startup.

| Situation | Behaviour |
|---|---|
| OpenWA down when the CMS starts | ✅ **CMS starts normally.** No startup dependency |
| OpenWA down during a send | The send fails; the recipient is retried with backoff (`nextAttemptAt`) and the execution stays open |
| OpenWA restarts | ✅ Self-heals — each send resolves the adapter fresh |
| Long outage | Retries continue to `WHATSAPP_MAX_RETRIES` (default 3), then the recipient is marked `FAILED` and the parent execution finalises as `FAILED` |
| Campaign status | Stays `RUNNING` while any recipient is `PENDING`/`RUNNING`, so it never finalises early |

> ⚠️ Delivery is **at-least-once**. A message accepted by OpenWA but lost
> before the CMS records the provider ID may be retried and therefore **sent
> twice**.

---

## D. Google Apps Script unavailable

Handled by the 20-second `AbortController` timeout added in Pass 3.

| Situation | Result |
|---|---|
| Bridge hangs | Request aborts at ~20 s and surfaces as the existing typed error `APPS_SCRIPT_NETWORK_ERROR` — never an `AbortError` |
| Bridge returns 401/403 | `APPS_SCRIPT_UNAUTHORIZED` (token mismatch) |
| Bridge unreachable | `APPS_SCRIPT_NETWORK_ERROR` |
| URL empty/misconfigured | Fails **only when a sync is invoked**, never at startup |

---

## E. SQLite contention (`SQLITE_BUSY`)

| Aspect | Current behaviour |
|---|---|
| Journal mode | `delete` (SQLite default) — see the warning in Part B |
| Busy timeout | `5000 ms`, applied at startup by `initializeSqliteRuntime()` |
| Scope | **Per connection.** Prisma exposes no hook to apply a PRAGMA to every future pooled connection, so connections not present at startup keep Prisma's own default |
| On contention | A writer **waits** up to the timeout rather than failing immediately |
| If it still fails | The error is caught; `setInterval` callbacks log and continue (`Worker tick error:`). The scheduler and worker survive; that one cycle is retried on the next tick |
| User-visible effect | A transient failed request, not an outage |

> `SQLITE_BUSY_TIMEOUT_MS = 5000` is a module constant, not an environment
> variable.

---

## F. Server restarts during a scheduled campaign

```
campaign (scheduled)
   └─ becomes due
        └─ scheduler creates a CampaignExecution snapshot
             └─ worker picks up PENDING recipients
                  └─ sends, one at a time
```

- Restart **before** the schedule is due → picked up normally afterwards.
- Restart **after** execution creation → `PENDING` recipients resume on the next
  tick; already-`SENT` recipients are not resent.
- Restart **mid-send** → that recipient is left `RUNNING`, handled by scenario G.
- Duplicate risk is **low but non-zero** — at-least-once delivery around the
  crash window.

---

## G. A recipient is `RUNNING` when the process crashes

This is the important recovery case.

`ExecutionQueueWorker.recoverStaleRunning()` runs at the **start of every
processing cycle** — it does **not** depend on process uptime.
---

# Part B — Backup & restore runbook

> **Do not execute a restore against production to "test" it.** The drill in §C.6
> is a procedure for a future, planned exercise on a disposable copy.

---

## A. What a backup is

Each backup is a single portable archive containing **the database and the
media**, plus integrity metadata:

```
<BACKUP_DIR>/
  backup-<timestamp>-<suffix>.tar.gz
  backup-<timestamp>-<suffix>.tar.gz.manifest.json
  backup-<timestamp>-<suffix>.tar.gz.sha256
```

Inside the archive:

| Entry | Contents |
|---|---|
| `backup-manifest.json` | Non-secret manifest (format version, created time, file list, sizes, hashes) |
| `database/database.sqlite` | Consistent SQLite snapshot taken with **`VACUUM INTO`** |
| `media/…` | Full copy of the media root |

Key properties (confirmed in Pass 1):

- The snapshot uses **`VACUUM INTO`**, executed by SQLite itself — consistent
  **while the application is running**, with no table locking or torn file copy.
- `.sha256` and `.manifest.json` are sidecars; the manifest also travels inside
  the archive.
- Only regular files and directories are archived/extracted (no symlinks or
  devices).

---

## B. Backup operations

### B.1 Location

`BACKUP_DIR` — **absolute**, and **outside the replaceable application
directory**. The shipped default (`storage/backups`) sits inside the app tree,
where a redeploy could delete every backup.

### B.2 Scheduled backups

| Setting | Default | Production |
|---|---|---|
---

## C. Restore

### C.1 Prerequisites

- [ ] A **verified** backup archive in `BACKUP_DIR`
- [ ] Enough free disk space for the pre-restore safety backup **plus** the
      replacement
- [ ] **Journal mode is `delete`** — see the warning in §C.2
- [ ] Nothing else is writing to the SQLite file

### C.2 ⚠️ WAL incompatibility — do not enable WAL

> **Measured in Pass 3.** With `SQLITE_JOURNAL_MODE=wal`, the backup suite
> (`test-5-12`, 134 checks) produced **6 failures**, all cascading from:
>
> ```
> RESTORE_FAILED ... EBUSY: resource busy or locked, rename '...\japa.db'
> ```
>
> With `journal_mode=delete`: **ALL 134 CHECKS PASSED**.
>
> **Cause:** the restore replaces the database by **renaming the file over it**.
> While SQLite holds a WAL mapping, Windows refuses that rename.
>
> **Therefore keep `SQLITE_JOURNAL_MODE=delete`.** WAL may only be enabled after
> the restore path is redesigned (e.g. stopping the process rather than renaming
> under a live connection). That redesign is out of scope.

### C.3 What a restore does, in order

1. Validates the archive, manifest and checksums
2. Extracts into a private temporary staging directory inside `BACKUP_DIR`
   (path-traversal guarded: `..`, absolute paths, drive letters, UNC, NUL bytes
   and non-regular files are all rejected)
3. **Creates a `PRE_RESTORE` safety backup** of the current database + media into
   `BACKUP_DIR`
4. Pauses the campaign scheduler, then the queue worker
5. Swaps the database file and restores media
6. Parks `-journal` / `-wal` / `-shm` sidecars so a stale journal cannot be
   replayed against the replaced database
7. Verifies the restored database
8. Resumes the scheduler and worker
9. Writes a `BACKUP_RESTORE_COMPLETED` audit event

If any step fails, a best-effort rollback restores the database from the
pre-restore snapshot and the media from the journal copy. A pending-restore
marker file is left behind **only** when rollback could not complete, so the
failure stays visible on next start.

### C.4 Restore procedure

1. **Settings → Backup → list** and confirm the target archive shows *valid* +
   *checksum matches*.
2. Note current row counts (Users / Recipients / Campaigns) for comparison.
3. Trigger the restore for that backup id (ADMIN-only).
4. Wait for completion. Do not restart or kill the process mid-restore.
5. On failure, read the audit log and the `PRE_RESTORE` backup that was created
   automatically.

### C.5 Post-restore verification

- [ ] CMS starts and `/api/health` returns `200`
- [ ] Login works
- [ ] Recipient / Message / Campaign counts match what you recorded
- [ ] Audit log contains `BACKUP_RESTORE_COMPLETED`
- [ ] **No pending-restore marker** remains in `BACKUP_DIR`
- [ ] A `PRE_RESTORE` safety backup exists
- [ ] Media images render (absolute paths must still resolve)
- [ ] Scheduler and worker are running again

### C.6 Restore drill (future exercise, on a disposable copy)

**Not executed in this pass.** When you rehearse a restore:

1. Copy the database to a scratch location and point a **throwaway**
   `DATABASE_URL`/`BACKUP_DIR` at it — never the live ones.
2. Run a backup in that environment.
3. Restore it.
4. Verify counts and media.
5. Delete the scratch environment.

This proves the backup path works **before** you depend on it in an incident.

---

## D. Operator summary

| Question | Answer |
|---|---|
| Where do backups live? | `BACKUP_DIR` (absolute, outside the app directory) |
| What is in a backup? | Database snapshot + **all media** + manifest + SHA-256 |
| Consistent while running? | ✅ Yes — taken with `VACUUM INTO` |
| How many are kept? | `BACKUP_RETENTION_COUNT`, default 10 |
| Does a restore need a shutdown? | ❌ No — scheduler and worker are paused in-process |
| Where does the safety backup go? | Into `BACKUP_DIR`, marked `PRE_RESTORE` |
| Can I enable WAL? | ❌ **No** — see §C.2 |
| Survive an app redeploy? | ✅ Only if `BACKUP_DIR` is outside the replaced tree |
| `BACKUP_SCHEDULE_ENABLED` | `false` | **`true`** — otherwise no automatic backup ever runs |
| `BACKUP_INTERVAL_HOURS` | `24` | e.g. `24` |
| `BACKUP_SCHEDULER_POLL_INTERVAL_MS` | `60000` | default is fine |
| `BACKUP_RETENTION_COUNT` | `10` | e.g. `10`; `0` disables cleanup |

> ⚠️ `BACKUP_SCHEDULE_ENABLED=false` is the shipped default and fails
> **silently** — the CMS looks healthy and simply never backs up. Verify a
> backup file actually appears after enabling it.

### B.3 Manual backup

**Settings → Backup → Create backup** (ADMIN-only, authenticated). The
scheduler is process-local, so only one backup or restore may run at a time.

### B.4 Verify a backup is good

1. Three files exist in `BACKUP_DIR` (`.tar.gz`, `.manifest.json`, `.sha256`).
2. Settings → Backup reports the archive **present**, manifest **valid**, and
   **matching** the sidecar.
3. The archive is **not** inside the application directory.

```
STALE_RUNNING_MS = 10 * 60 * 1000      // 10 minutes
```

It selects recipients where `status = 'RUNNING'` **and**
`updatedAt <= now - 10 minutes` (parent not `CANCELLED`), and resets them so
delivery resumes.

| Question | Answer |
|---|---|
| Recovery uptime-dependent? | ❌ **No** — time-threshold based, runs every cycle |
| Worst-case delay after restart | **~10 minutes**, plus one poll interval |
| Cancelled executions | Recovered immediately |
| **Duplicate messages?** | ⚠️ **Yes, possible.** If the crash happened *after* OpenWA accepted the message but *before* the CMS stored the result, the recipient is retried and receives **two** messages. Inherent at-least-once behaviour; **not** changed |

To shorten the window you would have to change `STALE_RUNNING_MS`, which is a
delivery-semantics decision and out of scope.

---

## H. Quick reference

| Event | Users logged out? | Work resumes? | Duplicates possible? |
|---|---|---|---|
| Planned restart | ✅ Yes | ✅ Next tick | Unlikely |
| Crash + supervisor restart | ✅ Yes | ✅ Next tick | ⚠️ Possible |
| Crash, no supervisor | ✅ Yes | ❌ Until manual start | — |
| OpenWA outage | ❌ No | ✅ Retries | ⚠️ Possible |
| Apps Script outage | ❌ No | ✅ Manual re-run | ❌ No |
| SQLite busy | ❌ No | ✅ Next cycle | ❌ No |
**Partial writes are possible.** `runSyncNow()` writes recipients in a loop; a
mid-run failure leaves earlier rows persisted. This is safe because sync is
**idempotent** — phone-number deduplication means a retry updates rather than
duplicates, and blank Sheet values preserve existing CMS values. **Re-running
a failed sync converges.**

There are **no automatic retries**; a failed sync is retried by the operator.