/**
 * Phase 6.0B — Apps Script bridge client (no Google Cloud, no service account).
 *
 * The Google Sheet stays private. The owner's Apps Script Web App reads the
 * response tab and returns JSON. Auth is a shared secret stored in:
 * - Apps Script Script Properties (CMS_SHARED_SECRET)
 * - CMS local .env (GOOGLE_APPS_SCRIPT_TOKEN)
 *
 * The secret is sent as `?token=` (Apps Script cannot reliably read the
 * Authorization header). It is never logged or returned to the frontend.
 */

export interface AppsScriptConfig {
  url: string;
  token: string;
}

export interface AppsScriptRow {
  timestamp?: string;
  name?: string;
  whatsappNumber?: string;
  consent?: string;
}

export interface AppsScriptPayload {
  success: boolean;
  headers?: string[];
  tabName?: string;
  rows?: AppsScriptRow[];
  message?: string;
  error?: string;
}

export function getAppsScriptConfig(): AppsScriptConfig {
  return {
    url: (process.env.GOOGLE_APPS_SCRIPT_URL ?? '').trim(),
    token: (process.env.GOOGLE_APPS_SCRIPT_TOKEN ?? '').trim(),
  };
}

function withToken(url: string, token: string, extra: Record<string, string> = {}): string {
  const sep = url.includes('?') ? '&' : '?';
  const params = new URLSearchParams({ token, ...extra });
  return `${url}${sep}${params.toString()}`;
}

/**
 * Bounded request timeout for the Apps Script bridge, in milliseconds.
 *
 * An Apps Script Web App executes on Google's infrastructure and a cold start
 * can legitimately take several seconds, so this is deliberately generous;
 * 20000 ms still guarantees a sync request terminates rather than hanging for
 * the browser's own timeout. Node's undici fetch has no default request
 * timeout, so without this a hung bridge would pin the HTTP request open
 * indefinitely.
 */
const APPS_SCRIPT_TIMEOUT_MS = 20_000;

/**
 * Performs a bounded Apps Script request.
 *
 * A timeout is reported as the existing APPS_SCRIPT_NETWORK_ERROR code rather
 * than leaking an AbortError implementation detail to the UI, which preserves the
 * current error classification for callers and tests. The caller's own
 * `fetchImpl` and the `signal` it supplies are still honoured: the abort signal
 * we attach is additional, never a replacement.
 */
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, APPS_SCRIPT_TIMEOUT_MS);

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new Error('APPS_SCRIPT_NETWORK_ERROR');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(res: Response): Promise<AppsScriptPayload> {
  try {
    return (await res.json()) as AppsScriptPayload;
  } catch {
    throw new Error('APPS_SCRIPT_BAD_RESPONSE');
  }
}

export async function pingAppsScript(
  cfg: AppsScriptConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let res: Response;
  try {
    res = await fetchWithTimeout(fetchImpl, withToken(cfg.url, cfg.token, { action: 'ping' }), {
      method: 'GET',
    });
  } catch {
    throw new Error('APPS_SCRIPT_NETWORK_ERROR');
  }
  if (res.status === 401 || res.status === 403) throw new Error('APPS_SCRIPT_UNAUTHORIZED');
  if (!res.ok) throw new Error(`APPS_SCRIPT_HTTP_ERROR:${res.status}`);
  const data = await readJson(res);
  if (!data.success) {
    if (data.error === 'UNAUTHORIZED') throw new Error('APPS_SCRIPT_UNAUTHORIZED');
    throw new Error('APPS_SCRIPT_BAD_RESPONSE');
  }
}

export async function fetchAppsScriptRows(
  cfg: AppsScriptConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ headers: string[]; rows: AppsScriptRow[] }> {
  let res: Response;
  try {
    res = await fetchWithTimeout(fetchImpl, withToken(cfg.url, cfg.token), { method: 'GET' });
  } catch {
    throw new Error('APPS_SCRIPT_NETWORK_ERROR');
  }
  if (res.status === 401 || res.status === 403) throw new Error('APPS_SCRIPT_UNAUTHORIZED');
  if (!res.ok) throw new Error(`APPS_SCRIPT_HTTP_ERROR:${res.status}`);
  const data = await readJson(res);
  if (!data.success) {
    if (data.error === 'UNAUTHORIZED') throw new Error('APPS_SCRIPT_UNAUTHORIZED');
    throw new Error('APPS_SCRIPT_BAD_RESPONSE');
  }
  return { headers: data.headers ?? [], rows: data.rows ?? [] };
}
