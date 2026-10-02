import { useEffect, useState, useCallback } from 'react';
import axios from 'axios';
import { Sidebar } from '../components/Sidebar';
import { useNavigate } from 'react-router-dom';
import { useCurrentUser } from '../hooks/useAuth';
import { RefreshCw, Shield, Server, Smartphone, Settings as SettingsIcon, Clock, HardDrive, AlertCircle, Lock, LogOut, DatabaseBackup, ArchiveRestore } from 'lucide-react';

interface WhatsAppSettings {
  provider: string;
  configured: boolean;
  connectionStatus: string;
  verification: {
    verified: boolean;
    reason: string;
    message: string;
  };
  phoneInfo: { id?: string; displayPhoneNumber?: string; verifiedName?: string } | null;
  apiVersion: string | undefined;
  tokenConfigured: boolean;
  webhookConfigured: boolean;
  webhookVerificationStatus: {
    configured: boolean;
    error: string | null;
  };
  webhookTokenConfigured: boolean;
}

interface SendingSettings {
  maxRetries: number;
  retryBackoff: {
    baseDelayMs: number;
    maxDelayMs: number;
    multiplier: number;
    jitterPercent: number;
  };
}

interface SchedulerSettings {
  state: string;
  pollIntervalMs: number;
  batchSize: number;
  workerState: string;
}

interface StorageSettings {
  uploadPath: string;
  mediaLimits: {
    maxFileSizeBytes: number;
    allowedMimeTypes: string[];
  };
}

interface SystemSettings {
  version: string;
  database: string;
  health: string;
}

interface SecuritySettings {
  twoFactorEnabled: boolean;
  sessionActive: boolean;
  sessionExpiry?: string;
  lastLoginAt?: string;
  activeSessionCount?: number;
}

interface BackupSettings {
  enabled: boolean;
  backupDirectory: string;
  retentionCount: number;
  intervalHours: number;
  lastBackupAt: string | null;
  lastBackupStatus: string;
  lastBackupError?: string | null;
  backupCount: number;
  totalSizeBytes: number;
  operationInProgress: boolean;
  operation?: string | null;
  pendingRestore?: {
    restoreId: string;
    backupId: string;
    safetyBackupId?: string;
    startedAt: string;
  } | null;
  schedulerState: string;
  schedulerEnabled: boolean;
}

interface BackupListItem {
  backupId: string;
  fileName: string;
  createdAt: string | null;
  kind: string | null;
  sizeBytes: number;
  databaseSizeBytes?: number | null;
  mediaFileCount?: number | null;
}

interface GoogleSheetsSettings {
  configured: boolean;
  spreadsheetId: string | null;
  sheetName: string | null;
  bridgeConfigured: boolean;
  connectionStatus: string;
}

interface SettingsData {
  whatsapp: WhatsAppSettings;
  sending: SendingSettings;
  scheduler: SchedulerSettings;
  storage: StorageSettings;
  system: SystemSettings;
  security?: SecuritySettings;
  backup?: BackupSettings;
  googleSheets?: GoogleSheetsSettings;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export default function Settings() {
  const navigate = useNavigate();
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  // Set when the backend refuses the admin settings request (403). Rendered as a
  // clean restricted state instead of "Failed to load settings".
  const [restricted, setRestricted] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordErrors, setPasswordErrors] = useState<Record<string, string>>({});
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [logoutLoading, setLogoutLoading] = useState(false);
  const [logoutMessage, setLogoutMessage] = useState<string | null>(null);

  /* Phase 6.0B — Google Sheets manual sync UI state (top-level hooks) */
  const [sheetsBusy, setSheetsBusy] = useState<'VERIFY' | 'SYNC' | null>(null);
  const [sheetsMessage, setSheetsMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [sheetsSummary, setSheetsSummary] = useState<{
    rowsRead: number;
    newRecipients: number;
    updatedRecipients: number;
    skippedNoConsent: number;
    invalidRows: number;
  } | null>(null);

  // Settings is ADMIN-only. Read the session identity at the top of the
  // component (hooks cannot run inside the callback below).
  const { user: currentUser, loading: authLoading } = useCurrentUser();

  const fetchSettings = useCallback(async () => {
    // Root cause of "Failed to load settings": Settings is ADMIN-only, but the
    // page issued the admin request anyway and rendered a generic failure for the
    // resulting 403. A non-ADMIN session must not make this request at all.
    if (authLoading) return;
    if (!currentUser) {
      navigate('/login');
      return;
    }
    if (currentUser.role !== 'ADMIN') {
      setLoading(false);
      return;
    }
    try {
      setError(null);
      const res = await axios.get('/api/settings');
      setSettings(res.data.data);
    } catch (err: any) {
      if (err.response?.status === 401) {
        navigate('/login');
      } else if (err.response?.status === 403) {
        // Backend said no: show the restricted state, not a failure.
        setRestricted(true);
      } else {
        setError('Failed to load settings');
      }
    } finally {
      setLoading(false);
    }
  }, [navigate, currentUser, authLoading]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const handleVerify = async () => {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await axios.post('/api/settings/verify-connection');
      setVerifyResult(
        res.data.data.verified
          ? 'Connection verified successfully.'
          : `Verification failed: ${res.data.data.message}`
      );
    } catch (err: any) {
      if (err.response) {
        setVerifyResult(`Verification failed: ${err.response.data?.errorMessage || err.response.status}`);
      } else {
        setVerifyResult('Verification failed. Please try again.');
      }
    } finally {
      setVerifying(false);
    }
  };

  const validatePasswordForm = (): boolean => {
    const errors: Record<string, string> = {};
    if (!currentPassword) {
      errors.currentPassword = 'Current password is required';
    }
    if (!newPassword) {
      errors.newPassword = 'New password is required';
    } else if (newPassword.length < 8) {
      errors.newPassword = 'New password must be at least 8 characters';
    }
    if (!confirmPassword) {
      errors.confirmPassword = 'Please confirm your new password';
    } else if (confirmPassword !== newPassword) {
      errors.confirmPassword = 'Passwords do not match';
    }
    setPasswordErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordMessage(null);
    if (!validatePasswordForm()) return;
    setPasswordSubmitting(true);
    try {
      await axios.post('/api/auth/change-password', {
        currentPassword,
        newPassword,
        confirmPassword,
      });
      setPasswordMessage('Password changed successfully.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordErrors({});
    } catch (err: any) {
      if (err.response) {
        const msg = err.response.data?.error?.message || err.response.data?.errorMessage || 'Password change failed';
        setPasswordMessage(`Error: ${msg}`);
      } else {
        setPasswordMessage('Password change failed. Please try again.');
      }
    } finally {
      setPasswordSubmitting(false);
    }
  };

  const handleLogout = async () => {
    setLogoutLoading(true);
    setLogoutMessage(null);
    try {
      await axios.post('/api/auth/logout');
      navigate('/login');
    } catch {
      setLogoutMessage('Logout failed. Please try again.');
      setLogoutLoading(false);
    }
  };

  /* Phase 5.12 — Backup & Recovery UI state */
  const [backupBusy, setBackupBusy] = useState<'CREATE' | 'VERIFY' | 'RESTORE' | null>(null);
  const [backupMessage, setBackupMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreList, setRestoreList] = useState<BackupListItem[]>([]);
  const [restoreListError, setRestoreListError] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupListItem | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState(false);

  const handleCreateBackup = async () => {
    setBackupBusy('CREATE');
    setBackupMessage(null);
    try {
      const res = await axios.post('/api/backups', {});
      const created = res.data?.data?.backup;
      setBackupMessage({ tone: 'ok', text: `Backup created: ${created?.backupId ?? 'unknown id'}` });
      fetchSettings();
    } catch (err: any) {
      const message = err.response?.data?.error?.message || err.response?.status || 'unknown error';
      setBackupMessage({ tone: 'error', text: `Backup failed: ${message}` });
    } finally {
      setBackupBusy(null);
    }
  };

  const openRestoreDialog = async (infoMessage?: string) => {
    setRestoreOpen(true);
    setRestoreConfirm(false);
    setRestoreTarget(null);
    setRestoreList([]);
    setRestoreListError(infoMessage ?? null);
    setBackupMessage(null);
    try {
      const res = await axios.get('/api/backups');
      const list: BackupListItem[] = Array.isArray(res.data?.data?.backups) ? res.data.data.backups : [];
      setRestoreList(list);
      setRestoreTarget(list.length > 0 ? list[0] : null);
    } catch {
      setRestoreListError('Failed to load the backup list.');
    }
  };

  const handleVerifyBackup = async () => {
    setBackupMessage(null);
    if (!restoreTarget) {
      await openRestoreDialog('Select a backup in this dialog, then press Verify Selected.');
      return;
    }
    setBackupBusy('VERIFY');
    try {
      const res = await axios.post(`/api/backups/${restoreTarget.backupId}/verify`, {});
      const data = res.data?.data;
      const errorCodes = (Array.isArray(data?.errors) ? data.errors : [])
        .map((entry: { code?: string }) => entry?.code)
        .filter(Boolean)
        .join(', ');
      setBackupMessage(
        data?.valid
          ? { tone: 'ok', text: `Backup ${data.backupId} verified successfully.` }
          : { tone: 'error', text: `Backup ${data?.backupId ?? restoreTarget.backupId} failed verification${errorCodes ? `: ${errorCodes}` : ''}.` }
      );
    } catch (err: any) {
      const message = err.response?.data?.error?.message || err.response?.status || 'unknown error';
      setBackupMessage({ tone: 'error', text: `Verification failed: ${message}` });
    } finally {
      setBackupBusy(null);
    }
  };

  const handleRestoreBackup = async () => {
    if (!restoreTarget || !restoreConfirm || backupBusy) return;
    setBackupBusy('RESTORE');
    try {
      const res = await axios.post(`/api/backups/${restoreTarget.backupId}/restore`, { confirmed: true });
      const data = res.data?.data;
      setRestoreOpen(false);
      setRestoreConfirm(false);
      setBackupMessage({
        tone: 'ok',
        text: `Restore completed from ${data?.backupId}. Safety backup of the previous state: ${data?.safetyBackupId ?? 'created'}.`,
      });
      fetchSettings();
    } catch (err: any) {
      const message = err.response?.data?.error?.message || err.response?.status || 'unknown error';
      setBackupMessage({ tone: 'error', text: `Restore failed: ${message}. The previous state was preserved where possible.` });
    } finally {
      setBackupBusy(null);
    }
  };

  const handleSheetsVerify = async () => {
    setSheetsBusy('VERIFY');
    setSheetsMessage(null);
    try {
      const res = await axios.post('/api/google-sheets/verify', {});
      setSheetsMessage({ tone: 'ok', text: res.data?.data?.message ?? 'Connected to Google Sheet.' });
    } catch (err: any) {
      const message = err.response?.data?.error?.message || err.response?.status || 'unknown error';
      setSheetsMessage({ tone: 'error', text: `Connection check failed: ${message}` });
    } finally {
      setSheetsBusy(null);
    }
  };

  const handleSheetsSync = async () => {
    setSheetsBusy('SYNC');
    setSheetsMessage(null);
    setSheetsSummary(null);
    try {
      const res = await axios.post('/api/google-sheets/sync', {});
      const summary = res.data?.data?.summary;
      setSheetsSummary(summary ?? null);
      setSheetsMessage({ tone: 'ok', text: 'Sync completed.' });
    } catch (err: any) {
      const message = err.response?.data?.error?.message || err.response?.status || 'unknown error';
      setSheetsMessage({ tone: 'error', text: `Sync failed: ${message}` });
    } finally {
      setSheetsBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="app-shell">
        <Sidebar />
        <main className="app-main">
          <div className="app-content">
            <div className="app-card p-5">
              <p className="text-[13px] text-muted-foreground">Loading settings...</p>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // A non-ADMIN session (or an explicit 403) shows a clean restricted state —
  // never an admin-level settings failure.
  if (restricted || (currentUser && currentUser.role !== 'ADMIN')) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
        <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 text-center">
          <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-muted">
            <Lock className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          </span>
          <h1 className="mt-4 text-sm font-semibold text-foreground">Access restricted</h1>
          <p className="mt-2 text-[13px] leading-5 text-muted-foreground">
            Settings are available to administrators only. Your account does not have permission to view them.
          </p>
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="mt-5 inline-flex h-10 items-center rounded-lg bg-primary px-4 text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-95"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="app-shell">
        <Sidebar />
        <main className="app-main">
          <div className="app-content">
            <div className="app-card flex items-start gap-2 border-destructive/40 bg-destructive/10 p-4">
              <AlertCircle className="h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
              <p className="text-[13px] font-medium text-destructive">{error}</p>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (!settings) return null;

  const { whatsapp, sending, scheduler, storage, system, security, backup, googleSheets } = settings;

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-main">
        <div className="app-content space-y-4">
          {/* Page header */}
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                <SettingsIcon className="h-5 w-5 text-primary" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h1 className="page-title">Settings</h1>
                <p className="page-subtitle">
                  Administrator configuration for integrations, delivery, storage and backups.
                </p>
              </div>
            </div>
          </div>

          {verifyResult && (
            <div
              className={`flex items-center gap-2 rounded-lg border px-4 py-3 ${
                verifyResult.includes('verified')
                  ? 'border-success/40 bg-success/10'
                  : 'border-destructive/40 bg-destructive/10'
              }`}
            >
              <AlertCircle
                className={`h-4 w-4 shrink-0 ${verifyResult.includes('verified') ? 'text-success' : 'text-destructive'}`}
                aria-hidden="true"
              />
              <span
                className={`text-[13px] font-medium ${verifyResult.includes('verified') ? 'text-success' : 'text-destructive'}`}
              >
                {verifyResult}
              </span>
            </div>
          )}

            {/* WhatsApp Section */}
            <div className="app-card p-5">
              <div className="flex items-center gap-2 mb-4">
                <Smartphone className="h-5 w-5 text-primary" />
                <h2 className="card-title">WhatsApp</h2>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Provider</p>
                  <p className="mt-1 text-[13px] text-foreground">{whatsapp.provider || 'none'}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Configured</p>
                  <p className="mt-1 text-sm">
                    {whatsapp.configured
                      ? <span className="font-medium text-success">Yes</span>
                      : <span className="text-muted-foreground">No</span>}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Connection Status</p>
                  <p className="mt-1 text-[13px] text-foreground">{whatsapp.connectionStatus}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Access Token</p>
                  <p className="mt-1 text-sm">
                    {whatsapp.tokenConfigured
                      ? <span className="font-medium text-success">Configured</span>
                      : <span className="text-muted-foreground">Not configured</span>}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Webhook</p>
                  <p className="mt-1 text-sm">
                    {whatsapp.webhookConfigured
                      ? <span className="font-medium text-success">Configured</span>
                      : <span className="text-muted-foreground">Not configured</span>}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">API Version</p>
                  <p className="mt-1 text-[13px] text-foreground">{whatsapp.apiVersion || '—'}</p>
                </div>
                {whatsapp.phoneInfo?.displayPhoneNumber && (
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Phone Number</p>
                    <p className="mt-1 text-[13px] text-foreground">{whatsapp.phoneInfo.displayPhoneNumber}</p>
                  </div>
                )}
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Webhook Verify Token</p>
                  <p className="mt-1 text-sm">
                    {whatsapp.webhookTokenConfigured
                      ? <span className="font-medium text-success">Configured</span>
                      : <span className="text-muted-foreground">Not configured</span>}
                  </p>
                </div>
              </div>
              {whatsapp.provider === 'official' && whatsapp.configured && (
                <div className="mt-4">
                  <button
                    onClick={handleVerify}
                    disabled={verifying}
                    className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-card transition-colors hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RefreshCw className={`h-4 w-4 ${verifying ? 'animate-spin' : ''}`} />
                    {verifying ? 'Verifying...' : 'Verify Connection'}
                  </button>
                </div>
              )}
              {whatsapp.webhookVerificationStatus && (
                <div className="mt-4 rounded-lg border border-border bg-muted p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Webhook Verification</p>
                  <p className="mt-1 text-[13px] text-foreground">
                    {whatsapp.webhookVerificationStatus.configured ? 'Configured' : 'Not configured'}
                  </p>
                  {whatsapp.webhookVerificationStatus.error && (
                    <p className="mt-1 text-[13px] font-medium text-destructive">{whatsapp.webhookVerificationStatus.error}</p>
                  )}
                </div>
              )}
            </div>

            {/* Google Sheets Sync Section (Phase 6.0B — Apps Script bridge, manual sync only) */}
            <div className="app-card p-5">
              <div className="flex items-center gap-2 mb-4">
                <Server className="h-5 w-5 text-primary" />
                <h2 className="card-title">Google Sheets Sync</h2>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Connection status</p>
                  <p className="mt-1 text-[13px] text-foreground">{googleSheets?.connectionStatus ?? 'NOT_CONFIGURED'}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Spreadsheet ID</p>
                  <p className="mt-1 break-all text-[13px] text-foreground">{googleSheets?.spreadsheetId ?? '—'}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Sheet/tab name</p>
                  <p className="mt-1 text-[13px] text-foreground">{googleSheets?.sheetName ?? '—'}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Apps Script bridge</p>
                  <p className="mt-1 text-sm">{googleSheets?.bridgeConfigured ? 'Configured' : 'Not configured'}</p>
                </div>
              </div>
              <p className="mt-3 meta-text">Configuration is environment-based. Manual Sync Now only; no automatic sync.</p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  onClick={handleSheetsVerify}
                  disabled={sheetsBusy !== null}
                  className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-4 text-sm font-medium text-foreground shadow-card transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {sheetsBusy === 'VERIFY' ? 'Checking...' : 'Connect / Configure'}
                </button>
                <button
                  onClick={handleSheetsSync}
                  disabled={sheetsBusy !== null}
                  className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-card transition-colors hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw className={`h-4 w-4 ${sheetsBusy === 'SYNC' ? 'animate-spin' : ''}`} />
                  {sheetsBusy === 'SYNC' ? 'Syncing...' : 'Sync Now'}
                </button>
              </div>
              {sheetsMessage && (
                <p className={`mt-3 text-sm ${sheetsMessage.tone === 'ok' ? 'text-success' : 'text-destructive'}`}>{sheetsMessage.text}</p>
              )}
              {sheetsSummary && (
                <div className="mt-3 rounded-lg border border-border bg-muted p-3 text-[13px] text-foreground">
                  <p className="mb-1.5 font-medium">Last sync result (spreadsheet rows, this run)</p>
                  <p>Rows read from sheet: {sheetsSummary.rowsRead}</p>
                  <p>New recipients created: {sheetsSummary.newRecipients}</p>
                  <p>Existing recipients updated: {sheetsSummary.updatedRecipients}</p>
                  <p>Skipped — no consent given: {sheetsSummary.skippedNoConsent}</p>
                  <p>Invalid rows skipped: {sheetsSummary.invalidRows}</p>
                  <p className="mt-2 text-[12px] leading-4 text-muted-foreground">
                    Rows are matched to recipients by phone number, so these figures count sheet rows, not unique recipients. See Recipients for the recipient total.
                  </p>
                </div>
              )}
            </div>

            {/* Sending & Retry Section */}
            <div className="app-card p-5">
              <div className="flex items-center gap-2 mb-4">
                <Shield className="h-5 w-5 text-primary" />
                <h2 className="card-title">Sending & Retry</h2>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Maximum Retries</p>
                  <p className="mt-1 text-[13px] text-foreground">{sending.maxRetries}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Retry Backoff</p>
                  <p className="mt-1 text-[13px] text-foreground">
                    {sending.retryBackoff.baseDelayMs / 1000}s base, {sending.retryBackoff.maxDelayMs / 60000}min max
                  </p>
                </div>
              </div>
            </div>

            {/* Scheduler & Worker Section */}
            <div className="app-card p-5">
              <div className="flex items-center gap-2 mb-4">
                <Clock className="h-5 w-5 text-primary" />
                <h2 className="card-title">Scheduler & Worker</h2>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Scheduler State</p>
                  <p className="mt-1 text-sm">
                    {scheduler.state === 'running'
                      ? <span className="font-medium text-success">Running</span>
                      : <span className="text-muted-foreground">Stopped</span>}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Worker State</p>
                  <p className="mt-1 text-sm">
                    {scheduler.workerState === 'running'
                      ? <span className="font-medium text-success">Running</span>
                      : <span className="text-muted-foreground">Stopped</span>}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Poll Interval</p>
                  <p className="mt-1 text-[13px] text-foreground">{scheduler.pollIntervalMs} ms</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Batch Size</p>
                  <p className="mt-1 text-[13px] text-foreground">{scheduler.batchSize}</p>
                </div>
              </div>
            </div>

            {/* Storage Section */}
            <div className="app-card p-5">
              <div className="flex items-center gap-2 mb-4">
                <HardDrive className="h-5 w-5 text-primary" />
                <h2 className="card-title">Storage</h2>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Upload Path</p>
                  <p className="mt-1 text-[13px] text-foreground">{storage.uploadPath}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Max File Size</p>
                  <p className="mt-1 text-[13px] text-foreground">{formatBytes(storage.mediaLimits.maxFileSizeBytes)}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Allowed Types</p>
                  <p className="mt-1 text-[13px] text-foreground">{storage.mediaLimits.allowedMimeTypes.join(', ')}</p>
                </div>
              </div>
            </div>

            {/* Backup & Recovery Section (Phase 5.12) */}
            <div className="app-card p-5">
              <div className="flex items-center gap-2 mb-4">
                <DatabaseBackup className="h-5 w-5 text-primary" />
                <h2 className="card-title">Backup &amp; Recovery</h2>
              </div>

              {backup && (
                <>
                  <div className="app-card mb-4 p-4">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Scheduled Backups</p>
                      <p className="mt-1 text-sm">
                        {backup.enabled
                          ? <span className="font-medium text-success">Enabled</span>
                          : <span className="text-muted-foreground">Disabled</span>}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Backup Directory</p>
                      <p className="mt-1 text-[13px] text-foreground">{backup.backupDirectory}</p>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Stored Backups</p>
                      <p className="mt-1 text-[13px] text-foreground">{backup.backupCount}</p>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Last Backup</p>
                      <p className="mt-1 text-[13px] text-foreground">
                        {backup.lastBackupAt ? new Date(backup.lastBackupAt).toLocaleString() : 'Never'}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Last Result</p>
                      <p className="mt-1 text-sm">
                        {backup.lastBackupStatus === 'SUCCESS' || backup.lastBackupStatus === 'AVAILABLE' || backup.lastBackupStatus === 'VALID'
                          ? <span className="font-medium text-success">{backup.lastBackupStatus}</span>
                          : backup.lastBackupStatus === 'NEVER'
                            ? <span className="text-muted-foreground">No backup yet</span>
                            : <span className="text-[13px] font-medium text-destructive">{backup.lastBackupStatus}</span>}
                        {backup.lastBackupError ? ` — ${backup.lastBackupError}` : ''}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Retention</p>
                      <p className="mt-1 text-[13px] text-foreground">Keep newest {backup.retentionCount}</p>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Backup Interval</p>
                      <p className="mt-1 text-[13px] text-foreground">Every {backup.intervalHours} h</p>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Scheduler State</p>
                      <p className="mt-1 text-[13px] text-foreground">{backup.schedulerState}</p>
                    </div>
                  </div>

                  {backup.pendingRestore && (
                    <div className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3">
                      <AlertCircle className="mt-0.5 h-5 w-5 text-destructive" />
                      <div>
                        <p className="text-[13px] font-semibold text-destructive">Incomplete restore detected</p>
                        <p className="text-[13px] text-destructive">
                          Restore {backup.pendingRestore.restoreId} (backup {backup.pendingRestore.backupId}) did not
                          finish cleanly. Review the restore journal before running another restore.
                        </p>
                      </div>
                    </div>
                  )}

                  {backupMessage && (
                    <p className={`mb-4 text-sm ${backupMessage.tone === 'ok' ? 'text-success' : 'text-destructive'}`}>
                      {backupMessage.text}
                    </p>
                  )}

                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      onClick={handleCreateBackup}
                      disabled={backupBusy !== null || backup.operationInProgress}
                      className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-card transition-colors hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <DatabaseBackup className="h-4 w-4" />
                      {backupBusy === 'CREATE' ? 'Creating...' : 'Create Backup'}
                    </button>
                    <button
                      onClick={handleVerifyBackup}
                      disabled={backupBusy !== null || backup.operationInProgress}
                      className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-4 text-sm font-medium text-foreground shadow-card transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {backupBusy === 'VERIFY' ? 'Verifying...' : 'Verify'}
                    </button>
                    <button
                      onClick={() => openRestoreDialog()}
                      disabled={backupBusy !== null || backup.operationInProgress}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-md hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <ArchiveRestore className="h-4 w-4" />
                      Restore
                    </button>
                    {backup.operationInProgress && (
                      <span className="text-[13px] text-muted-foreground">
                        A backup operation is in progress ({backup.operation ?? 'unknown'}).
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* System Section */}
            <div className="app-card p-5">
              <div className="flex items-center gap-2 mb-4">
                <Server className="h-5 w-5 text-primary" />
                <h2 className="card-title">System</h2>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Version</p>
                  <p className="mt-1 text-[13px] text-foreground">{system.version}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Database</p>
                  <p className="mt-1 text-sm">
                    {system.database === 'connected'
                      ? <span className="font-medium text-success">Connected</span>
                      : <span className="text-[13px] font-medium text-destructive">{system.database}</span>}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Health</p>
                  <p className="mt-1 text-sm">
                    {system.health === 'ok'
                      ? <span className="font-medium text-success">OK</span>
                      : <span className="text-[13px] font-medium text-destructive">{system.health}</span>}
                  </p>
                </div>
              </div>
            </div>

            {/* Security Section */}
            <div className="app-card p-5">
              <div className="flex items-center gap-2 mb-4">
                <Lock className="h-5 w-5 text-primary" />
                <h2 className="card-title">Security</h2>
              </div>

              {security && (
                <div className="app-card mb-4 p-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Two-Factor Auth</p>
                    <p className="mt-1 text-sm">
                      {security.twoFactorEnabled
                        ? <span className="font-medium text-success">Enabled</span>
                        : <span className="text-muted-foreground">Disabled</span>}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Session Status</p>
                    <p className="mt-1 text-sm">
                      {security.sessionActive
                        ? <span className="font-medium text-success">Active</span>
                        : <span className="text-muted-foreground">Inactive</span>}
                    </p>
                  </div>
                  {security.sessionExpiry && (
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Session Expiry</p>
                      <p className="mt-1 text-[13px] text-foreground">{security.sessionExpiry}</p>
                    </div>
                  )}
                  {security.lastLoginAt && (
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Last Login</p>
                      <p className="mt-1 text-[13px] text-foreground">{security.lastLoginAt}</p>
                    </div>
                  )}
                  {typeof security.activeSessionCount === 'number' && (
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Active Sessions</p>
                      <p className="mt-1 text-[13px] text-foreground">{security.activeSessionCount}</p>
                    </div>
                  )}
                </div>
              )}

              <form onSubmit={handleChangePassword} className="space-y-4">
                <h3 className="text-[13px] font-semibold text-foreground">Change Password</h3>
                <div>
                  <label className="block text-[13px] font-medium text-foreground">Current Password</label>
                  <input
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    autoComplete="current-password"
                  />
                  {passwordErrors.currentPassword && <p className="mt-1 text-[13px] font-medium text-destructive">{passwordErrors.currentPassword}</p>}
                </div>
                <div>
                  <label className="block text-[13px] font-medium text-foreground">New Password</label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    autoComplete="new-password"
                  />
                  {passwordErrors.newPassword && <p className="mt-1 text-[13px] font-medium text-destructive">{passwordErrors.newPassword}</p>}
                </div>
                <div>
                  <label className="block text-[13px] font-medium text-foreground">Confirm New Password</label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    autoComplete="new-password"
                  />
                  {passwordErrors.confirmPassword && <p className="mt-1 text-[13px] font-medium text-destructive">{passwordErrors.confirmPassword}</p>}
                </div>
                <div className="flex items-center gap-3">
                  <button
                    type="submit"
                    disabled={passwordSubmitting}
                    className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-card transition-colors hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {passwordSubmitting ? 'Changing...' : 'Change Password'}
                  </button>
                  {passwordMessage && (
                    <span className={`text-sm ${passwordMessage.includes('Error') || passwordMessage.includes('error') ? 'text-destructive' : 'text-success'}`}>
                      {passwordMessage}
                    </span>
                  )}
                </div>
              </form>

              <div className="mt-6 border-t border-border pt-4">
                <button
                  onClick={handleLogout}
                  disabled={logoutLoading}
                  className="inline-flex h-10 items-center gap-2 rounded-lg bg-destructive px-4 text-sm font-semibold text-destructive-foreground shadow-card transition-colors hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <LogOut className="h-4 w-4" />
                  {logoutLoading ? 'Logging out...' : 'Log Out'}
                </button>
                {logoutMessage && (
                  <p className="mt-2 text-[13px] font-medium text-destructive">{logoutMessage}</p>
                )}
              </div>
            </div>

            {restoreOpen && (
              <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                <div className="fixed inset-0 bg-foreground/50 backdrop-blur-[1px]" aria-hidden="true" />
                <div
                  className="app-card relative w-full max-w-lg p-5"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="restore-backup-title"
                >
                  <h3 className="card-title" id="restore-backup-title">Restore from Backup</h3>
                  <p className="mt-2 text-[13px] text-muted-foreground">
                    Restoring replaces the application database and reverts media files to the contents of the
                    selected backup. Any data created after the backup will be lost. A fresh safety backup of
                    the current state is created first.
                  </p>

                  {restoreListError && (
                    <p className="mb-3 text-[13px] font-medium text-destructive">{restoreListError}</p>
                  )}

                  <label className="mb-1 block text-[13px] font-medium text-foreground">Backup</label>
                  <select
                    value={restoreTarget?.backupId ?? ''}
                    onChange={(e) => {
                      const selected = restoreList.find((item) => item.backupId === e.target.value) ?? null;
                      setRestoreTarget(selected);
                      setRestoreConfirm(false);
                    }}
                    className="h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">Select a backup…</option>
                    {restoreList.map((item) => (
                      <option key={item.backupId} value={item.backupId}>
                        {item.backupId}
                        {item.createdAt ? ` — ${new Date(item.createdAt).toLocaleString()}` : ''}
                        {item.kind ? ` (${item.kind})` : ''}
                      </option>
                    ))}
                  </select>

                  {restoreTarget && (
                    <div className="mt-3 rounded-lg border border-border bg-muted p-3 text-[13px] text-foreground">
                      <p>Backup ID: <span className="font-medium">{restoreTarget.backupId}</span></p>
                      {restoreTarget.createdAt && (
                        <p>Created: {new Date(restoreTarget.createdAt).toLocaleString()}</p>
                      )}
                      <p>Archive size: {formatBytes(restoreTarget.sizeBytes)}</p>
                    </div>
                  )}

                  <label className="mt-4 flex items-start gap-2 text-[13px] text-foreground">
                    <input
                      type="checkbox"
                      checked={restoreConfirm}
                      onChange={(e) => setRestoreConfirm(e.target.checked)}
                      className="mt-1"
                    />
                    <span>I understand that restoring changes application data and cannot be undone.</span>
                  </label>

                  <div className="mt-4 flex items-center justify-end gap-3">
                    <button
                      onClick={() => setRestoreOpen(false)}
                      disabled={backupBusy !== null}
                      className="inline-flex h-10 items-center rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleVerifyBackup}
                      disabled={!restoreTarget || backupBusy !== null || backup?.operationInProgress}
                      className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-4 text-sm font-medium text-foreground shadow-card transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {backupBusy === 'VERIFY' ? 'Verifying...' : 'Verify Selected'}
                    </button>
                    <button
                      onClick={handleRestoreBackup}
                      disabled={!restoreTarget || !restoreConfirm || backupBusy !== null || backup?.operationInProgress}
                      className="inline-flex h-10 items-center gap-2 rounded-lg bg-destructive px-4 text-sm font-semibold text-destructive-foreground shadow-card transition-colors hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <ArchiveRestore className="h-4 w-4" />
                      {backupBusy === 'RESTORE' ? 'Restoring...' : 'Restore Now'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            <p className="mt-4 text-[11px] text-muted-foreground">
              Values marked as environment-dependent require a server restart to change.
            </p>
          </div>
      </main>
    </div>
  );
}
