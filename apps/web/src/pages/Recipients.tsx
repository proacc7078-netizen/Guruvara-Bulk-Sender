import { useEffect, useState } from 'react';
import axios from 'axios';
import { Sidebar } from '../components/Sidebar';
import { Plus, Upload, X, CheckCircle, AlertCircle, Pencil, Eye, Trash2, Tag as TagIcon, Search as SearchIcon, RefreshCw, Users as UsersIcon, UserCheck, UserX, Download } from 'lucide-react';
import { Link } from 'react-router-dom';
import BulkActionsBar, { RowCheckbox, type BulkResult } from '../components/BulkActionsBar';

interface RecipientTag {
  tag?: { id: string; name: string };
}

interface Recipient {
  id: string;
  name: string;
  whatsappNumber: string;
  language?: string | null;
  category?: string | null;
  consentStatus?: string | null;
  consentTimestamp?: string | null;
  notes?: string | null;
  source: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  tags: RecipientTag[];
}

interface RecipientForm {
  name: string;
  whatsappNumber: string;
  language: string;
  category: string;
  consentStatus: string;
  consentTimestamp: string;
  notes: string;
}

const initialForm: RecipientForm = {
  name: '',
  whatsappNumber: '',
  language: '',
  category: '',
  consentStatus: '',
  consentTimestamp: '',
  notes: ''
};

function formatDateTimeForInput(value?: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Compact date-time used in the table's "Updated" column. */
function formatUpdated(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Two-letter avatar initials, e.g. "Chinedu Eze" -> "CE". */
function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Deterministic avatar colour for a recipient.
 *
 * The palette is a small, muted, professional set that matches the CMS visual
 * language (no neon / high saturation). The index is derived from the recipient
 * id with a stable string hash, so the SAME recipient always gets the SAME
 * colour across reloads, filtering, sorting and navigation — it is never
 * randomised at render time.
 */
const AVATAR_PALETTE = [
  'bg-teal-100 text-teal-800',
  'bg-sky-100 text-sky-800',
  'bg-indigo-100 text-indigo-800',
  'bg-amber-100 text-amber-800',
  'bg-rose-100 text-rose-800',
  'bg-emerald-100 text-emerald-800',
  'bg-violet-100 text-violet-800',
  'bg-orange-100 text-orange-800',
] as const;

/**
 * Deterministic tag colour.
 *
 * The index is derived from the tag id (falling back to the name) with a stable
 * string hash, so a given tag always renders in the same colour across reloads,
 * filtering, sorting and navigation. Nothing is randomised at render time.
 *
 * The palette is muted and professional (no neon / high saturation) and every
 * pair is a light background with a dark, readable foreground.
 */
const TAG_PALETTE = [
  'bg-teal-100 text-teal-800',
  'bg-sky-100 text-sky-800',
  'bg-indigo-100 text-indigo-800',
  'bg-amber-100 text-amber-900',
  'bg-rose-100 text-rose-800',
  'bg-emerald-100 text-emerald-800',
  'bg-violet-100 text-violet-800',
  'bg-orange-100 text-orange-900',
] as const;

export function tagColorClass(seed: string): string {
  let hash = 0;
  const s = seed || 'tag';
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  return TAG_PALETTE[hash % TAG_PALETTE.length];
}

/** Stable seed for a tag: prefer the id so a rename never changes its colour. */
export function tagSeed(tag: { id?: string | null; name?: string | null }): string {
  return String(tag?.id ?? tag?.name ?? '');
}

export function avatarColorClass(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'ACTIVE':
      return 'border border-success/40 bg-success/10 text-success';
    case 'PAUSED':
      return 'border border-warning/40 bg-warning/10 text-warning';
    case 'UNSUBSCRIBED':
    case 'INVALID':
    case 'BLOCKED':
      return 'border border-border bg-muted text-muted-foreground';
    default:
      return 'border border-border bg-muted text-muted-foreground';
  }
}

function FilterSelect({
  id,
  label,
  value,
  onChange,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 sm:w-44" htmlFor={id}>
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] font-normal text-foreground shadow-card transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {children}
      </select>
    </label>
  );
}

export default function Recipients() {
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [languageFilter, setLanguageFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [availableLanguages, setAvailableLanguages] = useState<string[]>([]);

  // Bulk selection. The selection set is always the rows currently visible
  // under the active search/filters, so Select All and the count can never
  // refer to rows the operator cannot see.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);

  // Quick Add modal state
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [form, setForm] = useState<RecipientForm>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  // Edit modal state
  const [showEdit, setShowEdit] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<RecipientForm>(initialForm);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState('');

  // View modal state
  const [showView, setShowView] = useState(false);
  const [viewRecipient, setViewRecipient] = useState<Recipient | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewError, setViewError] = useState('');

  // Delete confirmation state
  const [showDelete, setShowDelete] = useState(false);
  const [deleteRecipient, setDeleteRecipient] = useState<Recipient | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  // Status change state
  const [statusUpdatingId, setStatusUpdatingId] = useState<string | null>(null);
  const [statusError, setStatusError] = useState('');
  // Unsubscribe confirmation state
  const [showUnsubscribe, setShowUnsubscribe] = useState(false);
  const [unsubscribeRecipient, setUnsubscribeRecipient] = useState<Recipient | null>(null);
  const [unsubscribeSubmitting, setUnsubscribeSubmitting] = useState(false);
  const [unsubscribeError, setUnsubscribeError] = useState('');

  // Tag management state
  interface Tag {
    id: string;
    name: string;
    _count?: { recipients: number };
  }
  const [tags, setTags] = useState<Tag[]>([]);
  const [showTagManager, setShowTagManager] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [tagSubmitting, setTagSubmitting] = useState(false);
  const [tagError, setTagError] = useState('');
  const [renamingTagId, setRenamingTagId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [showTagDelete, setShowTagDelete] = useState(false);
  const [deleteTagTarget, setDeleteTagTarget] = useState<Tag | null>(null);
  const [deleteTagSubmitting, setDeleteTagSubmitting] = useState(false);
  const [deleteTagError, setDeleteTagError] = useState('');

  // Recipient tag assignment state
  const [showRecipientTags, setShowRecipientTags] = useState(false);
  const [recipientTagsTarget, setRecipientTagsTarget] = useState<Recipient | null>(null);
  const [recipientTagsSubmitting, setRecipientTagsSubmitting] = useState(false);
  const [recipientTagsError, setRecipientTagsError] = useState('');

  const fetchRecipients = async (term?: string, filters?: { status?: string; language?: string; tagId?: string }) => {
    try {
      setError('');
      const params: Record<string, string> = {};
      const searchValue = term !== undefined ? term : searchTerm;
      if (searchValue && searchValue.trim()) params.search = searchValue.trim();
      const statusValue = filters?.status !== undefined ? filters.status : statusFilter;
      if (statusValue) params.status = statusValue;
      const languageValue = filters?.language !== undefined ? filters.language : languageFilter;
      if (languageValue) params.language = languageValue;
      const tagValue = filters?.tagId !== undefined ? filters.tagId : tagFilter;
      if (tagValue) params.tagId = tagValue;
      const res = await axios.get('/api/recipients', { params });
      if (res.data.success) {
        setRecipients(res.data.data);
        // Dynamically populate languages from the returned recipients
        const langs = Array.from(
          new Set((res.data.data as Recipient[]).map((r) => r.language).filter((l): l is string => Boolean(l)))
        ).sort();
        setAvailableLanguages((prev) => {
          const merged = Array.from(new Set([...prev, ...langs])).sort();
          return merged;
        });
      } else {
        setError('Failed to load recipients.');
      }
    } catch (err) {
      console.error(err);
      setError('Failed to load recipients.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRecipients();
  }, []);

  // Debounced search + filters — uses the API rather than filtering the loaded array
  useEffect(() => {
    const t = setTimeout(() => {
      fetchRecipients(searchTerm, { status: statusFilter, language: languageFilter, tagId: tagFilter });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, statusFilter, languageFilter, tagFilter]);

  // Refetch the current view from the backend without a full page reload. The
  // active search/status/language/tag filters are passed through so the list is
  // refreshed in place rather than reset.
  const handleRefresh = async () => {
    setLoading(true);
    await fetchRecipients(searchTerm, {
      status: statusFilter,
      language: languageFilter,
      tagId: tagFilter,
    });
  };

  const clearFilters = () => {
    setStatusFilter('');
    setLanguageFilter('');
    setTagFilter('');
  };

  const filtersActive = Boolean(statusFilter || languageFilter || tagFilter);

  const visibleRecipientIds = recipients.map((r) => r.id);

  // Summary figures for the metric row. The list endpoint returns the rows
  // matching the active search/filters only, so these are scoped to what is
  // currently loaded rather than the whole database.
  const totalCount = recipients.length;
  const activeCount = recipients.filter((r) => r.status === 'ACTIVE').length;
  const pausedCount = recipients.filter((r) => r.status === 'PAUSED').length;
  const taggedCount = recipients.filter((r) => r.tags && r.tags.length > 0).length;

  const toggleRecipient = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const toggleAllVisibleRecipients = () => {
    setSelectedIds((prev) => {
      const allSelected = visibleRecipientIds.length > 0 && visibleRecipientIds.every((id) => prev.includes(id));
      if (allSelected) return prev.filter((id) => !visibleRecipientIds.includes(id));
      return Array.from(new Set([...prev, ...visibleRecipientIds]));
    });
  };

  // Selection is scoped to what is visible: rows removed by a search/filter
  // change are dropped so a later bulk action can never touch a hidden row.
  if (
    selectedIds.some((id) => !visibleRecipientIds.includes(id)) &&
    (searchTerm || filtersActive)
  ) {
    setSelectedIds((prev) => prev.filter((id) => visibleRecipientIds.includes(id)));
  }

  const recipientById = (id: string) => recipients.find((r) => r.id === id);

  const bulkDeleteRecipients = async (confirmed = false) => {
    if (selectedIds.length === 0) return;
    setBulkBusy(true);
    try {
      const url = confirmed ? '/api/recipients/bulk-delete?confirm=true' : '/api/recipients/bulk-delete';
      const res = await axios.post<{ success: boolean; data: BulkResult }>(url, {
        ids: selectedIds,
        ...(confirmed ? { confirm: 'true' } : {}),
      });
      if (res.data.success) {
        setBulkResult(res.data.data);
        const removed = new Set(res.data.data.deleted ?? []);
        setSelectedIds((prev) => prev.filter((id) => !removed.has(id)));
        setLoading(true);
        await fetchRecipients();
      }
    } catch (err: any) {
      setBulkResult({
        requested: selectedIds.length,
        deleted: [],
        failed: [{ id: 'request', code: 'REQUEST_FAILED', message: err?.response?.data?.error?.message || 'Failed to delete recipients' }],
        partial: false,
      });
    } finally {
      setBulkBusy(false);
    }
  };

  const openQuickAdd = () => {
    setForm(initialForm);
    setFormError('');
    setSuccessMessage('');
    setShowQuickAdd(true);
  };

  const closeQuickAdd = () => {
    if (submitting) return;
    setShowQuickAdd(false);
    setFormError('');
    setSuccessMessage('');
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleQuickAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setFormError('');
    setSuccessMessage('');

    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        whatsappNumber: form.whatsappNumber.trim()
      };

      if (form.language.trim()) payload.language = form.language.trim();
      if (form.category.trim()) payload.category = form.category.trim();
      if (form.consentStatus.trim()) payload.consentStatus = form.consentStatus.trim();
      if (form.consentTimestamp.trim()) payload.consentTimestamp = form.consentTimestamp.trim();
      if (form.notes.trim()) payload.notes = form.notes.trim();

      const res = await axios.post('/api/recipients', payload);
      if (res.data.success) {
        setSuccessMessage(`Recipient "${res.data.data.name}" added successfully.`);
        setShowQuickAdd(false);
        setLoading(true);
        await fetchRecipients();
      }
    } catch (err: any) {
      setFormError(err.response?.data?.error?.message || 'Failed to add recipient.');
    } finally {
      setSubmitting(false);
    }
  };

  const openEdit = async (recipient: Recipient) => {
    setEditError('');
    setSuccessMessage('');
    setEditingId(recipient.id);
    setEditForm({
      name: recipient.name,
      whatsappNumber: recipient.whatsappNumber,
      language: recipient.language || '',
      category: recipient.category || '',
      consentStatus: recipient.consentStatus || '',
      consentTimestamp: formatDateTimeForInput(recipient.consentTimestamp),
      notes: recipient.notes || ''
    });
    setShowEdit(true);
  };

  const closeEdit = () => {
    if (editSubmitting) return;
    setShowEdit(false);
    setEditingId(null);
    setEditError('');
  };

  const handleEditInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setEditForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingId) return;
    setEditSubmitting(true);
    setEditError('');

    try {
      const payload: Record<string, unknown> = {
        name: editForm.name.trim(),
        whatsappNumber: editForm.whatsappNumber.trim()
      };

      if (editForm.language.trim()) payload.language = editForm.language.trim();
      else payload.language = null;

      if (editForm.category.trim()) payload.category = editForm.category.trim();
      else payload.category = null;

      if (editForm.consentStatus.trim()) payload.consentStatus = editForm.consentStatus.trim();
      else payload.consentStatus = null;

      if (editForm.consentTimestamp.trim()) payload.consentTimestamp = editForm.consentTimestamp.trim();
      else payload.consentTimestamp = null;

      if (editForm.notes.trim()) payload.notes = editForm.notes.trim();
      else payload.notes = null;

      const res = await axios.patch(`/api/recipients/${editingId}`, payload);
      if (res.data.success) {
        setSuccessMessage(`Recipient "${res.data.data.name}" updated successfully.`);
        setShowEdit(false);
        setEditingId(null);
        setLoading(true);
        await fetchRecipients();
      }
    } catch (err: any) {
      setEditError(err.response?.data?.error?.message || 'Failed to update recipient.');
    } finally {
      setEditSubmitting(false);
    }
  };

  const openView = async (recipient: Recipient) => {
    setViewError('');
    setViewRecipient(null);
    setViewLoading(true);
    setShowView(true);

    try {
      const res = await axios.get(`/api/recipients/${recipient.id}`);
      if (res.data.success) {
        setViewRecipient(res.data.data);
      } else {
        setViewError('Failed to load recipient details.');
      }
    } catch (err: any) {
      setViewError(err.response?.data?.error?.message || 'Failed to load recipient details.');
    } finally {
      setViewLoading(false);
    }
  };

  const closeView = () => {
    setShowView(false);
    setViewRecipient(null);
    setViewError('');
  };

  const openDelete = (recipient: Recipient) => {
    setDeleteError('');
    setSuccessMessage('');
    setDeleteRecipient(recipient);
    setShowDelete(true);
  };

  const closeDelete = () => {
    if (deleteSubmitting) return;
    setShowDelete(false);
    setDeleteRecipient(null);
    setDeleteError('');
  };

  const handleDeleteConfirm = async () => {
    if (!deleteRecipient) return;
    setDeleteSubmitting(true);
    setDeleteError('');

    try {
      const res = await axios.delete(`/api/recipients/${deleteRecipient.id}`);
      if (res.data.success) {
        setSuccessMessage(`Recipient "${deleteRecipient.name}" deleted successfully.`);
        setShowDelete(false);
        setDeleteRecipient(null);
        setLoading(true);
        await fetchRecipients();
      }
    } catch (err: any) {
      setDeleteError(err.response?.data?.error?.message || 'Failed to delete recipient.');
    } finally {
      setDeleteSubmitting(false);
    }
  };

  const handleStatusChange = async (recipient: Recipient, newStatus: string) => {
    if (newStatus === recipient.status) return;
    setStatusUpdatingId(recipient.id);
    setStatusError('');
    setSuccessMessage('');

    try {
      const res = await axios.patch(`/api/recipients/${recipient.id}/status`, { status: newStatus });
      if (res.data.success) {
        setSuccessMessage(`Recipient "${res.data.data.name}" status changed to ${newStatus}.`);
        setLoading(true);
        await fetchRecipients();
      }
    } catch (err: any) {
      setStatusError(err.response?.data?.error?.message || 'Failed to update status.');
    } finally {
      setStatusUpdatingId(null);
    }
  };

  const openUnsubscribe = (recipient: Recipient) => {
    setUnsubscribeError('');
    setSuccessMessage('');
    setUnsubscribeRecipient(recipient);
    setShowUnsubscribe(true);
  };

  const closeUnsubscribe = () => {
    if (unsubscribeSubmitting) return;
    setShowUnsubscribe(false);
    setUnsubscribeRecipient(null);
    setUnsubscribeError('');
  };

  const handleUnsubscribeConfirm = async () => {
    if (!unsubscribeRecipient) return;
    setUnsubscribeSubmitting(true);
    setUnsubscribeError('');

    try {
      const res = await axios.patch(`/api/recipients/${unsubscribeRecipient.id}/status`, { status: 'UNSUBSCRIBED' });
      if (res.data.success) {
        setSuccessMessage(`Recipient "${res.data.data.name}" has been unsubscribed.`);
        setShowUnsubscribe(false);
        setUnsubscribeRecipient(null);
        setLoading(true);
        await fetchRecipients();
      }
    } catch (err: any) {
      setUnsubscribeError(err.response?.data?.error?.message || 'Failed to unsubscribe recipient.');
    } finally {
      setUnsubscribeSubmitting(false);
    }
  };

  const fetchTags = async () => {
    try {
      const res = await axios.get('/api/tags');
      if (res.data.success) {
        setTags(res.data.data);
      }
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchTags();
  }, []);

  const openTagManager = () => {
    setTagError('');
    setNewTagName('');
    setRenamingTagId(null);
    setShowTagManager(true);
  };

  const closeTagManager = () => {
    if (tagSubmitting || deleteTagSubmitting) return;
    setShowTagManager(false);
    setShowTagDelete(false);
    setDeleteTagTarget(null);
  };

  const handleCreateTag = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTagName.trim()) return;
    setTagSubmitting(true);
    setTagError('');

    try {
      const res = await axios.post('/api/tags', { name: newTagName.trim() });
      if (res.data.success) {
        setNewTagName('');
        await fetchTags();
      }
    } catch (err: any) {
      setTagError(err.response?.data?.error?.message || 'Failed to create tag.');
    } finally {
      setTagSubmitting(false);
    }
  };

  const startRenameTag = (tag: Tag) => {
    setRenamingTagId(tag.id);
    setRenameValue(tag.name);
  };

  const handleRenameTag = async (tagId: string) => {
    if (!renameValue.trim()) return;
    setTagSubmitting(true);
    setTagError('');

    try {
      const res = await axios.patch(`/api/tags/${tagId}`, { name: renameValue.trim() });
      if (res.data.success) {
        setRenamingTagId(null);
        await fetchTags();
        await fetchRecipients();
      }
    } catch (err: any) {
      setTagError(err.response?.data?.error?.message || 'Failed to rename tag.');
    } finally {
      setTagSubmitting(false);
    }
  };

  const openTagDelete = (tag: Tag) => {
    setDeleteTagError('');
    setDeleteTagTarget(tag);
    setShowTagDelete(true);
  };

  const closeTagDelete = () => {
    if (deleteTagSubmitting) return;
    setShowTagDelete(false);
    setDeleteTagTarget(null);
  };

  const handleTagDeleteConfirm = async () => {
    if (!deleteTagTarget) return;
    setDeleteTagSubmitting(true);
    setDeleteTagError('');

    try {
      const res = await axios.delete(`/api/tags/${deleteTagTarget.id}`);
      if (res.data.success) {
        setShowTagDelete(false);
        setDeleteTagTarget(null);
        await fetchTags();
        await fetchRecipients();
      }
    } catch (err: any) {
      setDeleteTagError(err.response?.data?.error?.message || 'Failed to delete tag.');
    } finally {
      setDeleteTagSubmitting(false);
    }
  };

  const openRecipientTags = (recipient: Recipient) => {
    setRecipientTagsError('');
    setRecipientTagsTarget(recipient);
    setShowRecipientTags(true);
  };

  const closeRecipientTags = () => {
    if (recipientTagsSubmitting) return;
    setShowRecipientTags(false);
    setRecipientTagsTarget(null);
    setRecipientTagsError('');
  };

  const handleAssignTag = async (tagId: string) => {
    if (!recipientTagsTarget) return;
    setRecipientTagsSubmitting(true);
    setRecipientTagsError('');

    try {
      const res = await axios.post(`/api/recipients/${recipientTagsTarget.id}/tags`, { tagId });
      if (res.data.success) {
        await fetchRecipients();
      }
    } catch (err: any) {
      setRecipientTagsError(err.response?.data?.error?.message || 'Failed to assign tag.');
    } finally {
      setRecipientTagsSubmitting(false);
    }
  };

  const handleRemoveTag = async (tagId: string) => {
    if (!recipientTagsTarget) return;
    setRecipientTagsSubmitting(true);
    setRecipientTagsError('');

    try {
      const res = await axios.delete(`/api/recipients/${recipientTagsTarget.id}/tags/${tagId}`);
      if (res.data.success) {
        await fetchRecipients();
      }
    } catch (err: any) {
      setRecipientTagsError(err.response?.data?.error?.message || 'Failed to remove tag.');
    } finally {
      setRecipientTagsSubmitting(false);
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
              <h1 className="page-title">Recipients</h1>
              <p className="page-subtitle">
                Manage your WhatsApp recipients, eligibility and audience information.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={handleRefresh}
                disabled={loading}
                title="Refresh recipients"
                className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                <RefreshCw
                  className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                {loading ? 'Refreshing' : 'Refresh'}
              </button>
              <Link
                to="/recipients/import"
                className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted"
              >
                <Upload className="h-[18px] w-[18px] text-primary" aria-hidden="true" />
                Import
              </Link>
              <button
                onClick={openTagManager}
                className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted"
              >
                <TagIcon className="h-[18px] w-[18px] text-primary" aria-hidden="true" />
                Manage Tags
              </button>
              <button
                onClick={openQuickAdd}
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-card transition-colors hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
                + Add Recipient
              </button>
            </div>
          </div>

          {successMessage && (
            <div className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/10 px-4 py-3">
              <CheckCircle className="h-5 w-5 shrink-0 text-success" aria-hidden="true" />
              <span className="text-[13px] font-medium text-success">{successMessage}</span>
            </div>
          )}

          {statusError && (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3">
              <AlertCircle className="h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
              <span className="text-[13px] font-medium text-destructive">{statusError}</span>
            </div>
          )}

          {/* Summary row. All figures are derived from the rows this page has
              already loaded, so no new metrics or API fields are introduced. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                key: 'total',
                label: 'Recipients in this view',
                value: totalCount,
                hint: 'Distinct recipient records, matched to the current filters',
                icon: <UsersIcon className="h-5 w-5 text-primary" aria-hidden="true" />,
                dot: 'bg-primary',
              },
              {
                key: 'active',
                label: 'Active',
                value: activeCount,
                hint: 'Eligible to receive messages',
                icon: <UserCheck className="h-5 w-5 text-success" aria-hidden="true" />,
                dot: 'bg-success',
              },
              {
                key: 'paused',
                label: 'Paused',
                value: pausedCount,
                hint: 'Temporarily excluded',
                icon: <UserX className="h-5 w-5 text-warning" aria-hidden="true" />,
                dot: 'bg-warning',
              },
              {
                key: 'tagged',
                label: 'With Tags',
                value: taggedCount,
                hint: 'Assigned to audience cohorts',
                icon: <TagIcon className="h-5 w-5 text-info" aria-hidden="true" />,
                dot: 'bg-info',
              },
            ].map((card) => (
              <div key={card.key} className="app-card flex flex-col justify-between p-4">
                <div className="flex items-center justify-between text-muted-foreground">
                  <span className="text-[11px] font-semibold uppercase tracking-wider">{card.label}</span>
                  {card.icon}
                </div>
                <div className="mt-3">
                  <div className="text-2xl font-bold tabular-nums tracking-tight text-foreground">
                    {card.value.toLocaleString()}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-[13px] text-muted-foreground">
                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${card.dot}`} aria-hidden="true" />
                    <span>{card.hint}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Search + filter toolbar */}
          <div className="app-card flex flex-col gap-4 p-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="flex flex-1 flex-wrap items-end gap-3">
              <div className="relative min-w-0 flex-1 sm:max-w-md">
                <SearchIcon
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search by name, phone or tag..."
                  aria-label="Search recipients"
                  className="h-10 w-full rounded-lg border border-input bg-card pl-9 pr-3 text-[13px] text-foreground shadow-card transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                {searchTerm && (
                  <button
                    onClick={() => setSearchTerm('')}
                    className="absolute inset-y-0 right-0 flex items-center pr-3 text-muted-foreground transition-colors hover:text-foreground"
                    title="Clear search"
                    aria-label="Clear search"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                )}
              </div>

              <FilterSelect
                id="status-filter"
                label="Status"
                value={statusFilter}
                onChange={setStatusFilter}
              >
                <option value="">All Statuses</option>
                <option value="ACTIVE">Active</option>
                <option value="PAUSED">Paused</option>
                <option value="UNSUBSCRIBED">Unsubscribed</option>
                <option value="INVALID">Invalid</option>
                <option value="BLOCKED">Blocked</option>
              </FilterSelect>

              <FilterSelect
                id="language-filter"
                label="Language"
                value={languageFilter}
                onChange={setLanguageFilter}
              >
                <option value="">All Languages</option>
                {availableLanguages.map((lang) => (
                  <option key={lang} value={lang}>
                    {lang}
                  </option>
                ))}
              </FilterSelect>

              <FilterSelect id="tag-filter" label="Tag" value={tagFilter} onChange={setTagFilter}>
                <option value="">All Tags</option>
                {tags.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
              </FilterSelect>

              {filtersActive && (
                <button
                  onClick={clearFilters}
                  className="h-10 px-1 text-[13px] text-muted-foreground underline transition-colors hover:text-foreground"
                >
                  Clear filters
                </button>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5 self-end text-[13px] text-muted-foreground lg:self-auto">
              <span className="font-semibold tabular-nums text-foreground">{totalCount}</span>
              <span>total records</span>
            </div>
          </div>

          <BulkActionsBar<Recipient>
            visibleIds={visibleRecipientIds}
            selectedIds={selectedIds}
            onToggleAll={toggleAllVisibleRecipients}
            onClear={() => setSelectedIds([])}
            busy={bulkBusy}
            deleteLabel="Delete Selected"
            onDeleteSelected={() => bulkDeleteRecipients()}
            onDeletePermanent={() => bulkDeleteRecipients(true)}
            permanentDeleteWarning="Some selected recipients belong to campaigns. Permanently deleting them will remove their campaign memberships and delivery-history associations. Continue?"
            result={bulkResult}
            onDismissResult={() => setBulkResult(null)}
            describe={(id) => {
              const r = recipientById(id);
              return r ? `${r.name} (${r.whatsappNumber})` : id;
            }}
          />

          <div className="app-card overflow-hidden">
            {loading ? (
              <div className="p-6 text-center text-[13px] text-muted-foreground">Loading recipients...</div>
            ) : error ? (
              <div className="flex flex-col items-center px-4 py-12 text-center">
                <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
                  <AlertCircle className="h-6 w-6 text-destructive" aria-hidden="true" />
                </div>
                <p className="card-title">Could not load recipients</p>
                <p className="mt-1 max-w-md text-[13px] text-muted-foreground">{error}</p>
                <button
                  onClick={() => {
                    setLoading(true);
                    fetchRecipients();
                  }}
                  className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted"
                >
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  Retry
                </button>
              </div>
            ) : recipients.length === 0 && (searchTerm || filtersActive) ? (
              <div className="m-4 flex flex-col items-center rounded-lg bg-muted px-4 py-10 text-center">
                <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-card">
                  <SearchIcon className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
                </div>
                <h3 className="card-title">No recipients found</h3>
                <p className="mt-1 max-w-md text-[13px] text-muted-foreground">
                  {searchTerm
                    ? `No recipients match the filter criteria "${searchTerm}".`
                    : 'No recipients match the selected filters.'}{' '}
                  Try adjusting or clearing your filters.
                </p>
                <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                  {searchTerm && (
                    <button
                      onClick={() => setSearchTerm('')}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted"
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                      Clear search
                    </button>
                  )}
                  {filtersActive && (
                    <button
                      onClick={clearFilters}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted"
                    >
                      <RefreshCw className="h-4 w-4" aria-hidden="true" />
                      Reset all filters
                    </button>
                  )}
                </div>
              </div>
            ) : recipients.length === 0 ? (
              <div className="flex flex-col items-center px-4 py-12 text-center">
                <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                  <UsersIcon className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
                </div>
                <h3 className="card-title">No recipients yet</h3>
                <p className="mt-1 max-w-md text-[13px] text-muted-foreground">
                  Import recipients from a spreadsheet or add the first contact to get started.
                </p>
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  <button
                    onClick={openQuickAdd}
                    className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-card transition-colors hover:opacity-95"
                  >
                    <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
                    + Add Recipient
                  </button>
                  <Link
                    to="/recipients/import"
                    className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted"
                  >
                    <Download className="h-[18px] w-[18px] text-primary" aria-hidden="true" />
                    Import file
                  </Link>
                </div>
              </div>
            ) : (
              <div className="overflow-x-auto">
              <table className="min-w-[760px] sm:min-w-full divide-y divide-border">
                <thead className="bg-muted">
                  <tr>
                    <th scope="col" className="w-10 px-4 py-3">
                      <span className="sr-only">Select</span>
                    </th>
                    <th scope="col" className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Name</th>
                    <th scope="col" className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">WhatsApp Number</th>
                    <th scope="col" className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Language</th>
                    <th scope="col" className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Tags</th>
                    <th scope="col" className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Status</th>
                    <th scope="col" className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Updated</th>
                    <th scope="col" className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Source</th>
                    <th scope="col" className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {recipients.map((recipient) => (
                    <tr
                      key={recipient.id}
                      className={selectedIds.includes(recipient.id) ? 'bg-muted/50' : undefined}
                    >
                      <td className="px-4 py-3">
                        <RowCheckbox
                          checked={selectedIds.includes(recipient.id)}
                          onChange={() => toggleRecipient(recipient.id)}
                          disabled={bulkBusy}
                          label={`Select ${recipient.name}`}
                        />
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span
                            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${avatarColorClass(recipient.id)}`}
                            aria-hidden="true"
                          >
                            {initialsFor(recipient.name)}
                          </span>
                          <span className="table-text font-medium">{recipient.name}</span>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 table-text text-muted-foreground">
                        {recipient.whatsappNumber}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-[13px] text-muted-foreground">
                        {recipient.language || '-'}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <div className="flex max-w-xs flex-wrap items-center gap-1">
                          {recipient.tags && recipient.tags.length > 0 ? (
                            recipient.tags.map((rt) =>
                              rt.tag ? (
                                <span
                                  key={rt.tag.id}
                                  className={`h-5 rounded px-2 text-[11px] font-semibold uppercase tracking-wider ${tagColorClass(tagSeed(rt.tag))}`}
                                >
                                  {rt.tag.name}
                                </span>
                              ) : null
                            )
                          ) : (
                            <span className="text-[13px] text-muted-foreground">-</span>
                          )}
                          <button
                            onClick={() => openRecipientTags(recipient)}
                            className="inline-flex h-5 items-center gap-0.5 rounded border border-dashed border-border px-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                            title="Manage tags for this recipient"
                          >
                            <Plus className="h-3 w-3" aria-hidden="true" />
                            Tags
                          </button>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-semibold uppercase tracking-wider ${statusBadgeClass(recipient.status)}`}
                          >
                            <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                            {recipient.status}
                          </span>
                          {statusUpdatingId === recipient.id ? (
                            <span className="text-[11px] text-muted-foreground">Updating...</span>
                          ) : (
                            <select
                              value={recipient.status}
                              onChange={(e) => {
                                const val = e.target.value;
                                if (val === 'UNSUBSCRIBED') {
                                  openUnsubscribe(recipient);
                                } else {
                                  handleStatusChange(recipient, val);
                                }
                              }}
                              aria-label={`Change status for ${recipient.name}`}
                              className="h-7 rounded-md border border-input bg-card px-1.5 text-[11px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <option value="ACTIVE">ACTIVE</option>
                              <option value="PAUSED">PAUSED</option>
                              <option value="UNSUBSCRIBED">UNSUBSCRIBED</option>
                            </select>
                          )}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 table-text text-muted-foreground">
                        {formatUpdated(recipient.updatedAt)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-[13px] text-muted-foreground">
                        {recipient.source}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => openView(recipient)}
                            title="View details"
                            aria-label={`View ${recipient.name}`}
                            className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          >
                            <Eye className="h-4 w-4" aria-hidden="true" />
                            View
                          </button>
                          <button
                            onClick={() => openEdit(recipient)}
                            title="Edit recipient"
                            aria-label={`Edit ${recipient.name}`}
                            className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-primary transition-colors hover:bg-primary/10"
                          >
                            <Pencil className="h-4 w-4" aria-hidden="true" />
                            Edit
                          </button>
                          <button
                            onClick={() => openDelete(recipient)}
                            title="Delete recipient"
                            aria-label={`Delete ${recipient.name}`}
                            className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-destructive transition-colors hover:bg-destructive/10"
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Quick Add Modal */}
      {showQuickAdd && (
        <div className="fixed inset-0 z-50 overflow-y-auto" aria-labelledby="quick-add-title" role="dialog" aria-modal="true">
          <div className="flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            <div className="fixed inset-0 bg-foreground/50 backdrop-blur-[1px] transition-opacity" onClick={closeQuickAdd} aria-hidden="true"></div>

            <span className="hidden sm:inline-block sm:align-middle sm:h-screen" aria-hidden="true">&#8203;</span>

            <div className="app-card inline-block w-full max-w-lg transform overflow-hidden text-left transition-all sm:my-8 sm:align-middle">
              <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                <h3 className="text-base font-semibold tracking-tight text-foreground" id="quick-add-title">Quick Add Recipient</h3>
                <button
                  onClick={closeQuickAdd}
                  disabled={submitting}
                  className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <form onSubmit={handleQuickAddSubmit} className="space-y-4 p-5">
                {formError && (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3">
                    <AlertCircle className="h-4 w-4 flex-shrink-0 text-destructive" />
                    <span className="text-[13px] font-medium text-destructive">{formError}</span>
                  </div>
                )}

                <div className="space-y-4">
                  <div>
                    <label htmlFor="name" className="block text-[13px] font-medium text-foreground">
                      Name <span className="text-destructive">*</span>
                    </label>
                    <input
                      type="text"
                      id="name"
                      name="name"
                      value={form.name}
                      onChange={handleInputChange}
                      required
                      placeholder="e.g. John Doe"
                      className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>

                  <div>
                    <label htmlFor="whatsappNumber" className="block text-[13px] font-medium text-foreground">
                      WhatsApp Number <span className="text-destructive">*</span>
                    </label>
                    <input
                      type="tel"
                      id="whatsappNumber"
                      name="whatsappNumber"
                      value={form.whatsappNumber}
                      onChange={handleInputChange}
                      required
                      placeholder="e.g. +91 98765 43210"
                      className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="language" className="block text-[13px] font-medium text-foreground">
                        Language
                      </label>
                      <input
                        type="text"
                        id="language"
                        name="language"
                        value={form.language}
                        onChange={handleInputChange}
                        placeholder="e.g. English"
                        className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    </div>

                    <div>
                      <label htmlFor="category" className="block text-[13px] font-medium text-foreground">
                        Category
                      </label>
                      <input
                        type="text"
                        id="category"
                        name="category"
                        value={form.category}
                        onChange={handleInputChange}
                        placeholder="e.g. VIP"
                        className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="consentStatus" className="block text-[13px] font-medium text-foreground">
                        Consent Status
                      </label>
                      <select
                        id="consentStatus"
                        name="consentStatus"
                        value={form.consentStatus}
                        onChange={handleInputChange}
                        className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus:outline-none focus:ring-2 focus:ring-ring"
                      >
                        <option value="">Select consent status</option>
                        <option value="GRANTED">Granted</option>
                        <option value="PENDING">Pending</option>
                        <option value="REVOKED">Revoked</option>
                      </select>
                    </div>

                    <div>
                      <label htmlFor="consentTimestamp" className="block text-[13px] font-medium text-foreground">
                        Consent Timestamp
                      </label>
                      <input
                        type="datetime-local"
                        id="consentTimestamp"
                        name="consentTimestamp"
                        value={form.consentTimestamp}
                        onChange={handleInputChange}
                        className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor="notes" className="block text-[13px] font-medium text-foreground">
                      Notes
                    </label>
                    <textarea
                      id="notes"
                      name="notes"
                      value={form.notes}
                      onChange={handleInputChange}
                      rows={3}
                      placeholder="Optional notes about this recipient"
                      className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </div>

                <div className="mt-6 flex justify-end space-x-3">
                  <button
                    type="button"
                    onClick={closeQuickAdd}
                    disabled={submitting}
                    className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-card transition-colors hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
                  >
                    {submitting ? 'Adding...' : 'Add Recipient'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {showEdit && (
        <div className="fixed inset-0 z-50 overflow-y-auto" aria-labelledby="edit-title" role="dialog" aria-modal="true">
          <div className="flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            <div className="fixed inset-0 bg-foreground/50 backdrop-blur-[1px] transition-opacity" onClick={closeEdit} aria-hidden="true"></div>

            <span className="hidden sm:inline-block sm:align-middle sm:h-screen" aria-hidden="true">&#8203;</span>

            <div className="app-card inline-block w-full max-w-lg transform overflow-hidden text-left transition-all sm:my-8 sm:align-middle">
              <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                <h3 className="text-base font-semibold tracking-tight text-foreground" id="edit-title">Edit Recipient</h3>
                <button
                  onClick={closeEdit}
                  disabled={editSubmitting}
                  className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <form onSubmit={handleEditSubmit} className="space-y-4 p-5">
                {editError && (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3">
                    <AlertCircle className="h-4 w-4 flex-shrink-0 text-destructive" />
                    <span className="text-[13px] font-medium text-destructive">{editError}</span>
                  </div>
                )}

                <div className="space-y-4">
                  <div>
                    <label htmlFor="edit-name" className="block text-[13px] font-medium text-foreground">
                      Name <span className="text-destructive">*</span>
                    </label>
                    <input
                      type="text"
                      id="edit-name"
                      name="name"
                      value={editForm.name}
                      onChange={handleEditInputChange}
                      required
                      placeholder="e.g. John Doe"
                      className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>

                  <div>
                    <label htmlFor="edit-whatsappNumber" className="block text-[13px] font-medium text-foreground">
                      WhatsApp Number <span className="text-destructive">*</span>
                    </label>
                    <input
                      type="tel"
                      id="edit-whatsappNumber"
                      name="whatsappNumber"
                      value={editForm.whatsappNumber}
                      onChange={handleEditInputChange}
                      required
                      placeholder="e.g. +91 98765 43210"
                      className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="edit-language" className="block text-[13px] font-medium text-foreground">
                        Language
                      </label>
                      <input
                        type="text"
                        id="edit-language"
                        name="language"
                        value={editForm.language}
                        onChange={handleEditInputChange}
                        placeholder="e.g. English"
                        className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    </div>

                    <div>
                      <label htmlFor="edit-category" className="block text-[13px] font-medium text-foreground">
                        Category
                      </label>
                      <input
                        type="text"
                        id="edit-category"
                        name="category"
                        value={editForm.category}
                        onChange={handleEditInputChange}
                        placeholder="e.g. VIP"
                        className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="edit-consentStatus" className="block text-[13px] font-medium text-foreground">
                        Consent Status
                      </label>
                      <select
                        id="edit-consentStatus"
                        name="consentStatus"
                        value={editForm.consentStatus}
                        onChange={handleEditInputChange}
                        className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus:outline-none focus:ring-2 focus:ring-ring"
                      >
                        <option value="">Select consent status</option>
                        <option value="GRANTED">Granted</option>
                        <option value="PENDING">Pending</option>
                        <option value="REVOKED">Revoked</option>
                      </select>
                    </div>

                    <div>
                      <label htmlFor="edit-consentTimestamp" className="block text-[13px] font-medium text-foreground">
                        Consent Timestamp
                      </label>
                      <input
                        type="datetime-local"
                        id="edit-consentTimestamp"
                        name="consentTimestamp"
                        value={editForm.consentTimestamp}
                        onChange={handleEditInputChange}
                        className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor="edit-notes" className="block text-[13px] font-medium text-foreground">
                      Notes
                    </label>
                    <textarea
                      id="edit-notes"
                      name="notes"
                      value={editForm.notes}
                      onChange={handleEditInputChange}
                      rows={3}
                      placeholder="Optional notes about this recipient"
                      className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </div>

                <div className="mt-6 flex justify-end space-x-3">
                  <button
                    type="button"
                    onClick={closeEdit}
                    disabled={editSubmitting}
                    className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={editSubmitting}
                    className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-card transition-colors hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
                  >
                    {editSubmitting ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* View Modal */}
      {showView && (
        <div className="fixed inset-0 z-50 overflow-y-auto" aria-labelledby="view-title" role="dialog" aria-modal="true">
          <div className="flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            <div className="fixed inset-0 bg-foreground/50 backdrop-blur-[1px] transition-opacity" onClick={closeView} aria-hidden="true"></div>

            <span className="hidden sm:inline-block sm:align-middle sm:h-screen" aria-hidden="true">&#8203;</span>

            <div className="app-card inline-block w-full max-w-lg transform overflow-hidden text-left transition-all sm:my-8 sm:align-middle">
              <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                <h3 className="text-base font-semibold tracking-tight text-foreground" id="view-title">Recipient Details</h3>
                <button
                  onClick={closeView}
                  className="text-muted-foreground transition-colors hover:text-foreground"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="space-y-4 p-5">
                {viewLoading ? (
                  <div className="py-8 text-center text-[13px] text-muted-foreground">Loading recipient details...</div>
                ) : viewError ? (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3">
                    <AlertCircle className="h-4 w-4 flex-shrink-0 text-destructive" />
                    <span className="text-[13px] font-medium text-destructive">{viewError}</span>
                  </div>
                ) : viewRecipient ? (
                  <dl className="space-y-4">
                    <div>
                      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Name</dt>
                      <dd className="mt-1 text-[13px] text-foreground">{viewRecipient.name}</dd>
                    </div>
                    <div>
                      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">WhatsApp Number</dt>
                      <dd className="mt-1 text-[13px] text-foreground">{viewRecipient.whatsappNumber}</dd>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Language</dt>
                        <dd className="mt-1 text-[13px] text-foreground">{viewRecipient.language || '-'}</dd>
                      </div>
                      <div>
                        <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Category</dt>
                        <dd className="mt-1 text-[13px] text-foreground">{viewRecipient.category || '-'}</dd>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Consent Status</dt>
                        <dd className="mt-1 text-[13px] text-foreground">{viewRecipient.consentStatus || '-'}</dd>
                      </div>
                      <div>
                        <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Consent Timestamp</dt>
                        <dd className="mt-1 text-[13px] text-foreground">
                          {viewRecipient.consentTimestamp ? new Date(viewRecipient.consentTimestamp).toLocaleString() : '-'}
                        </dd>
                      </div>
                    </div>
                    <div>
                      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Notes</dt>
                      <dd className="mt-1 text-[13px] text-foreground">{viewRecipient.notes || '-'}</dd>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Source</dt>
                        <dd className="mt-1 text-[13px] text-foreground">{viewRecipient.source}</dd>
                      </div>
                      <div>
                        <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Status</dt>
                        <dd className="mt-1 text-sm">
                          <span className="inline-flex h-5 items-center gap-1 rounded-full border border-success/40 bg-success/10 px-2 text-[11px] font-semibold uppercase tracking-wider text-success">
                            {viewRecipient.status}
                          </span>
                        </dd>
                      </div>
                    </div>
                    <div>
                      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Tags</dt>
                      <dd className="mt-1 text-[13px] text-foreground">
                        {viewRecipient.tags && viewRecipient.tags.length > 0
                          ? viewRecipient.tags.map((rt) => rt.tag?.name).filter(Boolean).join(', ')
                          : '-'}
                      </dd>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Created At</dt>
                        <dd className="mt-1 text-[13px] text-foreground">
                          {viewRecipient.createdAt ? new Date(viewRecipient.createdAt).toLocaleString() : '-'}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Updated At</dt>
                        <dd className="mt-1 text-[13px] text-foreground">
                          {viewRecipient.updatedAt ? new Date(viewRecipient.updatedAt).toLocaleString() : '-'}
                        </dd>
                      </div>
                    </div>
                  </dl>
                ) : null}
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-border bg-muted px-5 py-3">
                <button
                  type="button"
                  onClick={closeView}
                  className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDelete && deleteRecipient && (
        <div className="fixed inset-0 z-50 overflow-y-auto" aria-labelledby="delete-title" role="dialog" aria-modal="true">
          <div className="flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            <div className="fixed inset-0 bg-foreground/50 backdrop-blur-[1px] transition-opacity" onClick={closeDelete} aria-hidden="true"></div>

            <span className="hidden sm:inline-block sm:align-middle sm:h-screen" aria-hidden="true">&#8203;</span>

            <div className="app-card inline-block w-full max-w-md transform overflow-hidden text-left transition-all sm:my-8 sm:align-middle">
              <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                <h3 className="text-base font-semibold tracking-tight text-foreground" id="delete-title">Delete Recipient</h3>
                <button
                  onClick={closeDelete}
                  disabled={deleteSubmitting}
                  className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="space-y-4 p-5">
                {deleteError && (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3">
                    <AlertCircle className="h-4 w-4 flex-shrink-0 text-destructive" />
                    <span className="text-[13px] font-medium text-destructive">{deleteError}</span>
                  </div>
                )}

                <div className="space-y-4">
                  <div>
                    <p className="text-[13px] text-foreground">
                      Are you sure you want to delete this recipient?
                    </p>
                  </div>
                  <div className="space-y-2 rounded-lg bg-muted p-4">
                    <div className="flex justify-between">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Name</span>
                      <span className="text-[13px] text-foreground">{deleteRecipient.name}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">WhatsApp Number</span>
                      <span className="text-[13px] text-foreground">{deleteRecipient.whatsappNumber}</span>
                    </div>
                  </div>
                  <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3">
                    <p className="text-[13px] font-medium text-destructive">
                      <span className="font-semibold">Warning:</span> This action cannot be undone. The recipient and all associated data will be permanently deleted.
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-border bg-muted px-5 py-3">
                <button
                  type="button"
                  onClick={closeDelete}
                  disabled={deleteSubmitting}
                  className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDeleteConfirm}
                  disabled={deleteSubmitting}
                  className="inline-flex h-10 items-center gap-2 rounded-lg bg-destructive px-4 text-sm font-semibold text-destructive-foreground shadow-card transition-colors hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4 mr-1" />
                  {deleteSubmitting ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Unsubscribe Confirmation Modal */}
      {showUnsubscribe && unsubscribeRecipient && (
        <div className="fixed inset-0 z-50 overflow-y-auto" aria-labelledby="unsubscribe-title" role="dialog" aria-modal="true">
          <div className="flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            <div className="fixed inset-0 bg-foreground/50 backdrop-blur-[1px] transition-opacity" onClick={closeUnsubscribe} aria-hidden="true"></div>

            <span className="hidden sm:inline-block sm:align-middle sm:h-screen" aria-hidden="true">&#8203;</span>

            <div className="app-card inline-block w-full max-w-md transform overflow-hidden text-left transition-all sm:my-8 sm:align-middle">
              <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                <h3 className="text-base font-semibold tracking-tight text-foreground" id="unsubscribe-title">Unsubscribe Recipient</h3>
                <button
                  onClick={closeUnsubscribe}
                  disabled={unsubscribeSubmitting}
                  className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="space-y-4 p-5">
                {unsubscribeError && (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3">
                    <AlertCircle className="h-4 w-4 flex-shrink-0 text-destructive" />
                    <span className="text-[13px] font-medium text-destructive">{unsubscribeError}</span>
                  </div>
                )}

                <div className="space-y-4">
                  <div>
                    <p className="text-[13px] text-foreground">
                      Are you sure you want to unsubscribe this recipient?
                    </p>
                  </div>
                  <div className="space-y-2 rounded-lg bg-muted p-4">
                    <div className="flex justify-between">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Name</span>
                      <span className="text-[13px] text-foreground">{unsubscribeRecipient.name}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">WhatsApp Number</span>
                      <span className="text-[13px] text-foreground">{unsubscribeRecipient.whatsappNumber}</span>
                    </div>
                  </div>
                  <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
                    <p className="text-sm text-yellow-700 dark:text-yellow-400">
                      <span className="font-semibold">Warning:</span> Unsubscribed recipients will not be included in future messaging campaigns. This does not delete the recipient.
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-border bg-muted px-5 py-3">
                <button
                  type="button"
                  onClick={closeUnsubscribe}
                  disabled={unsubscribeSubmitting}
                  className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleUnsubscribeConfirm}
                  disabled={unsubscribeSubmitting}
                  className="inline-flex h-10 items-center gap-2 rounded-lg bg-destructive px-4 text-sm font-semibold text-destructive-foreground shadow-card transition-colors hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
                >
                  {unsubscribeSubmitting ? 'Unsubscribing...' : 'Unsubscribe'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tag Manager Modal */}
      {showTagManager && (
        <div className="fixed inset-0 z-50 overflow-y-auto" aria-labelledby="tag-manager-title" role="dialog" aria-modal="true">
          <div className="flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            <div className="fixed inset-0 bg-foreground/50 backdrop-blur-[1px] transition-opacity" onClick={closeTagManager} aria-hidden="true"></div>

            <span className="hidden sm:inline-block sm:align-middle sm:h-screen" aria-hidden="true">&#8203;</span>

            <div className="app-card inline-block w-full max-w-lg transform overflow-hidden text-left transition-all sm:my-8 sm:align-middle">
              <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                <h3 className="text-base font-semibold tracking-tight text-foreground" id="tag-manager-title">Manage Tags</h3>
                <button
                  onClick={closeTagManager}
                  disabled={tagSubmitting || deleteTagSubmitting}
                  className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="space-y-4 p-5">
                {tagError && (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3">
                    <AlertCircle className="h-4 w-4 flex-shrink-0 text-destructive" />
                    <span className="text-[13px] font-medium text-destructive">{tagError}</span>
                  </div>
                )}

                <form onSubmit={handleCreateTag} className="flex space-x-2 mb-4">
                  <input
                    type="text"
                    value={newTagName}
                    onChange={(e) => setNewTagName(e.target.value)}
                    placeholder="New tag name"
                    className="h-10 flex-1 rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <button
                    type="submit"
                    disabled={tagSubmitting || !newTagName.trim()}
                    className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-card transition-colors hover:opacity-95 disabled:opacity-50"
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Create
                  </button>
                </form>

                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {tags.length === 0 ? (
                    <p className="py-4 text-center text-[13px] text-muted-foreground">No tags yet. Create one above.</p>
                  ) : (
                    tags.map((tag) => (
                      <div key={tag.id} className="flex items-center justify-between rounded-lg bg-muted px-3 py-2">
                        {renamingTagId === tag.id ? (
                          <div className="flex-1 flex space-x-2">
                            <input
                              type="text"
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              className="h-8 flex-1 rounded-lg border border-input bg-card px-2 text-[13px] text-foreground shadow-card focus:outline-none focus:ring-2 focus:ring-ring"
                            />
                            <button
                              onClick={() => handleRenameTag(tag.id)}
                              disabled={tagSubmitting || !renameValue.trim()}
                              className="text-sm text-blue-600 hover:text-blue-800 disabled:opacity-50"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => setRenamingTagId(null)}
                              disabled={tagSubmitting}
                              className="text-[13px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <>
                            <div>
                              <span className="text-[13px] text-foreground">{tag.name}</span>
                              <span className="ml-2 text-[11px] text-muted-foreground">
                                {tag._count?.recipients ?? 0} recipient{(tag._count?.recipients ?? 0) === 1 ? '' : 's'}
                              </span>
                            </div>
                            <div className="flex space-x-3">
                              <button
                                onClick={() => startRenameTag(tag)}
                                disabled={tagSubmitting}
                                className="text-blue-600 hover:text-blue-800 dark:text-blue-400 disabled:opacity-50"
                                title="Rename tag"
                              >
                                <Pencil className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => openTagDelete(tag)}
                                disabled={tagSubmitting}
                                className="text-[13px] font-medium text-destructive transition-colors hover:opacity-80 disabled:opacity-50"
                                title="Delete tag"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-border bg-muted px-5 py-3">
                <button
                  type="button"
                  onClick={closeTagManager}
                  disabled={tagSubmitting || deleteTagSubmitting}
                  className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tag Delete Confirmation Modal */}
      {showTagDelete && deleteTagTarget && (
        <div className="fixed inset-0 z-[60] overflow-y-auto" aria-labelledby="tag-delete-title" role="dialog" aria-modal="true">
          <div className="flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            <div className="fixed inset-0 bg-foreground/50 backdrop-blur-[1px] transition-opacity" onClick={closeTagDelete} aria-hidden="true"></div>

            <span className="hidden sm:inline-block sm:align-middle sm:h-screen" aria-hidden="true">&#8203;</span>

            <div className="app-card inline-block w-full max-w-md transform overflow-hidden text-left transition-all sm:my-8 sm:align-middle">
              <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                <h3 className="text-base font-semibold tracking-tight text-foreground" id="tag-delete-title">Delete Tag</h3>
                <button
                  onClick={closeTagDelete}
                  disabled={deleteTagSubmitting}
                  className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="space-y-4 p-5">
                {deleteTagError && (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3">
                    <AlertCircle className="h-4 w-4 flex-shrink-0 text-destructive" />
                    <span className="text-[13px] font-medium text-destructive">{deleteTagError}</span>
                  </div>
                )}

                <div className="space-y-4">
                  <p className="text-[13px] text-foreground">
                    Are you sure you want to delete the tag <span className="font-semibold">"{deleteTagTarget.name}"</span>?
                  </p>
                  <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3">
                    <p className="text-[13px] font-medium text-destructive">
                      <span className="font-semibold">Warning:</span> This tag will be removed from all recipients. This action cannot be undone.
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-border bg-muted px-5 py-3">
                <button
                  type="button"
                  onClick={closeTagDelete}
                  disabled={deleteTagSubmitting}
                  className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleTagDeleteConfirm}
                  disabled={deleteTagSubmitting}
                  className="inline-flex h-10 items-center gap-2 rounded-lg bg-destructive px-4 text-sm font-semibold text-destructive-foreground shadow-card transition-colors hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4 mr-1" />
                  {deleteTagSubmitting ? 'Deleting...' : 'Delete Tag'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Recipient Tags Modal */}
      {showRecipientTags && recipientTagsTarget && (
        <div className="fixed inset-0 z-50 overflow-y-auto" aria-labelledby="recipient-tags-title" role="dialog" aria-modal="true">
          <div className="flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            <div className="fixed inset-0 bg-foreground/50 backdrop-blur-[1px] transition-opacity" onClick={closeRecipientTags} aria-hidden="true"></div>

            <span className="hidden sm:inline-block sm:align-middle sm:h-screen" aria-hidden="true">&#8203;</span>

            <div className="app-card inline-block w-full max-w-lg transform overflow-hidden text-left transition-all sm:my-8 sm:align-middle">
              <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                <h3 className="text-base font-semibold tracking-tight text-foreground" id="recipient-tags-title">
                  Tags for {recipientTagsTarget.name}
                </h3>
                <button
                  onClick={closeRecipientTags}
                  disabled={recipientTagsSubmitting}
                  className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="space-y-4 p-5">
                {recipientTagsError && (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3">
                    <AlertCircle className="h-4 w-4 flex-shrink-0 text-destructive" />
                    <span className="text-[13px] font-medium text-destructive">{recipientTagsError}</span>
                  </div>
                )}

                <div className="mb-4">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Assigned Tags</p>
                  <div className="flex flex-wrap gap-2">
                    {recipientTagsTarget.tags && recipientTagsTarget.tags.length > 0 ? (
                      recipientTagsTarget.tags.map((rt) =>
                        rt.tag ? (
                          <span key={rt.tag.id} className={`inline-flex h-5 items-center rounded px-2 text-[11px] font-semibold uppercase tracking-wider ${tagColorClass(tagSeed(rt.tag))}`}>
                            {rt.tag.name}
                            <button
                              onClick={() => handleRemoveTag(rt.tag!.id)}
                              disabled={recipientTagsSubmitting}
                              className="ml-1.5 text-blue-600 hover:text-blue-900 dark:text-blue-300 disabled:opacity-50"
                              title="Remove tag"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </span>
                        ) : null
                      )
                    ) : (
                      <span className="text-[13px] text-muted-foreground">No tags assigned yet.</span>
                    )}
                  </div>
                </div>

                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Available Tags</p>
                  <div className="flex flex-wrap gap-2">
                    {tags.filter((t) => !(recipientTagsTarget.tags || []).some((rt) => rt.tag?.id === t.id)).length === 0 ? (
                      <span className="text-[13px] text-muted-foreground">
                        {tags.length === 0 ? 'No tags exist. Use "Manage Tags" to create some.' : 'All tags are already assigned.'}
                      </span>
                    ) : (
                      tags
                        .filter((t) => !(recipientTagsTarget.tags || []).some((rt) => rt.tag?.id === t.id))
                        .map((tag) => (
                          <button
                            key={tag.id}
                            onClick={() => handleAssignTag(tag.id)}
                            disabled={recipientTagsSubmitting}
                            className="inline-flex h-5 items-center rounded border border-dashed border-border px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
                          >
                            <Plus className="h-3 w-3 mr-1" />
                            {tag.name}
                          </button>
                        ))
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-border bg-muted px-5 py-3">
                <button
                  type="button"
                  onClick={closeRecipientTags}
                  disabled={recipientTagsSubmitting}
                  className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
