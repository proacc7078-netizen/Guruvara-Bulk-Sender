import { useEffect, useState, useCallback } from 'react';
import axios from 'axios';
import { Sidebar } from '../components/Sidebar';
import { History as HistoryIcon, Eye, X, Send, CheckCircle2, AlertCircle, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';

export interface HistoryItem {
  executionRecipientId: string;
  executionId: string;
  campaignId: string;
  campaignName: string;
  recipientId: string;
  recipientName: string | null;
  recipientPhone: string;
  status: string;
  attemptCount: number;
  providerMessageId: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  webhookErrorCode: string | null;
  webhookErrorMessage: string | null;
  nextAttemptAt: string | null;
  retryPending: boolean;
  messagePreview: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One campaign EXECUTION row in the grouped History list. Counts come from
 * real execution-recipient records and are mutually exclusive (a READ row is
 * counted as READ only). */
export interface HistoryGroup {
  executionId: string;
  campaignId: string;
  campaignName: string;
  messageName: string | null;
  /** Execution status (PENDING/RUNNING/COMPLETED/FAILED/CANCELLED) deliberately
   * not labelled "campaign status". */
  executionStatus: string;
  executionStartedAt: string | null;
  scheduledAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  recipientCount: number;
  sentCount: number;
  deliveredCount: number;
  readCount: number;
  failedCount: number;
  pendingCount: number;
}

export interface HistoryDetail {
  executionRecipientId: string;
  source: string;
  snapshot: {
    executionId: string;
    recipientId: string;
    recipientName: string | null;
    recipientPhone: string;
    status: string;
    attemptCount: number;
    providerMessageId: string | null;
    sentAt: string | null;
    deliveredAt: string | null;
    readAt: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    webhookErrorCode: string | null;
    webhookErrorMessage: string | null;
    nextAttemptAt: string | null;
    retryPending: boolean;
    createdAt: string;
    updatedAt: string;
  };
  execution: {
    id: string;
    status: string;
    campaignId: string;
    campaignName: string;
    messageId: string | null;
    messageName: string | null;
    messageBody: string;
    messagePreview: string | null;
    scheduledAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    failedAt: string | null;
    attemptCount: number;
    createdAt: string;
    updatedAt: string;
  };
  currentRecipient: {
    id: string;
    name: string | null;
    whatsappNumber: string;
    status: string;
    updatedAt: string;
  } | null;
  note: string;
}

const HISTORY_STATUSES = ['PENDING', 'RUNNING', 'SENT', 'DELIVERED', 'READ', 'FAILED'];

/**
 * Recipient-level DELIVERY status shown on each history row. The real
 * lifecycle is PENDING / RUNNING / SENT / DELIVERED / READ / FAILED.
 * This is deliberately separate from the execution status below.
 */
function getDeliveryStatusColor(status: string): string {
  switch (status) {
    case 'SENT':
      return 'border border-info/40 bg-info/10 text-info';
    case 'DELIVERED':
    case 'READ':
      return 'border border-success/40 bg-success/10 text-success';
    case 'FAILED':
      return 'border border-destructive/40 bg-destructive/10 text-destructive';
    case 'RUNNING':
      return 'border border-warning/40 bg-warning/10 text-warning';
    case 'PENDING':
    default:
      return 'border border-border bg-muted text-muted-foreground';
  }
}

/**
 * Campaign EXECUTION status (detail panel). PENDING / RUNNING /
 * COMPLETED / FAILED / CANCELLED. Never merged with delivery status.
 */
function getExecutionStatusColor(status: string): string {
  switch (status) {
    case 'COMPLETED':
      return 'border border-success/40 bg-success/10 text-success';
    case 'RUNNING':
      return 'border border-info/40 bg-info/10 text-info';
    case 'FAILED':
      return 'border border-destructive/40 bg-destructive/10 text-destructive';
    case 'PENDING':
    case 'CANCELLED':
    default:
      return 'border border-border bg-muted text-muted-foreground';
  }
}

/** Alias for the existing per-recipient delivery status badge, used by the
 * campaign drill-down table. Same component, clearer name at the call site. */
const DeliveryStatusBadge = HistoryStatusBadge;

/** Campaign EXECUTION status badge. Deliberately separate from the per-recipient
 * delivery status: an execution is PENDING/RUNNING/COMPLETED/FAILED/CANCELLED. */
function ExecutionStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    PENDING: 'border-border bg-muted text-muted-foreground',
    RUNNING: 'border-info/40 bg-info/10 text-info',
    COMPLETED: 'border-success/40 bg-success/10 text-success',
    FAILED: 'border-destructive/40 bg-destructive/10 text-destructive',
    CANCELLED: 'border-border bg-muted text-muted-foreground',
  };
  return (
    <span className={clsx('inline-flex h-5 items-center gap-1.5 rounded-full border px-2 text-[11px] font-semibold uppercase tracking-wider', map[status] ?? map.PENDING)}>
      {status}
    </span>
  );
}

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function HistoryStatusBadge({ status, retryPending }: { status: string; retryPending?: boolean }) {
  return (
    <span
      className={`inline-flex h-5 items-center gap-1.5 rounded-full border px-2 text-[11px] font-semibold uppercase tracking-wider ${getDeliveryStatusColor(status)}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {status}
      {retryPending && (
        <span className="rounded bg-background/60 px-1.5 py-0.5 text-[10px] font-semibold">
          RETRY PENDING
        </span>
      )}
    </span>
  );
}

interface FetchParams {
  page: number;
  limit: number;
  campaign?: string;
  recipient?: string;
  status?: string;
  providerId?: string;
  start?: string;
  end?: string;
}

export default function History() {
  

  // --- Campaign-grouped history -------------------------------------------------
  // The primary History list is now one row per CAMPAIGN EXECUTION with real
  // aggregate delivery counts. The recipient-level list above is retained and
  // is reused for the drill-down view, so no detail is lost.
  const [groups, setGroups] = useState<HistoryGroup[]>([]);
  const [openExecutionId, setOpenExecutionId] = useState<string | null>(null);
  const [groupDetail, setGroupDetail] = useState<HistoryItem[]>([]);
  const [groupDetailLoading, setGroupDetailLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [page, setPage] = useState(1);
  const [limit] = useState(25);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  // Filters
  const [campaignFilter, setCampaignFilter] = useState('');
  const [recipientFilter, setRecipientFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Detail modal
  const [showDetail, setShowDetail] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detail, setDetail] = useState<HistoryDetail | null>(null);

  const buildParams = (): FetchParams => {
    const params: FetchParams = { page, limit };
    if (campaignFilter) params.campaign = campaignFilter;
    if (recipientFilter) params.recipient = recipientFilter;
    if (statusFilter) params.status = statusFilter;
    if (providerFilter) params.providerId = providerFilter;
    if (startDate) params.start = startDate;
    if (endDate) params.end = endDate;
    return params;
  };

  const buildQuery = (p: FetchParams): string => {
    const q = new URLSearchParams();
    q.set('page', String(p.page));
    q.set('limit', String(p.limit));
    if (p.campaign) q.set('campaign', p.campaign);
    if (p.recipient) q.set('recipient', p.recipient);
    if (p.status) q.set('status', p.status);
    if (p.providerId) q.set('providerId', p.providerId);
    if (p.start) q.set('start', p.start);
    if (p.end) q.set('end', p.end);
    return q.toString();
  };

  // Recipient-level drill-down for one campaign execution. Reuses the same
  // serialization as the existing recipient list so no detail is lost.
  const ExecutionDetailPanel = ({ g }: { g: HistoryGroup }) => (
    <div className="border-t border-border bg-muted/30 p-4">
      <div className="mb-3">
        <h3 className="text-[13px] font-semibold text-foreground">{g.campaignName}</h3>
        <p className="text-[12px] text-muted-foreground">
          Execution status {g.executionStatus}{'\u00b7'} {g.recipientCount} recipient record(s){'\u00b7'} Sent {g.sentCount}{'\u00b7'} Delivered {g.deliveredCount}{'\u00b7'} Read {g.readCount}{'\u00b7'} Failed {g.failedCount}
        </p>
      </div>
      {groupDetailLoading ? (
        <div className="py-6 text-center text-[13px] text-muted-foreground">Loading history...</div>
      ) : groupDetail.length === 0 ? (
        <div className="py-6 text-center text-[13px] text-muted-foreground">No recipient records match the current filters.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full min-w-[820px] sm:min-w-[900px] divide-y divide-border">
            <thead className="bg-muted">
              <tr>
                {['Recipient', 'Detail', 'WhatsApp number', 'Status', 'Provider ID', 'Error', 'Attempts', 'Sent', 'Delivered', 'Read'].map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {groupDetail.map((r) => (
                <tr key={r.executionRecipientId}>
                  <td className="whitespace-nowrap px-3 py-2 text-[12px] text-muted-foreground">{r.recipientName || '-'}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <button
                      onClick={() => void fetchDetail(r.executionRecipientId)}
                      title="Open full record detail"
                      aria-label={`Open detail for ${r.recipientName || r.recipientPhone}`}
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] font-medium text-primary transition-colors hover:bg-primary/10"
                    >
                      <Eye className="h-3.5 w-3.5" aria-hidden="true" /> Detail
                    </button>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-[13px] text-muted-foreground">{r.recipientPhone}</td>
                  <td className="whitespace-nowrap px-3 py-2"><DeliveryStatusBadge status={r.status} /></td>
                  <td className="whitespace-nowrap px-3 py-2 text-[12px] text-muted-foreground">{r.providerMessageId || '\u2014'}</td>
                  <td className="px-3 py-2 text-[12px] text-muted-foreground">{r.errorMessage || r.webhookErrorMessage || '    '}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-[12px] text-muted-foreground">{r.attemptCount}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-[12px] text-muted-foreground">{r.sentAt ? formatDateTime(r.sentAt) : '    '}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-[12px] text-muted-foreground">{r.deliveredAt ? formatDateTime(r.deliveredAt) : '    '}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-[12px] text-muted-foreground">{r.readAt ? formatDateTime(r.readAt) : '    '}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  const hasAnyFilter = () =>
    Boolean(campaignFilter || recipientFilter || statusFilter || providerFilter || startDate || endDate);

  // Campaign-grouped table + inline recipient-level drill-down.
  const GroupedHistoryList = () => (
    <div className="app-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] sm:min-w-[900px] divide-y divide-border">
          <thead className="bg-muted">
            <tr>
              <th className="w-[26%] px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Campaign</th>
              <th className="w-[16%] px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Execution</th>
              <th className="w-[10%] px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Audience</th>
              <th className="w-[28%] px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Delivery</th>
              <th className="w-[12%] px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Execution status</th>
              <th className="w-[8%] px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {groups.map((g) => (
              <tr key={g.executionId}>
                <td className="px-4 py-3">
                  <div className="table-text font-medium">{g.campaignName}</div>
                  {g.messageName && <div className="truncate text-[12px] text-muted-foreground">{g.messageName}</div>}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-[13px] text-muted-foreground">
                  {g.executionStartedAt ? new Date(g.executionStartedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-'}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-[13px] text-foreground">{g.recipientCount}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
                    <span>Sent <strong className="text-foreground">{g.sentCount}</strong></span>
                    <span>Delivered <strong className="text-foreground">{g.deliveredCount}</strong></span>
                    <span>Read <strong className="text-foreground">{g.readCount}</strong></span>
                    <span>Failed <strong className="text-foreground">{g.failedCount}</strong></span>
                    {g.pendingCount > 0 && <span>Pending <strong className="text-foreground">{g.pendingCount}</strong></span>}
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  <ExecutionStatusBadge status={g.executionStatus} />
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => (openExecutionId === g.executionId ? setOpenExecutionId(null) : void openGroup(g))}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[13px] font-medium text-primary transition-colors hover:bg-primary/10"
                  >
                    {openExecutionId === g.executionId ? 'Hide' : 'View details'}
                    <ChevronRight className={clsx('h-4 w-4 transition-transform', openExecutionId === g.executionId && 'rotate-90')} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {groups.filter((g) => g.executionId === openExecutionId).map((g) => (
        <ExecutionDetailPanel key={g.executionId} g={g} />
      ))}
    </div>
  );

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = buildParams();
      const qs = buildQuery(params);
      // Campaign-grouped list. Server-side pagination at the EXECUTION level, so
      // a large history is never pulled into the browser to be grouped locally.
      const response = await axios.get<{
        success: boolean;
        data: { items: HistoryGroup[]; page: number; limit: number; total: number; totalPages: number };
      }>(`/api/history/campaigns?${qs}`);
      if (response.data.success) {
        setGroups(response.data.data.items);
        setPage(response.data.data.page);
        setTotal(response.data.data.total);
        setTotalPages(response.data.data.totalPages);
      } else {
        setError('Failed to load history.');
      }
    } catch {
      // Never surface a raw server error to the operator.
      setError('Failed to load history.');
    } finally {
      setLoading(false);
    }
  }, [limit, campaignFilter, recipientFilter, statusFilter, providerFilter, startDate, endDate]);

  // Drill-down: recipient-level records for one campaign execution. Reuses the
  // same serialization as the existing recipient list, so nothing is dropped.
  const openGroup = async (g: HistoryGroup) => {
    setOpenExecutionId(g.executionId);
    setGroupDetailLoading(true);
    setGroupDetail([]);
    try {
      const params = buildParams();
      const q = new URLSearchParams();
      q.set('page', '1');
      q.set('limit', '100');
      if (params.campaign) q.set('campaign', params.campaign);
      if (params.recipient) q.set('recipient', params.recipient);
      if (params.status) q.set('status', params.status);
      if (params.providerId) q.set('providerId', params.providerId);
      if (params.start) q.set('start', params.start);
      if (params.end) q.set('end', params.end);
      const r = await axios.get<{ success: boolean; data: { items: HistoryItem[] } }>(
        `/api/history/executions/${g.executionId}?${q.toString()}`
      );
      if (r.data.success) setGroupDetail(r.data.data.items);
    } catch {
      setGroupDetail([]);
    } finally {
      setGroupDetailLoading(false);
    }
  };

  useEffect(() => {
    fetchHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchHistory]);

  useEffect(() => {
    setPage(1);
  }, [campaignFilter, recipientFilter, statusFilter, providerFilter, startDate, endDate]);

  useEffect(() => {
    void fetchHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const fetchDetail = async (id: string) => {
    setShowDetail(true);
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    try {
      const response = await axios.get<{ success: boolean; data: HistoryDetail }>(
        `/api/history/${encodeURIComponent(id)}`
      );
      if (response.data.success) setDetail(response.data.data);
      else setDetailError('Failed to load detail');
    } catch {
      setDetailError('Unable to load detail.');
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => {
    setShowDetail(false);
    setDetail(null);
    setDetailError('');
  };

  const applyFilters = () => {
    setPage(1);
    void fetchHistory();
  };

  const clearFilters = () => {
    setCampaignFilter('');
    setRecipientFilter('');
    setStatusFilter('');
    setProviderFilter('');
    setStartDate('');
    setEndDate('');
    setPage(1);
    void fetchHistory();
  };

  const goToPage = (newPage: number) => {
    if (newPage < 1) return;
    setPage(newPage);
  };


  // Summary figures. `total` comes straight from the API; the status counts are
  // derived from the rows already loaded for the current page and are labelled
  // as such so they are never mistaken for global analytics.
  // Totals across every campaign execution on the CURRENT page, clearly labelled
  // as page-scoped so they are never mistaken for lifetime totals.
  const sumOnPage = (k: 'sentCount' | 'deliveredCount' | 'readCount' | 'failedCount' | 'recipientCount') =>
    groups.reduce((acc, g) => acc + (g[k] ?? 0), 0);

  const DetailRow = ({ label, value }: { label: string; value: string | null }) => (
    <div className="grid grid-cols-1 gap-0.5 border-b border-border py-1.5 last:border-b-0 sm:grid-cols-3 sm:gap-3">
      <dt className="text-[13px] font-medium text-muted-foreground">{label}</dt>
      <dd className="break-all text-[13px] text-foreground sm:col-span-2">{value ?? '-'}</dd>
    </div>
  );

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-main">
        <div className="app-content space-y-4">
          {/* Page header */}
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <h1 className="page-title">History</h1>
              <p className="page-subtitle">
                Recipient-level delivery outcomes for campaign executions.
              </p>
            </div>
          </div>

          {/* Summary. `total` is returned by the API; the status tiles count only
              the rows loaded for the current page and say so. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {
              [
                { key: 'total', label: 'Campaign Executions', value: total, hint: 'Matching the current filters', icon: <HistoryIcon className="h-5 w-5 text-primary" aria-hidden="true" />, dot: 'bg-primary' },
                { key: 'sent', label: 'Sent', value: sumOnPage('sentCount'), hint: 'On this page', icon: <Send className="h-5 w-5 text-info" aria-hidden="true" />, dot: 'bg-info' },
                { key: 'delivered', label: 'Delivered', value: sumOnPage('deliveredCount'), hint: 'On this page', icon: <CheckCircle2 className="h-5 w-5 text-success" aria-hidden="true" />, dot: 'bg-success' },
                { key: 'read', label: 'Read', value: sumOnPage('readCount'), hint: 'On this page', icon: <CheckCircle2 className="h-5 w-5 text-success" aria-hidden="true" />, dot: 'bg-success' },
                { key: 'failed', label: 'Failed', value: sumOnPage('failedCount'), hint: 'On this page', icon: <AlertCircle className="h-5 w-5 text-destructive" aria-hidden="true" />, dot: 'bg-destructive' },
              ].map((card) => (
                <div key={card.key} className="app-card flex items-start justify-between p-4">
                  <div className="min-w-0 space-y-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {card.label}
                    </span>
                    <div className="text-2xl font-bold tabular-nums tracking-tight text-foreground">
                      {card.value.toLocaleString()}
                    </div>
                    <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                      <span className={`inline-block h-1.5 w-1.5 rounded-full ${card.dot}`} aria-hidden="true" />
                      <span>{card.hint}</span>
                    </div>
                  </div>
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                    {card.icon}
                  </span>
                </div>
              ))
            }
          </div>

          {/* Filter toolbar */}
          <div className="app-card p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Campaign</label>
            <input
              type="text"
              value={campaignFilter}
              onChange={(e) => setCampaignFilter(e.target.value)}
              placeholder="Campaign name"
              className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Recipient</label>
            <input
              type="text"
              value={recipientFilter}
              onChange={(e) => setRecipientFilter(e.target.value)}
              placeholder="Name or phone"
              className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">All statuses</option>
              {HISTORY_STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Provider ID</label>
            <input
              type="text"
              value={providerFilter}
              onChange={(e) => setProviderFilter(e.target.value)}
              placeholder="Provider message ID"
              className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Start date</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">End date</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        </div>
            </div>


        <div className="flex gap-2 mb-4">
          <button
            onClick={applyFilters}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-card transition-colors hover:opacity-95"
          >
            Apply
          </button>
          <button
            onClick={clearFilters}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-4 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted"
          >
            Clear
          </button>
        </div>

        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-[13px] text-muted-foreground">Loading history...</div>
          </div>
        ) : groups.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-[13px] text-muted-foreground">
              {hasAnyFilter() ? 'No campaign executions match the current filters.' : 'No campaign history found.'}
            </div>
          </div>
        ) : (
          <>
            <GroupedHistoryList />
          </>
        )}



            {/* Pagination */}
            <div className="flex items-center justify-between mt-4">
              <div className="text-[13px] text-muted-foreground">
                Showing {(groups.length > 0 ? (page - 1) * limit + 1 : 0)}-{Math.min(page * limit, total)} of {total} campaign execution(s)
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => goToPage(page - 1)}
                  disabled={page <= 1}
                  className="inline-flex h-9 items-center rounded-lg border border-border bg-card px-3 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Previous
                </button>
                <span className="px-3 text-[13px] font-medium text-foreground">
                  Page {page} of {totalPages}
                </span>
                <button
                  onClick={() => goToPage(page + 1)}
                  disabled={page >= totalPages}
                  className="inline-flex h-9 items-center rounded-lg border border-border bg-card px-3 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>

        {/* Detail Modal */}
        {showDetail && (
          <div className="fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center sm:p-0" onClick={closeDetail}>
            <div className="fixed inset-0 bg-foreground/50 backdrop-blur-[1px]" aria-hidden="true" />
            <div
              className="app-card relative max-h-[85vh] w-full max-w-2xl overflow-y-auto p-5"
              role="dialog"
              aria-modal="true"
              aria-labelledby="history-detail-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <h2 className="card-title" id="history-detail-title">Execution Detail</h2>
                <button onClick={closeDetail} className="text-muted-foreground transition-colors hover:text-foreground">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {detailLoading && (
                <div className="flex items-center justify-center py-8 text-[13px] text-muted-foreground">Loading history...</div>
              )}
              {detailError && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-[13px] font-medium text-destructive">
                  {detailError}
                </div>
              )}
              {detail && !detailLoading && (
                <>
                  <div className="mb-4">
                    <span className="section-title">Source</span>
                    <p className="text-[13px] text-foreground">{detail.source}</p>
                  </div>

                  <div className="mb-4">
                    <span className="section-title">Snapshot (immutable execution record)</span>
                    <dl className="mt-1 rounded-lg border border-border bg-muted p-3">
                      <DetailRow label="Execution ID" value={detail.snapshot.executionId} />
                      <DetailRow label="Status" value={detail.snapshot.status} />
                      <DetailRow label="Recipient" value={detail.snapshot.recipientName ?? detail.snapshot.recipientPhone} />
                      <DetailRow label="Phone" value={detail.snapshot.recipientPhone} />
                      <DetailRow label="Attempt Count" value={String(detail.snapshot.attemptCount)} />
                      <DetailRow label="Provider Message ID" value={detail.snapshot.providerMessageId} />
                      <DetailRow label="Sent At" value={formatDateTime(detail.snapshot.sentAt)} />
                      <DetailRow label="Delivered At" value={formatDateTime(detail.snapshot.deliveredAt)} />
                      <DetailRow label="Read At" value={formatDateTime(detail.snapshot.readAt)} />
                      <DetailRow label="Error Code" value={detail.snapshot.errorCode} />
                      <DetailRow label="Error Message" value={detail.snapshot.errorMessage} />
                      <DetailRow label="Webhook Error Code" value={detail.snapshot.webhookErrorCode} />
                      <DetailRow label="Webhook Error Message" value={detail.snapshot.webhookErrorMessage} />
                      <DetailRow label="Next Attempt At" value={formatDateTime(detail.snapshot.nextAttemptAt)} />
                      <DetailRow label="Retry Pending" value={detail.snapshot.retryPending ? 'Yes' : 'No'} />
                      <DetailRow label="Created At" value={formatDateTime(detail.snapshot.createdAt)} />
                      <DetailRow label="Updated At" value={formatDateTime(detail.snapshot.updatedAt)} />
                    </dl>
                  </div>

                  <div className="mb-4">
                    <span className="section-title">Execution Context</span>
                    <dl className="mt-1 rounded-lg border border-border bg-muted p-3">
                      <DetailRow label="Execution ID" value={detail.execution.id} />
                      <DetailRow label="Campaign" value={detail.execution.campaignName} />
                      <div className="grid grid-cols-1 gap-0.5 border-b border-border py-1.5 last:border-b-0 sm:grid-cols-3 sm:gap-3">
                        <dt className="text-[13px] font-medium text-muted-foreground">Execution Status</dt>
                        <dd className="sm:col-span-2">
                          <span
                            className={`inline-flex h-5 items-center gap-1.5 rounded-full border px-2 text-[11px] font-semibold uppercase tracking-wider ${getExecutionStatusColor(detail.execution.status)}`}
                          >
                            <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                            {detail.execution.status}
                          </span>
                        </dd>
                      </div>
                      <DetailRow label="Message Preview" value={detail.execution.messagePreview} />
                      <DetailRow label="Scheduled At" value={formatDateTime(detail.execution.scheduledAt)} />
                      <DetailRow label="Started At" value={formatDateTime(detail.execution.startedAt)} />
                      <DetailRow label="Completed At" value={formatDateTime(detail.execution.completedAt)} />
                      <DetailRow label="Failed At" value={formatDateTime(detail.execution.failedAt)} />
                      <DetailRow label="Attempt Count" value={String(detail.execution.attemptCount)} />
                      <DetailRow label="Created At" value={formatDateTime(detail.execution.createdAt)} />
                      <DetailRow label="Updated At" value={formatDateTime(detail.execution.updatedAt)} />
                    </dl>
                  </div>

                  {detail.currentRecipient && (
                    <div className="mb-4">
                      <span className="section-title">Live Recipient (for comparison only)</span>
                      <dl className="mt-1 rounded-lg border border-border bg-muted p-3">
                        <DetailRow label="Recipient ID" value={detail.currentRecipient.id} />
                        <DetailRow label="Name" value={detail.currentRecipient.name ?? '-'} />
                        <DetailRow label="Phone" value={detail.currentRecipient.whatsappNumber} />
                        <DetailRow label="Live Status" value={detail.currentRecipient.status} />
                        <DetailRow label="Updated At" value={formatDateTime(detail.currentRecipient.updatedAt)} />
                      </dl>
                    </div>
                  )}

                  <p className="mt-4 text-[13px] italic text-muted-foreground">
                    {detail.note}
                  </p>
                </>
              )}
            </div>
              </div>
          )}
        </div>
      </main>
    </div>
  );
}
