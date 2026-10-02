// Node's native TypeScript loader requires explicit extensions on relative
// imports; Vite handles this too (allowImportingTsExtensions is enabled).
import type { ImportRow } from './importMapping.util.ts';
import { getRowDecision } from './importSelection.util.ts';
import type { ImportSelection } from './importSelection.util.ts';

/**
 * Step 12F — the confirm + import API client.
 *
 * The Step 12E selection is only USER INTENT: this module builds the request
 * for the authenticated import endpoint. It sends ONLY the rows the user
 * marked IMPORT; rows marked SKIP are never submitted. The server performs
 * the final safety check regardless of what is sent here.
 */
export type ImportRowPayload = {
  rowNumber: number;
  name: string;
  whatsappNumber: string;
  normalizedPhone: string;
  language: string | null;
  category: string | null;
  consentStatus: string | null;
  consentTimestamp: string | null;
  notes: string | null;
  source: string | null;
};

export type ImportRequestPayload = { rows: ImportRowPayload[] };

export type ImportRowResultStatus = 'CREATED' | 'SKIPPED' | 'FAILED';

export type ImportRowResult = {
  rowNumber: number;
  status: ImportRowResultStatus;
  name?: string;
  whatsappNumber?: string;
  normalizedPhone?: string;
  reason?: string;
};

export type ImportResultSummary = {
  total: number;
  created: number;
  skipped: number;
  failed: number;
};

export type ImportResult = {
  summary: ImportResultSummary;
  results: ImportRowResult[];
};

/** Builds the import request from the rows the user decided to IMPORT. */
export function buildImportPayload(
  rows: ImportRow[],
  selection: ImportSelection
): ImportRequestPayload {
  const selected: ImportRowPayload[] = [];
  for (const row of rows) {
    if (getRowDecision(selection, row) !== 'IMPORT') continue;
    selected.push({
      rowNumber: row.rowNumber,
      name: row.name,
      whatsappNumber: row.whatsappNumber,
      normalizedPhone: row.normalizedPhone ?? '',
      language: row.language || null,
      category: row.category || null,
      consentStatus: row.consentStatus || null,
      consentTimestamp: row.consentTimestamp || null,
      notes: row.notes || null,
      source: row.source || null,
    });
  }
  return { rows: selected };
}
