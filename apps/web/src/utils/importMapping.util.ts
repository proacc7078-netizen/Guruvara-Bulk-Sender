// Node's native TypeScript loader requires explicit extensions on relative
// imports; Vite handles this too (allowImportingTsExtensions is enabled).
import { normalizePhoneNumber } from './phone.util.ts';

/**
 * Result of Step 12A file parsing.
 * `rows` holds the first few rows used for the raw preview table.
 * `allRows` holds every parsed row and is what validation runs against.
 */
export interface ParsedPreview {
  fileName: string;
  headers: string[];
  rows: Array<Record<string, unknown>>;
  allRows: Array<Record<string, unknown>>;
  totalRows: number;
}

export type ColumnMapping = {
  name: string | null;
  whatsappNumber: string | null;
  language: string | null;
  category: string | null;
  consentStatus: string | null;
  consentTimestamp: string | null;
  notes: string | null;
  source: string | null;
};

/**
 * Step 12D duplicate information for a single import row.
 * Both fields only ever apply to rows that passed Step 12C validation,
 * so a row with `normalizedPhone === null` never participates.
 */
export type DuplicateInfo = {
  /** The row's normalizedPhone already exists as a recipient in the database. */
  existingInDatabase: boolean;
  /** Spreadsheet row numbers of the other imported rows sharing the same normalizedPhone. */
  duplicateRows: number[];
};

/**
 * Overall status of an import row. `isValid` keeps its Step 12C meaning
 * (validation errors only) and is never overwritten by duplicate detection.
 */
export type ImportRowStatus =
  | 'valid'
  | 'invalid'
  | 'existing-duplicate'
  | 'within-file-duplicate'
  | 'existing-and-within-file-duplicate';

/**
 * Step 12D duplicate summary counts. "Within-file duplicates" counts affected
 * rows, not distinct phone values; the phone groups are reported separately.
 */
export type DuplicateSummary = {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  /** Valid rows whose normalizedPhone already exists in the database. */
  existingDatabaseDuplicates: number;
  /** Valid rows that share their normalizedPhone with another imported row. */
  withinFileDuplicates: number;
  /** Number of distinct normalizedPhone values shared by two or more rows. */
  withinFileDuplicateGroups: number;
  /** Valid rows with no duplicate of either kind. */
  uniqueValidRows: number;
};

export type ImportRow = DuplicateInfo & {
  rowNumber: number;
  raw: Record<string, unknown>;
  name: string;
  whatsappNumber: string;
  normalizedPhone: string | null;
  language: string | null;
  category: string | null;
  consentStatus: string | null;
  consentTimestamp: string | null;
  notes: string | null;
  source: string | null;
  errors: string[];
  warnings: string[];
  isValid: boolean;
  status: ImportRowStatus;
};

export const MAPPING_FIELDS = [
  { key: 'name' as const, label: 'Name', required: true },
  { key: 'whatsappNumber' as const, label: 'WhatsApp Number', required: true },
  { key: 'language' as const, label: 'Language', required: false },
  { key: 'category' as const, label: 'Category', required: false },
  { key: 'consentStatus' as const, label: 'Consent Status', required: false },
  { key: 'consentTimestamp' as const, label: 'Consent Timestamp', required: false },
  { key: 'notes' as const, label: 'Notes', required: false },
  { key: 'source' as const, label: 'Source', required: false },
];

export const OBVIOUS_MATCHES: Record<string, string[]> = {
  name: ['Name', 'Full Name', 'Fullname', 'Customer Name', 'Recipient Name'],
  whatsappNumber: ['WhatsApp Number', 'Phone', 'Mobile', 'Phone Number', 'Mobile Number', 'WhatsApp', 'Contact Number'],
  language: ['Language', 'Lang', 'Preferred Language'],
  category: ['Category', 'Categories', 'Segment', 'Tag'],
  consentStatus: ['Consent Status', 'Consent', 'Consent Given', 'Consent Status'],
  consentTimestamp: ['Consent Timestamp', 'Consent Date', 'Consent Time', 'Consent At', 'Consent At Date'],
  notes: ['Notes', 'Note', 'Comments', 'Comment', 'Remarks'],
  source: ['Source', 'Import Source', 'Source Type'],
};

export function getObviousMatch(header: string, fieldKey: string): boolean {
  const normalized = header.trim();
  return OBVIOUS_MATCHES[fieldKey]?.some((m) => m.toLowerCase() === normalized.toLowerCase()) ?? false;
}

export function safeString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Applies the column mapping to every parsed row, producing the Step 12C
 * validation + normalization result set. Runs entirely client-side.
 */
export function validateAndNormalizeRows(
  preview: ParsedPreview,
  mapping: ColumnMapping
): ImportRow[] {
  const sourceRows = preview.allRows ?? preview.rows;
  const rows: ImportRow[] = [];

  for (let i = 0; i < preview.totalRows; i++) {
    const raw = sourceRows[i] ?? {};
    const errors: string[] = [];
    const warnings: string[] = [];

    const rawName = safeString(mapping.name ? raw[mapping.name] : undefined);
    const rawPhone = safeString(mapping.whatsappNumber ? raw[mapping.whatsappNumber] : undefined);

    const name = rawName.trim();
    const whatsappNumber = rawPhone.trim();

    if (!name) {
      errors.push('Name is required.');
    }

    let normalizedPhone: string | null = null;
    if (!whatsappNumber) {
      errors.push('WhatsApp number is required.');
    } else {
      const normalized = normalizePhoneNumber(whatsappNumber);
      if (!normalized) {
        errors.push('Invalid WhatsApp number.');
      } else {
        normalizedPhone = normalized;
      }
    }

    const language = mapping.language ? safeString(raw[mapping.language]).trim() || null : null;
    const category = mapping.category ? safeString(raw[mapping.category]).trim() || null : null;
    const consentStatus = mapping.consentStatus ? safeString(raw[mapping.consentStatus]).trim() || null : null;
    const consentTimestamp = mapping.consentTimestamp ? safeString(raw[mapping.consentTimestamp]).trim() || null : null;
    const notes = mapping.notes ? safeString(raw[mapping.notes]).trim() || null : null;
    const source = mapping.source ? safeString(raw[mapping.source]).trim() || null : null;

    rows.push({
      rowNumber: i + 1,
      raw,
      name,
      whatsappNumber,
      normalizedPhone,
      language,
      category,
      consentStatus,
      consentTimestamp,
      notes,
      source,
      errors,
      warnings,
      isValid: errors.length === 0,
      existingInDatabase: false,
      duplicateRows: [],
      status: errors.length === 0 ? 'valid' : 'invalid',
    });
  }

  return rows;
}
/**
 * Step 12D — the canonical phone a row can be checked with, or null when the
 * row cannot participate in duplicate detection. Only rows that passed Step 12C
 * validation and produced a normalizedPhone take part; invalid rows keep their
 * validation errors only.
 */
function duplicatePhoneOf(row: ImportRow): string | null {
  if (!row.isValid) return null;
  return row.normalizedPhone;
}

/**
 * Collects the unique, non-null normalized phones of the valid rows so the
 * import batch only ever needs a single duplicate lookup request.
 * Example: ['919000011111', '919000022222', '919000011111'] -> first two only.
 */
export function collectUniqueNormalizedPhones(rows: ImportRow[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const phone = duplicatePhoneOf(row);
    if (!phone) continue;
    if (seen.has(phone)) continue;
    seen.add(phone);
    unique.push(phone);
  }

  return unique;
}

export function getImportRowStatus(
  existingInDatabase: boolean,
  withinFileDuplicate: boolean
): ImportRowStatus {
  if (existingInDatabase && withinFileDuplicate) return 'existing-and-within-file-duplicate';
  if (existingInDatabase) return 'existing-duplicate';
  if (withinFileDuplicate) return 'within-file-duplicate';
  return 'valid';
}

/**
 * Applies duplicate detection to the Step 12C validation result.
 *
 * - `existingPhones` are the normalized phones reported by the read-only
 *   backend lookup (POST /api/recipients/import-duplicates).
 * - Within-file duplicates come from grouping the current import rows by
 *   normalizedPhone; every row of a group is flagged with the row numbers of
 *   the other rows in that group, and none of them is dropped.
 * - Invalid rows are returned untouched apart from having no duplicate info.
 */
export function applyDuplicateDetection(
  rows: ImportRow[],
  existingPhones: Iterable<string>
): ImportRow[] {
  const existingSet = existingPhones instanceof Set ? existingPhones : new Set(existingPhones);

  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const phone = duplicatePhoneOf(row);
    if (!phone) continue;
    const group = groups.get(phone);
    if (group) {
      group.push(row.rowNumber);
    } else {
      groups.set(phone, [row.rowNumber]);
    }
  }

  return rows.map((row) => {
    const phone = duplicatePhoneOf(row);
    if (!phone) {
      return { ...row, existingInDatabase: false, duplicateRows: [], status: 'invalid' };
    }

    const duplicateRows = (groups.get(phone) ?? [])
      .filter((rowNumber) => rowNumber !== row.rowNumber)
      .sort((a, b) => a - b);
    const existingInDatabase = existingSet.has(phone);

    return {
      ...row,
      existingInDatabase,
      duplicateRows,
      status: getImportRowStatus(existingInDatabase, duplicateRows.length > 0),
    };
  });
}

/**
 * Discards duplicate results (e.g. when the column mapping changes) while
 * keeping every Step 12C validation value intact.
 */
export function clearDuplicateDetection(rows: ImportRow[]): ImportRow[] {
  return rows.map((row) => ({
    ...row,
    existingInDatabase: false,
    duplicateRows: [],
    status: row.isValid ? 'valid' : 'invalid',
  }));
}

export function getDuplicateSummary(rows: ImportRow[]): DuplicateSummary {
  const validRows = rows.filter((row) => row.isValid);
  const existing = validRows.filter((row) => row.existingInDatabase);
  const withinFile = validRows.filter((row) => row.duplicateRows.length > 0);

  const duplicateGroups = new Set<string>();
  for (const row of withinFile) {
    if (row.normalizedPhone) duplicateGroups.add(row.normalizedPhone);
  }

  return {
    totalRows: rows.length,
    validRows: validRows.length,
    invalidRows: rows.length - validRows.length,
    existingDatabaseDuplicates: existing.length,
    withinFileDuplicates: withinFile.length,
    withinFileDuplicateGroups: duplicateGroups.size,
    uniqueValidRows: validRows.filter(
      (row) => !row.existingInDatabase && row.duplicateRows.length === 0
    ).length,
  };
}

/** Human readable duplicate reason(s) for the Step 12D table. */
export function describeDuplicateStatus(row: ImportRow): string {
  if (!row.isValid) return 'Not checked (row is invalid)';

  const reasons: string[] = [];
  if (row.existingInDatabase) {
    reasons.push('Existing recipient');
  }
  if (row.duplicateRows.length > 0) {
    const label = row.duplicateRows.length === 1 ? 'row' : 'rows';
    reasons.push(`Duplicate of ${label} ${row.duplicateRows.join(', ')}`);
  }

  if (reasons.length === 0) return 'No duplicate found';

  // "Existing recipient; duplicate of row 7" reads better than two capitalised clauses
  if (reasons.length > 1) {
    reasons[1] = reasons[1].charAt(0).toLowerCase() + reasons[1].slice(1);
  }

  return reasons.join('; ');
}