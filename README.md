# Japa Message CMS

A local-first web dashboard for managing recipients, creating messaging campaigns, scheduling them, and tracking campaign/job status.

## Setup Instructions (Phase 1)

1. **Install Dependencies**
   From the root folder, run:
   ```bash
   npm install
   ```
   *Note: This will install dependencies for both the frontend (web) and backend (server) using npm workspaces.*

2. **Configure Environment**
   Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
   Update the variables if needed.

3. **Database Setup**
   Run the Prisma migrations to initialize the SQLite database:
   ```bash
   npx prisma db push
   ```

4. **Seed Initial Admin User (Manual for now)**
   Create an initial admin user in the database to log in. You can use Prisma Studio:
   ```bash
   npx prisma studio
   ```

5. **Start Application**
   Run the development servers:
   ```bash
   npm run dev
   ```
   - Frontend: http://localhost:5173
   - Backend: http://localhost:3000

## Security and sessions

The server uses HTTP-only, SameSite-strict session cookies, a configurable session lifetime, Argon2 password hashing, login attempt throttling, audit logging, security response headers, and configurable CORS. Set a unique `SESSION_SECRET` of at least 32 characters in production. The development server generates a temporary secret when none is configured.

The session store is currently **memory-based** (express-session default). Sessions are therefore **lost on server restart** and are **not shared between server processes**. Production deployment should use an appropriate persistent/shared session store (e.g. Redis, PostgreSQL) if multiple server instances are introduced.

### Security-related environment variables

Security behavior is controlled via the following environment variables (see `.env.example` for full list):

- `SESSION_SECRET` — session signing secret (at least 32 characters)
- `SESSION_MAX_AGE_MS` — session lifetime in milliseconds
- `CORS_ORIGIN` — allowed browser origin for authenticated requests
- `LOGIN_MAX_ATTEMPTS` — failed login attempts before lockout
- `LOGIN_WINDOW_MS` — time window for login attempt counting
- `LOGIN_LOCKOUT_MS` — duration of lockout after exceeding max attempts
- `WHATSAPP_PROVIDER` — WhatsApp provider (`none`, `official`, or `openwa`)
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN` — webhook verification token
- `WHATSAPP_APP_SECRET` — webhook HMAC signing secret
- `WHATSAPP_OPENWA_WEBHOOK_SECRET` — OpenWA webhook HMAC-SHA256 signing secret; required to enable the endpoint (empty or missing fails closed)

### OpenWA provider (unofficial — opt-in, foundation only)

[OpenWA](https://github.com/rmyndharis/OpenWA) is a self-hosted, **unofficial** WhatsApp API gateway (it drives a linked WhatsApp account rather than the official Meta Cloud API). It is an alternative provider for this CMS, not a supported/recommended one, and it is **disabled unless explicitly selected**.

Status in this phase (Phase 7.4 — OpenWA wired into campaign delivery):

- Provider selection supports `none` (default), `official` (Meta Cloud API, unchanged) and `openwa`.
- `openwa` is selected only with `WHATSAPP_PROVIDER=openwa`; it is never the default.
- Campaign/queue delivery follows provider selection. With `WHATSAPP_PROVIDER=openwa` (and a configured API key + session id) the execution delivery service and the queue worker resolve the OpenWA adapter through the existing provider registry and use its existing `sendText`/`sendMedia` implementation. That path uses the immutable execution snapshot phone/message, preserves the returned OpenWA `messageId` as `providerMessageId`, and keeps the existing retry/error classification.
- `WHATSAPP_PROVIDER=none` (default) keeps the safe "provider not configured" adapter and never contacts a provider; `WHATSAPP_PROVIDER=official` keeps the Meta Cloud API behaviour exactly as before.
- Local media is never uploaded and local storage is never made publicly reachable: OpenWA's `send-image` endpoint takes a URL that OpenWA fetches itself, so an image send requires an externally reachable media URL. A local-only `storagePath` is rejected.

### OpenWA delivery-status webhook (Phase 7.3+)

When the CMS sends messages through OpenWA and the webhook endpoint is configured, OpenWA can POST delivery-status events back to the CMS.

**Japa CMS webhook endpoint (local):**

```
POST http://localhost:3000/api/webhooks/whatsapp/openwa
```

**Local networking notes:**

- Japa CMS runs on port `3000` by default (configurable via `PORT`).
- When OpenWA runs **locally on the same Windows host** (not inside Docker), the webhook URL is `http://localhost:3000/api/webhooks/whatsapp/openwa`.
- When OpenWA runs **inside Docker**, `localhost` inside the container refers to the container itself, not the Windows host. Docker-to-host connectivity then requires a host-access mechanism such as `host.docker.internal` (Docker Desktop for Windows) or a shared Docker network if both services are containerized. The exact URL depends on the Docker runtime configuration.
- The OpenWA webhook registration endpoint (used by OpenWA to register this CMS URL as a receiver) cannot be confirmed until the local OpenWA instance is running and reachable. No webhook has been registered yet in this phase.
- `WHATSAPP_OPENWA_WEBHOOK_SECRET` is required to enable this endpoint. When set, OpenWA must sign each POST body with HMAC-SHA256 and send the signature in `X-OpenWA-Signature: sha256=<hex>`. When empty or missing, the endpoint fails closed (`503 WEBHOOK_NOT_CONFIGURED`) and processes no event.

**Webhook secret:**

- `WHATSAPP_OPENWA_WEBHOOK_SECRET` is required to enable this endpoint. When set, OpenWA must sign each POST body with HMAC-SHA256 and send the signature in `X-OpenWA-Signature: sha256=<hex>`. When empty or missing, the endpoint fails closed (`503 WEBHOOK_NOT_CONFIGURED`) and processes no event.

Required environment variables (see `.env.example`; empty values are placeholders only):

- `WHATSAPP_OPENWA_BASE_URL` — base URL of the OpenWA instance, without the `/api` prefix (defaults to `http://localhost:2785`)
- `WHATSAPP_OPENWA_API_KEY` — OpenWA API key (sent as the `X-API-Key` header; never logged, never returned by an API response, never included in an error message)
- `WHATSAPP_OPENWA_SESSION_ID` — OpenWA session id (environment-specific; never hard-coded)

OpenWA is used for campaign/queue delivery whenever `WHATSAPP_PROVIDER=openwa` is configured; there is no separate sending switch. Set `WHATSAPP_PROVIDER=none` to disable delivery again.

`GET /api/whatsapp/status` (authenticated) reports a safe OpenWA summary when `WHATSAPP_PROVIDER=openwa`: the base URL, the API prefix, a masked session id, whether an API key is configured, and a connection verification that is healthy only when the OpenWA session reports `ready` with no connection error. The API key is never returned.

OpenWA is used at the operator's own risk: it is an unofficial integration and may lead to WhatsApp account restrictions.

### Backup & Recovery

The application includes a local-first backup and recovery subsystem that protects the SQLite database, uploaded media, and backup metadata without relying on cloud providers or paid services.

- **Backup directory:** `storage/backups` (configurable via `BACKUP_DIR`)
- **Archive format:** `backup-<timestamp>.tar.gz` containing a `backup-manifest.json`, a `database/` folder with the SQLite file, and a `media/` folder with uploaded files
- **Integrity:** SHA-256 checksums are recorded in the manifest and written as a `.sha256` sidecar file alongside each archive
- **Scheduling:** Automatic backups can be enabled with `BACKUP_SCHEDULE_ENABLED=true` and run at `BACKUP_INTERVAL_HOURS` (default 24). Backups are off by default.
- **Retention:** Configured via `BACKUP_RETENTION_COUNT` (default 10). Only the newest N valid backups are kept.
- **Restore safety:** Restore validates the backup, verifies checksums and archive structure, rejects unsafe paths, and creates a fresh safety backup of the current state before replacing anything. Restore never silently destroys the current database.
- **API:** Authenticated endpoints at `/api/backups` support create, list, verify, restore, and delete operations. The restore endpoint requires explicit confirmation.
- **Settings UI:** A Backup & Recovery section in the Settings page exposes backup status, last backup time, backup count, and provides Create / Verify / Restore actions.
- **Audit logging:** Security-relevant backup operations (create, verify, restore start/complete/fail, delete, retention cleanup) are recorded through the existing audit service. No tokens, passwords, secrets, or archive contents are logged.

To create a backup manually:

```bash
curl -X POST http://localhost:3000/api/backups -b cookies.txt
```

To restore from a backup (requires confirmation):

```bash
curl -X POST http://localhost:3000/api/backups/<backup-id>/restore -b cookies.txt -H "Content-Type: application/json" -d '{"confirm": true}'
```

Do not copy the SQLite database file directly while the application is running. Use the backup API instead, which produces a consistent snapshot.

### Secrets and repository hygiene

- No secrets or credentials are committed to this repository
- All secrets live in `.env` (gitignored) or server environment variables
- `.env` and `.env.*` (except `.env.example`) are in `.gitignore`
- `.env.example` contains only placeholder values

For drifted local SQLite databases, use additive schema synchronization rather than destructive resets:

```bash
npx prisma generate --schema=prisma/schema.prisma
npx prisma db push --schema=prisma/schema.prisma --skip-generate
```

### Google Sheets manual sync (Phase 6.0B — Apps Script bridge, no Google Cloud billing)

Manual "Sync Now" only — no automatic or scheduled sync. Flow:

Google Form → Google Sheet (private) → Google Apps Script Web App → CMS

The Sheet stays private. The owner's Apps Script runs as the owner, reads the
response tab, and returns `{ Name, WhatsApp Number, consent, timestamp }` as
JSON. The endpoint is protected by a shared secret:

- Apps Script Script Properties key `CMS_SHARED_SECRET`
- CMS local `.env` key `GOOGLE_APPS_SCRIPT_TOKEN`
- CMS also needs `GOOGLE_APPS_SCRIPT_URL` (the `/exec` Web App URL)
- Display-only labels (no secrets): `GOOGLE_SHEETS_SPREADSHEET_ID`, `GOOGLE_SHEETS_TAB_NAME`

Copy `.env.example` values into local `.env` (never commit them), restart the
server, open Settings → Google Sheets, press "Connect / Configure" (Verify),
then "Sync Now".

Behavior: only rows with consent "Yes" are imported; phone numbers use the
existing normalization; existing phones update name/phone/consent instead of
duplicating. Endpoints: `GET /api/google-sheets/status`,
`POST /api/google-sheets/verify`, `POST /api/google-sheets/sync` (all authenticated).
The token is never logged and never returned to the frontend.

Full Apps Script deploy steps: see `docs/google-apps-script-setup.md`.
The exact script to paste is `apps/server/src/services/google-apps-script.bridge.gs`.

