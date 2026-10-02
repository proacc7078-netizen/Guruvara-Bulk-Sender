# Reverse Proxy — Requirements and Checklist

Reference material only. **No reverse proxy was installed, configured, or
started during this project's hardening passes.** These files are templates for
an operator to adapt.

- [`nginx.conf`](nginx.conf) — explicit configuration (Linux and Windows paths)
- [`Caddyfile`](Caddyfile) — minimal alternative with automatic TLS

Use **one** of them, not both.

---

## 1. Why a reverse proxy is mandatory

Verified during Pass 2 against the running application:

| Fact | Evidence |
|---|---|
| Express serves **no static files** | `GET /` on the Express port returns **404** |
| The frontend calls `/api/...` **relatively** | No `VITE_API_BASE_URL` exists anywhere |
| `vite.config.ts` proxies `/api` → `localhost:3000` | **Dev only**; absent from the production build |

Without a separate static server the CMS is unusable, and if the SPA were served
from a *different* origin than the API, the `SameSite=Strict` session cookie
would be dropped by the browser. **Serve the SPA and the API from the same
origin.**

---

## 2. Mandatory proxy behaviours

| # | Requirement | Why |
|---|---|---|
| 1 | Terminate HTTPS | `cookie.secure = (NODE_ENV === 'production')`; cookies must be issued over TLS |
| 2 | Send **`X-Forwarded-Proto: https`** | `app.set('trust proxy', 1)` reads `req.protocol` from it. **Omitting it means no `Set-Cookie` is ever emitted and nobody can log in.** |
| 3 | Send **`X-Forwarded-For`** | `LOGIN_*` brute-force lockout is scoped by client IP |
| 4 | Preserve the **`Host`** header | Correct absolute URL construction |
| 5 | Proxy **`/api/*`** to `127.0.0.1:3000` | All API and webhook traffic |
| 6 | Serve **`apps/web/dist`** | The SPA build |
| 7 | **History fallback** to `index.html` | `BrowserRouter` — a refresh on any route below must not 404 |
| 8 | **Byte-exact webhook bodies** | HMAC-SHA256 over raw bytes |
| 9 | Body limit **> 5 MB** | Media upload cap is 5 MB (`MAX_FILE_SIZE`) |
| 10 | Do **not** cache `index.html` | Otherwise browsers load stale asset hashes after a deploy |

### SPA routes requiring history fallback

`/login` · `/dashboard` · `/messages` · `/messages/new` · `/messages/:id/edit` ·
`/campaigns` · `/campaigns/new` · `/campaigns/:id/edit` · `/recipients` ·
`/recipients/import` · `/history` · `/settings` · `/users`

### Body-size limits used by the application

| Surface | Limit | Source |
|---|---|---|
| JSON API body | `1mb` | `express.json({ limit: '1mb' })` |
| Raw webhook body | `1mb` | `express.raw({ type:'application/json', limit:'1mb' })` |
| Media upload | `5 MB` | `multer` `MAX_FILE_SIZE` |

Set the proxy limit to **10 MB** for comfortable headroom.

---

## 3. Webhook body-integrity checklist

Applies to **`POST /api/webhooks/whatsapp/openwa`** (and
`POST /api/webhooks/whatsapp` for the Meta path).

Express mounts, **in this order** (`apps/server/src/index.ts`):

```ts
app.use('/api/webhooks', express.raw({ type: 'application/json', limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
```

The raw body exists **only** so `receiveOpenWAWebhook` can verify
`X-OpenWA-Signature: sha256=<hex>` against the exact request bytes.

### Operator checklist

- [ ] Method stays **`POST`** — no redirect that converts it to `GET`
- [ ] `Content-Type: application/json` reaches Express unchanged
- [ ] Request body reaches Express **byte-for-byte**
- [ ] **`X-OpenWA-Signature` header** is forwarded (no stripping, no renaming)
- [ ] No **request-body rewriting**, `request_body` directive, or re-serialisation
- [ ] No **request decompression** applied on the proxy
- [ ] `gzip` disabled on the webhook location (nginx: `gzip off;`)
- [ ] **Caching disabled** for the webhook path
- [ ] Body limit ≥ 1 MB (the Express limit) — currently 10 MB globally
- [ ] No authentication/stripping middleware in front of `/api/webhooks/`
- [ ] OpenWA can reach the public HTTPS URL from its own network

### Failure signature

If the body is altered, HMAC verification fails and OpenWA delivery-status
updates are **rejected**. If `WHATSAPP_OPENWA_WEBHOOK_SECRET` is unset the
endpoint **fails closed** with `503 WEBHOOK_NOT_CONFIGURED` — correct and safe,
but delivery statuses will never be applied.

**Do not test this against the real OpenWA service.**

---

## 4. Security headers

The application already sets these itself (`apps/server/src/index.ts`), so the
proxy must **not** remove or duplicate them:

`X-Content-Type-Options: nosniff` · `X-Frame-Options: DENY` ·
`X-XSS-Protection: 1; mode=block` · `Referrer-Policy: no-referrer` ·
`Permissions-Policy: camera=(), microphone=(), geolocation=()` ·
`Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`

Additionally, when `NODE_ENV=production`, Express emits:

`Strict-Transport-Security: max-age=31536000; includeSubDomains`

⚠️ **HSTS caution:** once a browser has seen this header for your hostname it
will refuse plain HTTP for `max-age` seconds. Do not enable it until HTTPS is
confirmed working, or users will be locked out for up to a year.

---

## 5. Validation without installing anything

Both references can be syntax-checked without a running server (operator action
on their own machine):

```bash
# nginx — parse only, does not start or bind ports
nginx -t -c /path/to/nginx.conf

# Caddy — parse only
caddy validate --config Caddyfile --adapter caddyfile
```

Neither command was executed for this package, because no proxy binary is
present on this host.

---

## 6. Placeholders to substitute

| Placeholder | Replace with |
|---|---|
| `cms.example.com` | Your production hostname (and `admin@example.com` for Caddy) |
| `<<REPLACE>>/apps/web/dist` | Absolute path to the built SPA on the proxy host |
| `<<REPLACE>>/fullchain.pem`, `privkey.pem` | Your TLS certificate and key |
| `127.0.0.1:3000` | The CMS process (must match `PORT` in `.env`) |