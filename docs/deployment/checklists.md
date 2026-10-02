# Production Checklists

Copy these into your deployment ticket and tick them off. Reference material
only — nothing here was executed against a production system.

---

## A. Environment checklist

Full template: [`production.env.example`](production.env.example).

### Required — the server misbehaves without these

- [ ] `NODE_ENV=production` — **the single most important value.** Unset means
      `cookie.secure=false` **and no HSTS**
- [ ] `HOST=127.0.0.1` — unset leaves Express listening on **all interfaces**
- [ ] `PORT=3000` — must match the proxy's upstream
- [ ] `DATABASE_URL` — **absolute** `file:` path; parent directory exists and is
      writable
- [ ] `SESSION_SECRET` — ≥ 32 characters, high entropy, unique per deployment.
      The process **throws at startup** if absent/short in production
- [ ] `CORS_ORIGIN=https://<your-host>` — the shipped default
      `http://localhost:5173` makes every browser API call fail CORS
- [ ] `BACKUP_DIR` — absolute, outside the application tree
- [ ] `BACKUP_SCHEDULE_ENABLED=true` — default is `false` and fails silently

### Required for the features you actually use

- [ ] `WHATSAPP_PROVIDER=openwa`
- [ ] `WHATSAPP_OPENWA_BASE_URL` — without the `/api` suffix; note the **silent
      fallback to `http://localhost:2785`** if unset
- [ ] `WHATSAPP_OPENWA_API_KEY` and `WHATSAPP_OPENWA_SESSION_ID` — both
      required; the CMS throws `WHATSAPP_CONFIGURATION_INVALID` without them
- [ ] `WHATSAPP_OPENWA_WEBHOOK_SECRET` — enables the OpenWA webhook; unset ⇒
      `503 WEBHOOK_NOT_CONFIGURED`
- [ ] `MEDIA_PUBLIC_BASE_URL` — reachable **from OpenWA**; unset ⇒ images are
      silently omitted from messages
- [ ] `MEDIA_PUBLIC_TOKEN_SECRET` — unset ⇒ public media fails closed (404)
- [ ] `GOOGLE_APPS_SCRIPT_URL` — must end in **`/exec`**
- [ ] `GOOGLE_APPS_SCRIPT_TOKEN` — must match the Apps Script
      `CMS_SHARED_SECRET` Script Property

### Optional tuning (defaults are reasonable)

- [ ] `SESSION_MAX_AGE_MS` (default 24 h)
- [ ] `LOGIN_MAX_ATTEMPTS` / `LOGIN_WINDOW_MS` / `LOGIN_LOCKOUT_MS`
      (5 / 15 min / 15 min)
- [ ] `SCHEDULER_POLL_INTERVAL_MS` (60 s), `SCHEDULER_BATCH_SIZE` (25)
- [ ] `WORKER_POLL_INTERVAL_MS` (5 s)
- [ ] `WHATSAPP_MAX_RETRIES` (3)
- [ ] `BACKUP_INTERVAL_HOURS` (24), `BACKUP_RETENTION_COUNT` (10)
- [ ] `SQLITE_JOURNAL_MODE=delete` — **keep `delete`**; do not enable `wal`

### Known silent-fallback variables (no startup error, wrong behaviour later)

| Variable | Falls back to | Symptom if unset |
|---|---|---|
| `NODE_ENV` | development | Insecure cookies, no HSTS |
| `CORS_ORIGIN` | `http://localhost:5173` | Every browser API call rejected |
| `WHATSAPP_OPENWA_BASE_URL` | `http://localhost:2785` | Sends to the wrong host |
| `SESSION_SECRET` (dev only) | random per boot | Sessions die on every restart |
| `MEDIA_PUBLIC_BASE_URL` | `''` | Images silently missing from messages |
| `GOOGLE_APPS_SCRIPT_*` | `''` | Sync fails only when invoked |
| `BACKUP_SCHEDULE_ENABLED` | `false` | No backups, ever |
---

## B. Security checklist

### Runtime / network

- [ ] `NODE_ENV=production`
- [ ] `HOST=127.0.0.1` — the Express port is **not** publicly reachable
- [ ] Firewall: only 80/443 open; **3000 is loopback-only**
- [ ] HTTPS terminated at the reverse proxy
- [ ] `X-Forwarded-Proto` sent by the proxy (verified by a successful login)
- [ ] `CORS_ORIGIN` is the production origin
- [ ] HSTS is emitted (when `NODE_ENV=production`) — confirm HTTPS works
      **before** relying on it, since HSTS can lock out plain HTTP for up to a
      year

### Cookies and sessions (set by the application — verify, do not reconfigure)

- [ ] `HttpOnly` ✅
- [ ] `Secure` ✅ (only when `NODE_ENV=production`)
- [ ] `SameSite=Strict` ✅ — requires SPA and API on the **same origin**
- [ ] `SESSION_SECRET` unique, ≥ 32 chars, high entropy, never committed
- [ ] Accepts that **MemoryStore** forces a single process and loses sessions
      on restart

### Secrets

- [ ] OpenWA API key never logged; `GET /api/whatsapp/status` returns only
      `apiKeyConfigured` and a **masked** session id
- [ ] `WHATSAPP_OPENWA_WEBHOOK_SECRET` configured
- [ ] `MEDIA_PUBLIC_TOKEN_SECRET` configured
- [ ] Logs contain **no** tokens, passwords or `SESSION_SECRET`
- [ ] `.env` is git-ignored and never committed
- [ ] Real values never pasted into tickets, chat or screenshots

### Filesystem

- [ ] Production **database outside** the replaceable application directory
- [ ] **Backup directory outside** the replaceable application directory
- [ ] Service account has **minimum** rights: read/write on the persistent data
      directories only, not Administrator
- [ ] Logs written outside the application tree, with rotation
- [ ] The application directory is **never moved** after first deploy
      (`Media.storagePath` stores absolute paths — see `README.md` §C.3)

### Process

- [ ] Exactly **one** instance: no `cluster`, no `instances > 1`, no `--scale`
- [ ] Automatic restart configured (NSSM `AppExit Default Restart` / PM2
      `autorestart`)
- [ ] Only one `node.exe ... apps/server/dist/index.js` after start
---

## C. Google Sheets operational checklist

Setup detail: [`../google-apps-script-setup.md`](../google-apps-script-setup.md).

- [ ] Apps Script project is deployed as a **Web App**
- [ ] **Execute as: Me** (the Sheet owner's account)
- [ ] Deployment access permits the CMS to call it
- [ ] `GOOGLE_APPS_SCRIPT_URL` is the **deployed `/exec`** URL
- [ ] ❌ **Never** a `/dev` URL — the shared secret is exposed in page source
- [ ] `GOOGLE_APPS_SCRIPT_TOKEN` matches the Apps Script Script Property named
      **`CMS_SHARED_SECRET`**
- [ ] The deployment URL is recorded — redeploying Apps Script creates a **new**
      URL and silently breaks sync
- [ ] The Sheet stays **private**; access is via the bridge only

### Behaviour to be aware of

- [ ] Sync is **idempotent** — phone-number deduplication means a repeat run
      updates rather than duplicates
- [ ] Blank Sheet values **preserve** the existing CMS value
- [ ] Rows without consent are skipped
- [ ] **Partial writes are possible** if a run fails midway — safe, because a
      re-run converges
- [ ] Missing language/columns remain backward-compatible
- [ ] A bad URL is a **runtime** error, not a startup error
- [ ] Requests time out after **20 s** (Pass 3) and return
      `APPS_SCRIPT_NETWORK_ERROR`

---

## D. Webhook operational checklist

For `POST /api/webhooks/whatsapp/openwa`.

- [ ] Public HTTPS URL reachable **from OpenWA**
- [ ] Proxy forwards the request with the **method `POST`** intact
- [ ] `Content-Type: application/json` reaches Express unchanged
- [ ] Request body arrives **byte-for-byte**
- [ ] `X-OpenWA-Signature` header forwarded untouched
- [ ] No body rewriting, re-serialisation or decompression at the proxy
- [ ] `gzip` disabled on the webhook location
- [ ] Caching disabled for that path
- [ ] Body limit ≥ 1 MB (the Express limit); 10 MB globally is fine
- [ ] `WHATSAPP_OPENWA_WEBHOOK_SECRET` set on **both** sides
- [ ] Endpoint is **not** reachable without the secret (it fails closed `503`)

**Do not test this against the real OpenWA service.** Changing the route or
transforming the body breaks HMAC verification; see
[`reverse-proxy/README.md`](reverse-proxy/README.md) §3.

---

## E. Pre-launch gate

Do not launch until **every** box above is ticked and:

- [ ] A **verified backup exists** before the first production deploy
- [ ] Step 6 executed with the decided strategy (**Option B** —
      `npx prisma db push`), preceded by a verified backup and followed by
      application verification
- [ ] The backup from step 6 is retained for rollback
- [ ] `runbook-deploy.md` steps 12–19 all pass on a staging hostname