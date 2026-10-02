import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar';

/**
 * Shared application shell for the Stitch visual foundation.
 *
 * Establishes ONE consistent page-shell pattern (sidebar + content column)
 * so future page redesigns converge on the same offsets:
 *
 *   <AppShell>
 *     <PageContent />
 *   </AppShell>
 *
 * Pages are NOT yet migrated to this shell in this task: existing pages keep
 * rendering `<Sidebar />` in-flow (source-level regression tests assert that
 * import), so wiring the shell into App.tsx now would double-render the
 * sidebar. New / redesigned pages should use AppShell instead of hand-rolling
 * their own flex wrapper.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-main">
        <div className="app-content">{children}</div>
      </main>
    </div>
  );
}

export default AppShell;
