import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useCurrentUser } from './hooks/useAuth';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Recipients from './pages/Recipients';
import ImportWizard from './pages/ImportWizard';
import Messages from './pages/Messages';
import MessageEditor from './pages/MessageEditor';
import Campaigns from './pages/Campaigns';
import CampaignEditor from './pages/CampaignEditor';
import HistoryPage from './pages/History';
import Settings from './pages/Settings';
import Users from './pages/Users';

const queryClient = new QueryClient();

/**
 * ADMIN-only route guard.
 *
 * This is presentation only — the backend already rejects PRO with 403 on every
 * /api/settings and /api/users request. The guard exists so a PRO never sees an
 * admin surface (and never triggers an admin-only request that could only fail).
 */
function AdminOnly({ children }: { children: ReactNode }) {
  const { user, loading, isAdmin } = useCurrentUser();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (!isAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
        <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 text-center">
          <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-muted">
            <ShieldAlert className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          </span>
          <h1 className="mt-4 text-sm font-semibold text-foreground">Access restricted</h1>
          <p className="mt-2 text-[13px] leading-5 text-muted-foreground">
            This area is only available to administrators. Your account does not have permission to open it.
          </p>
          <a
            href="/dashboard"
            className="mt-5 inline-flex h-10 items-center rounded-lg bg-primary px-4 text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-95"
          >
            Back to Dashboard
          </a>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/messages" element={<Messages />} />
          <Route path="/messages/new" element={<MessageEditor mode="new" />} />
          <Route path="/messages/:id/edit" element={<MessageEditor mode="edit" />} />
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/campaigns/new" element={<CampaignEditor mode="new" />} />
          <Route path="/campaigns/:id/edit" element={<CampaignEditor mode="edit" />} />
          <Route path="/recipients" element={<Recipients />} />
          <Route path="/recipients/import" element={<ImportWizard />} />
          <Route path="/history" element={<HistoryPage />} />
          {/* Settings and Users are ADMIN-only (backend-enforced). */}
          <Route path="/settings" element={<AdminOnly><Settings /></AdminOnly>} />
          <Route path="/users" element={<AdminOnly><Users /></AdminOnly>} />
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
