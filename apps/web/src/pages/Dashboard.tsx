import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { Sidebar } from '../components/Sidebar';
import { AlertCircle, ArrowRight, CalendarClock, CheckCircle, Clock3, Eye, FileSpreadsheet, Megaphone, Plus, RefreshCw, Send, TriangleAlert, UserCheck, Users, XCircle } from 'lucide-react';

interface NextScheduledCampaign {
  scheduleId: string;
  campaignId: string;
  campaignName: string;
  campaignStatus: string;
  scheduledAt: string;
  timezone: string;
}

interface RecentActivityItem {
  executionId: string;
  campaignName: string;
  recipientName: string | null;
  recipientPhone: string;
  status: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  updatedAt: string;
}

interface DashboardData {
  generatedAt: string;
  totals: { totalRecipients: number; activeRecipients: number; scheduledCampaigns: number };
  todayCounts: { sentToday: number; deliveredToday: number; readToday: number; failedToday: number };
  nextScheduledCampaign: NextScheduledCampaign | null;
  recentActivity: RecentActivityItem[];
}

function formatDateTime(iso: string, timezone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'READ':
      return 'border-success/40 bg-success/10 text-success';
    case 'DELIVERED':
      return 'border-success/40 bg-success/10 text-success';
    case 'SENT':
      return 'border-info/40 bg-info/10 text-info';
    case 'FAILED':
      return 'border-destructive/40 bg-destructive/10 text-destructive';
    default:
      return 'border-border bg-muted text-muted-foreground';
  }
}

function MetricCard({
  icon,
  label,
  value,
  hint,
  hintTone,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  hintTone?: string;
}) {
  return (
    <div className="app-card app-card-padded flex flex-col justify-between gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
        <span className="text-muted-foreground">{icon}</span>
      </div>
      <p className="text-2xl font-bold tabular-nums tracking-tight text-foreground">{value}</p>
      {hint ? (
        <p className="text-xs font-normal text-muted-foreground">
          <span className={hintTone ?? ''}>{hint}</span>
        </p>
      ) : null}
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState<DashboardData | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const response = await axios.get<{ success: boolean; data: DashboardData }>('/api/dashboard');
      if (response.data.success) {
        setData(response.data.data);
        setError('');
      } else {
        setError('Failed to load dashboard summary.');
      }
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        navigate('/login');
        return;
      }
      setError('Unable to load dashboard. Please check your connection and try again.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [navigate]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return <div className="flex h-screen items-center justify-center">Loading...</div>;
  }

  const totalRecipients = data?.totals.totalRecipients ?? 0;
  const activeRecipients = data?.totals.activeRecipients ?? 0;
  const hasRecipients = totalRecipients > 0;
  const sentToday = data?.todayCounts.sentToday ?? 0;
  const deliveredToday = data?.todayCounts.deliveredToday ?? 0;
  const readToday = data?.todayCounts.readToday ?? 0;
  const failedToday = data?.todayCounts.failedToday ?? 0;

  const attentionItems: {
    title: string;
    detail: string;
    action?: { label: string; to: string };
  }[] = [];
  if (failedToday > 0) {
    attentionItems.push({
      title: `${failedToday} delivery ${failedToday === 1 ? 'failure' : 'failures'} today`,
      detail: 'Review the failed rows in History before retrying the campaign.',
      action: { label: 'Open History', to: '/history' },
    });
  }
  if (!hasRecipients) {
    attentionItems.push({
      title: 'No recipients yet',
      detail: 'Import recipients or add the first contact to start messaging.',
      action: { label: 'Go to Recipients', to: '/recipients' },
    });
  }

  const upcoming = data?.nextScheduledCampaign
    ? [
        {
          title: data.nextScheduledCampaign.campaignName,
          meta: `${formatDateTime(data.nextScheduledCampaign.scheduledAt, data.nextScheduledCampaign.timezone)} · ${data.nextScheduledCampaign.timezone}`,
          status: data.nextScheduledCampaign.campaignStatus,
        },
      ]
    : [];

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-main">
        <div className="mx-auto w-full max-w-[1440px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="page-title">Dashboard</h1>
              <p className="page-subtitle">Overview of your messaging activity and campaign operations.</p>
              {data && (
                <p className="meta-text mt-1">Updated {formatDateTime(data.generatedAt)}</p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => load(true)}
                disabled={refreshing}
                className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground shadow-card transition-colors hover:bg-muted disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
                {refreshing ? 'Refreshing' : 'Refresh'}
              </button>
              <button
                onClick={() => navigate('/campaigns/new')}
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-card transition-colors hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
                New Campaign
              </button>
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm font-medium text-destructive" role="alert">
              <AlertCircle className="h-5 w-5 shrink-0" aria-hidden="true" />
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <MetricCard
              icon={<Users className="h-5 w-5" aria-hidden="true" />}
              label="Total Recipients"
              value={(data?.totals.totalRecipients ?? 0).toLocaleString('en-US')}
              hint={hasRecipients ? `${activeRecipients.toLocaleString('en-US')} active` : 'No recipients yet'}
            />
            <MetricCard
              icon={<UserCheck className="h-5 w-5" aria-hidden="true" />}
              label="Active Recipients"
              value={activeRecipients.toLocaleString('en-US')}
              hint={hasRecipients && totalRecipients > 0 ? `${Math.round((activeRecipients / totalRecipients) * 100)}% reachable` : 'Import or add contacts'}
              hintTone="font-semibold text-primary"
            />
            <MetricCard
              icon={<Megaphone className="h-5 w-5" aria-hidden="true" />}
              label="Messages Sent Today"
              value={sentToday.toLocaleString('en-US')}
              hint="Across all campaigns"
            />
            <MetricCard
              icon={<CalendarClock className="h-5 w-5" aria-hidden="true" />}
              label="Scheduled Campaigns"
              value={data?.totals.scheduledCampaigns ?? 0}
              hint={
                data?.nextScheduledCampaign
                  ? `Next ${formatDateTime(data.nextScheduledCampaign.scheduledAt, data.nextScheduledCampaign.timezone)}`
                  : 'No upcoming dispatch'
              }
            />
            <MetricCard
              icon={<Send className="h-5 w-5" aria-hidden="true" />}
              label="Delivered Today"
              value={deliveredToday.toLocaleString('en-US')}
              hint={`${readToday.toLocaleString('en-US')} read · ${failedToday.toLocaleString('en-US')} failed`}
            />
          </div>

          <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-12">
            <section className="app-card overflow-hidden xl:col-span-8" aria-label="Recent Campaign Activity">
              <div className="flex flex-col gap-3 border-b border-border p-5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="card-title">Recent Campaign Activity</h2>
                  <p className="meta-text mt-0.5">Live delivery status for recent WhatsApp sends.</p>
                </div>
                <button
                  onClick={() => navigate('/history')}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
                >
                  View all activity
                  <ArrowRight className="h-[15px] w-[15px]" aria-hidden="true" />
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b border-border bg-muted/50 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      <th scope="col" className="px-5 py-3">Campaign</th>
                      <th scope="col" className="px-4 py-3">Recipient</th>
                      <th scope="col" className="px-4 py-3">Updated</th>
                      <th scope="col" className="px-4 py-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data && data.recentActivity.length > 0 ? (
                      data.recentActivity.map((item) => (
                        <tr
                          key={`${item.executionId}:${item.campaignName}:${item.recipientPhone}`}
                          className="transition-colors hover:bg-muted/50"
                        >
                          <td className="px-5 py-3.5">
                            <p className="text-[13px] font-semibold text-foreground">{item.campaignName}</p>
                            <p className="meta-text mt-0.5 font-mono">{item.executionId.slice(0, 8)}</p>
                          </td>
                          <td className="whitespace-nowrap px-4 py-3.5">
                            <p className="table-text">{item.recipientName || item.recipientPhone}</p>
                            {item.recipientName ? (
                              <p className="meta-text mt-0.5 tabular-nums">{item.recipientPhone}</p>
                            ) : null}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3.5 text-xs font-normal text-muted-foreground">
                            {formatDateTime(item.updatedAt)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3.5">
                            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${statusBadgeClass(item.status)}`}>
                              <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                              {item.status}
                            </span>
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={4} className="px-5 py-6 text-sm font-normal text-muted-foreground">
                          No delivery activity yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between border-t border-border bg-card px-5 py-3.5 text-xs font-normal text-muted-foreground">
                <span>Showing {data?.recentActivity.length ?? 0} recent operations</span>
                <button
                  onClick={() => navigate('/campaigns')}
                  className="inline-flex items-center gap-1 font-semibold text-primary hover:underline"
                >
                  View all campaigns
                  <ArrowRight className="h-[15px] w-[15px]" aria-hidden="true" />
                </button>
              </div>
            </section>

            <div className="space-y-6 xl:col-span-4">
              <section className="app-card app-card-padded" aria-label="Needs Attention">
                <div className="mb-4 flex items-center justify-between border-b border-border pb-3">
                  <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
                    <TriangleAlert className="h-5 w-5 text-warning" aria-hidden="true" />
                    Needs Attention
                  </h3>
                  <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[11px] font-semibold text-warning">
                    {attentionItems.length} {attentionItems.length === 1 ? 'item' : 'items'}
                  </span>
                </div>
                {attentionItems.length > 0 ? (
                  <div className="space-y-3">
                    {attentionItems.map((alert) => (
                      <div key={alert.title} className="space-y-1 rounded-lg border border-warning/40 bg-warning/10 p-3.5">
                        <p className="text-xs font-semibold text-foreground">{alert.title}</p>
                        <p className="text-xs font-normal leading-relaxed text-muted-foreground">{alert.detail}</p>
                        {alert.action ? (
                          <div className="pt-1">
                            <button
                              onClick={() => navigate(alert.action!.to)}
                              className="inline-flex items-center gap-1 text-xs font-semibold text-warning hover:underline"
                            >
                              {alert.action.label}
                              <ArrowRight className="h-[14px] w-[14px]" aria-hidden="true" />
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs font-normal leading-relaxed text-muted-foreground">
                    Nothing needs attention right now. Today&rsquo;s sends are on track.
                  </p>
                )}
              </section>

              <section className="app-card app-card-padded" aria-label="Upcoming Dispatches">
                <div className="mb-4 flex items-center justify-between border-b border-border pb-3">
                  <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
                    <Clock3 className="h-5 w-5 text-primary" aria-hidden="true" />
                    Upcoming Dispatches
                  </h3>
                  <span className="text-xs font-medium text-muted-foreground">
                    {upcoming.length} scheduled
                  </span>
                </div>
                {upcoming.length > 0 ? (
                  <div className="space-y-3">
                    {upcoming.map((item) => (
                      <div key={item.title} className="space-y-2 rounded-lg border border-border bg-card p-3.5 transition-colors hover:border-muted-foreground/40">
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-xs font-bold leading-tight text-foreground">{item.title}</span>
                          <span className="whitespace-nowrap rounded border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                            {item.status}
                          </span>
                        </div>
                        <p className="text-xs font-normal text-muted-foreground">{item.meta}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs font-normal leading-relaxed text-muted-foreground">
                    No upcoming dispatch. Schedule a campaign to see it here.
                  </p>
                )}
              </section>

              <section className="app-card app-card-padded" aria-label="Today at a glance">
                <div className="mb-3 flex items-center justify-between border-b border-border pb-3">
                  <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
                    <FileSpreadsheet className="h-5 w-5 text-success" aria-hidden="true" />
                    Today at a Glance
                  </h3>
                  <span className="inline-flex items-center gap-1 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success">
                    <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                    Live
                  </span>
                </div>
                <dl className="space-y-2.5 text-xs font-normal text-muted-foreground">
                  <div className="flex items-center justify-between">
                    <dt>Messages sent</dt>
                    <dd className="font-semibold tabular-nums text-foreground">{sentToday.toLocaleString('en-US')}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt>Delivered</dt>
                    <dd className="flex items-center gap-1.5 font-semibold tabular-nums text-foreground">
                      <CheckCircle className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                      {deliveredToday.toLocaleString('en-US')}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt>Read</dt>
                    <dd className="flex items-center gap-1.5 font-semibold tabular-nums text-foreground">
                      <Eye className="h-3.5 w-3.5 text-info" aria-hidden="true" />
                      {readToday.toLocaleString('en-US')}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt>Failed</dt>
                    <dd className="flex items-center gap-1.5 font-semibold tabular-nums text-foreground">
                      <XCircle className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
                      {failedToday.toLocaleString('en-US')}
                    </dd>
                  </div>
                </dl>
              </section>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
