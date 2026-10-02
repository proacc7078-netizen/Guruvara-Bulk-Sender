import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { Sidebar } from '../components/Sidebar';
import { Plus, Eye, Pencil, Trash2, RefreshCw, AlertCircle, Calendar, Archive, Bolt, Clock, CheckCircle2 } from 'lucide-react';
import BulkActionsBar, { RowCheckbox, type BulkResult } from '../components/BulkActionsBar';

interface CampaignMessageSummary {
  id: string;
  name: string;
  status: string;
}

interface CampaignSchedule {
  id: string;
  campaignId: string;
  scheduledAt: string;
  timezone: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface Campaign {
  id: string;
  name: string;
  description: string | null;
  status: string;
  messageId: string | null;
  message: CampaignMessageSummary | null;
  executions: { id: string }[];
  createdAt: string;
  updatedAt: string;
}

function formatScheduleDate(iso: string, timezone: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(instant);
  } catch {
    return '';
  }
}

function formatScheduleTime(iso: string, timezone: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(instant);
  } catch {
    return '';
  }
}

/**
 * Semantic status treatment for the campaign lifecycle (DRAFT / READY /
 * ARCHIVED), matching the shared token system used by Messages and Recipients.
 * Schedule and execution states are separate lifecycles and are rendered by
 * their own helpers below - they are deliberately not folded in here.
 */
function statusBadgeClass(status: string): string {
  switch (status) {
    case 'READY':
      return 'border border-success/40 bg-success/10 text-success';
    case 'DRAFT':
      return 'border border-warning/40 bg-warning/10 text-warning';
    case 'ARCHIVED':
    default:
      return 'border border-border bg-muted text-muted-foreground';
  }
}

/** Human label for a raw status value, e.g. DRAFT -> Draft. */
function statusLabel(status: string): string {
  switch (status) {
    case 'READY':
      return 'Ready';
    case 'DRAFT':
      return 'Draft';
    case 'ARCHIVED':
      return 'Archived';
    default:
      return status;
  }
}

function formatDateTime(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function Campaigns() {
  const navigate = useNavigate();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showDelete, setShowDelete] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Campaign | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Destructive choice needs its own confirmation step: 'CHOOSE' -> 'ARCHIVE'
  // | 'PERMANENT'. Campaigns WITH execution history default to CHOOSE so the
  // operator is offered Archive *or* Delete permanently, never forced.
  const [deleteChoice, setDeleteChoice] = useState<'CHOOSE' | 'ARCHIVE' | 'PERMANENT'>('CHOOSE');
  const [deleteError, setDeleteError] = useState('');

  // Bulk selection, scoped to the currently visible rows.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  // Phase 4.2: audience size per campaign, read from the audience endpoint so the
  // Phase 4.1 campaign payload stays unchanged.
  const [audienceCounts, setAudienceCounts] = useState<Record<string, number>>({});

  // Phase 4.4: schedule info per campaign
  const [schedules, setSchedules] = useState<Record<string, CampaignSchedule | null>>({});

  const loadAudienceCounts = async (list: Campaign[]) => {
    const entries = await Promise.all(
      list.map(async (campaign) => {
        try {
          const response = await axios.get<{ success: boolean; data: unknown[] }>(
            `/api/campaigns/${campaign.id}/audience`
          );
          return [campaign.id, response.data.success ? response.data.data.length : 0] as const;
        } catch {
          return [campaign.id, 0] as const;
        }
      })
    );
    setAudienceCounts(Object.fromEntries(entries));
  };

  const loadSchedules = async (list: Campaign[]) => {
    const entries = await Promise.all(
      list.map(async (campaign) => {
        try {
          const response = await axios.get<{ success: boolean; data: { schedule: CampaignSchedule | null } }>(
            `/api/campaigns/${campaign.id}/schedule`
          );
          return [campaign.id, response.data.success ? response.data.data.schedule : null] as const;
        } catch {
          return [campaign.id, null] as const;
        }
      })
    );
    setSchedules(Object.fromEntries(entries));
  };

  const fetchCampaigns = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await axios.get<{ success: boolean; data: Campaign[] }>(
        '/api/campaigns'
      );
      if (response.data.success) {
        setCampaigns(response.data.data);
        await loadAudienceCounts(response.data.data);
        await loadSchedules(response.data.data);
      } else setError('Failed to load campaigns');
    } catch {
      setError(
        'Unable to load campaigns. Please check your connection and try again.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCampaigns();
  }, [fetchCampaigns]);

  const visibleCampaignIds = campaigns.map((c) => c.id);

  // Lifecycle counts for the summary row. Derived from the campaigns the list
  // endpoint already returned plus the schedule data this page already loads;
  // no delivery, throughput or infrastructure metrics are invented.
  const draftCount = campaigns.filter((c) => c.status === 'DRAFT').length;
  const readyCount = campaigns.filter((c) => c.status === 'READY').length;
  const archivedCount = campaigns.filter((c) => c.status === 'ARCHIVED').length;
  const scheduledCount = campaigns.filter(
    (c) => schedules[c.id]?.status === 'SCHEDULED'
  ).length;

  const toggleCampaign = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const toggleAllVisibleCampaigns = () => {
    setSelectedIds((prev) => {
      const allSelected = visibleCampaignIds.length > 0 && visibleCampaignIds.every((id) => prev.includes(id));
      if (allSelected) return prev.filter((id) => !visibleCampaignIds.includes(id));
      return Array.from(new Set([...prev, ...visibleCampaignIds]));
    });
  };

  const campaignById = (id: string) => campaigns.find((c) => c.id === id);

  const runBulk = async (endpoint: '/api/campaigns/bulk-archive' | '/api/campaigns/bulk-delete', confirmed = false) => {
    if (selectedIds.length === 0) return;
    setBulkBusy(true);
    try {
      const url = confirmed ? `${endpoint}?confirm=true` : endpoint;
      const res = await axios.post<{ success: boolean; data: BulkResult }>(url, { ids: selectedIds, ...(confirmed ? { confirm: 'true' } : {}) });
      if (res.data.success) {
        setBulkResult(res.data.data);
        const changed = new Set(res.data.data.succeeded ?? []);
        setSelectedIds((prev) => prev.filter((id) => !changed.has(id)));
        await fetchCampaigns();
      }
    } catch (err: any) {
      setBulkResult({
        requested: selectedIds.length,
        succeeded: [],
        failed: [{ id: 'request', code: 'REQUEST_FAILED', message: err?.response?.data?.error?.message || 'Bulk action failed' }],
        partial: false,
      });
    } finally {
      setBulkBusy(false);
    }
  };

  const handleDeleteClick = (campaign: Campaign) => {
    setDeleteTarget(campaign);
    setDeleteError('');
    // History present -> ask which action; no history -> plain delete.
    setDeleteChoice(campaign.executions?.length ? 'CHOOSE' : 'PERMANENT');
    setShowDelete(true);
  };

  const handleCancelDelete = () => {
    setShowDelete(false);
    setDeleteTarget(null);
    setDeleteError('');
    setDeleteChoice('CHOOSE');
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeletingId(deleteTarget.id);
    try {
      // Archive: the non-destructive path. Always available, now offered
      // alongside Delete permanently instead of being forced.
      if (deleteChoice === 'ARCHIVE') {
        await axios.patch(`/api/campaigns/${deleteTarget.id}`, { status: 'ARCHIVED' });
        setCampaigns((prev) => prev.map((c) => (c.id === deleteTarget.id ? { ...c, status: 'ARCHIVED' } : c)));
        setShowDelete(false);
        setDeleteTarget(null);
        return;
      }
      // Delete permanently: requires the extra confirmation step and asks the
      // backend for the destructive cascade explicitly via ?confirm=true.
      await axios.delete<{ success: boolean }>(
        `/api/campaigns/${deleteTarget.id}?confirm=true`
      );
      setCampaigns((prev) => prev.filter((c) => c.id !== deleteTarget.id));
      setShowDelete(false);
      setDeleteTarget(null);
    } catch (err: any) {
      // Surface the backend explanation (e.g. CAMPAIGN_DELIVERY_IN_PROGRESS)
      // rather than a hard-coded generic string.
      setDeleteError(err.response?.data?.error?.message || 'Failed to delete campaign.');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-main">
        <div className="app-content space-y-4">
          {/* Page header */}
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <h1 className="page-title">Campaigns</h1>
              <p className="page-subtitle">
                Create, prepare and schedule WhatsApp campaigns.
              </p>
            </div>
            <button
              onClick={() => navigate('/campaigns/new')}
              className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-card transition-colors hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
              + New Campaign
            </button>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3">
              <AlertCircle className="h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
              <span className="text-[13px] font-medium text-destructive">{error}</span>
            </div>
          )}

          {/* Lifecycle summary. Every figure is counted from the campaigns the
              list endpoint already returned; nothing here is fabricated. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                key: 'total',
                label: 'Total Campaigns',
                value: campaigns.length,
                hint: 'All campaigns',
                icon: <Calendar className="h-5 w-5 text-primary" aria-hidden="true" />,
                dot: 'bg-primary',
              },
              {
                key: 'ready',
                label: 'Ready',
                value: readyCount,
                hint: 'Prepared to run',
                icon: <CheckCircle2 className="h-5 w-5 text-success" aria-hidden="true" />,
                dot: 'bg-success',
              },
              {
                key: 'draft',
                label: 'In Draft',
                value: draftCount,
                hint: 'Not yet finalised',
                icon: <Pencil className="h-5 w-5 text-warning" aria-hidden="true" />,
                dot: 'bg-warning',
              },
              {
                key: 'scheduled',
                label: 'Scheduled',
                value: scheduledCount,
                hint: `${archivedCount} archived`,
                icon: <Clock className="h-5 w-5 text-info" aria-hidden="true" />,
                dot: 'bg-info',
              },
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
            ))}
          </div>

        <BulkActionsBar<Campaign>
          visibleIds={visibleCampaignIds}
          selectedIds={selectedIds}
          onToggleAll={toggleAllVisibleCampaigns}
          onClear={() => setSelectedIds([])}
          busy={bulkBusy}
          deleteLabel="Delete Selected"
          onDeleteSelected={() => runBulk('/api/campaigns/bulk-delete')}
          onDeletePermanent={() => runBulk('/api/campaigns/bulk-delete', true)}
          permanentDeleteWarning="Some selected campaigns have execution history. Permanently deleting them will also permanently delete their delivery/read history. This cannot be undone. Continue?"
          onArchiveSelected={() => runBulk('/api/campaigns/bulk-archive')}
          result={bulkResult}
          onDismissResult={() => setBulkResult(null)}
          describe={(id) => {
            const c = campaignById(id);
            return c ? c.name : id;
          }}
        />

        {loading ? (
          <div className="app-card flex items-center justify-center py-12">
            <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
            <span className="sr-only">Loading campaigns</span>
          </div>
        ) : campaigns.length === 0 ? (
          <div className="app-card flex flex-col items-center px-4 py-12 text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Calendar className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
            </div>
            <h3 className="card-title">No campaigns yet</h3>
            <p className="mt-1 max-w-md text-[13px] text-muted-foreground">
              Create a campaign to prepare a message, choose an audience and send it on WhatsApp.
            </p>
            <button
              onClick={() => navigate('/campaigns/new')}
              className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-card transition-colors hover:opacity-95"
            >
              <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
              + New Campaign
            </button>
          </div>
        ) : (
          <div className="app-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-border">
                <thead className="bg-muted">
                  <tr>
                    <th scope="col" className="w-10 px-4 py-3">
                      <span className="sr-only">Select</span>
                    </th>
                    <th scope="col" className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Campaign</th>
                    <th scope="col" className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Message</th>
                    <th scope="col" className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Audience</th>
                    <th scope="col" className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Status</th>
                    <th scope="col" className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Schedule</th>
                    <th scope="col" className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Updated</th>
                    <th scope="col" className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {campaigns.map((campaign) => (
                    <tr
                      key={campaign.id}
                      className={selectedIds.includes(campaign.id) ? 'bg-muted/50' : undefined}
                    >
                      <td className="px-4 py-3">
                        <RowCheckbox
                          checked={selectedIds.includes(campaign.id)}
                          onChange={() => toggleCampaign(campaign.id)}
                          disabled={bulkBusy}
                          label={`Select ${campaign.name}`}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col">
                          <span className="table-text font-medium">{campaign.name}</span>
                          {campaign.description && (
                            <span className="mt-0.5 line-clamp-1 max-w-xs text-[11px] text-muted-foreground">
                              {campaign.description}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {campaign.message ? (
                          <div className="flex flex-col">
                            <span className="line-clamp-1 text-[13px] font-medium text-foreground">
                              {campaign.message.name}
                            </span>
                            <span className="text-[11px] text-muted-foreground">
                              {statusLabel(campaign.message.status)}
                            </span>
                          </div>
                        ) : (
                          <span className="text-[13px] text-muted-foreground">None</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <span className="inline-flex h-5 items-center rounded bg-muted px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          {audienceCounts[campaign.id] ?? 0}{' '}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <span
                          className={`inline-flex h-5 items-center gap-1.5 rounded-full border px-2 text-[11px] font-semibold uppercase tracking-wider ${statusBadgeClass(campaign.status)}`}
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                          {statusLabel(campaign.status)}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        {schedules[campaign.id] ? (
                          schedules[campaign.id]!.status === 'SCHEDULED' ? (
                            <div className="flex flex-col">
                              <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-info/40 bg-info/10 px-2 text-[11px] font-semibold uppercase tracking-wider text-info">
                                <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                                Scheduled
                              </span>
                              <span className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
                                {formatScheduleDate(schedules[campaign.id]!.scheduledAt, schedules[campaign.id]!.timezone)},{' '}
                                {formatScheduleTime(schedules[campaign.id]!.scheduledAt, schedules[campaign.id]!.timezone)}
                              </span>
                            </div>
                          ) : (
                            <div className="flex flex-col">
                              <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-muted px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                                <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                                Cancelled
                              </span>
                              <span className="mt-0.5 text-[11px] text-muted-foreground">Schedule cancelled</span>
                            </div>
                          )
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
                            <Bolt className="h-4 w-4" aria-hidden="true" />
                            Unscheduled
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 table-text text-muted-foreground">
                        {formatDateTime(campaign.updatedAt)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => navigate(`/campaigns/${campaign.id}/edit`)}
                            title="View"
                            aria-label={`View ${campaign.name}`}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          >
                            <Eye className="h-4 w-4" aria-hidden="true" />
                          </button>
                          <button
                            onClick={() => navigate(`/campaigns/${campaign.id}/edit`)}
                            title="Edit"
                            aria-label={`Edit ${campaign.name}`}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-primary transition-colors hover:bg-primary/10"
                          >
                            <Pencil className="h-4 w-4" aria-hidden="true" />
                          </button>
                          <button
                            onClick={() => handleDeleteClick(campaign)}
                            title="Delete"
                            aria-label={`Delete ${campaign.name}`}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-destructive transition-colors hover:bg-destructive/10"
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {showDelete && deleteTarget && (
          <div
            className="fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center sm:p-0"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-campaign-title"
          >
            <div
              className="fixed inset-0 bg-foreground/50 backdrop-blur-[1px] transition-opacity"
              onClick={handleCancelDelete}
              aria-hidden="true"
            />
            <div className="app-card relative max-h-[85vh] w-full max-w-md overflow-y-auto p-5">
              <h3 className="card-title" id="delete-campaign-title">
                {deleteTarget.executions?.length
                  ? 'Campaign has execution history'
                  : 'Delete Campaign'}
              </h3>

              {deleteChoice === 'CHOOSE' ? (
                <>
                  <p className="mt-2 text-[13px] text-muted-foreground">
                    This campaign has execution history. Choose what you want to do.
                  </p>
                  <div className="mt-4 space-y-2">
                    <button
                      type="button"
                      onClick={() => setDeleteChoice('ARCHIVE')}
                      className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted"
                    >
                      <Archive className="h-4 w-4" aria-hidden="true" />
                      Archive (keeps all history)
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteChoice('PERMANENT')}
                      className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-destructive px-3.5 text-[13px] font-semibold text-destructive-foreground shadow-card transition-colors hover:opacity-95"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                      Delete permanently...
                    </button>
                  </div>
                </>
              ) : deleteChoice === 'PERMANENT' ? (
                <div className="mt-3">
                  <p className="text-[13px] font-semibold text-destructive">
                    This will permanently delete the campaign. This cannot be undone.
                  </p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-muted-foreground">
                    <li>The campaign and its audience memberships will be removed.</li>
                    <li>Its schedules will be removed.</li>
                    <li>
                      Its execution history - including delivery and read history for every
                      recipient - will also be permanently deleted.
                    </li>
                  </ul>
                  <p className="mt-2 text-[13px] text-muted-foreground">
                    Messages, media and recipients are not affected. To keep the history, choose
                    Archive instead.
                  </p>
                </div>
              ) : (
                <>
                  <p className="mt-2 text-[13px] text-muted-foreground">
                    Archive this campaign? It will no longer run, but all execution and delivery
                    history is preserved.
                  </p>
                  <p className="mt-1 text-[13px] text-muted-foreground">
                    The message, recipients and media remain intact.
                  </p>
                </>
              )}

              {deleteError && (
                <p className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-[13px] font-medium text-destructive">
                  {deleteError}
                </p>
              )}
              <div className="mt-5 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() =>
                    deleteChoice === 'CHOOSE' ? handleCancelDelete() : setDeleteChoice('CHOOSE')
                  }
                  disabled={deletingId !== null}
                  className="inline-flex h-10 items-center rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted disabled:opacity-50"
                >
                  {deleteChoice === 'CHOOSE' ? 'Cancel' : 'Back'}
                </button>
                {deleteChoice !== 'CHOOSE' && (
                  <button
                    type="button"
                    onClick={handleConfirmDelete}
                    disabled={deletingId !== null}
                    className={`inline-flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-semibold text-white shadow-card transition-colors hover:opacity-95 disabled:opacity-50 ${
                      deleteChoice === 'ARCHIVE'
                        ? 'bg-muted-foreground'
                        : 'bg-destructive'
                    }`}
                  >
                    {deleteChoice === 'ARCHIVE'
                      ? 'Archive'
                      : deletingId !== null
                        ? 'Deleting...'
                        : 'Delete permanently'}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
        </div>
      </main>
    </div>
  );
}
