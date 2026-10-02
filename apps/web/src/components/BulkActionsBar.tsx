import { useMemo, useState } from 'react';
import { Trash2, Archive, AlertCircle, X, SquareCheckBig } from 'lucide-react';

export interface BulkFailure {
  id: string;
  code: string;
  message: string;
}

export interface BulkResult {
  requested: number;
  deleted?: string[];
  succeeded?: string[];
  failed: BulkFailure[];
  partial: boolean;
}

interface BulkActionsBarProps<T> {
  /** Rows currently visible under the active search/filters. Defines the selection set. */
  visibleIds: string[];
  selectedIds: string[];
  onToggleAll: () => void;
  onClear: () => void;
  busy: boolean;
  deleteLabel: string;
  onDeleteSelected: () => void;
  onDeletePermanent?: () => void;
  permanentDeleteLabel?: string;
  permanentDeleteWarning?: string;
  onArchiveSelected?: () => void;
  archiveLabel?: string;
  result?: BulkResult | null;
  onDismissResult?: () => void;
  describe?: (id: string) => string;
  rowKey?: (row: T) => string;
}

/**
 * One consistent multi-select pattern for the list pages (Recipients, Messages,
 * Campaigns): per-row checkbox, Select All over the currently visible rows,
 * a live selected count, a bulk action bar, explicit confirmation, and a
 * per-record failure report. No third-party table library is used.
 */
export default function BulkActionsBar<T>({
  visibleIds,
  selectedIds,
  onToggleAll,
  onClear,
  busy,
  deleteLabel,
  onDeleteSelected,
  onDeletePermanent,
  permanentDeleteLabel,
  permanentDeleteWarning,
  onArchiveSelected,
  archiveLabel,
  result,
  onDismissResult,
  describe,
}: BulkActionsBarProps<T>) {
  const [confirming, setConfirming] = useState<'delete' | 'archive' | 'permanent' | null>(null);
  const [visibleCount, setVisibleCount] = useState(visibleIds.length);

  // Keep the header checkbox in sync when the visible set changes (filters).
  if (visibleCount !== visibleIds.length) setVisibleCount(visibleIds.length);

  const allVisibleSelected = useMemo(
    () => visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id)),
    [visibleIds, selectedIds]
  );
  const someVisibleSelected = useMemo(
    () => visibleIds.some((id) => selectedIds.includes(id)),
    [visibleIds, selectedIds]
  );

  const run = (action: 'delete' | 'archive' | 'permanent') => {
    setConfirming(null);
    if (action === 'delete') onDeleteSelected();
    else if (action === 'permanent') onDeletePermanent?.();
    else onArchiveSelected?.();
  };

  const DEPENDENCY_CODES = ['RECIPIENT_IN_CAMPAIGN', 'MESSAGE_IN_CAMPAIGN', 'CAMPAIGN_HAS_EXECUTION_HISTORY'];
  const hasDependencyFailure = Boolean(
    onDeletePermanent && result && result.failed.some((f) => DEPENDENCY_CODES.includes(f.code)),
  );

  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-2 text-[13px] font-medium text-foreground">
          <input
            type="checkbox"
            checked={allVisibleSelected}
            ref={(el) => { if (el) el.indeterminate = someVisibleSelected && !allVisibleSelected; }}
            onChange={onToggleAll}
            disabled={visibleIds.length === 0 || busy}
            className="h-4 w-4 rounded border-input accent-primary"
            aria-label="Select all visible rows"
          />
          <span>Select all</span>
        </label>
        <span className="text-[13px] text-muted-foreground" data-testid="bulk-selected-count">
          {selectedIds.length} selected
        </span>
        {selectedIds.length > 0 && (
          <button
            onClick={onClear}
            disabled={busy}
            className="text-[13px] text-muted-foreground underline transition-colors hover:text-foreground disabled:opacity-50"
          >
            Clear selection
          </button>
        )}
      </div>

      {selectedIds.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted px-3 py-2">
          <SquareCheckBig className="h-5 w-5 text-primary" aria-hidden="true" />
          <span className="text-[13px] font-semibold text-foreground">
            {selectedIds.length} item{selectedIds.length === 1 ? '' : 's'} selected
          </span>
          <div className="ml-auto flex items-center gap-2">
            {onArchiveSelected && (
              <button
                onClick={() => setConfirming('archive')}
                disabled={busy}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted disabled:opacity-50"
              >
                <Archive className="h-4 w-4" aria-hidden="true" />
                {archiveLabel}
              </button>
            )}
            <button
              onClick={() => setConfirming('delete')}
              disabled={busy}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-destructive px-2.5 text-[13px] font-semibold text-destructive-foreground shadow-card transition-colors hover:opacity-95 disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              {deleteLabel}
            </button>
          </div>
        </div>
      )}

      {confirming && (
        <div className="mt-2 flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3">
          <AlertCircle className="h-4 w-4 flex-shrink-0 text-warning" />
          <p className="text-[13px] text-warning">
            {confirming === 'permanent'
              ? (permanentDeleteWarning ||
                  `Permanently delete ${selectedIds.length} selected item${selectedIds.length === 1 ? '' : 's'} and all dependent data? This cannot be undone.`)
              : confirming === 'archive'
                ? `Archive ${selectedIds.length} selected item${selectedIds.length === 1 ? '' : 's'}? This is safe and preserves history.`
                : `Delete ${selectedIds.length} selected item${selectedIds.length === 1 ? '' : 's'}? This cannot be undone. Items that cannot be deleted will be reported individually.`}
          </p>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setConfirming(null)}
              disabled={busy}
              className="inline-flex h-8 items-center rounded-lg px-2.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={() => run(confirming)}
              disabled={busy}
              className={`inline-flex h-8 items-center rounded-lg px-2.5 text-[13px] font-semibold text-white shadow-card transition-colors disabled:opacity-50 ${
                confirming === 'archive'
                  ? 'bg-muted-foreground hover:opacity-90'
                  : confirming === 'permanent'
                    ? 'bg-destructive hover:opacity-90'
                    : 'bg-destructive hover:opacity-90'
              }`}
            >
              {busy
                ? 'Working...'
                : confirming === 'permanent'
                  ? permanentDeleteLabel || 'Delete permanently'
                  : `Yes, ${confirming === 'archive' ? 'Archive' : 'Delete'}`}
            </button>
          </div>
        </div>
      )}

      {result && (
        <div
          className={`mt-2 rounded-lg border p-3 ${
            result.failed.length > 0
              ? 'border-destructive/40 bg-destructive/10'
              : 'border-success/40 bg-success/10'
          }`}
          data-testid="bulk-result"
        >
          <div className="flex items-start gap-2">
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-foreground">
                {result.partial
                  ? `Partially completed: ${(result.deleted ?? result.succeeded ?? []).length} of ${result.requested} succeeded, ${result.failed.length} failed.`
                  : result.failed.length > 0
                    ? `Nothing was changed: all ${result.requested} item(s) failed.`
                    : `Completed: ${result.requested} item(s) processed successfully.`}
              </p>
              {result.failed.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {result.failed.map((f) => (
                    <li key={f.id} className="text-[11px] font-medium text-destructive">
                      <span className="font-medium">{describe ? describe(f.id) : f.id}</span>
                      {' \u2014 '}
                      {f.message} <span className="opacity-70">[{f.code}]</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {onDismissResult && (
              <button onClick={onDismissResult} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Dismiss result">
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
          {hasDependencyFailure && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-medium text-destructive">
                These items are still referenced. You can delete them together with their dependent records permanently.
              </span>
              <button
                onClick={() => setConfirming('permanent')}
                disabled={busy}
                className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg bg-destructive px-2.5 text-[13px] font-semibold text-destructive-foreground shadow-card transition-colors hover:opacity-95 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                {permanentDeleteLabel || 'Delete permanently'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Checkbox for a single row, matching the header checkbox style. */
export function RowCheckbox({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={onChange}
      disabled={disabled}
      aria-label={label}
      className="h-4 w-4 rounded border-input accent-primary"
    />
  );
}
