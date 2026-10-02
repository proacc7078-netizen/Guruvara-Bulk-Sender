# Process Supervision (Windows)

Reference material only. **No Windows service was created and NSSM/PM2 were not
installed.** These are instructions for an operator.

---

## The one rule

> **EXACTLY ONE CMS PROCESS.**
>
> `express-session` uses the default **MemoryStore**, which lives in a single
> process's heap. A second instance would not share sessions, and — far worse —
> the `CampaignSchedulerService` and `ExecutionQueueWorker` are in-process
> `setInterval` loops. **A second process means duplicate WhatsApp sends.**

Therefore, always:

- `instances: 1` in PM2, and **never** `exec_mode: cluster`
- exactly one NSSM service
- no IIS node pool, no `pm2 --scale`, no `loadbalancer` mode

---

## Option A — NSSM Windows service (recommended for Windows)

NSSM runs a program as a Windows Service with restart-on-failure and log
capture. It is the simplest correct option here.

> **NSSM was not downloaded, installed, or run.** Obtain it yourself from a
> source you trust and verify the binary.

### Concept

```
Windows Service "JapaCMS"
        │
        ├─ Program : node.exe
        ├─ Args    : <app>\apps\server\dist\index.js
        ├─ Dir     : <app>            ← working directory matters, see below
        ├─ Restart : on failure / delay 5s / attempts 10
        └─ Logs    : <logdir>\stdout.log, <logdir>\stderr.log
```

### Why the working directory matters

`apps/server/dist/index.js` loads `.env` relative to its own location:

```ts
dotenv.config({ path: path.join(__dirname, '../../../.env') });
```

and `backup.paths.repoRoot()` walks a fixed number of directories up from
`__dirname`. The service's working directory should therefore be the
**application root** — this keeps behaviour identical to running
`node apps/server/dist/index.js` from there.

### Install commands (operator)

```powershell
# 1. Verify Node is on the SYSTEM PATH (services do not see user PATH).
#    Services run as LocalSystem; a per-user Node install may be invisible.
where.exe node

# 2. Add the service (adjust paths)
nssm install JapaCMS "C:\Program Files\nodejs\node.exe"
nssm set JapaCMS AppParameters "<app>\apps\server\dist\index.js"
nssm set JapaCMS AppDirectory "<app>"
nssm set JapaCMS DisplayName "Japa Message CMS"
nssm set JapaCMS Description "Japa Message CMS API (single instance)"
nssm set JapaCMS Start SERVICE_AUTO_START

# 3. Environment for the service — set the same values as
#    docs/deployment/production.env.example
nssm set JapaCMS AppEnvironmentExtra NODE_ENV=production
nssm set JapaCMS AppEnvironmentExtra HOST=127.0.0.1
nssm set JapaCMS AppEnvironmentExtra PORT=3000
nssm set JapaCMS AppEnvironmentExtra DATABASE_URL=file:D:/japa-data/db/japa.db
nssm set JapaCMS AppEnvironmentExtra BACKUP_DIR=D:/japa-data/backups

# 4. Automatic restart on unexpected exit
nssm set JapaCMS AppExit Default Restart
nssm set JapaCMS AppRestartDelay 5000
nssm set JapaCMS AppThrottle 10000
nssm set JapaCMS AppMaxInstances 1        # ← belt and braces: never 2

# 5. Logs
nssm set JapaCMS AppStdout <logdir>\stdout.log
nssm set JapaCMS AppStderr <logdir>\stderr.log
---

## Option B — PM2 (cross-platform alternative)

Use **either** NSSM **or** PM2, not both.

> PM2 was not installed or started here.

```powershell
npm install -g pm2
```

`ecosystem.config.cjs` (create at the application root; example only):

```js
module.exports = {
  apps: [
    {
      name: 'japa-cms',
      script: 'apps/server/dist/index.js',
      cwd: __dirname,

      // ── SINGLE INSTANCE ──────────────────────────────────────────────
      instances: 1,
      exec_mode: 'fork',        // NEVER 'cluster'

      // ── Restart policy ───────────────────────────────────────────────
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      min_uptime: '20s',
      max_memory_restart: '512M',

      // ── Logs ─────────────────────────────────────────────────────────
      out_file: 'logs/out.log',
      error_file: 'logs/err.log',
      merge_logs: true,
      time: true,

      // ── Environment ──────────────────────────────────────────────────
      // See docs/deployment/production.env.example for the full list.
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '3000',
        DATABASE_URL: 'file:D:/japa-data/db/japa.db',
        BACKUP_DIR: 'D:/japa-data/backups',
        BACKUP_SCHEDULE_ENABLED: 'true',
        SQLITE_JOURNAL_MODE: 'delete',
      },
    },
  ],
};
```

```powershell
pm2 start ecosystem.config.cjs
pm2 save                       # persist across reboot
pm2 startup                    # register as a Windows startup task
pm2 logs japa-cms              # tail
pm2 monit                      # CPU/mem + restart count
```

Verify single instance:

```powershell
pm2 list               # 'japa-cms' must show exactly one row
pm2 describe japa-cms   # confirm exec mode is 'fork'
```

---

## How the application shuts down

Pass 3 added a single graceful-shutdown path used by `SIGTERM`/`SIGINT` and by
the `uncaughtException` / `unhandledRejection` handlers:

1. `shutdownStarted` latch makes it idempotent (no interleaved shutdowns)
2. `backupScheduler.stop()`
3. `scheduler.stop()` — drains any in-flight cycle
4. `worker.stop()` — drains any in-flight cycle
5. `process.exit(code)` — `0` for signals, `1` for a process-level failure
6. A 15-second watchdog force-exits if any `stop()` hangs

Because of (6) a hung shutdown cannot leave an orphaned process holding the
SQLite file — important on Windows, where an open file handle would block
backup and restore.

### Windows signal caveat

Windows does not deliver POSIX signals the way Linux does. Stopping an NSSM
service or `pm2 stop` terminates the process through the Windows service control
manager. The application's handlers are still correct and are what run on
Linux/systemd; on Windows expect an OS-level stop rather than a
`SIGTERM`-driven graceful drain. **Always stop the service cleanly through the
service manager — never `taskkill /F` — so the SQLite file is released.**

---

## Pre-start checklist

- [ ] `NODE_ENV=production`
- [ ] `HOST=127.0.0.1` (Express must not be reachable from the network)
- [ ] `PORT` matches the proxy's `reverse_proxy` target
- [ ] `DATABASE_URL` is an **absolute** path to an existing, writable directory
- [ ] Working directory is the application root
- [ ] Service restart configured, `max_instances = 1` / `instances: 1`
- [ ] `logs/` directory exists and is writable by the service account
- [ ] Only **one** `node.exe ... dist/index.js` process after start
nssm set JapaCMS AppRotateFiles 1
nssm set JapaCMS AppRotateBytes 10485760    # 10 MB

# 6. Start
nssm start JapaCMS
```

### Verify it is running exactly once

```powershell
Get-Service JapaCMS
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Select-Object ProcessId, CommandLine
```

Expect **one** `node.exe` whose command line is
`<app>\apps\server\dist\index.js`. Two lines mean duplicate sending.