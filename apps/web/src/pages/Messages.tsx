import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { Sidebar } from '../components/Sidebar';
import { Plus, Eye, Pencil, Trash2, RefreshCw, AlertCircle, Archive, CheckCircle2 } from 'lucide-react';
import BulkActionsBar, { RowCheckbox, type BulkResult } from '../components/BulkActionsBar';

interface Message {
  id: string;
  name: string;
  body: string;
  language: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Semantic status treatment for the message lifecycle (DRAFT / READY /
 * ARCHIVED), matching the shared token system used by the other list pages.
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

function MessageIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export default function Messages() {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showDelete, setShowDelete] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState<Message | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');

  // Bulk selection, scoped to the currently visible rows.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);

  const visibleMessageIds = messages.map((m) => m.id);

  // Lifecycle counts for the summary row. These are derived from the messages
  // the list endpoint already returned; no extra metrics are invented.
  const draftCount = messages.filter((m) => m.status === 'DRAFT').length;
  const readyCount = messages.filter((m) => m.status === 'READY').length;
  const archivedCount = messages.filter((m) => m.status === 'ARCHIVED').length;

  const toggleMessage = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const toggleAllVisibleMessages = () => {
    setSelectedIds((prev) => {
      const allSelected = visibleMessageIds.length > 0 && visibleMessageIds.every((id) => prev.includes(id));
      if (allSelected) return prev.filter((id) => !visibleMessageIds.includes(id));
      return Array.from(new Set([...prev, ...visibleMessageIds]));
    });
  };

  const messageById = (id: string) => messages.find((m) => m.id === id);

  // Active vs Archived view. Uses the EXISTING ARCHIVED status — no new
  // archive data model is introduced, and archived rows stay in the same list.
  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const isArchived = (m: Message) => m.status === 'ARCHIVED';
  const tabMessages = messages.filter((m) => (tab === 'archived' ? isArchived(m) : !isArchived(m)));
  const [unarchivingId, setUnarchivingId] = useState<string | null>(null);

  // Restore an archived message to the normal active lifecycle. READY is the
  // status campaigns consume, so restoring to READY keeps archived messages
  // usable and never mutates any campaign or execution history.
  const unarchiveMessage = async (msg: Message) => {
    setUnarchivingId(msg.id);
    setError('');
    try {
      await axios.patch(`/api/messages/${msg.id}`, { status: 'READY' });
      await fetchMessages();
      setTab('active');
    } catch (err: any) {
      setError(err?.response?.data?.error?.message || 'Failed to restore the message');
    } finally {
      setUnarchivingId(null);
    }
  };

  const runBulk = async (endpoint: '/api/messages/bulk-archive' | '/api/messages/bulk-delete', confirmed = false) => {
    if (selectedIds.length === 0) return;
    setBulkBusy(true);
    try {
      const url = confirmed ? `${endpoint}?confirm=true` : endpoint;
      const res = await axios.post<{ success: boolean; data: BulkResult }>(url, { ids: selectedIds, ...(confirmed ? { confirm: 'true' } : {}) });
      if (res.data.success) {
        setBulkResult(res.data.data);
        const changed = new Set(res.data.data.succeeded ?? []);
        setSelectedIds((prev) => prev.filter((id) => !changed.has(id)));
        await fetchMessages();
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

  const fetchMessages = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await axios.get<{ success: boolean; data: Message[] }>(
        '/api/messages'
      );
      if (response.data.success) setMessages(response.data.data);
      else setError('Failed to load messages');
    } catch {
      setError(
        'Unable to load messages. Please check your connection and try again.'
      );
    } finally {
      setLoading(false);
    }
    }, []);

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  const handleDeleteClick = (msg: Message) => {
    setDeleteMessage(msg);
    setDeleteError('');
    setShowDelete(true);
  };

  const handleCancelDelete = () => {
    setShowDelete(false);
    setDeleteMessage(null);
    setDeleteError('');
  };

  const handleConfirmDelete = async () => {
    if (!deleteMessage) return;
    setDeletingId(deleteMessage.id);
    try {
      await axios.delete<{ success: boolean }>(
        `/api/messages/${deleteMessage.id}`
      );
      setMessages((prev) => prev.filter((m) => m.id !== deleteMessage.id));
      setShowDelete(false);
      setDeleteMessage(null);
    } catch (err: any) {
      // Surface the backend explanation instead of a generic string, so a
      // MESSAGE_IN_CAMPAIGN refusal tells the user why the message is in use.
      // The generic text stays as the fallback, matching the pattern already
      // used by the other pages (Campaigns, Recipients, Login, Settings).
      setDeleteError(err.response?.data?.error?.message || 'Failed to delete message.');
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
              <h1 className="page-title">Messages</h1>
              <p className="page-subtitle">
                Create and manage reusable WhatsApp messages and media attachments for campaigns.
              </p>
            </div>
            {/* Active / Archived. Uses the existing ARCHIVED status only. */}
            <div
              role="tablist"
              aria-label="Message status"
              className="mb-4 inline-flex rounded-lg border border-border bg-card p-1"
            >
              <button
                role="tab"
                aria-selected={tab === 'active'}
                onClick={() => setTab('active')}
                className={`rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
                  tab === 'active' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Active
              </button>
              <button
                role="tab"
                aria-selected={tab === 'archived'}
                onClick={() => setTab('archived')}
                className={`rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
                  tab === 'archived' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Archived{archivedCount > 0 ? ` (${archivedCount})` : ''}
              </button>
            </div>
            <button
              onClick={() => navigate('/messages/new')}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-card transition-colors hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
              + New Message
            </button>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3">
              <AlertCircle className="h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
              <span className="text-[13px] font-medium text-destructive">{error}</span>
            </div>
          )}

          {/* Lifecycle summary. Every figure is counted from the messages the
              list endpoint already returned, so nothing here is fabricated. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                key: 'total',
                label: 'Total Messages',
                value: messages.length,
                hint: 'All messages in the library',
                icon: <MessageIcon className="h-5 w-5 text-primary" />,
                dot: 'bg-primary',
              },
              {
                key: 'ready',
                label: 'Ready',
                value: readyCount,
                hint: 'Available for campaigns',
                icon: <CheckCircle2 className="h-5 w-5 text-success" aria-hidden="true" />,
                dot: 'bg-success',
              },
              {
                key: 'draft',
                label: 'In Draft',
                value: draftCount,
                hint: 'Not yet published',
                icon: <Pencil className="h-5 w-5 text-warning" aria-hidden="true" />,
                dot: 'bg-warning',
              },
              {
                key: 'archived',
                label: 'Archived',
                value: archivedCount,
                hint: 'Retired from use',
                icon: <Archive className="h-5 w-5 text-muted-foreground" aria-hidden="true" />,
                dot: 'bg-muted-foreground',
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

        <BulkActionsBar<Message>
          visibleIds={visibleMessageIds}
          selectedIds={selectedIds}
          onToggleAll={toggleAllVisibleMessages}
          onClear={() => setSelectedIds([])}
          busy={bulkBusy}
          deleteLabel="Delete Selected"
          onDeleteSelected={() => runBulk('/api/messages/bulk-delete')}
          onDeletePermanent={() => runBulk('/api/messages/bulk-delete', true)}
          permanentDeleteWarning="Some selected messages are used by campaigns. Permanently deleting them will remove those campaign associations. Continue?"
          onArchiveSelected={() => runBulk('/api/messages/bulk-archive')}
          result={bulkResult}
          onDismissResult={() => setBulkResult(null)}
          describe={(id) => {
            const m = messageById(id);
            return m ? m.name : id;
          }}
        />

        {loading ? (
          <div className="app-card flex items-center justify-center py-12">
            <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
            <span className="sr-only">Loading messages</span>
          </div>
        ) : messages.length === 0 ? (
          <div className="app-card flex flex-col items-center px-4 py-12 text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <MessageIcon className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="card-title">No messages yet</h3>
            <p className="mt-1 max-w-md text-[13px] text-muted-foreground">
              Create a reusable message to use in your campaigns, or add a media attachment from the editor.
            </p>
            <button
              onClick={() => navigate('/messages/new')}
              className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-card transition-colors hover:opacity-95"
            >
              <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
              + New Message
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
                    <th scope="col" className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Message</th>
                    <th scope="col" className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Preview</th>
                    <th scope="col" className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Language</th>
                    <th scope="col" className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Status</th>
                    <th scope="col" className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Updated</th>
                    <th scope="col" className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {tabMessages.map((msg) => (
                    <tr
                      key={msg.id}
                      className={selectedIds.includes(msg.id) ? 'bg-muted/50' : undefined}
                    >
                      <td className="px-4 py-3">
                        <RowCheckbox
                          checked={selectedIds.includes(msg.id)}
                          onChange={() => toggleMessage(msg.id)}
                          disabled={bulkBusy}
                          label={`Select ${msg.name}`}
                        />
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <MessageIcon className="h-[18px] w-[18px] shrink-0 text-primary" />
                          <span className="table-text font-medium">{msg.name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <p className="line-clamp-1 max-w-md text-[13px] text-muted-foreground">
                          {msg.body}
                        </p>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        {msg.language ? (
                          <span className="inline-flex h-5 items-center rounded bg-muted px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                            {msg.language}
                          </span>
                        ) : (
                          <span className="text-[13px] text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <span
                          className={`inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-[11px] font-semibold uppercase tracking-wider ${statusBadgeClass(msg.status)}`}
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                          {statusLabel(msg.status)}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 table-text text-muted-foreground">
                        {formatDateTime(msg.updatedAt)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {/* Archived messages offer restore instead of edit. */}
                          {msg.status === 'ARCHIVED' && (
                            <button
                              onClick={() => unarchiveMessage(msg)}
                              disabled={unarchivingId === msg.id}
                              title="Unarchive"
                              aria-label={`Unarchive ${msg.name}`}
                              className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[12px] font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
                            >
                              <Archive className="h-4 w-4" aria-hidden="true" />
                              Unarchive
                            </button>
                          )}
                          <button
                            onClick={() => navigate(`/messages/${msg.id}/edit`)}
                            title="View"
                            aria-label={`View ${msg.name}`}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          >
                            <Eye className="h-4 w-4" aria-hidden="true" />
                          </button>
                          <button
                            onClick={() => navigate(`/messages/${msg.id}/edit`)}
                            title="Edit"
                            aria-label={`Edit ${msg.name}`}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-primary transition-colors hover:bg-primary/10"
                          >
                            <Pencil className="h-4 w-4" aria-hidden="true" />
                          </button>
                          <button
                            onClick={() => handleDeleteClick(msg)}
                            title="Delete"
                            aria-label={`Delete ${msg.name}`}
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

        {showDelete && deleteMessage && (
          <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal="true" aria-labelledby="delete-message-title">
            <div
              className="fixed inset-0 bg-foreground/50 backdrop-blur-[1px] transition-opacity"
              onClick={handleCancelDelete}
              aria-hidden="true"
            />
            <div className="app-card relative w-full max-w-sm p-5">
              <h3 className="card-title" id="delete-message-title">
                Delete Message
              </h3>
              <p className="mt-2 text-[13px] text-muted-foreground">
                Are you sure you want to delete "{deleteMessage.name}"? This action cannot be undone.
              </p>
              {deleteError && (
                <p className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-[13px] font-medium text-destructive">
                  {deleteError}
                </p>
              )}
              <div className="mt-5 flex items-center justify-end gap-2">
                <button
                  onClick={handleCancelDelete}
                  disabled={deletingId !== null}
                  className="inline-flex h-10 items-center rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmDelete}
                  disabled={deletingId !== null}
                  className="inline-flex h-10 items-center gap-2 rounded-lg bg-destructive px-4 text-sm font-semibold text-destructive-foreground shadow-card transition-colors hover:opacity-95 disabled:opacity-50"
                >
                  {deletingId !== null ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        )}
        </div>
      </main>
    </div>
  );
}
