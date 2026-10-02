import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Sidebar } from '../components/Sidebar';
import { useNavigate } from 'react-router-dom';
import { useCurrentUser } from '../hooks/useAuth';
import { AlertCircle, Plus, RefreshCw, ShieldCheck, UserCog, X, Eye } from 'lucide-react';

/**
 * Phase 8.1 — Admin-only user management.
 *
 * Read/create/role-change only: no passwords are ever rendered (the API never
 * returns them) and the create form never holds the password beyond the POST.
 * Navigation to this route is hidden for PRO sessions; the backend still
 * returns 403 FORBIDDEN on every /api/users call, which is surfaced verbatim.
 */
interface AdminUser {
  id: string;
  email: string;
  role: string;
  /** Lightweight profile fields (nullable). */
  displayName?: string | null;
  assignment?: string | null;
  avatarUrl?: string | null;
  initials?: string;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ApiErrorBody {
  error?: { code?: string; message?: string };
  errorMessage?: string;
}

const ROLE_OPTIONS = ['PRO', 'ADMIN'] as const;
type RoleOption = (typeof ROLE_OPTIONS)[number];

function getApiErrorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const body = err.response?.data as ApiErrorBody | undefined;
    const message = body?.error?.message || body?.errorMessage;
    if (message) return message;
    if (err.response?.status === 403) return 'You do not have permission to perform this action';
  }
  return fallback;
}

/**
 * ADMIN and PRO are the only roles. They are two peer values in the CMS, not a
 * hierarchy, so the badge uses the shared semantic tokens rather than
 * implying a ranking between them.
 */
function RoleBadge({ role }: { role: string }) {
  const isAdmin = role === 'ADMIN';
  return (
    <span
      className={`inline-flex h-5 items-center gap-1.5 rounded-full border px-2 text-[11px] font-semibold uppercase tracking-wider ${
        isAdmin
          ? 'border-info/40 bg-info/10 text-info'
          : 'border-border bg-muted text-muted-foreground'
      }`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {isAdmin ? 'ADMIN' : 'PRO'}
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

export default function Users() {
  const navigate = useNavigate();
  const { user: currentUser, loading: authLoading, isAdmin } = useCurrentUser();

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Success/error banners are transient UI toasts, not audit records. Auto
  // dismiss after 4s; audit/history rows in the DB are never auto-deleted.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  /* Create-user form state. The password is held only until POST. */
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<RoleOption>('PRO');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  /* Role change state: PATCH only fires from the confirmation modal. */
  const [roleTarget, setRoleTarget] = useState<AdminUser | null>(null);
  const [roleTargetRole, setRoleTargetRole] = useState<RoleOption>('PRO');
  const [roleChanging, setRoleChanging] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);

  // Seed the profile form from the authoritative current-user data.
  useEffect(() => {
    if (currentUser) {
      setDisplayName(currentUser.displayName ?? '');
      setAssignment(currentUser.assignment ?? '');
    }
  }, [currentUser]);

  const fetchUsers = useCallback(async () => {
    try {
      setError(null);
      const res = await axios.get('/api/users');
      setUsers(Array.isArray(res.data?.data?.users) ? res.data.data.users : []);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        navigate('/login');
        return;
      }
      setError(getApiErrorMessage(err, 'Failed to load users'));
    } finally {
      setLoading(false);
    }
  }, [navigate]);

  useEffect(() => {
    // Admin-only page: never call the admin API unless the backend says ADMIN.
    if (authLoading || !isAdmin) return;
    fetchUsers();
  }, [authLoading, isAdmin, fetchUsers]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError(null);
    setNotice(null);
    setCreating(true);
    try {
      const res = await axios.post('/api/users', {
        email: newEmail.trim(),
        password: newPassword,
        role: newRole,
      });
      const created: AdminUser | undefined = res.data?.data?.user;
      setNotice(`User ${created?.email ?? newEmail.trim()} created with role ${newRole}.`);
      setNewEmail('');
      setNewPassword('');
      setNewRole('PRO');
      await fetchUsers();
    } catch (err) {
      setCreateError(getApiErrorMessage(err, 'Failed to create user'));
    } finally {
      setCreating(false);
    }
  };

  /* Bulk selection + destructive confirmation (ADMIN only). */
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<Array<{ email: string; code: string; message: string }>>([]);

  const selectableUsers = users.filter((u) => u.id !== currentUser?.id);
  const allSelected = selectableUsers.length > 0 && selectableUsers.every((u) => selected.includes(u.id));

  const toggleOne = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const toggleAll = () =>
    setSelected(allSelected ? [] : selectableUsers.map((u) => u.id));

  /* View Profile (ADMIN-only read-only). Lightweight: identity + assignment +
   timestamps. Never exposes password or any secret. */
  const [profileTarget, setProfileTarget] = useState<AdminUser | null>(null);

  const openRoleChange = (target: AdminUser) => {
    setRoleTarget(target);
    setRoleTargetRole(target.role === 'ADMIN' ? 'PRO' : 'ADMIN');
    setRoleError(null);
  };

  const runBulkDelete = async () => {
    setBulkBusy(true);
    setBulkError(null);
    setBlocked([]);
    try {
      const res = await axios.delete('/api/users', { data: { userIds: selected } });
      const deleted: string[] = res.data?.data?.deletedEmails ?? [];
      setNotice(`Deleted ${res.data?.data?.deleted ?? deleted.length} user(s): ${deleted.join(', ') || 'none'}.`);
      setSelected([]);
      setBulkOpen(false);
      await fetchUsers();
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        // Backend refused the whole batch and told us exactly why. Report it
        // rather than silently doing a partial delete.
        const body = err.response.data as { error?: { message?: string; blocked?: Array<{ email: string; code: string; message: string }> } };
        setBlocked(body?.error?.blocked ?? []);
        setBulkError(body?.error?.message ?? 'No users were deleted.');
      } else {
        setBulkError(getApiErrorMessage(err, 'Failed to delete selected users'));
      }
    } finally {
      setBulkBusy(false);
    }
  };

  /* Profile (the signed-in ADMIN's own lightweight profile). */
  const [displayName, setDisplayName] = useState('');
  const [assignment, setAssignment] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileNotice, setProfileNotice] = useState<string | null>(null);
  const { refresh: refreshUser } = useCurrentUser();

  /* Avatar upload — reuses the existing POST /api/media storage pipeline.
     Type/size are validated here for fast feedback AND remain enforced
     server-side by the same media endpoint + the profile avatar check. */
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
  const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

  const pickAvatar = () => {
    setAvatarError(null);
    avatarInputRef.current?.click();
  };

  const onAvatarSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    setAvatarError(null);
    if (!AVATAR_TYPES.includes(file.type)) {
      setAvatarError('Choose a JPG, PNG or WebP image.');
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setAvatarError('Image must be 5 MB or smaller.');
      return;
    }
    setAvatarBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const up = await axios.post('/api/media', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      const mediaId = up.data?.data?.id;
      if (!mediaId) throw new Error('Upload did not return a media id');
      await axios.patch('/api/users/me/profile', { avatarMediaId: mediaId });
      // Refresh the shared current-user cache so the sidebar updates immediately.
      await refreshUser();
      setProfileNotice('Photo updated.');
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : 0;
      setAvatarError(status === 413 ? 'Image must be 5 MB or smaller.'
        : status === 400 ? 'That file type is not supported.'
        : getApiErrorMessage(err, 'Failed to upload the photo'));
    } finally {
      setAvatarBusy(false);
    }
  };

  const removeAvatar = async () => {
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      await axios.patch('/api/users/me/profile', { avatarMediaId: null });
      await refreshUser();
      setProfileNotice('Photo removed.');
    } catch (err) {
      setAvatarError(getApiErrorMessage(err, 'Failed to remove the photo'));
    } finally {
      setAvatarBusy(false);
    }
  };

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileBusy(true);
    setProfileNotice(null);
    try {
      await axios.patch('/api/users/me/profile', {
        displayName: displayName.trim(),
        assignment: assignment.trim(),
      });
      // Refresh the shared current-user cache so the sidebar picks up the new
      // display name immediately (single source of truth).
      await refreshUser();
      setProfileNotice('Profile saved.');
    } catch (err) {
      setProfileNotice(getApiErrorMessage(err, 'Failed to save profile'));
    } finally {
      setProfileBusy(false);
    }
  };

  const handleRoleChange = async () => {
    if (!roleTarget) return;
    setRoleChanging(true);
    setRoleError(null);
    try {
      await axios.patch(`/api/users/${roleTarget.id}/role`, { role: roleTargetRole });
      setNotice(`Role for ${roleTarget.email} changed to ${roleTargetRole}.`);
      setRoleTarget(null);
      await fetchUsers();
    } catch (err) {
      // Backend guards (e.g. LAST_ADMIN 409) are surfaced verbatim.
      setRoleError(getApiErrorMessage(err, 'Failed to change role'));
    } finally {
      setRoleChanging(false);
    }
  };

  /* UI hiding only: PRO never sees this page content. Backend still 403s. */
  if (authLoading) {
    return (
      <div className="app-shell">
        <Sidebar />
        <main className="app-main">
          <div className="app-content">
            <div className="app-card p-5">
              <p className="text-[13px] text-muted-foreground">Loading users...</p>
            </div>
          </div>
        </main>
      </div>
    );
  }
  if (!isAdmin) {
    return (
      <div className="app-shell">
        <Sidebar />
        <main className="app-main">
          <div className="app-content">
            <div className="app-card flex flex-col items-center px-4 py-12 text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <ShieldCheck className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
              </div>
              <h2 className="card-title">Admins only</h2>
              <p className="mt-1 max-w-md text-[13px] text-muted-foreground">
                User management is available to administrator accounts.
              </p>
              <button
                onClick={() => navigate('/dashboard')}
                className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-card transition-colors hover:opacity-95"
              >
                Back to Dashboard
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
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                <UserCog className="h-5 w-5 text-primary" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h1 className="page-title">Users</h1>
                <p className="page-subtitle">
                  Manage the CMS accounts that can sign in, and their roles.
                </p>
              </div>
            </div>
            <button
              onClick={() => {
                setLoading(true);
                fetchUsers();
              }}
              disabled={loading}
              className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
              {loading ? 'Refreshing' : 'Refresh'}
            </button>
          </div>

          {/* Transient success/error notification: this is a UI toast, NOT an audit
              record. It auto-dismisses and can be dismissed manually. The
              persistent audit/history records in the database are untouched. */}
          {notice && (
            <div role="status" aria-live="polite" className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/10 px-4 py-3">
              <span className="flex-1 text-[13px] font-medium text-success">{notice}</span>
              <button
                type="button"
                onClick={() => setNotice(null)}
                aria-label="Dismiss notification"
                className="shrink-0 rounded p-0.5 text-success transition-opacity hover:opacity-70"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" aria-hidden="true" />
              <span className="text-[13px] font-medium text-destructive">{error}</span>
            </div>
          )}

          {/* Create user — POST /api/users */}
          <div className="app-card p-4">
            <h2 className="card-title">Create User</h2>
            <p className="meta-text mt-0.5">
              The password is sent once in the request and is never displayed again.
            </p>
            <form onSubmit={handleCreate} className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1">
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground" htmlFor="user-email">
                  Email
                </label>
                <input
                  id="user-email"
                  type="email"
                  required
                  autoComplete="off"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <div className="flex-1">
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground" htmlFor="user-password">
                  Password
                </label>
                <input
                  id="user-password"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground" htmlFor="user-role">
                  Role
                </label>
                <select
                  id="user-role"
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value === 'ADMIN' ? 'ADMIN' : 'PRO')}
                  className="mt-1 block h-10 rounded-lg border border-input bg-card px-3 text-[13px] text-foreground shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="PRO">PRO</option>
                  <option value="ADMIN">ADMIN</option>
                </select>
              </div>
              <button
                type="submit"
                disabled={creating}
                className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-card transition-colors hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
                {creating ? 'Creating...' : 'Create User'}
              </button>
            </form>
            {createError && (
              <p className="mt-3 text-[13px] font-medium text-destructive">{createError}</p>
            )}
          </div>

          {/* User table */}
          {/* User table */}
          {loading ? (
            <div className="app-card flex items-center justify-center py-12">
              <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
              <span className="sr-only">Loading users</span>
            </div>
          ) : users.length === 0 ? (
            <div className="app-card flex flex-col items-center px-4 py-12 text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <UserCog className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
              </div>
              <h3 className="card-title">No users found</h3>
              <p className="mt-1 max-w-md text-[13px] text-muted-foreground">
                Create the first account above to give someone access to the CMS.
              </p>
            </div>
          ) : (
            <div className="app-card overflow-hidden">
              {/* Bulk action bar */}
              <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
                <span className="text-[13px] font-medium text-foreground">
                  {selected.length} selected
                </span>
                <button
                  type="button"
                  disabled={selected.length === 0}
                  onClick={() => { setBulkError(null); setBlocked([]); setBulkOpen(true); }}
                  className="ml-auto inline-flex h-9 items-center gap-2 rounded-lg bg-destructive px-3 text-[13px] font-semibold text-destructive-foreground transition-opacity hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Delete selected users
                </button>
              </div>
              <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-border">
                <thead className="bg-muted">
                  <tr>
                    <th scope="col" className="w-10 px-4 py-3 text-left">
                      <input
                        type="checkbox"
                        aria-label="Select all users"
                        checked={allSelected}
                        onChange={toggleAll}
                        disabled={selectableUsers.length === 0}
                        className="h-4 w-4 rounded border-input accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
                      />
                    </th>
                    <th scope="col" className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Email</th>
                    <th scope="col" className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Role</th>
                    <th scope="col" className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Created</th>
                    <th scope="col" className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Last Login</th>
                    <th scope="col" className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {users.map((u) => {
                    const isSelf = u.id === currentUser?.id;
                    return (
                      <tr key={u.id} className={selected.includes(u.id) ? 'bg-accent/40' : undefined}>
                        <td className="px-4 py-3">
                          {/* Self is never selectable: the server rejects it too. */}
                          <input
                            type="checkbox"
                            aria-label={`Select ${u.email}`}
                            checked={selected.includes(u.id)}
                            disabled={isSelf}
                            onChange={() => toggleOne(u.id)}
                            className="h-4 w-4 rounded border-input accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
                          />
                        </td>
                        <td className="whitespace-nowrap px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary" aria-hidden="true">
                              {u.email.slice(0, 1).toUpperCase()}
                            </span>
                            <span className="table-text">{u.email}</span>
                            {isSelf && (
                              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                You
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3">
                          <RoleBadge role={u.role} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-[13px] text-muted-foreground">
                          {formatDateTime(u.createdAt)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-[13px] text-muted-foreground">
                          {formatDateTime(u.lastLoginAt)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right">
                          <button
                            onClick={() => setProfileTarget(u)}
                            title="View Profile"
                            aria-label={`View profile of ${u.email}`}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          >
                            <Eye className="h-4 w-4" aria-hidden="true" />
                          </button>
                          <button
                            onClick={() => openRoleChange(u)}
                            aria-label={`Change role for ${u.email}`}
                            className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted"
                          >
                            <UserCog className="h-4 w-4" aria-hidden="true" />
                            Change to {u.role === 'ADMIN' ? 'PRO' : 'ADMIN'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </div>
          )}
          {/* Role change confirmation - the PATCH is only issued from here. */}
          {roleTarget && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <div className="fixed inset-0 bg-foreground/50 backdrop-blur-[1px]" aria-hidden="true" />
              <div
                className="app-card relative w-full max-w-md p-5"
                role="dialog"
                aria-modal="true"
                aria-labelledby="change-role-title"
              >
                <div className="mb-2 flex items-start justify-between">
                  <h3 className="card-title" id="change-role-title">Change role</h3>
                  <button
                    onClick={() => setRoleTarget(null)}
                    disabled={roleChanging}
                    aria-label="Close"
                    className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
                <p className="text-[13px] text-muted-foreground">
                  Change the role of <span className="font-medium text-foreground">{roleTarget.email}</span> from{' '}
                  <span className="font-medium text-foreground">{roleTarget.role}</span> to{' '}
                  <span className="font-medium text-foreground">{roleTargetRole}</span>?
                </p>

                {roleError && (
                  <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3">
                    <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" aria-hidden="true" />
                    <span className="text-[13px] font-medium text-destructive">{roleError}</span>
                  </div>
                )}

                <div className="mt-5 flex items-center justify-end gap-2">
                  <button
                    onClick={() => setRoleTarget(null)}
                    disabled={roleChanging}
                    className="inline-flex h-10 items-center rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleRoleChange}
                    disabled={roleChanging}
                    className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-card transition-colors hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {roleChanging ? 'Changing...' : `Change to ${roleTargetRole}`}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Bulk delete confirmation */}
          {bulkOpen && (
            <div className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/40 p-4 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="bulk-delete-title">
              <div className="w-full max-w-sm max-h-[85vh] overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-lg">
                <h2 id="bulk-delete-title" className="text-sm font-semibold text-foreground">
                  Delete {selected.length} user{selected.length === 1 ? '' : 's'}?
                </h2>
                <p className="mt-2 text-[13px] leading-5 text-muted-foreground">
                  This action permanently removes the selected CMS accounts.
                </p>
                {bulkError && (
                  <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3">
                    <p className="text-[13px] font-medium text-destructive">{bulkError}</p>
                    {blocked.length > 0 && (
                      <ul className="mt-2 space-y-1">
                        {blocked.map((b) => (
                          <li key={b.email + b.code} className="text-[12px] text-destructive">
                            {b.email} — {b.message}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <button
                    type="button"
                    onClick={() => setBulkOpen(false)}
                    disabled={bulkBusy}
                    className="h-10 rounded-lg border border-border bg-card px-4 text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={runBulkDelete}
                    disabled={bulkBusy}
                    className="h-10 rounded-lg bg-destructive px-4 text-[13px] font-semibold text-destructive-foreground transition-opacity hover:opacity-95 disabled:opacity-50"
                  >
                    {bulkBusy ? 'Deleting...' : 'Delete users'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* View Profile (ADMIN only, read-only) */}
          {profileTarget && (
            <div className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/40 p-4 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="view-profile-title">
              <div className="w-full max-w-sm max-h-[85vh] overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-lg">
                <div className="flex items-start gap-3">
                  {profileTarget.avatarUrl ? (
                    <img src={profileTarget.avatarUrl} alt="" className="h-12 w-12 shrink-0 rounded-full border border-border bg-white object-cover" />
                  ) : (
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">
                      {(profileTarget.initials || profileTarget.email.slice(0, 2)).toUpperCase()}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <h2 id="view-profile-title" className="truncate text-sm font-semibold text-foreground">
                      {profileTarget.displayName || profileTarget.email}
                    </h2>
                    <p className="truncate text-[13px] text-muted-foreground">{profileTarget.email}</p>
                  </div>
                </div>
                <dl className="mt-4 space-y-2 text-[13px]">
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Role</dt>
                    <dd><RoleBadge role={profileTarget.role} /></dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Display name</dt>
                    <dd className="truncate text-foreground">{profileTarget.displayName || '—'}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Assignment</dt>
                    <dd className="truncate text-foreground">{profileTarget.assignment || '—'}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Created</dt>
                    <dd className="text-foreground">{formatDateTime(profileTarget.createdAt)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Last login</dt>
                    <dd className="text-foreground">{formatDateTime(profileTarget.lastLoginAt)}</dd>
                  </div>
                </dl>
                <div className="mt-5 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setProfileTarget(null)}
                    className="h-10 rounded-lg border border-border bg-card px-4 text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Lightweight profile for the signed-in user */}
          <div className="app-card mt-5 p-5">
            <h3 className="card-title">My profile</h3>
            <p className="mt-1 text-[13px] text-muted-foreground">
              This name is what the sidebar shows for your account.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-4">
              {/* Avatar: image when set, initials fallback otherwise. */}
              {currentUser?.avatarUrl ? (
                <img
                  src={currentUser.avatarUrl}
                  alt=""
                  className="h-16 w-16 shrink-0 rounded-full border border-border bg-white object-cover"
                />
              ) : (
                <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-muted text-lg font-semibold text-muted-foreground">
                  {(currentUser?.initials || 'U')}
                </span>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={onAvatarSelected}
                />
                <button
                  type="button"
                  onClick={pickAvatar}
                  disabled={avatarBusy}
                  className="inline-flex h-10 items-center rounded-lg border border-border bg-card px-4 text-[13px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                >
                  {avatarBusy ? 'Uploading...' : 'Upload image'}
                </button>
                {currentUser?.avatarUrl && (
                  <button
                    type="button"
                    onClick={removeAvatar}
                    disabled={avatarBusy}
                    className="inline-flex h-10 items-center rounded-lg border border-border bg-card px-4 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
                  >
                    Remove photo
                  </button>
                )}
                <span className="text-[12px] text-muted-foreground">JPG, PNG or WebP · up to 5 MB</span>
              </div>
              {avatarError && <p className="w-full text-[13px] font-medium text-destructive">{avatarError}</p>}
            </div>
            <form onSubmit={saveProfile} className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-[13px] font-medium text-foreground">Display name</label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={80}
                  className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <div>
                <label className="block text-[13px] font-medium text-foreground">Assignment</label>
                <input
                  type="text"
                  value={assignment}
                  onChange={(e) => setAssignment(e.target.value)}
                  maxLength={80}
                  placeholder="e.g. Thursday Updates"
                  className="mt-1 block h-10 w-full rounded-lg border border-input bg-card px-3 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
                <button
                  type="submit"
                  disabled={profileBusy}
                  className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-95 disabled:opacity-50"
                >
                  {profileBusy ? 'Saving...' : 'Save profile'}
                </button>
                {profileNotice && (
                  <span className="text-[13px] text-muted-foreground">{profileNotice}</span>
                )}
              </div>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}
