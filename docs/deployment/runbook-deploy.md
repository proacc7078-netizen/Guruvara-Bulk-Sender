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
in every placeholder.

#### 5a. Production environment preflight table

Verify **every row** before continuing. Do not copy values from any development
file; generate production secrets fresh.

| Variable | Production requirement |
|---|---|
| `NODE_ENV` | `production` |
| `HOST` | `127.0.0.1` |
| `PORT` | Must match backend/proxy configuration |
| `DATABASE_URL` | Absolute persistent path **OUTSIDE the repository** |
| `SQLITE_JOURNAL_MODE` | `delete` |
| `SESSION_SECRET` | Fresh high-entropy production secret |
| `CORS_ORIGIN` | Exact production frontend origin |
| `MEDIA_PUBLIC_BASE_URL` | Production HTTPS origin |
| `MEDIA_PUBLIC_TOKEN_SECRET` | Fresh production secret |
| `WHATSAPP_PROVIDER` | `openwa` |
| `WHATSAPP_OPENWA_BASE_URL` | Production OpenWA endpoint |
| `WHATSAPP_OPENWA_API_KEY` | Production secret |
| `WHATSAPP_OPENWA_SESSION_ID` | Production session |
| `WHATSAPP_OPENWA_WEBHOOK_SECRET` | Production secret |
| `GOOGLE_APPS_SCRIPT_URL` | Deployed `/exec` URL |
| `GOOGLE_APPS_SCRIPT_TOKEN` | Production secret |
| `BACKUP_DIR` | Absolute persistent path **OUTSIDE the application tree** |
| `BACKUP_SCHEDULE_ENABLED` | `true` |

> Generate secrets locally, e.g.
> `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
> Never write a production secret into any repository file, ticket, or log.

#### 5b. Common production misconfigurations

These are the values most often carried over from development by mistake:

| Symptom | Wrong value | Correct value |
|---|---|---|
| No `Secure` cookie, no HSTS | `NODE_ENV=development` | `NODE_ENV=production` |
| API reachable from the whole network | `HOST` unset (binds all interfaces) | `HOST=127.0.0.1` |
| Every browser API call fails CORS | `CORS_ORIGIN` unset (`http://localhost:5173`) | exact production origin |
| Database lost on redeploy | `DATABASE_URL` inside the repository | external absolute path |
| All backups lost on redeploy | `BACKUP_DIR=storage/backups` | external absolute path |
| No backups are ever taken | `BACKUP_SCHEDULE_ENABLED=false` | `true` |
| Images missing from WhatsApp messages | dev/container `MEDIA_PUBLIC_BASE_URL` | production HTTPS origin |

Minimum acceptable starting point:

```
NODE_ENV=production
HOST=127.0.0.1
---

## Phase C — Database

### 6. Initialise the production database

#### 6a. ⚠️ SAFETY GATE — verify ALL of these BEFORE running `db push`

| # | Gate | How to confirm |
|---|---|---|
| 1 | Production `.env` points to the **intended external** production DB | Read `DATABASE_URL` and verify the path |
| 2 | The path is **absolute** | It must not be relative (e.g. `file:./data/...`) |
| 3 | The DB is **not inside the repository** | The path must be outside the app/repository tree |
| 4 | A **verified production backup exists** | Settings → Backup lists it as present + valid |
| 5 | **Schema review is complete** | the `prisma/schema.prisma` diff has been reviewed |
| 6 | **No destructive Prisma flags** | No `--force-reset`, no `--accept-data-loss` |

> If **any** gate fails, **STOP**. Do not run `db push`.

Only when all six pass, and **only against the intended production
`DATABASE_URL`**, run:

```bash
npx prisma db push --schema=prisma/schema.prisma
```

> ⚠️ This command acts on whatever `DATABASE_URL` currently resolves to. A wrong
> path will synchronise the schema against the **wrong database**. Re-read
> `DATABASE_URL` immediately before running it.

#### 6b. The command

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

### 12a. Create the production ADMIN account (REQUIRED before step 13)

> ⚠️ **Do NOT run `prisma/seed.ts` in production.**
>
> `prisma/seed.ts` creates a **development** administrator
> (`admin@japa.local`) with a **weak development password**. That credential is
> published in the repository. It must never exist in production.

| Rule | Detail |
|---|---|
| Do not run the seed | `prisma/seed.ts` is for local development only |
| Do not use the seed credentials | Neither the seed email nor the seed password is acceptable in production |
| Create the first ADMIN through the app | Use the application's supported **user creation flow** (`POST /api/users`, ADMIN-only) or **Users → Add user** in the UI |
| Password strength | Use a **strong, unique** password. It must satisfy the application's existing validation: **8–128 characters** (`MIN_PASSWORD_LENGTH` / `MAX_PASSWORD_LENGTH` in `apps/server/src/utils/credentials.util.ts`) |
| Then verify login | Confirm the new ADMIN can log in before continuing the deployment |
| Never record it | Do not document, print, screenshot, or paste a production password anywhere — not in this documentation, a ticket, a log, `.env`, or Git |

Sequence:

1. Start the CMS (step 11) and confirm `/api/health` (step 12).
2. Bootstrap the **first** ADMIN. Because no ADMIN exists yet, create it directly
   in the database **once**, using a strong Argon2-hashed password — or use the
   seeded account **temporarily**, then immediately create a new ADMIN with a
   strong password via the UI, verify it, and delete the seeded account.
3. Confirm the strong-password ADMIN can log in and reach an ADMIN-only screen
   (for example **Users** or **Settings**).
4. Only then continue to step 13.

> If the seeded account was used as a bootstrap, **confirm it has been removed or
> had its password changed** before the deployment is called complete.

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

### ⚠️ PRODUCTION STORAGE CONSTRAINT — read before any deployment or upgrade

This is a permanent property of the application and it constrains how you deploy.

- **`storage/uploads` is FIXED relative to the deployed application.** It is
  resolved from the compiled file location (`path.resolve(__dirname, ...)`).
  There is **no** environment variable that can redirect it.
- **`Media.storagePath` stores ABSOLUTE filesystem paths** in the database
  (for example `C:\...\japa-message-cms\storage\uploads\abc.jpg`).
- Therefore **the application directory MUST NOT be moved after deployment.**

| Requirement | Consequence |
|---|---|
| Establish the application directory **permanently** at first deploy | Choosing the path later is not possible once media exists |
| Upgrades must be **in place** | Replace `apps/server/dist` + `apps/web/dist` only — never relocate `<app>` |
| A strategy that copies the app elsewhere **breaks media** | Every existing media URL returns 404 "Media file no longer exists" |
| `storage/uploads` must be **backed up** | It is **not** inside the database and **not** inside the backup archive location |

If the deployment must make `<app>` fully disposable, use an NTFS **directory
junction** from `<app>\storage\uploads` to persistent storage — but **only on a
fresh deployment with no existing media rows**. Never apply this to a populated
database; see [`README.md`](README.md) §C.3–C.4.

---

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

#### 18a. ⚠️ BACKUP SAFETY GATE — required BEFORE serving production traffic

Production backup configuration must be:

```
BACKUP_SCHEDULE_ENABLED=true
BACKUP_DIR=<absolute path outside the application tree>
```

Then, before serving traffic, confirm:

- [ ] `BACKUP_SCHEDULE_ENABLED=true` in the **production** `.env`
- [ ] `BACKUP_DIR` is **absolute**
- [ ] `BACKUP_DIR` is **outside** the application tree (a redeploy must not delete backups)
- [ ] A backup has been **created**
- [ ] The **archive exists** (`backup-<timestamp>.tar.gz`)
- [ ] The **manifest exists** (`…tar.gz.manifest.json`) and reports **valid**
- [ ] The **checksum matches** (`…tar.gz.sha256` agrees with the manifest)
- [ ] The backup is **retained** outside the application tree
- [ ] `storage/uploads` is covered by your own storage backup (see the storage constraint above)

> A green `/api/health` says nothing about backups. If `BACKUP_SCHEDULE_ENABLED`
> is left `false`, the CMS looks perfectly healthy and **never backs up at all**.

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
---

## Phase H — Pre-launch checklist and final order

### H1. Infrastructure prerequisites (all must be satisfied)

| # | Prerequisite | Notes |
|---|---|---|
| 1 | Persistent server / host | Always-on machine |
| 2 | Reverse proxy | nginx, Caddy or IIS — serves `apps/web/dist`, proxies `/api` |
| 3 | TLS certificate | Obtained and installed by the operator |
| 4 | DNS record | Points the hostname at the host |
| 5 | Process supervisor | NSSM or PM2, **one instance**, auto-restart |
| 6 | **Exactly ONE Node process** | See the warning below |
| 7 | Persistent **database** directory | Outside the repository |
| 8 | Persistent **backup** directory | Outside the application tree |
| 9 | Persistent **application** directory | Fixed forever — media paths are absolute |
| 10 | Persistent `storage/uploads` | Lives inside `<app>`; must survive upgrades |

> #### ⚠️ MULTIPLE NODE INSTANCES ARE NOT SUPPORTED
>
> The session store is **`express-session` MemoryStore** and the
> `CampaignSchedulerService` + `ExecutionQueueWorker` are **process-local**
> `setInterval` loops.
>
> Running a second instance means:
> - sessions are **not shared** between processes (random logouts), and
> - the scheduler and queue worker run **twice** — causing **duplicate WhatsApp
>   messages** to recipients.
>
> Therefore: `instances: 1`, `exec_mode: 'fork'`, **never** `cluster`, **never**
> `pm2 --scale`, **never** multiple NSSM services, **never** an IIS node pool.

### H2. Final pre-launch order (follow exactly, in order)

| # | Step | Gate / verification |
|---|---|---|
| 1 | Provision persistent server | Prerequisite 1 |
| 2 | **Choose and permanently establish the application directory** | Cannot be changed later |
| 3 | Install application | `npm ci`, `npx prisma generate` |
| 4 | Create production `.env` | Full preflight table (step 5a) passes |
| 5 | Create external DB / backup directories | Writable by the service account |
| 6 | Install / configure process supervisor | One instance, auto-restart |
| 7 | Install / configure reverse proxy | `nginx -t` / `caddy validate` passes |
| 8 | Configure DNS / TLS | Certificate valid, chain trusted |
| 9 | Verify backend loopback binding | Server log shows `bound to 127.0.0.1` |
| 10 | Verify proxy | `/`, an SPA route, and `/api/health` all respond |
| 11 | **Create a verified production backup** | Backup safety gate (18a) passes |
| 12 | Run `npx prisma db push` | DB safety gate (6a) — all 6 checks pass |
| 13 | Start the application | Startup log shows SQLite ready + listening |
| 14 | **Create production ADMIN** (strong password) | Step 12a — seed **not** used |
| 15 | Verify login / logout | Login persists across a refresh; logout → 401 |
| 16 | Verify dashboard / recipients / messages / campaigns / history | Each loads real data |
| 17 | Configure OpenWA | Settings → WhatsApp shows configured |
| 18 | Verify OpenWA webhook | Bad signature rejected (fails closed) |
| 19 | Configure Google Apps Script | `/exec` URL, token matches |
| 20 | Verify Google sync | Ping + small sync succeed |
| 21 | **Controlled WhatsApp test** | One deliberate test message only |
| 22 | Verify delivery / history | Status recorded, history entry correct |
| 23 | **Enable scheduled backups** | `BACKUP_SCHEDULE_ENABLED=true` confirmed |
| 24 | Final production smoke test | Full pass, then monitor |

> Steps 11 and 12 are a deliberate order: **back up before touching the schema**.
> Step 14 comes after start-up because creating the first ADMIN needs a running
> server.
> to deploy in place or use an NTFS junction.