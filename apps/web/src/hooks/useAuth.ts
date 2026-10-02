import { useEffect, useState } from 'react';
import axios from 'axios';

/**
 * Phase 8.1 — current session identity for the frontend.
 *
 * Wraps the existing GET /api/auth/me endpoint (the authoritative source for
 * the signed-in user's role) with a module-level cache so the Sidebar and the
 * page each mount without duplicate requests.
 *
 * The cache is keyed by nothing and lives for the page session: after login or
 * logout the SPA navigates (Login.tsx), which is a client-side transition, so
 * we invalidate whenever a request fails (401) and expose `refresh()` for the
 * rare case where a role changed while the page is open.
 */
export interface CurrentUser {
  id: string;
  email: string;
  role: string;
  /** Pre-deployment profile fields (nullable). */
  displayName?: string | null;
  assignment?: string | null;
  /** Resolved URL from the authenticated media route, or null when unset. */
  avatarUrl?: string | null;
  /** Server-computed initials fallback for the avatar slot. */
  initials?: string;
}

type AuthState = {
  user: CurrentUser | null;
  loading: boolean;
};

let state: AuthState = { user: null, loading: true };
let inFlight: Promise<CurrentUser | null> | null = null;
const listeners = new Set<(next: AuthState) => void>();

function emit() {
  for (const listener of listeners) listener(state);
}

async function fetchCurrentUser(): Promise<CurrentUser | null> {
  try {
    const res = await axios.get('/api/auth/me');
    const user = res.data?.data?.user ?? null;
    state = { user, loading: false };
    return user;
  } catch {
    // 401 or network failure: treat as signed out. Sidebar then hides
    // admin-only entries; individual pages keep their existing redirect logic.
    state = { user: null, loading: false };
    return null;
  } finally {
    inFlight = null;
    emit();
  }
}

function load(): Promise<CurrentUser | null> {
  if (!inFlight) inFlight = fetchCurrentUser();
  return inFlight;
}

/**
 * Returns the authenticated user (including `role`), whether the identity
 * request is still in flight, and a `refresh()` helper.
 *
 * `isAdmin` is false while loading and for any role other than ADMIN, so
 * admin-only navigation stays hidden unless the backend says otherwise.
 */
export function useCurrentUser(): {
  user: CurrentUser | null;
  loading: boolean;
  isAdmin: boolean;
  refresh: () => Promise<CurrentUser | null>;
} {
  const [current, setCurrent] = useState<AuthState>(state);

  useEffect(() => {
    const listener = (next: AuthState) => setCurrent(next);
    listeners.add(listener);
    // Kick off (or join) the identity request; the listener receives the
    // result. Initial state already mirrors the module-level cache, so no
    // synchronous setState is needed here.
    void load();
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return {
    user: current.user,
    loading: current.loading,
    isAdmin: !current.loading && current.user?.role === 'ADMIN',
    refresh: load,
  };
}

/**
 * Pre-deployment helpers shared by the sidebar, header and profile UI so the
 * display name / role wording is defined in ONE place instead of being
 * duplicated per component.
 *
 * The name always comes from current-user profile data (displayName), never a
 * hard-coded string, so a profile update is reflected everywhere at once.
 */
export function displayNameOf(user: CurrentUser | null): string {
  if (!user) return '';
  const dn = user.displayName?.trim();
  return dn && dn.length ? dn : user.email;
}

export function roleLabelOf(user: CurrentUser | null): 'Administrator' | 'Pro' {
  return user?.role === 'ADMIN' ? 'Administrator' : 'Pro';
}

export function initialsOf(user: CurrentUser | null): string {
  if (!user) return '';
  if (user.initials) return user.initials;
  const dn = user.displayName?.trim();
  return (dn && dn.length ? dn : user.email)
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('') || 'U';
}