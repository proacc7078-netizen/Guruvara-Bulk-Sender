# Deployment Runbook — First-Time Production Deployment

Reference procedure. **None of these steps were executed as part of Pass 4.**
Substitute your own hostnames, paths and secrets.

Prerequisites: [`README.md`](README.md) (topology + layout) and
[`production.env.example`](production.env.example).

> ### ✅ STEP 6 — DECIDED: OPTION B (`prisma db push`)
>
> **PROJECT DECISION: this project uses `npx prisma db push` for schema
> synchronisation.** No baseline migration was created, no migration history was
> repaired, squashed, rewritten or deleted.
>
> Rationale: single-server / local-first CMS · no Git repository yet · the
> existing migration history is intrinsically non-replayable (`CampaignSchedule`
> is created by no migration) · the live database already matches the Prisma
> schema · a fresh `db push` and an existing-database `db push` have both been
> verified · backup/restore is the practical rollback mechanism.
>
> Exact command (run from the application root, against the **production**
> `DATABASE_URL`):
>
> ```bash
> npx prisma db push --schema=prisma/schema.prisma
> ```
>
> **Operational rule — never skip steps 1–5:**
> 1. Take a **verified backup** (Settings → Backup) and confirm it lists as valid.
> 2. Review the intended changes in `prisma/schema.prisma` (and confirm
>    `npx prisma db push` reports only the expected statements).
> 3. Run `db push` against the production `DATABASE_URL`.
> 4. Verify the application: login, recipients, messages, campaigns.
> 5. **Retain the backup** for rollback.
>
> **Never:**
> - run `prisma migrate reset`
> - run destructive commands blindly (`--force-reset`, `--accept-data-loss`)
> - delete or rewrite migration history
> - assume that rolling back the application rolls back database state —
>   they are independent. Application rollback restores build artefacts; data
>   rollback requires restoring a backup.
>
> Note: `db push` is a **no-op** when the database already matches the schema,
> which is the normal case.

---

## Phase A — Host preparation

### 1. Install Node.js LTS

```bash
node --version     # expect v20.x or newer LTS
npm --version
```

On Windows, confirm `node.exe` is on the **SYSTEM** `PATH` — services do not see
a per-user install (see `process-supervisor/README.md`).

### 2. Obtain and verify dependencies

```bash
cd <app>
npm ci
```

### 3. Generate the Prisma client

```bash
npx prisma generate --schema=prisma/schema.prisma
```

> The Prisma CLI is only needed at build/deploy time. The generated client is
> what the running server uses, and `prisma/schema.prisma` must remain present
> in the deployment tree because the client resolves paths relative to it.

---

## Phase B — Persistent directories

### 4. Create persistent directories

```bash
# Example POSIX layout
sudo mkdir -p /var/lib/japa/db
sudo mkdir -p /var/lib/japa/backups
sudo chown -R japa:japa /var/lib/japa
chmod 750 /var/lib/japa
```

```powershell
# Example Windows layout
New-Item -ItemType Directory -Force D:\japa-data\db
New-Item -ItemType Directory -Force D:\japa-data\backups
```

The service account needs **read + write** on these, because SQLite must create
`-journal`/`-shm` sidecars next to `japa.db` during normal operation.

### 5. Configure `.env`

Copy [`production.env.example`](production.env.example) to `<app>/.env` and fill
in every placeholder. At minimum set:

```
NODE_ENV=production
HOST=127.0.0.1
---

## Phase C — Database

### 6. Initialise the production database

**Decision: Option B — `npx prisma db push`.** (Rationale at the top of this file.)

```bash
cd <app>
npx prisma db push --schema=prisma/schema.prisma
```

Expected output for a brand-new database:

```
SQLite database japa.db created at file:<persistent-data>/db/japa.db
Your database is now in sync with your Prisma schema.
```

On an existing, already-correct database this is a **no-op**:

```
Your database is already in sync with your Prisma schema.
```

Facts that informed the decision (recorded for future maintainers):

- The current migration history is **not replayable** — `CampaignSchedule` is
>   created by no migration, so `prisma migrate deploy` fails on a fresh
>   database.
> - Three migrations (`security_admin_hardening`, `user_roles`, `user_profile`)
>   are recorded nowhere in `_prisma_migrations` despite existing in the live DB.
> - **A backup must exist before any database change on an existing system.**

---

## Phase D — Build

### 7. Build the server

```bash
npm run build --workspace=apps/server
```

Produces `apps/server/dist/` (CommonJS, `apps/server/dist/index.js`).

> Do **not** bundle, flatten, or single-file the output. `backup.paths.repoRoot()`
> walks a fixed number of directories up from `__dirname`, so the compiled file
> layout must be preserved.

### 8. Build the frontend

```bash
npm run build --workspace=apps/web
```

Produces `apps/web/dist/` (`index.html` + `assets/`).

---

---

## Phase F — Start and verify

### 11. Start the CMS

Note the startup lines in the service log:

```
SQLite runtime ready (journal_mode=delete, busy_timeout=5000ms)
Server is running on port 3000 (bound to 127.0.0.1)
```

### 12. Verify liveness

```bash
curl https://<your-host>/api/health
# {"success":true,"data":{"status":"ok","timestamp":"..."}}
```

> ⚠️ `/api/health` returns a **static** response. It does **not** check the
> database, storage, scheduler, worker, OpenWA, or environment variables. It
> proves only that the Node event loop is alive and Express is routing. It can
> return `200` against a completely empty database. Steps 13–15 are the real
> readiness checks.

### 13. Verify login and session (proves the proxy + trust proxy)

Open `https://<your-host>/login` in a browser and sign in.

- You must land on `/dashboard` **and stay signed in** after a refresh.
- If the session silently drops, `X-Forwarded-Proto` is missing — re-check the
  proxy, `app.set('trust proxy', 1)`, and `NODE_ENV=production`.

### 14. Verify database access

Load **Recipients**, **Messages**, and **Campaigns** — each performs a real
query. Confirm there is no missing-table error, which would mean step 6 was
skipped or ran against the wrong `DATABASE_URL`.

### 15. Verify media upload

Upload a small JPG/PNG/WebP from the message editor.

- The proxy body limit must exceed 5 MB.
- The file must appear under `<app>/storage/uploads`.
- The row's `Media.storagePath` is an **absolute** path — note it; that path
  must remain valid for the life of the deployment.

### 16. Verify OpenWA configuration

**Settings → WhatsApp** must show:

- provider `openwa`
- `apiKeyConfigured: true`
- `sessionIdConfigured: true`
- a masked session id (`12345678...`)
- `apiBaseUrl` matching your real OpenWA host

Never paste the API key or the full session id into a ticket or log.

### 17. Verify Google Sheets configuration

**Settings → Sheets** — run the connection test (`action=ping`), then a small
sync. Confirm `GOOGLE_APPS_SCRIPT_URL` ends in `/exec`. See
[`checklists.md`](checklists.md).

### 18. Verify a scheduled backup

Trigger a manual backup from **Settings → Backup**. Confirm three files appear:

```
backup-<timestamp>.tar.gz
backup-<timestamp>.tar.gz.manifest.json
backup-<timestamp>.tar.gz.sha256
```

They must be in `BACKUP_DIR`, **outside** the application directory. Restore is
described in [`runbook-operations.md`](runbook-operations.md) §C — **do not run
a restore against production to "check" it.**

### 19. Verify restart behaviour

Restart the service through the service manager and confirm:

- `/api/health` returns `200` again
- the scheduler and worker resume (Settings diagnostics)
- you are **logged out** — expected, `MemoryStore` does not survive a restart
- no campaign is sent twice

---

## Phase G — Record what you did

Capture and store with the deployment:

- hostname, Node version, proxy used
- absolute paths of `<app>`, database and backup directory
- the Pass 1 decision used for step 6
- **a known-good backup created before the first production deploy**
- the previous `apps/server/dist` + `apps/web/dist` artifacts, if any
## Phase E — Infrastructure

### 9. Configure the reverse proxy

Choose **one** of [`reverse-proxy/nginx.conf`](reverse-proxy/nginx.conf) or
[`reverse-proxy/Caddyfile`](reverse-proxy/Caddyfile). Substitute every
`<<REPLACE>>` and `cms.example.com`.

Validate **before** enabling (parse only, binds nothing):

```bash
nginx -t -c /path/to/nginx.conf
caddy validate --config Caddyfile --adapter caddyfile
```

Obtain a TLS certificate through your own CA/ACME process. Confirm the proxy
sends `X-Forwarded-Proto` — without it, login silently fails (Pass 3).

### 10. Configure the process supervisor

Follow [`process-supervisor/README.md`](process-supervisor/README.md) — NSSM
**or** PM2, never both, always **one instance**.
PORT=3000
DATABASE_URL="file:<persistent-data>/db/japa.db"
BACKUP_DIR=<persistent-data>/backups
BACKUP_SCHEDULE_ENABLED=true
CORS_ORIGIN=https://<your-host>
SESSION_SECRET=<at least 32 chars, high entropy>
```

> **Media uploads cannot be redirected by environment variable.** They always
> live at `<app>/storage/uploads`. Read `README.md` §C.3 before deciding whether
> to deploy in place or use an NTFS junction.