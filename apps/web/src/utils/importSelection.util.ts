// Node's native TypeScript loader requires explicit extensions on relative
// imports; Vite handles this too (allowImportingTsExtensions is enabled).
import type { ImportRow } from './importMapping.util.ts';

/**
 * Step 12E — the human decision for a single import row.
 *
 * This module only *describes* what would be imported. It performs no database
 * work, no phone normalization and no duplicate detection; it consumes the rows
 * already produced by Steps 12C and 12D.
 */
export type ImportDecision = 'IMPORT' | 'SKIP';

/**
 * Spreadsheet row number -> decision. The decision state is deliberately kept
 * out of `ImportRow` so the validated / duplicate-detected rows are never
 * mutated by the preview.
 */
export type ImportSelection = Record<number, ImportDecision>;

export type ImportPreviewSummary = {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  existingDatabaseDuplicates: number;
  withinFileDuplicateRows: number;
  selectedForImport: number;
  skippedRows: number;
};

/**
 * A row may only be imported when Step 12C found no validation error and Step
 * 12D found no duplicate of either kind. Invalid rows, rows that already exist
 * in the database and within-file duplicates are never importable in Step 12E.
 */
export function isImportEligible(row: ImportRow): boolean {
  return row.isValid && !row.existingInDatabase && row.duplicateRows.length === 0;
}

/** Default decision: importable rows are imported, everything else is skipped. */
export function getDefaultDecision(row: ImportRow): ImportDecision {
  return isImportEligible(row) ? 'IMPORT' : 'SKIP';
}

/** Why a row is, or is not, a candidate for import. */
export function getImportDecisionReason(row: ImportRow): string {
  if (!row.isValid) return 'Validation error.';
  if (row.existingInDatabase && row.duplicateRows.length > 0) {
    return 'Already exists in database and is duplicated in this file.';
  }
  if (row.existingInDatabase) return 'Already exists in database.';
  if (row.duplicateRows.length > 0) return 'Duplicate in this file.';
  return 'Ready';
}

/** Details column: the classification reason plus a note for manual skips. */
export function getImportDecisionDetails(row: ImportRow, decision: ImportDecision): string {
  const reason = getImportDecisionReason(row);
  if (decision === 'SKIP' && isImportEligible(row)) {
    return reason.endsWith('.') ? reason + ' Skipped by user.' : reason + '. Skipped by user.';
  }
  return reason;
}

/**
 * Only valid unique rows can be switched between IMPORT and SKIP. Invalid rows,
 * existing recipients and within-file duplicates are locked to SKIP in 12E
 * because overwrite / merge behaviour is not implemented.
 */
export function canChangeImportDecision(row: ImportRow): boolean {
  return isImportEligible(row);
}

/** Effective decision for a row: locked rows are always SKIP. */
export function getRowDecision(selection: ImportSelection, row: ImportRow): ImportDecision {
  if (!isImportEligible(row)) return 'SKIP';
  return selection[row.rowNumber] ?? getDefaultDecision(row);
}

/** Default selection for a freshly classified row set (every row keeps its default). */
export function buildImportSelection(rows: ImportRow[]): ImportSelection {
  const selection: ImportSelection = {};
  for (const row of rows) {
    selection[row.rowNumber] = getDefaultDecision(row);
  }
  return selection;
}

/**
 * Rebuilds the decisions after validation or duplicate detection ran again.
 *
 * A manual SKIP is only carried over while the row is still importable and its
 * classification did not change; every row that became invalid or a duplicate
 * always falls back to SKIP. Stale decisions can therefore never turn an
 * unsafe row into an import.
 */
export function reconcileImportSelection(
  rows: ImportRow[],
  previous: ImportSelection
): ImportSelection {
  const selection: ImportSelection = {};
  for (const row of rows) {
    if (!isImportEligible(row)) {
      selection[row.rowNumber] = 'SKIP';
      continue;
    }
    selection[row.rowNumber] = previous[row.rowNumber] === 'SKIP' ? 'SKIP' : 'IMPORT';
  }
  return selection;
}

/**
 * Changes a single row decision. Rows that are not importable are pinned to
 * SKIP, so a locked row can never be switched to IMPORT.
 */
export function setImportDecision(
  selection: ImportSelection,
  row: ImportRow,
  decision: ImportDecision
): ImportSelection {
  if (!isImportEligible(row)) {
    return { ...selection, [row.rowNumber]: 'SKIP' };
  }
  return { ...selection, [row.rowNumber]: decision };
}

/**
 * Select all importable rows. Invalid rows, existing recipients and within-file
 * duplicates are explicitly set to SKIP.
 */
export function selectAllImportableRows(rows: ImportRow[]): ImportSelection {
  const selection: ImportSelection = {};
  for (const row of rows) {
    selection[row.rowNumber] = isImportEligible(row) ? 'IMPORT' : 'SKIP';
  }
  return selection;
}

/** Set every row (importable or not) back to SKIP. */
export function deselectAllRows(rows: ImportRow[]): ImportSelection {
  const selection: ImportSelection = {};
  for (const row of rows) {
    selection[row.rowNumber] = 'SKIP';
  }
  return selection;
}

export function countSelectedForImport(rows: ImportRow[], selection: ImportSelection): number {
  return rows.filter((row) => getRowDecision(selection, row) === 'IMPORT').length;
}

export function getImportPreviewSummary(
  rows: ImportRow[],
  selection: ImportSelection
): ImportPreviewSummary {
  const validRows = rows.filter((row) => row.isValid);
  const selectedForImport = countSelectedForImport(rows, selection);

  return {
    totalRows: rows.length,
    validRows: validRows.length,
    invalidRows: rows.length - validRows.length,
    existingDatabaseDuplicates: validRows.filter((row) => row.existingInDatabase).length,
    withinFileDuplicateRows: validRows.filter((row) => row.duplicateRows.length > 0).length,
    selectedForImport,
    skippedRows: rows.length - selectedForImport,
  };
}