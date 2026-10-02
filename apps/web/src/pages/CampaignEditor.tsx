import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import { Sidebar } from '../components/Sidebar';
import { ArrowLeft, AlertCircle } from 'lucide-react';

const ALLOWED_STATUSES = ['DRAFT', 'READY', 'ARCHIVED'] as const;
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const RECIPIENT_STATUSES = ['ACTIVE', 'PAUSED', 'UNSUBSCRIBED', 'INVALID', 'BLOCKED'] as const;
// Same debounce the Recipients page uses for its API search.
const RECIPIENT_SEARCH_DEBOUNCE_MS = 300;

interface CampaignEditorProps {
  mode: 'new' | 'edit';
}

interface LoadedCampaign {
  name: string;
  description: string | null;
  status: string;
  messageId: string | null;
}

interface MessageOption {
  id: string;
  name: string;
  status: string;
}

interface AudienceRecipient {
  id: string;
  name: string;
  whatsappNumber: string;
  normalizedPhone: string;
  language: string | null;
  category: string | null;
  status: string;
  source: string;
  tags?: { tag?: { id: string; name: string } | null }[];
}

interface TagOption {
  id: string;
  name: string;
}

// Phase 4.3 — review & finalization types
interface CampaignIssue {
  code: string;
  message: string;
}

interface CampaignReadiness {
  valid: boolean;
  issues: CampaignIssue[];
  audienceCount: number;
}

interface MessageMedia {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

interface MessageDetail {
  id: string;
  name: string;
  body: string;
  status: string;
  media: MessageMedia | null;
}

// Phase 4.4 — scheduling
type ScheduleStatus = 'SCHEDULED' | 'CANCELLED';

interface CampaignSchedule {
  id: string;
  campaignId: string;
  scheduledAt: string;
  timezone: string;
  status: ScheduleStatus | string;
  createdAt: string;
  updatedAt: string;
}

interface SchedulePayload {
  scheduledAt: string;
  timezone: string;
}

// Only used when the runtime cannot enumerate timezone identifiers.
const FALLBACK_TIMEZONES = [
  'UTC',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
];

// Practical selector list: the platform's own timezone identifiers when
// available, otherwise a short fallback. Validation stays server-side.
function listTimezones(): string[] {
  try {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf;
    if (typeof supported === 'function') {
      const zones = supported('timeZone');
      if (Array.isArray(zones) && zones.length > 0) return zones;
    }
  } catch {
    // fall through to the short list
  }
  return FALLBACK_TIMEZONES;
}

// The browser zone is only a *default*; the administrator can change it.
function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// Renders a stored instant as the wall clock of the timezone it was planned in,
// so the displayed value never silently switches to the browser's zone.
function wallClockInTimezone(iso: string, timezone: string): { date: string; time: string } {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return { date: '', time: '' };
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(instant);
  } catch {
    return { date: '', time: '' };
  }
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const hour = read('hour') === '24' ? '00' : read('hour');
  return {
    date: `${read('year')}-${read('month')}-${read('day')}`,
    time: `${hour}:${read('minute')}`,
  };
}

function formatScheduleDate(iso: string, timezone: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      day: 'numeric',
      month: 'long',
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
 * Semantic status treatment for the recipient lifecycle, matching the shared
 * token system used on the Recipients page.
 */
function getRecipientStatusColor(status: string): string {
  switch (status) {
    case 'ACTIVE':
      return 'border border-success/40 bg-success/10 text-success';
    case 'PAUSED':
      return 'border border-warning/40 bg-warning/10 text-warning';
    case 'INVALID':
    case 'BLOCKED':
      return 'border border-destructive/40 bg-destructive/10 text-destructive';
    case 'UNSUBSCRIBED':
    default:
      return 'border border-border bg-muted text-muted-foreground';
  }
}

/**
 * Campaign lifecycle is DRAFT / READY / ARCHIVED. Schedule (SCHEDULED /
 * CANCELLED) and execution (PENDING / RUNNING / COMPLETED / FAILED /
 * CANCELLED) are separate lifecycles with their own helpers below - they are
 * deliberately never folded into the campaign status.
 */
function getCampaignStatusColor(status: string): string {
  switch (status) {
    case 'READY':
      return 'border border-success/40 bg-success/10 text-success';
    case 'ARCHIVED':
      return 'border border-border bg-muted text-muted-foreground';
    case 'DRAFT':
    default:
      return 'border border-warning/40 bg-warning/10 text-warning';
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

/** Schedule lifecycle: SCHEDULED / CANCELLED / absent (unscheduled). */
function getScheduleStatusColor(status: string): string {
  switch (status) {
    case 'SCHEDULED':
      return 'border border-info/40 bg-info/10 text-info';
    case 'CANCELLED':
    default:
      return 'border border-border bg-muted text-muted-foreground';
  }
}

/** Execution lifecycle: PENDING / RUNNING / COMPLETED / FAILED / CANCELLED. */
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
export default function CampaignEditor({ mode }: CampaignEditorProps) {
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();
  const campaignId = params.id;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [messageId, setMessageId] = useState('');
  const [status, setStatus] = useState<string>('DRAFT');
  const [messages, setMessages] = useState<MessageOption[]>([]);
  const [loading, setLoading] = useState(mode === 'edit');
  const [loadError, setLoadError] = useState('');
  const [nameError, setNameError] = useState('');
  const [apiError, setApiError] = useState('');
  const [saving, setSaving] = useState(false);

  // Phase 4.2 — audience selection state
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [visibleRecipients, setVisibleRecipients] = useState<AudienceRecipient[]>([]);
  const [audienceSearch, setAudienceSearch] = useState('');
  const [audienceStatusFilter, setAudienceStatusFilter] = useState('');
  const [audienceLanguageFilter, setAudienceLanguageFilter] = useState('');
  const [audienceTagFilter, setAudienceTagFilter] = useState('');
  const [audienceLanguages, setAudienceLanguages] = useState<string[]>([]);
  const [audienceTags, setAudienceTags] = useState<TagOption[]>([]);
  const [audienceLoading, setAudienceLoading] = useState(false);
  const [audienceError, setAudienceError] = useState('');
  const [audienceSaveError, setAudienceSaveError] = useState('');
  const [audienceSuccess, setAudienceSuccess] = useState('');
  const [savingAudience, setSavingAudience] = useState(false);

  // Phase 4.3 — review & finalization state
  const [messageDetail, setMessageDetail] = useState<MessageDetail | null>(null);
  const [audienceSnapshot, setAudienceSnapshot] = useState<AudienceRecipient[]>([]);
  const [readiness, setReadiness] = useState<CampaignReadiness | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [readinessRefreshKey, setReadinessRefreshKey] = useState(0);
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState('');
  const [finalizeIssues, setFinalizeIssues] = useState<CampaignIssue[]>([]);
  const [finalizeSuccess, setFinalizeSuccess] = useState('');

  // Phase 4.4 — scheduling state
  const [schedule, setSchedule] = useState<CampaignSchedule | null>(null);

  // Phase 4.5 — execution state
  const [execution, setExecution] = useState<{ status: string } | null>(null);
  const [executionLoading, setExecutionLoading] = useState(false);
  const [executionError, setExecutionError] = useState('');
  const [executionPrepared, setExecutionPrepared] = useState(false);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleError, setScheduleError] = useState('');
  const [scheduling, setScheduling] = useState(false);
  const [scheduleFormError, setScheduleFormError] = useState('');
  const [scheduleSuccess, setScheduleSuccess] = useState('');
  const [isEditSchedule, setIsEditSchedule] = useState(false);
  const [editScheduledAt, setEditScheduledAt] = useState('');
  const [editTimezone, setEditTimezone] = useState(browserTimezone());
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  // The Message CMS stays the source of truth for messages: this page only selects one.
  useEffect(() => {
    let cancelled = false;
    const loadMessages = async () => {
      try {
        const response = await axios.get<{ success: boolean; data: MessageOption[] }>(
          '/api/messages'
        );
        if (cancelled) return;
        if (response.data.success) setMessages(response.data.data);
      } catch {
        if (!cancelled) setApiError('Unable to load messages.');
      }
    };
    loadMessages();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (mode !== 'edit') return;
    let cancelled = false;
    const loadCampaign = async () => {
      setLoading(true);
      setLoadError('');
      try {
        const response = await axios.get<{ success: boolean; data: LoadedCampaign }>(
          `/api/campaigns/${campaignId}`
        );
        if (cancelled) return;
        if (response.data.success) {
          const campaign = response.data.data;
          setName(campaign.name ?? '');
          setDescription(campaign.description ?? '');
          setMessageId(campaign.messageId ?? '');
          setStatus(
            (ALLOWED_STATUSES as readonly string[]).includes(campaign.status)
              ? campaign.status
              : 'DRAFT'
          );
        } else {
          setLoadError('Failed to load campaign');
        }
      } catch {
        if (!cancelled) setLoadError('Campaign not found.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadCampaign();
    return () => {
      cancelled = true;
    };
  }, [mode, campaignId]);

  // Tag options for the audience tag filter (reuses the existing tags endpoint).
  useEffect(() => {
    let cancelled = false;
    const loadTags = async () => {
      try {
        const response = await axios.get<{ success: boolean; data: TagOption[] }>('/api/tags');
        if (!cancelled && response.data.success) setAudienceTags(response.data.data);
      } catch {
        // The tag filter simply stays empty when tags cannot be loaded.
      }
    };
    loadTags();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the existing audience of a saved campaign into the selection.
  useEffect(() => {
    if (mode !== 'edit' || !campaignId) return;
    let cancelled = false;
    const loadAudience = async () => {
      try {
        const response = await axios.get<{ success: boolean; data: AudienceRecipient[] }>(
          `/api/campaigns/${campaignId}/audience`
        );
        if (cancelled) return;
        if (response.data.success) {
          setSelectedIds(response.data.data.map((recipient) => recipient.id));
          // Phase 4.3: the same rows feed the review summary.
          setAudienceSnapshot(response.data.data);
        } else {
          setAudienceError('Failed to load the campaign audience.');
        }
      } catch {
        if (!cancelled) setAudienceError('Unable to load the campaign audience.');
      }
    };
    loadAudience();
    return () => {
      cancelled = true;
    };
  }, [mode, campaignId]);

  // Phase 4.3 — the review screen shows the selected message (body + media).
  // The Message CMS stays authoritative: this is a read-only lookup.
  useEffect(() => {
    if (!messageId) {
      setMessageDetail(null);
      return;
    }
    let cancelled = false;
    const loadMessageDetail = async () => {
      try {
        const response = await axios.get<{ success: boolean; data: MessageDetail }>(
          `/api/messages/${messageId}`
        );
        if (cancelled) return;
        setMessageDetail(response.data.success ? response.data.data : null);
      } catch {
        if (!cancelled) setMessageDetail(null);
      }
    };
    loadMessageDetail();
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  // Phase 4.3 — authoritative readiness snapshot. The server decides whether the
  // campaign may become READY; the panel below only displays that verdict.
  useEffect(() => {
    if (mode !== 'edit' || !campaignId) return;
    let cancelled = false;
    const loadReadiness = async () => {
      setReadinessLoading(true);
      try {
        const response = await axios.get<{ success: boolean; data: CampaignReadiness }>(
          `/api/campaigns/${campaignId}/readiness`
        );
        if (cancelled) return;
        setReadiness(response.data.success ? response.data.data : null);
      } catch {
        if (!cancelled) setReadiness(null);
      } finally {
        if (!cancelled) setReadinessLoading(false);
      }
    };
    loadReadiness();
    return () => {
      cancelled = true;
    };
  }, [mode, campaignId, readinessRefreshKey]);

  // Phase 4.4 — fetch existing schedule when editing a campaign.
  useEffect(() => {
    if (mode !== 'edit' || !campaignId) return;
    let cancelled = false;
    const loadSchedule = async () => {
      setScheduleLoading(true);
      try {
        const response = await axios.get<{ success: boolean; data: { schedule: CampaignSchedule | null } }>(
          `/api/campaigns/${campaignId}/schedule`
        );
        if (!cancelled) {
          setSchedule(response.data.success ? response.data.data.schedule : null);
          setScheduleError('');
        }
      } catch {
        if (!cancelled) setScheduleError('Unable to load schedule.');
      } finally {
        if (!cancelled) setScheduleLoading(false);
      }
    };
    loadSchedule();
    return () => {
      cancelled = true;
    };
  }, [mode, campaignId]);

  // Phase 4.5 — load execution status
  useEffect(() => {
    if (!campaignId) return;
    let cancelled = false;
    const loadExecution = async () => {
      setExecutionLoading(true);
      try {
        const response = await axios.get<{ success: boolean; data: { execution: { status: string } | null } }>(
          `/api/campaigns/${campaignId}/execution`
        );
        if (!cancelled) {
          setExecution(response.data.success ? response.data.data.execution : null);
          setExecutionPrepared(!!response.data.success && response.data.data.execution !== null);
          setExecutionError('');
        }
      } catch {
        if (!cancelled) setExecutionError('Unable to load execution status.');
      } finally {
        if (!cancelled) setExecutionLoading(false);
      }
    };
    loadExecution();
    return () => {
      cancelled = true;
    };
  }, [mode, campaignId]);

  // Debounced recipient search + filters. Reuses GET /api/recipients so the
  // search/status/language/tag semantics stay identical to the Recipients page.
  // Note: this effect never touches the selection, so recipients selected on a
  // different search/filter page stay selected.
  useEffect(() => {
    if (!campaignId) return;
    let cancelled = false;
    setAudienceLoading(true);
    const timer = setTimeout(async () => {
      try {
        const params: Record<string, string> = {};
        if (audienceSearch.trim()) params.search = audienceSearch.trim();
        if (audienceStatusFilter) params.status = audienceStatusFilter;
        if (audienceLanguageFilter) params.language = audienceLanguageFilter;
        if (audienceTagFilter) params.tagId = audienceTagFilter;
        const response = await axios.get<{ success: boolean; data: AudienceRecipient[] }>(
          '/api/recipients',
          { params }
        );
        if (cancelled) return;
        if (response.data.success) {
          setVisibleRecipients(response.data.data);
          setAudienceError('');
          const langs = Array.from(
            new Set(response.data.data.map((r) => r.language).filter((l): l is string => Boolean(l)))
          ).sort();
          setAudienceLanguages((prev) => Array.from(new Set([...prev, ...langs])).sort());
        } else {
          setAudienceError('Failed to load recipients.');
        }
      } catch {
        if (!cancelled) setAudienceError('Failed to load recipients.');
      } finally {
        if (!cancelled) setAudienceLoading(false);
      }
    }, RECIPIENT_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [campaignId, audienceSearch, audienceStatusFilter, audienceLanguageFilter, audienceTagFilter]);

  const handleToggleRecipient = (recipientId: string) => {
    setAudienceSuccess('');
    setAudienceSaveError('');
    setSelectedIds((prev) =>
      prev.includes(recipientId) ? prev.filter((id) => id !== recipientId) : [...prev, recipientId]
    );
  };

  // "Select All Visible" selects only the recipients currently visible.
  const handleSelectAllVisible = () => {
    setAudienceSuccess('');
    setAudienceSaveError('');
    const visibleIds = visibleRecipients.map((recipient) => recipient.id);
    setSelectedIds((prev) => Array.from(new Set([...prev, ...visibleIds])));
  };

  // "Clear Visible" removes only the recipients currently visible.
  const handleClearVisible = () => {
    setAudienceSuccess('');
    setAudienceSaveError('');
    const visibleIds = new Set(visibleRecipients.map((recipient) => recipient.id));
    setSelectedIds((prev) => prev.filter((id) => !visibleIds.has(id)));
  };

  const handleClearAudienceFilters = () => {
    setAudienceStatusFilter('');
    setAudienceLanguageFilter('');
    setAudienceTagFilter('');
  };

  const handleSaveAudience = async () => {
    if (!campaignId || savingAudience) return;
    setSavingAudience(true);
    setAudienceSaveError('');
    setAudienceSuccess('');
    try {
      // One atomic payload for the whole audience — never one call per recipient.
      const response = await axios.put<{ success: boolean; data: AudienceRecipient[] }>(
        `/api/campaigns/${campaignId}/audience`,
        { recipientIds: selectedIds }
      );
      if (response.data.success) {
        setSelectedIds(response.data.data.map((recipient) => recipient.id));
        setAudienceSnapshot(response.data.data);
        // The saved audience changes readiness, so re-read the authoritative verdict.
        setReadinessRefreshKey((prev) => prev + 1);
        setFinalizeError('');
        setFinalizeIssues([]);
        setFinalizeSuccess('');
        setAudienceSuccess(
          `Audience saved: ${response.data.data.length} recipient${response.data.data.length === 1 ? '' : 's'}.`
        );
      } else {
        setAudienceSaveError('Failed to save the audience.');
      }
    } catch (err: unknown) {
      const message =
        typeof err === 'object' && err !== null &&
        'response' in err && (err as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message;
      setAudienceSaveError(typeof message === 'string' ? message : 'Failed to save the audience.');
    } finally {
      setSavingAudience(false);
    }
  };

  // Phase 4.3 — readiness checklist derived from the server verdict.
  const issueCodes = new Set((readiness?.issues ?? []).map((issue) => issue.code));
  const hasReviewMedia = Boolean(messageDetail && messageDetail.media);
  const readinessItems = [
    {
      key: 'name',
      label: 'Campaign name',
      ok: !issueCodes.has('NAME_REQUIRED') && Boolean(name.trim()),
    },
    {
      key: 'message-selected',
      label: 'Message selected',
      ok:
        !issueCodes.has('MESSAGE_REQUIRED') &&
        !issueCodes.has('MESSAGE_NOT_FOUND') &&
        !issueCodes.has('MESSAGE_ARCHIVED') &&
        Boolean(messageId),
    },
    {
      key: 'message-content',
      label: 'Message content',
      ok: !issueCodes.has('MESSAGE_EMPTY') && Boolean(messageDetail?.body?.trim()),
    },
    {
      key: 'audience',
      label: 'Audience selected',
      ok:
        !issueCodes.has('AUDIENCE_EMPTY') &&
        !issueCodes.has('AUDIENCE_RECIPIENT_MISSING') &&
        (readiness ? readiness.audienceCount > 0 : audienceSnapshot.length > 0),
    },
    { key: 'media', label: 'Media (optional)', ok: hasReviewMedia },
  ];
  const isArchivedCampaign = status === 'ARCHIVED';
  // Client-side guard only — the server stays authoritative.
  const canFinalizeCampaign = Boolean(readiness?.valid) && !isArchivedCampaign;

  // Phase 4.3 — finalization. READY only means the configuration passed CMS
  // validation; no execution behaviour is attached to it in this phase.
  const handleFinalizeCampaign = async () => {
    if (!campaignId || finalizing || !canFinalizeCampaign) return;
    setFinalizing(true);
    setFinalizeError('');
    setFinalizeIssues([]);
    setFinalizeSuccess('');
    try {
      const response = await axios.post<{ success: boolean; data: { campaign: { status: string } } }>(
        `/api/campaigns/${campaignId}/finalize`
      );
      if (response.data.success) {
        setStatus('READY');
        setFinalizeSuccess('Campaign is READY: the configuration passed CMS validation.');
        setReadinessRefreshKey((prev) => prev + 1);
      } else {
        setFinalizeError('Campaign is not ready');
      }
    } catch (err: unknown) {
      const errorPayload =
        typeof err === 'object' && err !== null && 'response' in err
          ? (
              err as {
                response?: {
                  data?: { error?: { message?: string; issues?: CampaignIssue[] } };
                };
              }
            ).response?.data?.error
          : undefined;
      setFinalizeError(
        typeof errorPayload?.message === 'string'
          ? errorPayload.message
          : 'Failed to finalize the campaign.'
      );
      setFinalizeIssues(Array.isArray(errorPayload?.issues) ? errorPayload.issues : []);
    } finally {
      setFinalizing(false);
    }
  };

  // Brings the administrator back to the first thing that needs attention.
  const handleFixCampaign = () => {
    const targetId = messageId ? 'audience-search' : 'campaign-message';
    const target = document.getElementById(targetId);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // Phase 4.4 — schedule handlers. The schedule section lives INSIDE the outer
  // campaign edit <form>, so it must NOT be a nested <form> (invalid HTML:
  // the parser drops the inner start tag, detaching the Schedule button from
  // its handler and hijacking Enter into the outer Save Campaign submit).
  // Handlers accept an optional event so they work for both button clicks
  // and keyboard (Enter) activation.
  const handleScheduleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const date = e.target.value; // YYYY-MM-DD
    const [, time] = editScheduledAt.split('T');
    setEditScheduledAt(`${date}T${time ?? ''}`);
    setScheduleFormError('');
  };

  const handleScheduleTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = e.target.value; // HH:MM
    const [date] = editScheduledAt.split('T');
    setEditScheduledAt(`${date ?? ''}T${time}`);
    setScheduleFormError('');
  };

  // Schedule inputs live INSIDE the outer campaign edit <form> (a nested
  // <form> would be invalid HTML, so the schedule region is a plain div).
  // Pressing Enter in one of these inputs would otherwise implicitly submit
  // the OUTER form (Save Campaign). Intercept Enter here: submit the schedule
  // instead. This never fires while a native date/time picker popup has focus
  // (the picker swallows the key), so the Schedule button's explicit onClick
  // stays the reliable submission path — Enter is a bonus, not a dependency.
  const handleScheduleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleScheduleSubmit();
    }
  };

  const handleTimezoneChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setEditTimezone(e.target.value);
    setScheduleFormError('');
  };

  const startEditSchedule = () => {
    if (!schedule) return;
    const parts = wallClockInTimezone(schedule.scheduledAt, schedule.timezone);
    setEditScheduledAt(`${parts.date}T${parts.time}`);
    setEditTimezone(schedule.timezone);
    setIsEditSchedule(true);
    setScheduleFormError('');
    setScheduleSuccess('');
  };

  const cancelEditSchedule = () => {
    setIsEditSchedule(false);
    setScheduleFormError('');
    setScheduleSuccess('');
  };

  const handleScheduleSubmit = async (e?: React.FormEvent | React.MouseEvent | React.KeyboardEvent) => {
    e?.preventDefault();
    setScheduleFormError('');
    setScheduleSuccess('');
    // Client-side guard only — the server stays authoritative for future-time,
    // timezone/DST and READY-state validation. Missing fields must never reach
    // the API: show a clear error and stop before any request.
    const [datePart, timePart] = editScheduledAt.split('T');
    if (!datePart || !timePart) {
      setScheduleFormError('Select a date and time to schedule the campaign.');
      return;
    }
    setScheduling(true);
    try {
      const payload: SchedulePayload = { scheduledAt: editScheduledAt, timezone: editTimezone };
      if (schedule && schedule.status === 'SCHEDULED') {
        const response = await axios.patch<{ success: boolean; data: { schedule: CampaignSchedule | null } }>(
          `/api/campaigns/${campaignId}/schedule`,
          payload
        );
        if (response.data.success) {
          setSchedule(response.data.data.schedule);
          setScheduleSuccess('Schedule updated.');
          setIsEditSchedule(false);
        } else {
          setScheduleFormError('Failed to update schedule.');
        }
      } else {
        const response = await axios.post<{ success: boolean; data: { schedule: CampaignSchedule | null } }>(
          `/api/campaigns/${campaignId}/schedule`,
          payload
        );
        if (response.data.success) {
          setSchedule(response.data.data.schedule);
          setScheduleSuccess('Campaign scheduled.');
        } else {
          setScheduleFormError('Failed to schedule campaign.');
        }
      }
    } catch (err: unknown) {
      const message =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message
          : 'Failed to save schedule.';
      setScheduleFormError(typeof message === 'string' ? message : 'Failed to save schedule.');
    } finally {
      setScheduling(false);
    }
  };

  const handleCancelSchedule = async () => {
    setShowCancelConfirm(false);
    setScheduleFormError('');
    try {
      const response = await axios.post<{ success: boolean; data: { schedule: CampaignSchedule | null } }>(
        `/api/campaigns/${campaignId}/schedule/cancel`
      );
      if (response.data.success) {
        setSchedule(response.data.data.schedule);
        setScheduleSuccess('Schedule cancelled.');
      } else {
        setScheduleFormError('Failed to cancel schedule.');
      }
    } catch (err: unknown) {
      const message =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message
          : 'Failed to cancel schedule.';
      setScheduleFormError(typeof message === 'string' ? message : 'Failed to cancel schedule.');
    }
  };

  const handleScheduleAgain = () => {
    if (!schedule) return;
    const parts = wallClockInTimezone(schedule.scheduledAt, schedule.timezone);
    setEditScheduledAt(`${parts.date}T${parts.time}`);
    setEditTimezone(schedule.timezone);
    setIsEditSchedule(false);
    setScheduleFormError('');
    setScheduleSuccess('');
  };

  const handlePrepareExecution = async () => {
    if (!campaignId || executionLoading) return;
    setExecutionLoading(true);
    setExecutionError('');
    try {
      const response = await axios.post<{ success: boolean; data: { execution: { status: string } } }>(
        `/api/campaigns/${campaignId}/execution`
      );
      if (response.data.success) {
        setExecution(response.data.data.execution);
        setExecutionPrepared(true);
      } else {
        setExecutionError('Failed to prepare execution.');
      }
    } catch {
      setExecutionError('Failed to prepare execution.');
    } finally {
      setExecutionLoading(false);
    }
  };

  const handleCancel = () => navigate('/campaigns');

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setApiError('');
    setNameError('');

    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError('Campaign Name is required');
      return;
    }
    if (trimmedName.length > MAX_NAME_LENGTH) {
      setNameError(`Campaign Name must be at most ${MAX_NAME_LENGTH} characters`);
      return;
    }
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      setApiError(`Description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: trimmedName,
        description: description.trim() ? description : null,
        messageId: messageId ? messageId : null,
        status,
      };

      if (mode === 'edit') {
        await axios.patch(`/api/campaigns/${campaignId}`, payload);
        // Existing campaign keeps the Phase 4.1 behaviour.
        navigate('/campaigns');
      } else {
        // Phase 4.2: once the campaign exists its audience becomes selectable.
        // The campaign is never created implicitly by the audience selector.
        const created = await axios.post('/api/campaigns', payload);
        navigate(`/campaigns/${created.data.data.id}/edit`);
      }
    } catch {
      setApiError('Failed to save campaign. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-main">
        <div className="app-content space-y-4">
          {/* Page header */}
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <button
                type="button"
                onClick={handleCancel}
                className="mb-2 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Back to Campaigns
              </button>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="page-title">
                  {mode === 'edit' ? 'Edit Campaign' : 'New Campaign'}
                </h1>
                {!loading && !loadError && (
                  <span
                    className={`inline-flex h-5 items-center gap-1.5 rounded-full border px-2 text-[11px] font-semibold uppercase tracking-wider ${getCampaignStatusColor(status)}`}
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                    {statusLabel(status)}
                  </span>
                )}
              </div>
              <p className="page-subtitle">
                Prepare a message, choose an audience, finalize, then schedule for dispatch.
              </p>
            </div>
          </div>

          {loading ? (
            <div className="app-card p-5">
              <p className="text-[13px] text-muted-foreground">Loading campaign...</p>
            </div>
          ) : loadError ? (
            <div className="app-card flex items-start gap-2 border-destructive/40 bg-destructive/10 p-4">
              <AlertCircle className="h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
              <p className="text-[13px] font-medium text-destructive">{loadError}</p>
            </div>
          ) : (
          <form
            onSubmit={handleSubmit}
            className="space-y-4"
          >
            <div>
              <label
                htmlFor="campaign-name"
                className="block text-[13px] font-medium text-foreground"
              >
                Campaign Name
              </label>
              <input
                id="campaign-name"
                name="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={MAX_NAME_LENGTH}
                placeholder="Festival greeting campaign"
                disabled={saving}
                className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              />
              {nameError && <p className="mt-1 text-[13px] font-medium text-destructive">{nameError}</p>}
            </div>

            <div>
              <label
                htmlFor="campaign-description"
                className="block text-[13px] font-medium text-foreground"
              >
                Description
              </label>
              <textarea
                id="campaign-description"
                name="description"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={MAX_DESCRIPTION_LENGTH}
                placeholder="Optional notes about this campaign"
                disabled={saving}
                className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              />
            </div>

            <div>
              <label
                htmlFor="campaign-message"
                className="block text-[13px] font-medium text-foreground"
              >
                Message
              </label>
              <select
                id="campaign-message"
                name="messageId"
                value={messageId}
                onChange={(e) => setMessageId(e.target.value)}
                disabled={saving}
                className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                <option value="">None</option>
                {messages.map((msg) => (
                  <option key={msg.id} value={msg.id}>
                    {msg.name}
                  </option>
                ))}
              </select>
              <p className="mt-1 meta-text">
                Messages are managed in the Message CMS.
              </p>
            </div>

            <div>
              <label
                htmlFor="campaign-status"
                className="block text-[13px] font-medium text-foreground"
              >
                Status
              </label>
              <select
                id="campaign-status"
                name="status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                disabled={saving}
                className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                {ALLOWED_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>

            {/* Phase 4.2 — Audience */}
            <div className="app-card p-5">
              <h2 className="card-title">Audience</h2>
              {!campaignId ? (
                <p id="audience-hint" className="mt-1 text-[13px] text-muted-foreground">
                  Save the campaign first — the audience selector becomes active once the campaign exists.
                </p>
              ) : (
                <>
                  <div className="mt-3">
                    <label
                      htmlFor="audience-search"
                      className="block text-[13px] font-medium text-foreground"
                    >
                      Search recipients
                    </label>
                    <input
                      id="audience-search"
                      type="search"
                      value={audienceSearch}
                      onChange={(e) => setAudienceSearch(e.target.value)}
                      placeholder="Search by name or phone"
                      disabled={savingAudience}
                      className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    />
                  </div>

                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <div>
                      <label
                        htmlFor="audience-status-filter"
                        className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                      >
                        Status
                      </label>
                      <select
                        id="audience-status-filter"
                        value={audienceStatusFilter}
                        onChange={(e) => setAudienceStatusFilter(e.target.value)}
                        disabled={savingAudience}
                        className="mt-1 block h-10 rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                      >
                        <option value="">All</option>
                        {RECIPIENT_STATUSES.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label
                        htmlFor="audience-language-filter"
                        className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                      >
                        Language
                      </label>
                      <select
                        id="audience-language-filter"
                        value={audienceLanguageFilter}
                        onChange={(e) => setAudienceLanguageFilter(e.target.value)}
                        disabled={savingAudience}
                        className="mt-1 block h-10 rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                      >
                        <option value="">All</option>
                        {audienceLanguages.map((language) => (
                          <option key={language} value={language}>
                            {language}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label
                        htmlFor="audience-tag-filter"
                        className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                      >
                        Tag
                      </label>
                      <select
                        id="audience-tag-filter"
                        value={audienceTagFilter}
                        onChange={(e) => setAudienceTagFilter(e.target.value)}
                        disabled={savingAudience}
                        className="mt-1 block h-10 rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                      >
                        <option value="">All</option>
                        {audienceTags.map((tag) => (
                          <option key={tag.id} value={tag.id}>
                            {tag.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    {(audienceStatusFilter || audienceLanguageFilter || audienceTagFilter) && (
                      <button
                        type="button"
                        onClick={handleClearAudienceFilters}
                        disabled={savingAudience}
                        className="inline-flex h-10 items-center rounded-lg border border-border bg-card px-3 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted disabled:opacity-50"
                      >
                        Clear Filters
                      </button>
                    )}
                  </div>

                  <p
                    id="audience-selected-count"
                    className="mt-3 text-[13px] font-semibold text-foreground"
                  >
                    Selected: {selectedIds.length} {selectedIds.length === 1 ? 'recipient' : 'recipients'}
                  </p>

                  <div className="mt-3 overflow-hidden rounded-lg border border-border">
                    {audienceLoading ? (
                      <p id="audience-loading" className="p-4 text-[13px] text-muted-foreground">
                        Loading recipients...
                      </p>
                    ) : (
                      <div className="max-h-80 overflow-x-auto overflow-y-auto">
                        <table className="min-w-full divide-y divide-border">
                          <thead className="bg-muted">
                            <tr>
                              <th scope="col" className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Select</th>
                              <th scope="col" className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Name</th>
                              <th scope="col" className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">WhatsApp</th>
                              <th scope="col" className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Language</th>
                              <th scope="col" className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Status</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {visibleRecipients.length === 0 ? (
                              <tr>
                                <td colSpan={5} className="px-3 py-4 text-[13px] text-muted-foreground">
                                  No recipients match the current search / filters.
                                </td>
                              </tr>
                            ) : (
                              visibleRecipients.map((recipient) => (
                                <tr key={recipient.id} className="bg-card">
                                  <td className="px-3 py-2">
                                    <input
                                      type="checkbox"
                                      checked={selectedIds.includes(recipient.id)}
                                      onChange={() => handleToggleRecipient(recipient.id)}
                                      disabled={savingAudience}
                                      aria-label={`Select ${recipient.name}`}
                                      data-testid={`audience-checkbox-${recipient.id}`}
                                    />
                                  </td>
                                  <td className="table-text px-3 py-2">{recipient.name}</td>
                                  <td className="px-3 py-2 text-[13px] text-muted-foreground">{recipient.whatsappNumber}</td>
                                  <td className="px-3 py-2 text-[13px] text-muted-foreground">{recipient.language || '-'}</td>
                                  <td className="px-3 py-2 text-sm">
                                    <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${getRecipientStatusColor(recipient.status)}`}>
                                      {recipient.status}
                                    </span>
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      id="audience-select-all-visible"
                      onClick={handleSelectAllVisible}
                      disabled={savingAudience || audienceLoading || visibleRecipients.length === 0}
                      className="inline-flex h-10 items-center rounded-lg border border-border bg-card px-3 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted disabled:opacity-50"
                    >
                      Select All Visible
                    </button>
                    <button
                      type="button"
                      id="audience-clear-visible"
                      onClick={handleClearVisible}
                      disabled={savingAudience || audienceLoading || visibleRecipients.length === 0}
                      className="inline-flex h-10 items-center rounded-lg border border-border bg-card px-3 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted disabled:opacity-50"
                    >
                      Clear Visible
                    </button>
                    <button
                      type="button"
                      id="audience-save"
                      onClick={handleSaveAudience}
                      disabled={savingAudience}
                      className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-card transition-colors hover:opacity-95 disabled:opacity-50"
                    >
                      {savingAudience ? 'Saving audience...' : 'Save Audience'}
                    </button>
                  </div>

                  {audienceError && (
                    <p id="audience-error" className="mt-2 text-[13px] font-medium text-destructive">{audienceError}</p>
                  )}
                  {audienceSaveError && (
                    <p className="mt-2 text-[13px] font-medium text-destructive">{audienceSaveError}</p>
                  )}
                  {audienceSuccess && (
                    <p id="audience-success" className="mt-2 text-[13px] font-medium text-success">{audienceSuccess}</p>
                  )}
                </>
              )}
            </div>

            {/* Phase 4.3 — Review & Finalize */}
            <div id="review-section" className="app-card p-5">
              <h2 className="card-title">Review</h2>
              <p className="mt-1 text-[13px] text-muted-foreground">
                READY means this campaign configuration passed CMS validation.
              </p>

              {!campaignId ? (
                <p id="review-hint" className="mt-2 text-[13px] text-muted-foreground">
                  Save the campaign first — the review and finalization become available once the campaign exists.
                </p>
              ) : (
                <>
                  <div
                    id="review-campaign-summary"
                    className="app-card p-4"
                  >
                    <h3 className="section-title">
                      Campaign
                    </h3>
                    <dl className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                      <div>
                        <dt className="text-[13px] text-muted-foreground">Name</dt>
                        <dd id="review-campaign-name" className="text-[13px] font-semibold text-foreground">
                          {name.trim() || '-'}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[13px] text-muted-foreground">Description</dt>
                        <dd id="review-campaign-description" className="text-[13px] text-foreground">
                          {description.trim() || '-'}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[13px] text-muted-foreground">Status</dt>
                        <dd>
                          <span
                            id="review-campaign-status"
                            className={`px-2 py-0.5 text-xs rounded-full font-medium ${getCampaignStatusColor(status)}`}
                          >
                            {status}
                          </span>
                        </dd>
                      </div>
                    </dl>
                  </div>
                  <div
                    id="review-message-summary"
                    className="app-card p-4"
                  >
                    <h3 className="section-title">
                      Message
                    </h3>
                    {messageDetail ? (
                      <div className="mt-2 space-y-2 text-sm">
                        <div className="flex items-center gap-2">
                          <span id="review-message-name" className="text-[13px] font-semibold text-foreground">
                            {messageDetail.name}
                          </span>
                          <span
                            id="review-message-status"
                            className={`px-2 py-0.5 text-xs rounded-full font-medium ${getCampaignStatusColor(messageDetail.status)}`}
                          >
                            {messageDetail.status}
                          </span>
                        </div>
                        <div>
                          <p className="text-[13px] text-muted-foreground">Body preview</p>
                          <p
                            id="review-message-body"
                            className="mt-1 whitespace-pre-wrap rounded-lg border border-border bg-muted p-3 text-[13px] text-foreground"
                          >
                            {messageDetail.body}
                          </p>
                        </div>
                      </div>
                    ) : (
                      <p id="review-message-missing" className="mt-2 text-[13px] text-muted-foreground">
                        No message selected.
                      </p>
                    )}
                  </div>

                  <div
                    id="review-media-summary"
                    className="app-card p-4"
                  >
                    <h3 className="section-title">
                      Media
                    </h3>
                    {messageDetail && messageDetail.media ? (
                      <div className="mt-2 flex items-center gap-3">
                        <img
                          id="review-media-preview"
                          src={`/api/media/${messageDetail.media.id}`}
                          alt={messageDetail.media.filename}
                          className="h-16 w-16 rounded-lg border border-border object-cover"
                        />
                        <div className="text-sm">
                          <p id="review-media-filename" className="text-[13px] font-semibold text-foreground">
                            {messageDetail.media.filename}
                          </p>
                          <p className="text-[13px] text-muted-foreground">{messageDetail.media.mimeType}</p>
                        </div>
                      </div>
                    ) : (
                      <p id="review-no-media" className="mt-2 text-[13px] text-muted-foreground">
                        No media attached
                      </p>
                    )}
                  </div>
                  <div
                    id="review-audience-summary"
                    className="app-card p-4"
                  >
                    <h3 className="section-title">
                      Audience
                    </h3>
                    <p id="review-audience-count" className="mt-2 text-[13px] font-semibold text-foreground">
                      Selected: {audienceSnapshot.length} {audienceSnapshot.length === 1 ? 'recipient' : 'recipients'}
                    </p>
                    <div className="mt-3 overflow-hidden rounded-lg border border-border">
                      <div className="max-h-64 overflow-x-auto overflow-y-auto">
                        <table className="min-w-full divide-y divide-border">
                          <thead className="bg-muted">
                            <tr>
                              {['Name', 'WhatsApp', 'Language', 'Status', 'Tags'].map((heading) => (
                                <th
                                  key={heading}
                                  scope="col"
                                  className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                                >
                                  {heading}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {audienceSnapshot.length === 0 ? (
                              <tr>
                                <td
                                  id="review-audience-empty"
                                  colSpan={5}
                                  className="px-3 py-4 text-[13px] text-muted-foreground"
                                >
                                  No recipients selected yet.
                                </td>
                              </tr>
                            ) : (
                              audienceSnapshot.map((recipient) => (
                                <tr key={recipient.id} data-testid={`review-audience-row-${recipient.id}`}>
                                  <td className="table-text px-3 py-2">{recipient.name}</td>
                                  <td className="px-3 py-2 text-[13px] text-muted-foreground">
                                    {recipient.whatsappNumber}
                                  </td>
                                  <td className="px-3 py-2 text-[13px] text-muted-foreground">
                                    {recipient.language || '-'}
                                  </td>
                                  <td className="px-3 py-2 text-sm">
                                    <span
                                      className={`px-2 py-0.5 text-xs rounded-full font-medium ${getRecipientStatusColor(recipient.status)}`}
                                    >
                                      {recipient.status}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2 text-[13px] text-muted-foreground">
                                    {(recipient.tags ?? [])
                                      .map((entry) => entry.tag?.name)
                                      .filter(Boolean)
                                      .join(', ') || '-'}
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                  <div
                    id="readiness-panel"
                    className="app-card p-4"
                  >
                    <h3 className="section-title">
                      Campaign Readiness
                    </h3>
                    {readinessLoading ? (
                      <p id="readiness-loading" className="mt-2 text-[13px] text-muted-foreground">
                        Checking readiness...
                      </p>
                    ) : (
                      <>
                        <ul className="mt-2 space-y-1 text-sm">
                          {readinessItems.map((item) => (
                            <li key={item.key} id={`readiness-item-${item.key}`} className="flex items-center gap-2">
                              <span
                                aria-hidden="true"
                                className={item.ok ? 'text-success' : 'text-muted-foreground'}
                              >
                                {item.ok ? '✓' : '○'}
                              </span>
                              <span className="text-[13px] text-foreground">{item.label}</span>
                            </li>
                          ))}
                        </ul>

                        {readiness && readiness.valid ? (
                          <div id="readiness-valid" className="mt-3">
                            <p className="text-[13px] font-semibold text-success">
                              Campaign is ready to finalize.
                            </p>
                            <button
                              type="button"
                              id="finalize-campaign"
                              onClick={handleFinalizeCampaign}
                              disabled={finalizing || !canFinalizeCampaign}
                              className="mt-2 inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-card transition-colors hover:opacity-95 disabled:opacity-50"
                            >
                              {finalizing ? 'Finalizing...' : 'Finalize Campaign'}
                            </button>
                          </div>
                        ) : (
                          <div id="readiness-invalid" className="mt-3">
                            <p className="text-[13px] font-semibold text-destructive">
                              Campaign cannot be finalized.
                            </p>
                            <ul className="mt-1 list-inside list-disc text-[13px] text-destructive">
                              {(readiness?.issues ?? []).map((issue) => (
                                <li key={issue.code} data-testid={`readiness-issue-${issue.code}`}>
                                  {issue.message}
                                </li>
                              ))}
                            </ul>
                            <button
                              type="button"
                              id="fix-campaign"
                              onClick={handleFixCampaign}
                              className="mt-2 inline-flex h-10 items-center rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted"
                            >
                              Fix Campaign
                            </button>
                          </div>
                        )}

                        {isArchivedCampaign && (
                          <p id="finalize-archived-guard" className="mt-3 text-[13px] text-muted-foreground">
                            Archived campaigns cannot be finalized. Set the campaign status back to DRAFT to review it
                            again.
                          </p>
                        )}

                        {finalizeSuccess && (
                          <p id="finalize-success" className="mt-3 text-[13px] font-medium text-success">
                            {finalizeSuccess}
                          </p>
                        )}
                        {finalizeError && (
                          <div id="finalize-error" className="mt-3">
                            <p className="text-[13px] font-medium text-destructive">{finalizeError}</p>
                            {finalizeIssues.length > 0 && (
                              <ul id="finalize-issues" className="mt-1 list-inside list-disc text-[13px] text-destructive">
                                {finalizeIssues.map((issue) => (
                                  <li key={issue.code} data-testid={`finalize-issue-${issue.code}`}>
                                    {issue.message}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* Phase 4.4 — Schedule */}
            {mode === 'edit' && campaignId && (
              <div className="app-card p-5">
                <h2 className="card-title">Schedule</h2>
                {scheduleLoading ? (
                  <p className="mt-2 text-[13px] text-muted-foreground">Loading schedule...</p>
                ) : scheduleError ? (
                  <p className="mt-2 text-[13px] font-medium text-destructive">{scheduleError}</p>
                ) : status === 'DRAFT' ? (
                  <div className="mt-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-[13px] font-medium text-warning">
                    <p>Finalize this campaign before scheduling.</p>
                  </div>
                ) : status === 'ARCHIVED' ? (
                  <div className="mt-2 rounded-lg border border-border bg-muted p-3 text-[13px] text-muted-foreground">
                    <p>Archived campaigns cannot be scheduled.</p>
                  </div>
                ) : status === 'READY' && !schedule ? (
                  <div className="mt-3 space-y-3" role="group" aria-label="Schedule campaign">
                    <div className="flex flex-wrap items-end gap-3">
                      <div>
                        <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Date</label>
                        <input
                          type="date"
                          value={editScheduledAt.split('T')[0] || ''}
                          onChange={handleScheduleDateChange}
                          onKeyDown={handleScheduleInputKeyDown}
                          disabled={scheduling}
                          required
                          className="mt-1 block h-10 rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Time</label>
                        <input
                          type="time"
                          value={editScheduledAt.split('T')[1] || ''}
                          onChange={handleScheduleTimeChange}
                          onKeyDown={handleScheduleInputKeyDown}
                          disabled={scheduling}
                          required
                          className="mt-1 block h-10 rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Timezone</label>
                        <select
                          value={editTimezone}
                          onChange={handleTimezoneChange}
                          disabled={scheduling}
                          className="mt-1 block h-10 rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                        >
                          {listTimezones().map((tz) => (
                            <option key={tz} value={tz}>
                              {tz}
                            </option>
                          ))}
                        </select>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleScheduleSubmit()}
                        disabled={scheduling}
                        className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-card transition-colors hover:opacity-95 disabled:opacity-50"
                      >
                        {scheduling ? 'Scheduling...' : 'Schedule'}
                      </button>
                    </div>
                    {scheduleFormError && <p className="text-[13px] font-medium text-destructive">{scheduleFormError}</p>}
                  </div>
                ) : status === 'READY' && schedule && schedule.status === 'SCHEDULED' ? (
                  <div className="mt-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex h-5 items-center gap-1.5 rounded-full border px-2 text-[11px] font-semibold uppercase tracking-wider ${getScheduleStatusColor('SCHEDULED')}`}
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                        Scheduled
                      </span>
                      <span className="text-[13px] text-foreground">
                        {formatScheduleDate(schedule.scheduledAt, schedule.timezone)},{' '}
                        {formatScheduleTime(schedule.scheduledAt, schedule.timezone)}
                      </span>
                      <span className="meta-text">{schedule.timezone}</span>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={startEditSchedule}
                        className="inline-flex h-8 items-center rounded-lg border border-border bg-card px-2.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted"
                      >
                        Edit Schedule
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowCancelConfirm(true)}
                        className="inline-flex h-8 items-center gap-2 rounded-lg bg-destructive px-2.5 text-[13px] font-semibold text-destructive-foreground shadow-card transition-colors hover:opacity-95 disabled:opacity-50"
                      >
                        Cancel Schedule
                      </button>
                    </div>
                    {isEditSchedule && (
                      <div className="mt-2 space-y-2 rounded-lg border border-border bg-card p-3" role="group" aria-label="Edit schedule">
                        <div className="flex flex-wrap items-end gap-3">
                          <div>
                            <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Date</label>
                            <input
                              type="date"
                              value={editScheduledAt.split('T')[0] || ''}
                              onChange={handleScheduleDateChange}
                              onKeyDown={handleScheduleInputKeyDown}
                              disabled={scheduling}
                              required
                              className="mt-1 block h-10 rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Time</label>
                            <input
                              type="time"
                              value={editScheduledAt.split('T')[1] || ''}
                              onChange={handleScheduleTimeChange}
                              onKeyDown={handleScheduleInputKeyDown}
                              disabled={scheduling}
                              required
                              className="mt-1 block h-10 rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Timezone</label>
                            <select
                              value={editTimezone}
                              onChange={handleTimezoneChange}
                              disabled={scheduling}
                              className="mt-1 block h-10 rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                            >
                              {listTimezones().map((tz) => (
                                <option key={tz} value={tz}>
                                  {tz}
                                </option>
                              ))}
                            </select>
                          </div>
                          <button
                            type="button"
                            onClick={() => void handleScheduleSubmit()}
                            disabled={scheduling}
                            className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-card transition-colors hover:opacity-95 disabled:opacity-50"
                          >
                            {scheduling ? 'Saving...' : 'Save Schedule'}
                          </button>
                          <button
                            type="button"
                            onClick={cancelEditSchedule}
                            disabled={scheduling}
                            className="inline-flex h-10 items-center rounded-lg border border-border bg-card px-3 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted disabled:opacity-50"
                          >
                            Cancel Edit
                          </button>
                        </div>
                        {scheduleFormError && <p className="text-[13px] font-medium text-destructive">{scheduleFormError}</p>}
                      </div>
                    )}
                  </div>
                ) : status === 'READY' && schedule && schedule.status === 'CANCELLED' ? (
                  <div className="mt-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex h-5 items-center gap-1.5 rounded-full border px-2 text-[11px] font-semibold uppercase tracking-wider ${getScheduleStatusColor('CANCELLED')}`}
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                        Cancelled
                      </span>
                      <span className="text-[13px] text-foreground">
                        {formatScheduleDate(schedule.scheduledAt, schedule.timezone)},{' '}
                        {formatScheduleTime(schedule.scheduledAt, schedule.timezone)}
                      </span>
                      <span className="meta-text">{schedule.timezone}</span>
                    </div>
                    <button
                      type="button"
                      onClick={handleScheduleAgain}
                      className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground shadow-card transition-colors hover:opacity-95"
                    >
                      Schedule Again
                    </button>
                  </div>
                ) : null}
                {scheduleSuccess && <p className="mt-2 text-[13px] font-medium text-success">{scheduleSuccess}</p>}
                {/* Cancel confirmation modal */}
                {showCancelConfirm && (
                  <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <div className="fixed inset-0 bg-foreground/50 backdrop-blur-[1px] transition-opacity" aria-hidden="true" />
                    <div
                      className="app-card relative w-full max-w-sm p-5"
                      role="dialog"
                      aria-modal="true"
                      aria-labelledby="cancel-schedule-title"
                    >
                      <h3 className="card-title" id="cancel-schedule-title">Cancel Schedule</h3>
                      <p className="mt-2 text-[13px] text-muted-foreground">
                        Are you sure you want to cancel this schedule? The campaign will remain READY.
                      </p>
                      <div className="flex justify-end gap-3">
                        <button
                          type="button"
                          onClick={() => setShowCancelConfirm(false)}
                          disabled={scheduling}
                          className="inline-flex h-10 items-center rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted disabled:opacity-50"
                        >
                          Keep Schedule
                        </button>
                        <button
                          type="button"
                          onClick={handleCancelSchedule}
                          disabled={scheduling}
                          className="inline-flex h-10 items-center gap-2 rounded-lg bg-destructive px-4 text-sm font-semibold text-destructive-foreground shadow-card transition-colors hover:opacity-95 disabled:opacity-50"
                        >
                          {scheduling ? 'Cancelling...' : 'Cancel Schedule'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
             )}

            {/* Phase 4.5 — Execution status */}
            {mode === 'edit' && campaignId && schedule && schedule.status === 'SCHEDULED' && (
              <div className="app-card p-5">
                <h2 className="card-title">Execution</h2>
                {executionLoading ? (
                  <p className="mt-2 text-[13px] text-muted-foreground">Loading execution...</p>
                ) : executionError ? (
                  <p className="mt-2 text-[13px] font-medium text-destructive">{executionError}</p>
                ) : executionPrepared && execution ? (
                  <div className="mt-2 flex items-center gap-2">
                    <span
                      className={`inline-flex h-5 items-center gap-1.5 rounded-full border px-2 text-[11px] font-semibold uppercase tracking-wider ${getExecutionStatusColor(execution.status)}`}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                      Prepared · {statusLabel(execution.status)}
                    </span>
                  </div>
                ) : (
                  <div className="mt-2 flex items-center gap-3">
                    <span className="text-[13px] text-muted-foreground">
                      Execution: Not prepared
                    </span>
                    <button
                      type="button"
                      onClick={handlePrepareExecution}
                      disabled={executionLoading}
                      className="inline-flex h-8 items-center gap-2 rounded-lg bg-primary px-2.5 text-[13px] font-semibold text-primary-foreground shadow-card transition-colors hover:opacity-95 disabled:opacity-50"
                    >
                      {executionLoading ? 'Preparing...' : 'Prepare Execution'}
                    </button>
                  </div>
                )}
              </div>
            )}

            {apiError && <p className="text-[13px] font-medium text-destructive">{apiError}</p>}

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={handleCancel}
                disabled={saving}
                className="inline-flex h-10 items-center rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-card transition-colors hover:opacity-95 disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Campaign'}
              </button>
            </div>
          </form>
        )}
        </div>
      </main>
    </div>
  );
}
