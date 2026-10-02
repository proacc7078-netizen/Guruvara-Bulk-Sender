# Japa Message CMS — Production Deployment Package

Reference configuration and operating procedure for running the CMS as a
single-server production deployment.

> **Status: reference material only.** Nothing in this directory installs,
> starts, or configures infrastructure. Every value below is a placeholder that
> the operator must substitute. No production system was created to produce it.

**Last updated:** Production Hardening Pass 4

---

## Contents

| File | Purpose |
|---|---|
| [`README.md`](README.md) | Topology, directory layout, hard constraints *(this file)* |
| [`reverse-proxy/nginx.conf`](reverse-proxy/nginx.conf) | nginx reference config (Linux + Windows) |
| [`reverse-proxy/Caddyfile`](reverse-proxy/Caddyfile) | Caddy reference config (automatic TLS) |
| [`reverse-proxy/README.md`](reverse-proxy/README.md) | Proxy requirements + webhook body-integrity checklist |
| [`process-supervisor/README.md`](process-supervisor/README.md) | Windows service supervision (NSSM) and PM2 |
| [`production.env.example`](production.env.example) | Production environment template (no secrets) |
| [`runbook-deploy.md`](runbook-deploy.md) | First-time deployment, step by step |
| [`runbook-operations.md`](runbook-operations.md) | Restart/crash behaviour + backup & restore runbook |
| [`checklists.md`](checklists.md) | Environment, security, Google Sheets, webhook checklists |

---

## B. Deployment topology

```
                     ┌───────────────────────────────────────────────┐
   Browser ──HTTPS──▶  Reverse proxy (nginx / Caddy / IIS)            │
                     │   • terminates TLS                             │
                     │   • serves  apps/web/dist   (React SPA)       │
                     │   • proxies /api/*  ─────────────┐            │
                     │   • preserves Host, adds        │            │
                     │     X-Forwarded-Proto/For        │            │
                     └─────────────────────────────────┼────────────┘
                                                       │ HTTP (loopback only)
                     ┌─────────────────────────────────▼────────────┐
                     │  Express CMS   —  EXACTLY ONE PROCESS         │
                     │  apps/server/dist/index.js                    │
                     │  • REST API  /api/*                            │
                     │  • webhooks   /api/webhooks/*  (raw body)      │
                     │  • express-session MemoryStore                 │
                     │  • CampaignSchedulerService   (setInterval)   │
                     │  • ExecutionQueueWorker       (setInterval)   │
                     │  • BackupScheduler                           │
                     │  • NO static file serving                     │
                     └───┬───────────────┬──────────────┬───────────┘
                         │               │              │
              DATABASE_URL (env)   <app>/storage/     BACKUP_DIR (env)
              <persistent>/db/       uploads/          <persistent>/
                japa.db              (FIXED PATH)       backups/
                         │               │              │
                    [PERSISTENT]    [PERSISTENT]    [PERSISTENT]

   External services (not hosted by this application):
     • OpenWA            — WhatsApp gateway. CMS calls it OUTBOUND.
                          OpenWA POSTs delivery status INBOUND to
                          /api/webhooks/whatsapp/openwa
     • Google Apps Script — deployed Web App, /exec URL, called OUTBOUND
```
---

## C. Production directory layout

### C.1 Replaceable application tree

These may be deleted and redeployed at any time:

```
<app>/
  apps/
    server/
      dist/                 # compiled server (apps/server/dist/index.js)
    web/
      dist/                 # built SPA  (index.html + /assets/*)
  prisma/
    schema.prisma           # required at runtime by the Prisma client
    migrations/             # NOT ignored by .gitignore (see Pass 1/3)
  node_modules/
  .env                      # production environment
  storage/
    uploads/                # ⚠️ PERSISTENT — see C.3
```

### C.2 Persistent data (outside the application tree)

```
<persistent-data>/        e.g. D:\japa-data  or  /var/lib/japa
  db/
    japa.db                # DATABASE_URL target
  backups/                 # BACKUP_DIR target
```

Configured via environment only:

```
DATABASE_URL=file:<persistent-data>/db/japa.db
BACKUP_DIR=<persistent-data>/backups
```

### C.3 ⚠️ Media uploads cannot be relocated by environment variable

This is a hard constraint of the current implementation and the single most
important packaging decision.

`apps/server/src/controllers/media.controller.ts` resolves the upload
directory by walking up from `__dirname`:

```ts
path.resolve(__dirname, '..', '..', '..', '..', 'storage', 'uploads')
```

`apps/server/src/services/backup/backup.paths.ts` does the same via
`repoRoot()`. **There is no `UPLOAD_DIR` / `STORAGE_DIR` environment variable**,
and none may be introduced casually — adding one changes application code and
the backup layout contract.

Consequences:

1. Uploads are **always** `<app>/storage/uploads`, whatever `.env` says.
2. `Media.storagePath` rows store **absolute filesystem paths**
   (for example `C:\Users\...\storage\uploads\abc.jpg`).
3. An existing populated deployment **must not be moved to a new filesystem
   path** without a deliberate migration/rewrite plan — every existing media
   row would point at a path that no longer exists and the UI would return
   404 "Media file no longer exists".

### C.4 Choosing a layout

| Approach | Use when | Trade-off |
|---|---|---|
| **A. Deploy in place** (recommended first deployment) | Starting from the current development directory | Simplest and zero-risk. `<app>` is never moved or wiped. Back up `<app>/storage/uploads` together with the DB. |
| **B. Junction the uploads dir** | `<app>` must be fully disposable | Create an NTFS **directory junction** from `<app>\storage\uploads` to `<persistent-data>\uploads`. Node's `fs` follows junctions transparently. **Only** on a fresh deployment with no existing media rows. |

> **Never** use option B on an already-populated database. Junctions change what
> an absolute path means between environments and will silently break rows
> written when the real directory lived elsewhere.
---

## D. Hard constraints that shape this package

| # | Constraint | Consequence |
|---|---|---|
| 1 | `express-session` uses **MemoryStore** | **Exactly one process.** No cluster mode, no `instances > 1`, no horizontal scaling. Sessions are lost on restart. |
| 2 | Express serves **no static files** (`GET /` → 404) | A reverse proxy serving `apps/web/dist` is **mandatory**, not optional. |
| 3 | Frontend uses `BrowserRouter` and relative `/api` URLs | The proxy must serve `index.html` for unknown paths (history fallback) **and** proxy `/api` on the **same origin** — otherwise `SameSite=Strict` cookies break. |
| 4 | `app.set('trust proxy', 1)` (Pass 3) | The proxy must send `X-Forwarded-Proto`. Exactly **one** hop is trusted. |
| 5 | `SQLITE_JOURNAL_MODE` defaults to `delete` (Pass 3) | Do **not** enable `wal` while the Windows restore path renames the live DB file — restore fails with `EBUSY`. |
| 6 | Scheduler + worker are in-process `setInterval` loops | A second process would double-send. One process only. |
| 7 | `repoRoot()` walks a fixed number of directories | The build must not be bundled or flattened. Keep `apps/server/dist/services/backup/backup.paths.js` at its compiled depth. |
| 8 | `Media.storagePath` is absolute | See C.3. |
| 9 | Startup performs **no** schema migration | Database initialisation is an explicit operator step. |

---

## E. Prerequisites

| Requirement | Notes |
|---|---|
| Node.js **LTS** (20.x or 22.x) | The project declares no `engines` field; Node 24 LTS is what this codebase was verified on. |
| A reverse proxy | nginx, Caddy, or IIS — see `reverse-proxy/` |
| A process supervisor | Windows Service via NSSM, or PM2 — see `process-supervisor/` |
| A TLS certificate | Obtained and installed by the operator. Not created by this package. |
| A hostname | DNS record pointing at the host. Not created by this package. |

---

## F. Related project documentation

- [`docs/google-apps-script-setup.md`](../google-apps-script-setup.md) — Apps Script bridge setup
- Pass 1 — migration/DB architecture investigation (decision still pending)
- Pass 2 — deployment/runtime investigation
- Pass 3 — runtime safety fixes (`trust proxy`, crash handlers, SQLite, timeouts)

---

## G. Database strategy decision

> **DECIDED — OPTION B: schema is synchronised with `npx prisma db push`.**
>
> No baseline migration was created and no migration history was repaired,
> squashed, rewritten or deleted. Rationale and the full operational rule are in
> [`runbook-deploy.md`](runbook-deploy.md) step 6.