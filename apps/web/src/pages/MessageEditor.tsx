import { useEffect, useState, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import { Sidebar, BrandMark } from '../components/Sidebar';
import { BRAND_NAME } from '../constants/brand';
import { ArrowLeft, AlertCircle, Trash2, RefreshCw } from 'lucide-react';

/**
 * Semantic status treatment for the message lifecycle, matching the shared
 * token system used by the Messages list and Recipients pages.
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


const ALLOWED_STATUSES = ['DRAFT', 'READY', 'ARCHIVED'] as const;
const MAX_NAME_LENGTH = 200;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

interface MessageEditorProps {
  mode: 'new' | 'edit';
}

interface LoadedMessage {
  name: string;
  body: string;
  language: string | null;
  status: string;
  media?: {
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    storagePath: string;
  } | null;
}

interface MediaState {
  id: string | null;
  filename: string;
  mimeType: string;
  size: number;
  previewUrl: string | null;
  uploading: boolean;
  error: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export default function MessageEditor({ mode }: MessageEditorProps) {
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();
  const messageId = params.id;

  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [language, setLanguage] = useState('');
  const [status, setStatus] = useState<string>('DRAFT');
  const [loading, setLoading] = useState(mode === 'edit');
  const [loadError, setLoadError] = useState('');
  const [nameError, setNameError] = useState('');
  const [bodyError, setBodyError] = useState('');
  const [apiError, setApiError] = useState('');
  const [saving, setSaving] = useState(false);

  const [mediaState, setMediaState] = useState<MediaState>({
    id: null,
    filename: '',
    mimeType: '',
    size: 0,
    previewUrl: null,
    uploading: false,
    error: '',
  });
  const [mediaUploaded, setMediaUploaded] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode !== 'edit') return;
    let cancelled = false;
    const loadMessage = async () => {
      setLoading(true);
      setLoadError('');
      try {
        const response = await axios.get<{ success: boolean; data: LoadedMessage }>(
          `/api/messages/${messageId}`
        );
        if (cancelled) return;
        if (response.data.success) {
          const msg = response.data.data;
          setName(msg.name ?? '');
          setBody(msg.body ?? '');
          setLanguage(msg.language ?? '');
          setStatus(
            (ALLOWED_STATUSES as readonly string[]).includes(msg.status) ? msg.status : 'DRAFT'
          );
          if (msg.media) {
            setMediaState({
              id: msg.media.id,
              filename: msg.media.filename,
              mimeType: msg.media.mimeType,
              size: msg.media.size,
              previewUrl: `/api/media/${msg.media.id}`,
              uploading: false,
              error: '',
            });
          }
        } else {
          setLoadError('Failed to load message');
        }
      } catch (err: unknown) {
        if (cancelled) return;
        if (axios.isAxiosError(err) && err.response?.status === 404) {
          setLoadError('Message not found. It may have been deleted.');
        } else {
          setLoadError('Unable to load message. Please check your connection and try again.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadMessage();
    return () => {
      cancelled = true;
    };
  }, [mode, messageId]);

  const validate = (): boolean => {
    let valid = true;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError('Message Name is required');
      valid = false;
    } else if (trimmedName.length > MAX_NAME_LENGTH) {
      setNameError(`Message Name must be at most ${MAX_NAME_LENGTH} characters`);
      valid = false;
    } else {
      setNameError('');
    }
    if (!body.trim()) {
      setBodyError('Message Body is required');
      valid = false;
    } else {
      setBodyError('');
    }
    return valid;
  };

  const validateFile = (file: File): string | null => {
    const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return 'Unsupported file type. Only JPG, PNG, and WebP are allowed.';
    }
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      return 'Unsupported file type. Only JPG, PNG, and WebP are allowed.';
    }
    if (file.size > MAX_FILE_SIZE) {
      return 'File exceeds maximum size of 5 MB';
    }
    return null;
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setApiError('');
    const validationError = validateFile(file);
    if (validationError) {
      setMediaState((prev) => ({ ...prev, error: validationError }));
      return;
    }

    setMediaState((prev) => ({ ...prev, uploading: true, error: '' }));

    const formData = new FormData();
    formData.append('file', file);
    if (mode === 'edit' && messageId) {
      formData.append('messageId', messageId);
    }

    try {
      const response = await axios.post<{ success: boolean; data: any }>(
        '/api/media',
        formData,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      );
      if (response.data.success) {
        const data = response.data.data as { id: string; filename: string; mimeType: string; size: number };
        setMediaState({
          id: data.id,
          filename: data.filename,
          mimeType: data.mimeType,
          size: data.size,
          previewUrl: `/api/media/${data.id}`,
          uploading: false,
          error: '',
        });
        setMediaUploaded(true);
      } else {
        setMediaState((prev) => ({
          ...prev,
          uploading: false,
          error: (response.data as any).error?.message || 'Upload failed',
        }));
      }
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.data) {
        const data = err.response.data as { error?: { message?: string } };
        setMediaState((prev) => ({
          ...prev,
          uploading: false,
          error: data.error?.message || 'Upload failed',
        }));
      } else {
        setMediaState((prev) => ({
          ...prev,
          uploading: false,
          error: 'Upload failed. Please try again.',
        }));
      }
    }
  };

  const handleRemoveMedia = async () => {
    if (!mediaState.id) return;
    try {
      await axios.delete(`/api/media/${mediaState.id}`);
    } catch {
      // proceed with local removal even if server delete fails
    }
    if (mediaState.previewUrl) {
      URL.revokeObjectURL(mediaState.previewUrl);
    }
    setMediaState({
      id: null,
      filename: '',
      mimeType: '',
      size: 0,
      previewUrl: null,
      uploading: false,
      error: '',
    });
    setMediaUploaded(false);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setApiError('');
    if (!validate()) return;
    setSaving(true);
    try {
      const payload = {
      name: name.trim(),
      body,
      language: language.trim() ? language.trim() : null,
      status,
      };
      let savedMessageId = '';
      if (mode === 'new') {
        const response = await axios.post<{ success: boolean; data: { id: string } }>('/api/messages', payload);
        savedMessageId = response.data.data.id;
      } else {
        await axios.patch(`/api/messages/${messageId}`, payload);
        savedMessageId = messageId || '';
      }

      if (mediaState.id && savedMessageId && mediaUploaded) {
        const formData = new FormData();
        const fileInput = fileInputRef.current;
        if (fileInput && fileInput.files?.[0]) {
          formData.append('file', fileInput.files[0]);
        } else {
          formData.append('file', new Blob([], { type: mediaState.mimeType }), mediaState.filename);
        }
        formData.append('messageId', savedMessageId);
        try {
          await axios.post('/api/media', formData, {
            headers: { 'Content-Type': 'multipart/form-data' },
          });
        } catch {
          // media association failure is non-fatal for message save
        }
      }

      navigate('/messages');
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.data) {
        const data = err.response.data as { error?: { message?: string } };
        setApiError(data.error?.message || 'Failed to save message. Please try again.');
      } else {
        setApiError('Failed to save message. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    navigate('/messages');
  };

  const heading = mode === 'new' ? 'New Message' : 'Edit Message';
  const subtitle =
    mode === 'new'
      ? 'Create a new message. It will be saved as a draft.'
      : 'Update the message details below.';


  if (mode === 'edit' && loading) {
    return (
      <div className="app-shell">
        <Sidebar />
        <main className="app-main">
          <div className="app-content">
            <p className="text-[13px] text-muted-foreground">Loading message...</p>
          </div>
        </main>
      </div>
    );
  }

  if (mode === 'edit' && loadError) {
    return (
      <div className="app-shell">
        <Sidebar />
        <main className="app-main">
          <div className="app-content space-y-4">
            <div>
              <h1 className="page-title">Edit Message</h1>
            </div>
            <div className="app-card flex items-start gap-2 border-destructive/40 bg-destructive/10 p-4">
              <AlertCircle className="h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
              <p className="text-[13px] font-medium text-destructive">{loadError}</p>
            </div>
            <div>
              <button
                type="button"
                onClick={handleCancel}
                className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Back to Messages
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-main">
        <div className="app-content space-y-4">
          {/* Page header */}
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="page-title">{heading}</h1>
                <span
                  className={`inline-flex h-5 items-center gap-1.5 rounded-full border px-2 text-[11px] font-semibold uppercase tracking-wider ${statusBadgeClass(status)}`}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                  {statusLabel(status)}
                </span>
              </div>
              <p className="page-subtitle">{subtitle}</p>
            </div>
            <button
              type="button"
              onClick={handleCancel}
              disabled={saving}
              className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted disabled:opacity-50"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Back to Messages
            </button>
          </div>

          <form onSubmit={handleSave} className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12">
            {/* Main editor column */}
            <div className="space-y-4 lg:col-span-7">
              <div className="app-card overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted px-5 py-3">
                  <div>
                    <h2 className="card-title">Message Details</h2>
                    <p className="section-title mt-0.5">Reusable WhatsApp content</p>
                  </div>
                </div>
                <div className="space-y-4 p-5">
                  {apiError && (
                    <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                      <p className="text-[13px] font-medium text-destructive">{apiError}</p>
                    </div>
                  )}
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <div className="sm:col-span-2">
                      <label htmlFor="message-name" className="block text-[13px] font-medium text-foreground">
                        Message Name <span className="text-destructive">*</span>
                      </label>
                      <input
                        id="message-name"
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        maxLength={MAX_NAME_LENGTH}
                        placeholder="Festival greeting"
                        className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                      {nameError && <p className="mt-1 text-[13px] font-medium text-destructive">{nameError}</p>}
                    </div>
                    <div>
                      <label htmlFor="message-language" className="block text-[13px] font-medium text-foreground">
                        Language
                      </label>
                      <input
                        id="message-language"
                        type="text"
                        value={language}
                        onChange={(e) => setLanguage(e.target.value)}
                        placeholder="English"
                        className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center justify-between">
                      <label htmlFor="message-body" className="block text-[13px] font-medium text-foreground">
                        Message Body <span className="text-destructive">*</span>
                      </label>
                      <span className="tabular-nums text-[11px] text-muted-foreground">
                        {body.length} characters
                      </span>
                    </div>
                    <textarea
                      id="message-body"
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      rows={9}
                      placeholder="Write the message text here"
                      className="mt-1 block w-full resize-y rounded-lg border border-input bg-card p-4 text-[13px] leading-relaxed text-foreground shadow-card transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    {bodyError && <p className="mt-1 text-[13px] font-medium text-destructive">{bodyError}</p>}
                  </div>
                  <div>
                    <label htmlFor="message-status" className="block text-[13px] font-medium text-foreground">
                      Status
                    </label>
                    <select
                      id="message-status"
                      value={status}
                      onChange={(e) => setStatus(e.target.value)}
                      className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {ALLOWED_STATUSES.map((option) => (
                        <option key={option} value={option}>
                          {statusLabel(option)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-[13px] font-medium text-foreground">Media Attachment</h3>
                        <p className="meta-text mt-0.5">Optional single image sent with the message.</p>
                      </div>
                      <span className="rounded bg-muted px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Single Image
                      </span>
                    </div>
                    <div className="mt-2">
                      <input
                        ref={fileInputRef}
                        id="message-media"
                        type="file"
                        accept=".jpg,.jpeg,.png,.webp"
                        onChange={handleFileSelect}
                        disabled={saving || mediaState.uploading}
                        className="block w-full text-[13px] text-muted-foreground file:mr-3 file:h-9 file:cursor-pointer file:rounded-lg file:border-0 file:bg-primary file:px-3.5 file:text-[13px] file:font-semibold file:text-primary-foreground hover:file:opacity-95"
                      />
                      <p className="mt-1 text-[11px] text-muted-foreground">Supported: JPG, PNG, WebP - Max 5 MB</p>
                      {mediaState.uploading && (
                        <p className="mt-2 text-[13px] font-medium text-primary">Uploading...</p>
                      )}
                      {mediaState.error && (
                        <p className="mt-2 text-[13px] font-medium text-destructive">{mediaState.error}</p>
                      )}
                      {mediaState.id && !mediaState.uploading && (
                        <div className="mt-3 flex flex-col items-center justify-between gap-3 rounded-lg border border-border bg-muted p-3.5 sm:flex-row">
                          <div className="flex w-full items-center gap-3 sm:w-auto">
                            {mediaState.previewUrl && (
                              <img
                                src={mediaState.previewUrl}
                                alt={mediaState.filename}
                                className="h-14 w-20 shrink-0 rounded-md border border-border object-cover"
                              />
                            )}
                            <div className="flex min-w-0 flex-col">
                              <span className="truncate text-[13px] font-semibold text-foreground">{mediaState.filename}</span>
                              <span className="tabular-nums text-[11px] text-muted-foreground">
                                {formatFileSize(mediaState.size)} - {mediaState.mimeType}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 self-end sm:self-center">
                            <button
                              type="button"
                              onClick={() => fileInputRef.current?.click()}
                              disabled={saving || mediaState.uploading}
                              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted disabled:opacity-50"
                            >
                              <RefreshCw className="h-4 w-4" aria-hidden="true" />
                              Replace
                            </button>
                            <button
                              type="button"
                              onClick={handleRemoveMedia}
                              disabled={saving || mediaState.uploading}
                              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-destructive/40 bg-card px-2.5 text-[13px] font-medium text-destructive shadow-card transition-colors hover:bg-destructive/10 disabled:opacity-50"
                            >
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                              Remove
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2">
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
                  className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-card transition-colors hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save Message'}
                </button>
              </div>
            </div>

            {/* WhatsApp-style visual preview. Reflects the current form values
                only; it is not a live rendering of provider output. */}
            <div className="lg:col-span-5">
              <div className="app-card overflow-hidden">
                <div className="flex items-center justify-between gap-2 border-b border-border bg-muted px-4 py-3">
                  <div className="flex min-w-0 items-center gap-2">
                    {/* Application sender identity in the messaging preview.
                        UI branding only — the message model has no sender field, so
                        provider payload semantics are unchanged. */}
                    <BrandMark size="sm" />
                    <div className="min-w-0">
                      <h2 className="truncate card-title">{BRAND_NAME}</h2>
                    </div>
                  </div>
                  <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Visual only
                  </span>
                </div>
                <div className="flex min-h-[320px] flex-col justify-end gap-3 bg-muted p-4">
                  <div className="max-w-[92%] self-end overflow-hidden rounded-lg rounded-tr-none border border-border bg-card">
                    {mediaState.previewUrl && (
                      <div className="h-36 w-full overflow-hidden bg-muted">
                        <img src={mediaState.previewUrl} alt={mediaState.filename} className="h-full w-full object-cover" />
                      </div>
                    )}
                    <div className="p-3">
                      {body.trim() ? (
                        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">{body}</p>
                      ) : (
                        <p className="text-[13px] italic text-muted-foreground">
                          Your message preview will appear here.
                        </p>
                      )}
                    </div>
                  </div>
                  <p className="text-center text-[11px] font-medium text-muted-foreground">
                    Approximate layout only - not actual WhatsApp rendering
                  </p>
                </div>
              </div>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}
