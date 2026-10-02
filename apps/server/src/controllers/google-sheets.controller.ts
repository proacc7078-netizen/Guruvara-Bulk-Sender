import { RequestHandler } from 'express';
import { recordAuditSafe } from '../services/audit.service';
import { getSheetsStatus, publicStatus, runSyncNow, verifySheetsConnection } from '../services/google-sync.service';

// Phase 6.0B — authenticated Google Sheets endpoints (Apps Script bridge, manual sync only).
// Never returns secrets; error messages are sanitized.

export const getGoogleSheetsStatus: RequestHandler = async (req, res) => {
  try {
    const s = getSheetsStatus();
    return res.json({
      success: true,
      data: {
        ...publicStatus(),
        missing: s.configured ? [] : ['SET_IN_ENVIRONMENT'],
      },
    });
  } catch {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to read Google Sheets status' } });
  }
};

export const verifyGoogleSheets: RequestHandler = async (req, res) => {
  try {
    const result = await verifySheetsConnection();
    recordAuditSafe('GOOGLE_SHEETS_VERIFY', req, { ok: result.ok });
    if (result.ok) return res.json({ success: true, data: result });
    return res.status(502).json({ success: false, error: { code: 'GOOGLE_SHEETS_VERIFY_FAILED', message: result.message } });
  } catch {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Verification failed' } });
  }
};

export const syncGoogleSheetsNow: RequestHandler = async (req, res) => {
  try {
    const summary = await runSyncNow();
    recordAuditSafe('GOOGLE_SHEETS_SYNC', req, {
      rowsRead: summary.rowsRead,
      newRecipients: summary.newRecipients,
      updatedRecipients: summary.updatedRecipients,
      skippedNoConsent: summary.skippedNoConsent,
      invalidRows: summary.invalidRows,
    });
    return res.json({ success: true, data: { summary } });
  } catch (err) {
    const e = err as { message?: string; statusCode?: number };
    const msg = e?.message ?? 'SYNC_FAILED';
    const status = e?.statusCode ?? 500;
    if (msg.startsWith('NOT_CONFIGURED')) {
      return res.status(409).json({ success: false, error: { code: 'GOOGLE_SHEETS_NOT_CONFIGURED', message: 'Google Sheets sync is not configured. Set the environment variables first.' } });
    }
    if (msg === 'INVALID_APPS_SCRIPT_URL') {
      return res.status(400).json({ success: false, error: { code: msg, message: 'Configured Apps Script URL is invalid.' } });
    }
    if (msg === 'GOOGLE_AUTH_FAILED' || msg === 'GOOGLE_API_ERROR') {
      return res.status(502).json({ success: false, error: { code: msg, message: 'Google Sheets request failed. Please try again.' } });
    }
    if (msg === 'UNEXPECTED_COLUMNS' || msg === 'APPS_SCRIPT_BAD_RESPONSE') {
      return res.status(502).json({ success: false, error: { code: 'UPSTREAM_FORMAT_ERROR', message: 'Apps Script response did not match the expected Name / WhatsApp Number / consent layout.' } });
    }
    return res.status(status).json({ success: false, error: { code: 'SYNC_FAILED', message: 'Google Sheets sync failed.' } });
  }
};
