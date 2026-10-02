import { normalizePhoneNumber } from '../utils/phone.util';

// Phase 6.0B — pure row mapping / classification for Google Sheets sync.
// Name -> name, WhatsApp Number -> phone, consent column -> consent.
// Only consent "Yes" is imported. Reuses existing phone normalization.

export interface SheetRowInput {
  name: string;
  phone: string;
  consent: string;
  /** Preferred language from the sheet ("Preferred Language to Receive Updates").
   * Optional so existing callers/tests that omit it keep working. */
  language?: string;
}

export type RowDecision =
  | { kind: 'import'; name: string; rawPhone: string; normalizedPhone: string; language?: string }
  | { kind: 'skip-consent' }
  | { kind: 'invalid'; reason: string };

function parseHeader(headers: string[]): { nameIdx: number; phoneIdx: number; consentIdx: number; languageIdx: number } {
  const norm = headers.map((h) => String(h ?? '').trim().toLowerCase());
  let nameIdx = norm.findIndex((h) => h === 'name');
  let phoneIdx = norm.findIndex((h) => h === 'whatsapp number' || h === 'whatsapp' || h === 'phone');
  let consentIdx = norm.findIndex((h) => h.startsWith('i agree'));
  if (consentIdx === -1) consentIdx = norm.findIndex((h) => h === 'consent' || h.includes('consent'));
  // The Google Form writes "Preferred Language to Receive Updates". Matched
  // loosely so a reworded question still resolves. Optional: -1 simply means the
  // sheet has no language column and none is imported.
  let languageIdx = norm.findIndex((h) => h.includes('language'));
  return { nameIdx, phoneIdx, consentIdx, languageIdx };
}

export function mapValuesToRow(headers: string[], values: string[]): SheetRowInput | null {
  const { nameIdx, phoneIdx, consentIdx, languageIdx } = parseHeader(headers);
  if (nameIdx === -1 || phoneIdx === -1 || consentIdx === -1) return null;
  return {
    name: (values[nameIdx] ?? '').trim(),
    phone: (values[phoneIdx] ?? '').trim(),
    consent: (values[consentIdx] ?? '').trim(),
    language: languageIdx >= 0 ? (values[languageIdx] ?? '').trim() : '',
  };
}

export function isConsentYes(value: string): boolean {
  // Strict affirmative gate. Accepts only the explicit affirmative forms:
  // "yes", anything beginning with "yes," (the Google Form answer
  // "Yes, I agree to receive WhatsApp updates"), and anything beginning with
  // "i agree". Negations, blanks and arbitrary text are always rejected so
  // consent is never granted from a non-affirmative answer.
  const v = value.trim().toLowerCase();
  return v === 'yes' || v.startsWith('yes,') || v.startsWith('i agree');
}

export function classifyRow(row: SheetRowInput): RowDecision {
  if (!isConsentYes(row.consent)) return { kind: 'skip-consent' };
  if (!row.name) return { kind: 'invalid', reason: 'MISSING_NAME' };
  if (!row.phone) return { kind: 'invalid', reason: 'MISSING_PHONE' };
  const normalizedPhone = normalizePhoneNumber(row.phone);
  if (!normalizedPhone || normalizedPhone.replace(/\D/g, '').length < 10) {
    return { kind: 'invalid', reason: 'INVALID_PHONE' };
  }
  // Carry the sheet's language through so the sync can store it. Blank is kept as
  // an empty string (meaning "no opinion") rather than being dropped, so the
  // service can distinguish "sheet had none" from "sheet had a value".
  const language = (row.language ?? '').trim();
  return { kind: 'import', name: row.name, rawPhone: row.phone, normalizedPhone, language };
}

export interface SyncSummary {
  rowsRead: number;
  newRecipients: number;
  updatedRecipients: number;
  skippedNoConsent: number;
  invalidRows: number;
  errors: Array<{ row: number; reason: string }>;
}

export function emptySummary(): SyncSummary {
  return {
    rowsRead: 0,
    newRecipients: 0,
    updatedRecipients: 0,
    skippedNoConsent: 0,
    invalidRows: 0,
    errors: [],
  };
}
