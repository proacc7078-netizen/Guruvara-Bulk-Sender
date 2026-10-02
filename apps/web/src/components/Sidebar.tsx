import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import axios from 'axios';
import {
  LayoutDashboard, Users, MessageSquare, Calendar, History, Settings, UserCog,
  LogOut, Menu, X, type LucideIcon,
} from 'lucide-react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { useCurrentUser, displayNameOf, roleLabelOf, initialsOf } from '../hooks/useAuth';
import { BRAND_NAME, BRAND_LOGO } from '../constants/brand';

interface NavItem {
  name: string;
  href: string;
  icon: LucideIcon;
  /** Administrative surfaces render only for ADMIN sessions (UI hiding). */
  adminOnly?: boolean;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

const navigation: NavItem[] = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Recipients', href: '/recipients', icon: Users },
  { name: 'Messages', href: '/messages', icon: MessageSquare },
  { name: 'Campaigns', href: '/campaigns', icon: Calendar },
  { name: 'History', href: '/history', icon: History },
  { name: 'Users', href: '/users', icon: UserCog, adminOnly: true },
  // Pre-deployment role boundary: Settings is ADMIN-only. The backend already
  // rejects PRO with 403; this keeps it out of the PRO sidebar as well.
  { name: 'Settings', href: '/settings', icon: Settings, adminOnly: true },
];

const sections: NavSection[] = [
  { label: 'Overview', items: navigation.filter((i) => i.href === '/dashboard') },
  { label: 'Manage', items: navigation.filter((i) => ['/recipients', '/messages', '/campaigns', '/history'].includes(i.href)) },
  { label: 'Administration', items: navigation.filter((i) => ['/users', '/settings'].includes(i.href)) },
];

/**
 * Official application logo, rendered proportionally. The source artwork is a
 * square emblem, so a circular slot plus object-contain keeps it undistorted —
 * never stretched or cropped.
 */
export function BrandMark({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const box = size === 'sm' ? 'h-7 w-7' : 'h-9 w-9';
  return (
    <span className={twMerge('flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-white', box)}>
      <img src={BRAND_LOGO} alt="" className="h-full w-full object-contain" />
    </span>
  );
}

/** Shared confirmation dialog so every destructive confirmation looks identical. */
export function ConfirmDialog({
  open, title, body, confirmLabel, onCancel, onConfirm, busy, destructive = true,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  busy?: boolean;
  destructive?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) ref.current?.focus(); }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/40 p-4 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-lg">
        <h2 id="confirm-title" className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="mt-2 text-[13px] leading-5 text-muted-foreground">{body}</p>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="h-10 rounded-lg border border-border bg-card px-4 text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
          >
            Cancel
          </button>
          <button
            ref={ref}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={twMerge(
              'h-10 rounded-lg px-4 text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-95 disabled:opacity-50',
              destructive ? 'bg-destructive' : 'bg-primary'
            )}
          >
            {busy ? 'Working...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  // UI hiding only — the backend enforces ADMIN on /api/users, /api/settings.
  const { user, isAdmin } = useCurrentUser();
  const [open, setOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Close the mobile drawer whenever navigation happens.
  useEffect(() => { setOpen(false); }, [location.pathname]);

  const visibleSections = sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => !item.adminOnly || isAdmin),
    }))
    .filter((section) => section.items.length > 0);

  // Logout is a first-class sidebar action: reliable, and NOT dependent on the
  // user visiting Settings first. A failed request still returns to /login so a
  // session problem can never trap the operator inside the app.
  const doLogout = async () => {
    setBusy(true);
    try {
      await axios.post('/api/auth/logout');
    } catch {
      /* continue to /login regardless */
    } finally {
      setBusy(false);
      setConfirmOpen(false);
      navigate('/login', { replace: true });
    }
  };

  const nav = (
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4" aria-label="Primary">
        {visibleSections.map((section) => (
          <div key={section.label}>
            <p className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {section.label}
            </p>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const isActive = location.pathname.startsWith(item.href);
                return (
                  <li key={item.name}>
                    <Link
                      key={item.name}
                      to={item.href}
                      aria-current={isActive ? 'page' : undefined}
                      className={twMerge(
                        clsx(
                          isActive
                            ? 'bg-accent font-medium text-accent-foreground'
                            : 'font-normal text-muted-foreground hover:bg-muted hover:text-foreground',
                          'group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1'
                        )
                      )}
                    >
                      <item.icon
                        className={clsx(
                          isActive ? 'text-accent-foreground' : 'text-muted-foreground group-hover:text-foreground',
                          'h-[18px] w-[18px] shrink-0'
                        )}
                        aria-hidden="true"
                      />
                      {item.name}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    );

  const userBlock = (
    <div className="shrink-0 border-t border-border px-3 py-3">
      <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
        {user?.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="h-8 w-8 shrink-0 rounded-full border border-border bg-white object-cover" />
        ) : (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
            {initialsOf(user) || 'U'}
          </span>
        )}
        <div className="min-w-0 flex-1 leading-tight">
          {/* Always from current-user profile data — never a hard-coded string. */}
          <p className="truncate text-[13px] font-medium text-foreground">{displayNameOf(user)}</p>
          <p className="truncate text-xs font-normal text-muted-foreground">{roleLabelOf(user)}</p>
        </div>
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          aria-label="Log out"
          title="Log out"
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <p className="px-2 pt-2 text-[11px] font-normal leading-4 text-muted-foreground">
        Connected · All systems normal
      </p>
    </div>
  );

  const brandHeader = (
    <div className="flex h-16 shrink-0 items-center gap-2.5 border-b border-border px-5">
      <BrandMark />
      <div className="min-w-0 leading-tight">
        <p className="truncate text-sm font-semibold text-foreground">{BRAND_NAME}</p>
        <p className="truncate text-xs font-normal text-muted-foreground">Operations CMS</p>
      </div>
    </div>
  );

  return (
    <>
      {/* Compact mobile bar */}
      <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-card px-4 py-2.5 lg:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open navigation"
          aria-expanded={open}
          className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>
        <BrandMark size="sm" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{BRAND_NAME}</span>
      </div>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-foreground/40" onClick={() => setOpen(false)} role="presentation" />
          <div className="absolute inset-y-0 left-0 flex w-64 max-w-[85vw] flex-col border-r border-border bg-card">
            <div className="flex h-16 shrink-0 items-center justify-between border-b border-border px-5">
              <div className="flex min-w-0 items-center gap-2.5">
                <BrandMark />
                <span className="truncate text-sm font-semibold text-foreground">{BRAND_NAME}</span>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close navigation"
                className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            {nav}
            {userBlock}
          </div>
        </div>
      )}

      {/* Desktop sidebar */}
      <div className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-card text-card-foreground lg:flex">
        {brandHeader}
        {nav}
        {userBlock}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Log out?"
        body={`Are you sure you want to log out of ${BRAND_NAME}?`}
        confirmLabel="Log out"
        busy={busy}
        destructive={false}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={doLogout}
      />
    </>
  );
}
