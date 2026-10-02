import { prisma } from '../config/db';
import { fetchAppsScriptRows, getAppsScriptConfig, pingAppsScript } from './google-sheets.client';
import { classifyRow, emptySummary, SyncSummary } from './google-sync.mapper';

// Phase 6.0B — manual Apps Script bridge -> Recipient sync.
// Manual Sync Now only. Reuses Recipient model + normalizePhoneNumber via mapper.

export interface GoogleSheetsStatus {
  configured: boolean;
  spreadsheetId: string | null;
  sheetName: string | null;
  bridgeConfigured: boolean;
  missing: string[];
}

export function getSheetsStatus(): GoogleSheetsStatus {
  const spreadsheetId = (process.env.GOOGLE_SHEETS_SPREADSHEET_ID ?? '').trim() || null;
  const sheetName = (process.env.GOOGLE_SHEETS_TAB_NAME ?? 'Form Responses 1').trim() || 'Form Responses 1';
  const url = (process.env.GOOGLE_APPS_SCRIPT_URL ?? '').trim();
  const token = (process.env.GOOGLE_APPS_SCRIPT_TOKEN ?? '').trim();
  const missing: string[] = [];
  if (!url) missing.push('GOOGLE_APPS_SCRIPT_URL');
  if (!token) missing.push('GOOGLE_APPS_SCRIPT_TOKEN');
  return {
    configured: missing.length === 0,
    spreadsheetId,
    sheetName,
    bridgeConfigured: Boolean(url && token),
    missing,
  };
}

export function publicStatus(): Omit<GoogleSheetsStatus, 'missing'> & { connectionStatus: string } {
  const s = getSheetsStatus();
  return {
    configured: s.configured,
    spreadsheetId: s.spreadsheetId,
    sheetName: s.sheetName,
    bridgeConfigured: s.bridgeConfigured,
    connectionStatus: s.configured ? 'CONFIGURED' : 'NOT_CONFIGURED',
  };
}

function validBridgeUrl(url: string): boolean {
  return /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/(exec|dev)$/.test(url)
    || /^https:\/\/script\.googleusercontent\.com\//.test(url);
}

export async function verifySheetsConnection(fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; message: string }> {
  const status = getSheetsStatus();
  if (!status.configured) return { ok: false, message: `Missing configuration: ${status.missing.join(', ')}` };
  const cfg = getAppsScriptConfig();
  if (!validBridgeUrl(cfg.url)) return { ok: false, message: 'Configured Apps Script URL looks invalid.' };
  try {
    await pingAppsScript(cfg, fetchImpl);
    return { ok: true, message: 'Connected to Google Sheet via Apps Script.' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'UNKNOWN';
    if (msg === 'APPS_SCRIPT_UNAUTHORIZED') return { ok: false, message: 'Apps Script rejected the shared secret. Check GOOGLE_APPS_SCRIPT_TOKEN.' };
    if (msg === 'APPS_SCRIPT_NETWORK_ERROR') return { ok: false, message: 'Could not reach the Apps Script web app. Check the URL and deployment.' };
    return { ok: false, message: 'Apps Script bridge error. Please try again.' };
  }
}

export async function runSyncNow(fetchImpl: typeof fetch = fetch): Promise<SyncSummary> {
  const status = getSheetsStatus();
  if (!status.configured) {
    throw Object.assign(new Error(`NOT_CONFIGURED:${status.missing.join(',')}`), { statusCode: 409 });
  }
  const cfg = getAppsScriptConfig();
  if (!validBridgeUrl(cfg.url)) {
    throw Object.assign(new Error('INVALID_APPS_SCRIPT_URL'), { statusCode: 400 });
  }
  let payload: {
    headers: string[];
    rows: Array<{ name?: string; whatsappNumber?: string; consent?: string; language?: string }>;
  };
  try {
    payload = await fetchAppsScriptRows(cfg, fetchImpl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'UNKNOWN';
    if (msg === 'APPS_SCRIPT_UNAUTHORIZED') {
      throw Object.assign(new Error('GOOGLE_AUTH_FAILED'), { statusCode: 502 });
    }
    throw Object.assign(new Error('GOOGLE_API_ERROR'), { statusCode: 502 });
  }
  const summary = emptySummary();
  if (!payload.rows || payload.rows.length === 0) return summary;
  for (let i = 0; i < payload.rows.length; i++) {
    const r = payload.rows[i];
    // rowsRead = rows fetched from Google Sheets, counted before any
    // classification so the summary reflects what was actually read.
    summary.rowsRead += 1;
    const decision = classifyRow({
      name: String(r.name ?? '').trim(),
      phone: String(r.whatsappNumber ?? '').trim(),
      consent: String(r.consent ?? '').trim(),
      language: String(r.language ?? '').trim(),
    });
    if (decision.kind === 'skip-consent') {
      summary.skippedNoConsent += 1;
      continue;
    }
    if (decision.kind === 'invalid') {
      summary.invalidRows += 1;
      summary.errors.push({ row: i + 2, reason: decision.reason });
      continue;
    }
    const existing = await prisma.recipient.findUnique({
      where: { normalizedPhone: decision.normalizedPhone },
    });
    if (existing) {
      const patch: Record<string, unknown> = {};
      if (existing.name !== decision.name) patch.name = decision.name;
      if (existing.whatsappNumber !== decision.rawPhone) patch.whatsappNumber = decision.rawPhone;
      if (existing.consentStatus !== 'GRANTED') patch.consentStatus = 'GRANTED';
      if (!existing.consentTimestamp) patch.consentTimestamp = new Date();
      // Language from the sheet. A BLANK sheet value must never erase an
      // existing language the operator already set in the CMS.
      if (decision.language && existing.language !== decision.language) {
        patch.language = decision.language;
      }
      if (Object.keys(patch).length > 0) {
        await prisma.recipient.update({ where: { id: existing.id }, data: patch });
      }
      summary.updatedRecipients += 1;
    } else {
      await prisma.recipient.create({
        data: {
          name: decision.name,
          whatsappNumber: decision.rawPhone,
          normalizedPhone: decision.normalizedPhone,
          // Written only when the sheet actually supplied one; left undefined so
          // the column keeps its existing default rather than storing "".
          ...(decision.language ? { language: decision.language } : {}),
          status: 'ACTIVE',
          source: 'GOOGLE_SHEETS',
          consentStatus: 'GRANTED',
          consentTimestamp: new Date(),
        },
      });
      summary.newRecipients += 1;
    }
  }
  return summary;
}
