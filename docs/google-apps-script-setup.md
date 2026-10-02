# Google Apps Script bridge setup (Phase 6.0B)

No Google Cloud project, no billing, no service account. The Google Sheet
stays **private** — only the sheet owner's Apps Script can read it, and the CMS
calls that script with a shared secret.

Flow:

Google Form → Google Sheet (private) → Apps Script Web App → CMS

## 1. Create the form + sheet (5 min)

1. Create a Google Form with exactly these questions:
   - `Name` (short answer, required)
   - `WhatsApp Number` (short answer, required)
   - `I agree to receive WhatsApp updates from JAPA` — answers must be
     `Yes` / `No` (multiple choice or dropdown, required). Only `Yes` rows
     are ever imported.
2. Open the Form's **Responses** tab → **Link to Sheets** (creates the
   response spreadsheet). Keep the tab name (default `Form Responses 1`).
3. Keep the spreadsheet **private** (do NOT set "Anyone with the link").

## 2. Add the bridge script (5 min)

1. In the response spreadsheet: **Extensions → Apps Script**.
2. Delete any starter code and paste the full contents of:
   `apps/server/src/services/google-apps-script.bridge.gs`
3. If your response tab is not named `Form Responses 1`, edit the
   `SHEET_TAB_NAME` variable at the top of the script to match.
4. Save (Ctrl+S / Cmd+S).

Expected script contract (already implemented in that file):

- `doGet(e)` requires `?token=<shared-secret>` and returns 401-style
  `{ success: false, error: 'UNAUTHORIZED' }` without it.
- `GET <exec-url>?token=<secret>&action=ping` →
  `{ success: true, message: 'Apps Script bridge reachable.' }`
- `GET <exec-url>?token=<secret>` →
  `{ success: true, headers: [...], tabName: '...', rows: [{ timestamp, name, whatsappNumber, consent }] }`

## 3. Store the shared secret (2 min)

1. In the Apps Script editor: **Project Settings (gear icon) → Script
   Properties → Add script property**:
   - Property: `CMS_SHARED_SECRET`
   - Value: a long random string (e.g. 32+ characters). Generate one with:
     `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
2. Keep a copy of that exact value — it becomes `GOOGLE_APPS_SCRIPT_TOKEN`
   in the CMS `.env` below. Either side mismatching causes Verify to report
   "rejected the shared secret".

## 4. Deploy as Web App (3 min)

1. In Apps Script: **Deploy → New deployment → type: Web app**.
2. Settings:
   - **Description:** e.g. `JAPA CMS sheets bridge`
   - **Execute as:** `Me` (the spreadsheet owner — this is what keeps the
     sheet private while still readable by the script)
   - **Who has access:** `Anyone` — note: this is required for the CMS server
     to reach the URL, but the URL alone is useless without the shared
     secret; every request without the correct `?token=` gets `UNAUTHORIZED`
     and no sheet data.
3. Click **Deploy**, authorize when prompted, and copy the **Web app URL**
   (looks like `https://script.google.com/macros/s/<id>/exec`).
4. If you ever edit the script later: **Deploy → Manage deployments → Edit
   → New version** so the `/exec` URL serves the new code.

## 5. Configure the CMS (2 min)

In `japa-message-cms/.env` (never commit real values):

```env
GOOGLE_APPS_SCRIPT_URL=https://script.google.com/macros/s/<id>/exec
GOOGLE_APPS_SCRIPT_TOKEN=<the same CMS_SHARED_SECRET value>
GOOGLE_SHEETS_SPREADSHEET_ID=<optional display label from the sheet URL>
GOOGLE_SHEETS_TAB_NAME=Form Responses 1
```

Then restart the CMS server.

## 6. Verify + Sync Now

1. Open the CMS → **Settings → Google Sheets**.
2. `Connection status` should read `CONFIGURED` (it reads only env presence,
   never the token value).
3. Press **Connect / Configure** (Verify): the CMS calls
   `?action=ping` with the token. Success means URL + secret both match.
4. Press **Sync Now**: imports only `Yes`-consent rows, normalizes phones,
   creates new recipients or updates existing ones by normalized phone.
5. Troubleshooting:
   - "Missing configuration" → `GOOGLE_APPS_SCRIPT_URL` or
     `GOOGLE_APPS_SCRIPT_TOKEN` is empty in `.env`, or the server was not
     restarted after editing it.
   - "rejected the shared secret" → the `.env` token does not equal the
     Script Property `CMS_SHARED_SECRET` (check for trailing spaces).
   - "Could not reach the Apps Script web app" → the deployment is not a
     `New version`, the URL is a `/dev` URL, or access is not `Anyone`.
   - Empty sync (0 rows) → form has no responses yet, or the tab name in
     `SHEET_TAB_NAME` does not match the real tab.

## Security notes

- The Google Sheet is never shared publicly and never shared with a service
  account; only the owner's script reads it.
- The shared secret travels as `?token=` because Apps Script Web Apps cannot
  reliably read the `Authorization` header. It is sent server-to-server over
  HTTPS only — never rendered in the CMS UI, never put in a sheet cell.
- CMS endpoints (`/api/google-sheets/*`) require login and never return the
  token; see `test-6-0b.cjs` for the regression coverage.
