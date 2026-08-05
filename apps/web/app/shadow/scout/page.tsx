'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { readRoleSession } from '@/components/roleSession';
import { apiBase } from '@/lib/apiBase';

// ─── Types ────────────────────────────────────────────────────────────────────

interface JobStatusResult {
  jobId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  sessionType: string;
  safetyStatus: 'pending' | 'passed' | 'filtered' | 'not_applicable';
  output?: {
    resultStatus?: 'ok' | 'filtered' | 'unavailable';
    summary?: string;
    strengths?: string[];
    growthAreas?: string[];
    recommendedTopics?: string[];
    openQuestions?: string[];
    insightNotes?: string;
    generatedAt?: string;
    profileTier?: string;
    response?: string;
  } | null;
  error?: string | null;
  createdAt: string;
  completedAt?: string | null;
}

interface OrgJobsResponse {
  ok: boolean;
  jobs: JobStatusResult[];
}

interface ScoreboardResponse {
  readonly organizationId: string;
  readonly period: string;
  readonly effectiveness: {
    readonly avgRecommendationScore: number | null;
    readonly concernedTopics: string[];
  };
  readonly engagement: {
    readonly dailyActiveUsers: number;
    readonly avgMessagesPerSession: number | null;
    readonly feedbackRate: number | null;
    readonly usersByTier: { bronze: number; silver: number; gold: number };
    readonly newUsersThisPeriod: number;
  };
  readonly safety: {
    readonly highRiskFlagCount: number;
    readonly escalationsToHuman: number;
    readonly flaggedTopicsNeedingReview: string[];
  };
  readonly growth: {
    readonly totalInteractions: number;
    readonly positiveOutcomeRate: number | null;
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ScoutReportPage() {
  const router = useRouter();
  const [userRole] = useState<string>(() =>
    typeof window !== 'undefined' ? readRoleSession()?.role ?? '' : '',
  );

  const [jobs, setJobs] = useState<JobStatusResult[]>([]);
  const [scoreboard, setScoreboard] = useState<ScoreboardResponse | null>(null);
  const [selectedJob, setSelectedJob] = useState<JobStatusResult | null>(null);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [error, setError] = useState('');

  const canAccessAdmin = ['admin', 'organization_admin', 'platform_owner', 'coach'].includes(userRole);
  const canViewOrgMetrics = ['admin', 'organization_admin', 'platform_owner'].includes(userRole);

  useEffect(() => {
    const session = readRoleSession();
    if (!session) {
      router.replace('/login');
      return;
    }
    if (!canAccessAdmin) {
      router.replace('/shadow');
    }
  }, [router, canAccessAdmin]);

  const loadData = useCallback(async () => {
    setLoadingJobs(true);
    setError('');
    try {
      const requests: Promise<Response>[] = [
        fetch(`${apiBase()}/api/pilot/shadow/jobs?limit=30`, { credentials: 'include' }),
      ];
      if (canViewOrgMetrics) {
        requests.push(fetch(`${apiBase()}/api/pilot/shadow/metrics?days=30`, { credentials: 'include' }));
      }
      const [jobsRes, scoreRes] = await Promise.allSettled(requests);

      if (jobsRes.status === 'fulfilled' && jobsRes.value.ok) {
        const data = (await jobsRes.value.json()) as OrgJobsResponse;
        setJobs(data.jobs ?? []);
      }

      if (scoreRes?.status === 'fulfilled' && scoreRes.value.ok) {
        const data = await scoreRes.value.json() as { metrics?: ScoreboardResponse };
        setScoreboard(data.metrics ?? null);
      }
    } catch {
      setError('Failed to load data');
    } finally {
      setLoadingJobs(false);
    }
  }, [canViewOrgMetrics]);

  useEffect(() => {
    if (!userRole) return undefined;
    const timer = window.setTimeout(() => {
      void loadData();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadData, userRole]);

  const scoutJobs = jobs.filter((j) => j.sessionType === 'scout_report');
  const heavyBagJobs = jobs.filter((j) => j.sessionType === 'heavy_bag');
  const safeCompleted = (job: JobStatusResult) => (
    job.status === 'completed'
    && job.safetyStatus === 'passed'
    && job.output?.resultStatus === 'ok'
  );

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
      {/* HEADER */}
      <header className="border-b-4 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 py-4 md:px-8">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-[var(--red-primary)]">SHADOW Intelligence</p>
            <h1 className="font-display text-2xl font-black tracking-tight text-[var(--black)]">Scout Reports</h1>
            <p className="mt-1 text-xs text-[var(--gray-dark)]">Profile intelligence, Recovery Round jobs, and The Scorecard</p>
          </div>
          <div className="flex gap-3">
            <Link
              href="/shadow"
              className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 py-2 text-xs font-mono text-[var(--gray-dark)] transition hover:border-[var(--red-primary)] hover:text-[var(--black)]"
            >
              ← SHADOW
            </Link>
            <button
              type="button"
              disabled
              title="Requires the secure scheduled SHADOW worker"
              className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 py-2 text-xs font-mono font-bold text-[var(--gray-dark)] opacity-60"
            >
              Scout Report worker not active
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-5xl p-4 md:p-8 space-y-6">
        {error ? (
          <p className="border border-[var(--red-primary)] bg-[var(--canvas-tan-light)] px-4 py-2 text-xs font-mono text-[var(--red-primary)]">{error}</p>
        ) : null}

        {/* METRICS DASHBOARD */}
        {scoreboard ? (
          <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5 space-y-4">
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-[var(--gray-dark)]">Metrics Dashboard — {scoreboard.period}</p>

            {/* Tier Distribution */}
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <p className="text-xs font-mono text-[var(--gray-dark)] mb-2">Tier Distribution</p>
                <div className="space-y-2">
                  {[
                    { label: '🥇 Gold', count: scoreboard.engagement.usersByTier.gold, percent: ((scoreboard.engagement.usersByTier.gold / Math.max(scoreboard.engagement.usersByTier.gold + scoreboard.engagement.usersByTier.silver + scoreboard.engagement.usersByTier.bronze, 1)) * 100).toFixed(0) },
                    { label: '🥈 Silver', count: scoreboard.engagement.usersByTier.silver, percent: ((scoreboard.engagement.usersByTier.silver / Math.max(scoreboard.engagement.usersByTier.gold + scoreboard.engagement.usersByTier.silver + scoreboard.engagement.usersByTier.bronze, 1)) * 100).toFixed(0) },
                    { label: '🥉 Bronze', count: scoreboard.engagement.usersByTier.bronze, percent: ((scoreboard.engagement.usersByTier.bronze / Math.max(scoreboard.engagement.usersByTier.gold + scoreboard.engagement.usersByTier.silver + scoreboard.engagement.usersByTier.bronze, 1)) * 100).toFixed(0) },
                  ].map(({ label, count, percent }: { label: string; count: number; percent: string }) => (
                    <div key={label} className="space-y-1">
                      <div className="flex justify-between text-[9px] text-[var(--gray-dark)]">
                        <span>{label} {count} users</span>
                        <span>{percent}%</span>
                      </div>
                      <div className="h-1.5 bg-[var(--canvas-tan)] border border-[var(--black)] overflow-hidden">
                        <div
                          className="h-full bg-[var(--red-primary)]"
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Effectiveness */}
              <div>
                <p className="text-xs font-mono text-[var(--gray-dark)] mb-2">Effectiveness Metrics</p>
                <div className="space-y-2">
                  {[
                    { label: 'Positive Outcome Rate', value: scoreboard.growth.positiveOutcomeRate == null ? 'Unavailable' : `${Math.round(scoreboard.growth.positiveOutcomeRate * 100)}%`, color: 'var(--status-ready)' },
                    { label: 'Reviewed Recommendation Score', value: scoreboard.effectiveness.avgRecommendationScore == null ? 'Unavailable' : `${scoreboard.effectiveness.avgRecommendationScore}%`, color: 'var(--gray-dark)' },
                    { label: 'Human Escalations', value: scoreboard.safety.escalationsToHuman, color: 'var(--red-primary)' },
                  ].map(({ label, value, color }) => (
                    <div key={label} className="flex justify-between border border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-2">
                      <span className="text-[9px] text-[var(--gray-dark)]">{label}</span>
                      <span className="text-[9px] font-mono font-bold" style={{ color }}>{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Engagement Summary */}
            <div className="border-t border-[var(--black)] pt-3">
              <p className="text-xs font-mono text-[var(--gray-dark)] mb-2">Engagement Summary</p>
              <div className="grid md:grid-cols-3 gap-2">
                {[
                  { label: 'Total Interactions', value: scoreboard.growth.totalInteractions },
                  { label: 'Daily Active Users', value: scoreboard.engagement.dailyActiveUsers },
                  { label: 'Avg Messages / Session', value: scoreboard.engagement.avgMessagesPerSession?.toFixed(1) ?? 'Unavailable' },
                ].map(({ label, value }) => (
                  <div key={label} className="border border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-2 text-center">
                    <p className="text-[9px] text-[var(--gray-dark)]">{label}</p>
                    <p className="mt-1 text-sm font-mono font-bold text-[var(--red-primary)]">{value}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Top Topics */}
            {scoreboard.effectiveness.concernedTopics.length > 0 ? (
              <div className="border-t border-[var(--black)] pt-3">
                <p className="text-xs font-mono text-[var(--gray-dark)] mb-2">Top Engaged Topics</p>
                <div className="flex flex-wrap gap-2">
                  {scoreboard.effectiveness.concernedTopics.map((topic, idx) => (
                    <span key={topic} className="border border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-1 text-[9px] font-mono text-[var(--red-primary)]">
                      #{idx + 1} {topic}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        {/* THE SCORECARD */}
        {scoreboard ? (
          <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-[var(--gray-dark)]">The Scorecard — {scoreboard.period}</p>
            <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
              {[
                { label: 'Total Interactions', value: scoreboard.growth.totalInteractions },
                { label: 'Positive Rate', value: scoreboard.growth.positiveOutcomeRate == null ? 'Unavailable' : `${Math.round(scoreboard.growth.positiveOutcomeRate * 100)}%` },
                { label: 'Active Users', value: scoreboard.engagement.dailyActiveUsers },
                { label: 'Gold Profiles', value: scoreboard.engagement.usersByTier.gold },
              ].map(({ label, value }) => (
                <div key={label} className="border border-[var(--black)] bg-[var(--canvas-tan)] p-3 text-center">
                  <p className="text-xs font-mono text-[var(--gray-dark)]">{label}</p>
                  <p className="mt-1 text-xl font-black text-[var(--red-primary)]">{value}</p>
                </div>
              ))}
            </div>
            <div className="mt-4 flex gap-4">
              {[
                { label: '🥇 Gold', count: scoreboard.engagement.usersByTier.gold },
                { label: '🥈 Silver', count: scoreboard.engagement.usersByTier.silver },
                { label: '🥉 Bronze', count: scoreboard.engagement.usersByTier.bronze },
              ].map(({ label, count }) => (
                <div key={label} className="text-xs font-mono text-[var(--gray-dark)]">
                  <span className="text-[var(--red-primary)]">{label}</span> {count} users
                </div>
              ))}
              {scoreboard.effectiveness.concernedTopics.length > 0 ? (
                <div className="text-xs font-mono text-[var(--gray-dark)]">
                  Topics needing review: <span className="text-[var(--red-primary)]">{scoreboard.effectiveness.concernedTopics.join(', ')}</span>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {/* SCOUT REPORTS */}
        <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-[var(--gray-dark)]">
              Scout Reports ({scoutJobs.length})
            </p>
          </div>

          {loadingJobs ? (
            <p className="mt-4 text-xs text-[var(--gray-dark)] font-mono">Loading...</p>
          ) : scoutJobs.length === 0 ? (
            <p className="mt-4 text-xs text-[var(--gray-dark)] font-mono">No verified Scout Reports are available. Generation remains disabled until the secure scheduled worker is configured.</p>
          ) : (
            <div className="mt-4 space-y-3">
              {scoutJobs.map((job) => (
                <button
                  key={job.jobId}
                  className={`border bg-[var(--canvas-tan)] p-4 cursor-pointer transition w-full text-left ${
                    selectedJob?.jobId === job.jobId ? 'border-[var(--red-primary)]' : 'border-[var(--black)] hover:border-[var(--red-primary)]'
                  }`}
                  onClick={() => setSelectedJob(selectedJob?.jobId === job.jobId ? null : job)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <StatusBadge status={job.status} />
                      <p className="mt-1 text-[10px] text-[var(--gray-dark)] font-mono">{job.jobId.slice(0, 8)}... · {new Date(job.createdAt).toLocaleDateString()}</p>
                    </div>
                    {safeCompleted(job) && job.output?.profileTier ? (
                      <span className="text-[10px] font-mono text-[var(--red-primary)] border border-[var(--black)] px-2 py-0.5">
                        {job.output.profileTier.toUpperCase()}
                      </span>
                    ) : null}
                  </div>

                  {/* Expanded report */}
                  {selectedJob?.jobId === job.jobId && safeCompleted(job) && job.output ? (
                    <div className="mt-4 space-y-3 text-xs">
                      {job.output.summary ? (
                        <div>
                          <p className="font-mono text-[var(--red-primary)] uppercase tracking-[0.1em]">Summary</p>
                          <p className="mt-1 leading-6 text-[var(--gray-dark)]">{job.output.summary}</p>
                        </div>
                      ) : null}
                      {job.output.strengths?.length ? (
                        <div>
                          <p className="font-mono text-[var(--red-primary)] uppercase tracking-[0.1em]">Strengths</p>
                          <ul className="mt-1 space-y-1 text-[var(--gray-dark)]">
                            {job.output.strengths.map((s) => <li key={s}>→ {s}</li>)}
                          </ul>
                        </div>
                      ) : null}
                      {job.output.growthAreas?.length ? (
                        <div>
                          <p className="font-mono text-[var(--red-primary)] uppercase tracking-[0.1em]">Growth Areas</p>
                          <ul className="mt-1 space-y-1 text-[var(--gray-dark)]">
                            {job.output.growthAreas.map((a) => <li key={a}>→ {a}</li>)}
                          </ul>
                        </div>
                      ) : null}
                      {job.output.recommendedTopics?.length ? (
                        <div>
                          <p className="font-mono text-[var(--red-primary)] uppercase tracking-[0.1em]">Recommended Topics</p>
                          <div className="mt-1 flex flex-wrap gap-2">
                            {job.output.recommendedTopics.map((t) => (
                              <span key={t} className="border border-[var(--black)] px-2 py-0.5 text-[9px] text-[var(--gray-dark)]">{t}</span>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {job.output.insightNotes ? (
                        <div>
                          <p className="font-mono text-[var(--red-primary)] uppercase tracking-[0.1em]">Insight Notes</p>
                          <p className="mt-1 leading-6 text-[var(--gray-dark)]">{job.output.insightNotes}</p>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {selectedJob?.jobId === job.jobId
                    && job.status === 'completed'
                    && !safeCompleted(job) ? (
                      <p className="mt-2 text-[10px] font-mono text-[var(--red-primary)]">
                        This result is unavailable because it did not pass the server safety boundary or the required model capability is not active.
                      </p>
                    ) : null}

                  {selectedJob?.jobId === job.jobId && job.status === 'pending' ? (
                    <p className="mt-2 text-[10px] font-mono text-[var(--gray-dark)]">Queued for secure background processing.</p>
                  ) : null}

                  {selectedJob?.jobId === job.jobId && job.status === 'failed' ? (
                    <p className="mt-2 text-[10px] font-mono text-[var(--red-primary)]">Error: {job.error}</p>
                  ) : null}
                </button>
              ))}
            </div>
          )}
        </section>

        {/* HEAVY BAG HISTORY */}
        {heavyBagJobs.length > 0 ? (
          <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-[var(--gray-dark)]">
              Heavy Bag Session History ({heavyBagJobs.length})
            </p>
            <div className="mt-3 space-y-2">
              {heavyBagJobs.slice(0, 10).map((job) => (
                <div
                  key={job.jobId}
                  className="flex items-center justify-between border border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-2"
                >
                  <div className="flex items-center gap-3">
                    <StatusBadge status={job.status} />
                    <span className="text-[10px] font-mono text-[var(--gray-dark)]">{new Date(job.createdAt).toLocaleString()}</span>
                  </div>
                  {job.status === 'completed' && job.completedAt ? (
                    <span className="text-[9px] font-mono text-[var(--gray-dark)]">
                      {Math.round((new Date(job.completedAt).getTime() - new Date(job.createdAt).getTime()) / 1000)}s
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

      </div>
    </main>
  );
}

function StatusBadge({ status }: { readonly status: JobStatusResult['status'] }) {
  const styles: Record<JobStatusResult['status'], string> = {
    pending:   'text-[var(--gray-dark)] border-[var(--black)]',
    running:   'text-[var(--red-primary)] border-[var(--red-primary)]',
    completed: 'text-[var(--status-ready)] border-[var(--status-ready)]',
    failed:    'text-[var(--red-primary)] border-[var(--red-primary)]',
    cancelled: 'text-[var(--gray-dark)] border-[var(--black)]',
  };
  return (
    <span className={`border px-2 py-0.5 text-[9px] font-mono uppercase tracking-[0.1em] ${styles[status]}`}>
      {status}
    </span>
  );
}
