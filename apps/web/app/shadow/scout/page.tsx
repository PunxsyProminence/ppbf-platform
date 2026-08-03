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
  const [generateFocus, setGenerateFocus] = useState('');
  const [generateBusy, setGenerateBusy] = useState(false);
  const [generateNotice, setGenerateNotice] = useState('');
  const [generateError, setGenerateError] = useState('');

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

  // The whole background pipeline existed -- executors, worker, this listing
  // page, even an unlock metric counting completed reports -- while nothing
  // in any UI could enqueue one (behavioral audit BC-3). This is the missing
  // producer: it calls the same chat endpoint any API client would, so every
  // server gate (role check on the session-type override, worker-enabled
  // check, rate limits, request validation) applies unchanged. A 503 here
  // means the worker is off, and the button says so instead of pretending.
  async function requestGeneration(kind: 'scout_report' | 'board_summary') {
    if (generateBusy) return;
    setGenerateBusy(true);
    setGenerateNotice('');
    setGenerateError('');
    const focus = generateFocus.trim();
    try {
      const response = await fetch(`${apiBase()}/api/pilot/shadow/chat`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: focus || (kind === 'scout_report'
            ? 'Generate a scout report from my current SHADOW context.'
            : 'Generate a board summary of current governance signals.'),
          sessionType: kind,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { state?: string; jobId?: string; response?: string; error?: string }
        | null;
      if (response.ok && payload?.state === 'queued' && payload.jobId) {
        setGenerateFocus('');
        setGenerateNotice(`Queued as job ${payload.jobId.slice(0, 8)}… — it appears below once the worker completes it.`);
        await loadData();
      } else {
        setGenerateError(payload?.response || payload?.error || 'The request was not queued.');
      }
    } catch {
      setGenerateError('The generation request could not be sent. Check your connection and try again.');
    } finally {
      setGenerateBusy(false);
    }
  }

  const scoutJobs = jobs.filter((j) => j.sessionType === 'scout_report');
  const heavyBagJobs = jobs.filter((j) => j.sessionType === 'heavy_bag');
  const boardJobs = jobs.filter((j) => j.sessionType === 'board_summary');
  const safeCompleted = (job: JobStatusResult) => (
    job.status === 'completed'
    && job.safetyStatus === 'passed'
    && job.output?.resultStatus === 'ok'
  );

  return (
    <main className="min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      {/* HEADER */}
      <header className="border-b-4 border-[color:var(--brass-700)] bg-[var(--hide-900)] px-4 py-4 md:px-8">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-[color:var(--locked)]">SHADOW Intelligence</p>
            <h1 className="font-display text-2xl font-black tracking-tight text-[color:var(--bone-200)]">Scout Reports</h1>
            <p className="mt-1 text-xs text-[color:var(--bone-400)]">Profile intelligence, Recovery Round jobs, and The Scorecard</p>
          </div>
          <div className="flex gap-3">
            <Link
              href="/shadow"
              className="border-2 border-[color:var(--hide-600)] bg-[var(--hide-900)] px-3 py-2 text-xs font-mono text-[color:var(--bone-400)] transition hover:border-[color:var(--brass-700)] hover:text-[color:var(--bone-200)]"
            >
              ← SHADOW
            </Link>
            <button
              type="button"
              disabled
              title="Requires the secure scheduled SHADOW worker"
              className="border-2 border-[color:var(--hide-600)] bg-[var(--hide-900)] px-4 py-2 text-xs font-mono font-bold text-[#6a5a4a] opacity-60"
            >
              Scout Report worker not active
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-5xl p-4 md:p-8 space-y-6">
        {error ? (
          <p className="border border-[color:var(--locked)] bg-[#1a0a0a] px-4 py-2 text-xs font-mono text-[color:var(--locked)]">{error}</p>
        ) : null}

        {/* METRICS DASHBOARD */}
        {scoreboard ? (
          <section className="border-2 border-[color:var(--brass-700)] bg-[#151515] p-5 space-y-4">
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-[color:var(--brass-300)]">Metrics Dashboard — {scoreboard.period}</p>

            {/* Tier Distribution */}
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <p className="text-xs font-mono text-[color:var(--bone-400)] mb-2">Tier Distribution</p>
                <div className="space-y-2">
                  {[
                    { label: '🥇 Gold', count: scoreboard.engagement.usersByTier.gold, percent: ((scoreboard.engagement.usersByTier.gold / Math.max(scoreboard.engagement.usersByTier.gold + scoreboard.engagement.usersByTier.silver + scoreboard.engagement.usersByTier.bronze, 1)) * 100).toFixed(0) },
                    { label: '🥈 Silver', count: scoreboard.engagement.usersByTier.silver, percent: ((scoreboard.engagement.usersByTier.silver / Math.max(scoreboard.engagement.usersByTier.gold + scoreboard.engagement.usersByTier.silver + scoreboard.engagement.usersByTier.bronze, 1)) * 100).toFixed(0) },
                    { label: '🥉 Bronze', count: scoreboard.engagement.usersByTier.bronze, percent: ((scoreboard.engagement.usersByTier.bronze / Math.max(scoreboard.engagement.usersByTier.gold + scoreboard.engagement.usersByTier.silver + scoreboard.engagement.usersByTier.bronze, 1)) * 100).toFixed(0) },
                  ].map(({ label, count, percent }: { label: string; count: number; percent: string }) => (
                    <div key={label} className="space-y-1">
                      <div className="flex justify-between text-[9px] text-[color:var(--bone-400)]">
                        <span>{label} {count} users</span>
                        <span>{percent}%</span>
                      </div>
                      <div className="h-1.5 bg-[var(--hide-950)] border border-[#3a2a2a] overflow-hidden">
                        <div
                          className="h-full bg-[var(--brass-300)]"
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Effectiveness */}
              <div>
                <p className="text-xs font-mono text-[color:var(--bone-400)] mb-2">Effectiveness Metrics</p>
                <div className="space-y-2">
                  {[
                    { label: 'Positive Outcome Rate', value: scoreboard.growth.positiveOutcomeRate == null ? 'Unavailable' : `${Math.round(scoreboard.growth.positiveOutcomeRate * 100)}%`, color: 'var(--cleared)' },
                    { label: 'Reviewed Recommendation Score', value: scoreboard.effectiveness.avgRecommendationScore == null ? 'Unavailable' : `${scoreboard.effectiveness.avgRecommendationScore}%`, color: 'var(--brass-300)' },
                    { label: 'Human Escalations', value: scoreboard.safety.escalationsToHuman, color: 'var(--locked)' },
                  ].map(({ label, value, color }) => (
                    <div key={label} className="flex justify-between border border-[#3a2a2a] bg-[var(--hide-950)] px-3 py-2">
                      <span className="text-[9px] text-[color:var(--bone-400)]">{label}</span>
                      <span className="text-[9px] font-mono font-bold" style={{ color }}>{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Engagement Summary */}
            <div className="border-t border-[#3a2a2a] pt-3">
              <p className="text-xs font-mono text-[color:var(--bone-400)] mb-2">Engagement Summary</p>
              <div className="grid md:grid-cols-3 gap-2">
                {[
                  { label: 'Total Interactions', value: scoreboard.growth.totalInteractions },
                  { label: 'Daily Active Users', value: scoreboard.engagement.dailyActiveUsers },
                  { label: 'Avg Messages / Session', value: scoreboard.engagement.avgMessagesPerSession?.toFixed(1) ?? 'Unavailable' },
                ].map(({ label, value }) => (
                  <div key={label} className="border border-[#3a2a2a] bg-[var(--hide-950)] px-3 py-2 text-center">
                    <p className="text-[9px] text-[color:var(--bone-400)]">{label}</p>
                    <p className="mt-1 text-sm font-mono font-bold text-[color:var(--brass-300)]">{value}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Top Topics */}
            {scoreboard.effectiveness.concernedTopics.length > 0 ? (
              <div className="border-t border-[#3a2a2a] pt-3">
                <p className="text-xs font-mono text-[color:var(--bone-400)] mb-2">Top Engaged Topics</p>
                <div className="flex flex-wrap gap-2">
                  {scoreboard.effectiveness.concernedTopics.map((topic, idx) => (
                    <span key={topic} className="border border-[color:var(--hide-600)] bg-[var(--hide-950)] px-3 py-1 text-[9px] font-mono text-[color:var(--brass-300)]">
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
          <section className="border-2 border-[color:var(--brass-700)] bg-[#151515] p-5">
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-[color:var(--brass-300)]">The Scorecard — {scoreboard.period}</p>
            <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
              {[
                { label: 'Total Interactions', value: scoreboard.growth.totalInteractions },
                { label: 'Positive Rate', value: scoreboard.growth.positiveOutcomeRate == null ? 'Unavailable' : `${Math.round(scoreboard.growth.positiveOutcomeRate * 100)}%` },
                { label: 'Active Users', value: scoreboard.engagement.dailyActiveUsers },
                { label: 'Gold Profiles', value: scoreboard.engagement.usersByTier.gold },
              ].map(({ label, value }) => (
                <div key={label} className="border border-[color:var(--hide-600)] bg-[var(--hide-950)] p-3 text-center">
                  <p className="text-xs font-mono text-[color:var(--bone-400)]">{label}</p>
                  <p className="mt-1 text-xl font-black text-[color:var(--brass-300)]">{value}</p>
                </div>
              ))}
            </div>
            <div className="mt-4 flex gap-4">
              {[
                { label: '🥇 Gold', count: scoreboard.engagement.usersByTier.gold },
                { label: '🥈 Silver', count: scoreboard.engagement.usersByTier.silver },
                { label: '🥉 Bronze', count: scoreboard.engagement.usersByTier.bronze },
              ].map(({ label, count }) => (
                <div key={label} className="text-xs font-mono text-[color:var(--bone-400)]">
                  <span className="text-[color:var(--brass-300)]">{label}</span> {count} users
                </div>
              ))}
              {scoreboard.effectiveness.concernedTopics.length > 0 ? (
                <div className="text-xs font-mono text-[color:var(--bone-400)]">
                  Topics needing review: <span className="text-[color:var(--brass-300)]">{scoreboard.effectiveness.concernedTopics.join(', ')}</span>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {/* SCOUT REPORTS */}
        <section className="border-2 border-[color:var(--brass-700)] bg-[#151515] p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-[color:var(--brass-300)]">
              Scout Reports ({scoutJobs.length})
            </p>
          </div>

          <div className="mt-3 border border-[color:var(--hide-600)] bg-[var(--hide-950)] p-3">
            <label htmlFor="generate-focus" className="block text-[10px] font-mono uppercase tracking-[0.14em] text-[#a89478]">
              Generate (optional focus)
            </label>
            <div className="mt-2 flex flex-wrap gap-2">
              <input
                id="generate-focus"
                type="text"
                value={generateFocus}
                onChange={(event) => setGenerateFocus(event.target.value)}
                maxLength={500}
                placeholder="e.g. progress since the last competition cycle"
                className="min-w-[220px] flex-1 border border-[color:var(--hide-600)] bg-[#151515] px-3 py-2 text-xs text-[color:var(--bone-300)] outline-none focus:border-[color:var(--brass-300)]"
                disabled={generateBusy}
              />
              <button
                type="button"
                onClick={() => void requestGeneration('scout_report')}
                disabled={generateBusy}
                className="border-2 border-[color:var(--brass-700)] bg-[#2a1a1a] px-3 py-2 text-[10px] font-mono font-bold uppercase tracking-[0.12em] text-[color:var(--locked)] transition hover:border-[color:var(--locked)] disabled:opacity-50"
              >
                {generateBusy ? 'Queuing…' : 'Generate scout report'}
              </button>
              {canViewOrgMetrics ? (
                <button
                  type="button"
                  onClick={() => void requestGeneration('board_summary')}
                  disabled={generateBusy}
                  className="border-2 border-[color:var(--hide-600)] bg-[var(--hide-900)] px-3 py-2 text-[10px] font-mono font-bold uppercase tracking-[0.12em] text-[color:var(--brass-300)] transition hover:border-[color:var(--brass-300)] disabled:opacity-50"
                >
                  Generate board summary
                </button>
              ) : null}
            </div>
            {generateNotice ? <p role="status" className="mt-2 text-xs text-[color:var(--brass-300)]">{generateNotice}</p> : null}
            {generateError ? <p role="alert" className="mt-2 text-xs text-[color:var(--locked)]">{generateError}</p> : null}
          </div>

          {loadingJobs ? (
            <p className="mt-4 text-xs text-[var(--bone-400)] font-mono">Loading...</p>
          ) : scoutJobs.length === 0 ? (
            <p className="mt-4 text-xs text-[var(--bone-400)] font-mono">No Scout Reports yet. Generate one above — it is processed by the background worker and listed here when complete.</p>
          ) : (
            <div className="mt-4 space-y-3">
              {scoutJobs.map((job) => (
                <button
                  key={job.jobId}
                  className={`border bg-[var(--hide-950)] p-4 cursor-pointer transition w-full text-left ${
                    selectedJob?.jobId === job.jobId ? 'border-[color:var(--brass-300)]' : 'border-[color:var(--hide-600)] hover:border-[color:var(--brass-700)]'
                  }`}
                  onClick={() => setSelectedJob(selectedJob?.jobId === job.jobId ? null : job)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <StatusBadge status={job.status} />
                      <p className="mt-1 text-[10px] text-[color:var(--bone-400)] font-mono">{job.jobId.slice(0, 8)}... · {new Date(job.createdAt).toLocaleDateString()}</p>
                    </div>
                    {safeCompleted(job) && job.output?.profileTier ? (
                      <span className="text-[10px] font-mono text-[color:var(--brass-300)] border border-[color:var(--hide-600)] px-2 py-0.5">
                        {job.output.profileTier.toUpperCase()}
                      </span>
                    ) : null}
                  </div>

                  {/* Expanded report */}
                  {selectedJob?.jobId === job.jobId && safeCompleted(job) && job.output ? (
                    <div className="mt-4 space-y-3 text-xs">
                      {job.output.summary ? (
                        <div>
                          <p className="font-mono text-[color:var(--brass-300)] uppercase tracking-[0.1em]">Summary</p>
                          <p className="mt-1 leading-6 text-[color:var(--bone-300)]">{job.output.summary}</p>
                        </div>
                      ) : null}
                      {job.output.strengths?.length ? (
                        <div>
                          <p className="font-mono text-[color:var(--brass-300)] uppercase tracking-[0.1em]">Strengths</p>
                          <ul className="mt-1 space-y-1 text-[color:var(--bone-300)]">
                            {job.output.strengths.map((s) => <li key={s}>→ {s}</li>)}
                          </ul>
                        </div>
                      ) : null}
                      {job.output.growthAreas?.length ? (
                        <div>
                          <p className="font-mono text-[color:var(--brass-300)] uppercase tracking-[0.1em]">Growth Areas</p>
                          <ul className="mt-1 space-y-1 text-[color:var(--bone-300)]">
                            {job.output.growthAreas.map((a) => <li key={a}>→ {a}</li>)}
                          </ul>
                        </div>
                      ) : null}
                      {job.output.recommendedTopics?.length ? (
                        <div>
                          <p className="font-mono text-[color:var(--brass-300)] uppercase tracking-[0.1em]">Recommended Topics</p>
                          <div className="mt-1 flex flex-wrap gap-2">
                            {job.output.recommendedTopics.map((t) => (
                              <span key={t} className="border border-[color:var(--hide-600)] px-2 py-0.5 text-[9px] text-[color:var(--bone-400)]">{t}</span>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {job.output.insightNotes ? (
                        <div>
                          <p className="font-mono text-[color:var(--brass-300)] uppercase tracking-[0.1em]">Insight Notes</p>
                          <p className="mt-1 leading-6 text-[color:var(--bone-300)]">{job.output.insightNotes}</p>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {selectedJob?.jobId === job.jobId
                    && job.status === 'completed'
                    && !safeCompleted(job) ? (
                      <p className="mt-2 text-[10px] font-mono text-[color:var(--brass-300)]">
                        This result is unavailable because it did not pass the server safety boundary or the required model capability is not active.
                      </p>
                    ) : null}

                  {selectedJob?.jobId === job.jobId && job.status === 'pending' ? (
                    <p className="mt-2 text-[10px] font-mono text-[color:var(--bone-400)]">Queued for secure background processing.</p>
                  ) : null}

                  {selectedJob?.jobId === job.jobId && job.status === 'failed' ? (
                    <p className="mt-2 text-[10px] font-mono text-[color:var(--locked)]">Error: {job.error}</p>
                  ) : null}

                  {selectedJob?.jobId === job.jobId && job.status === 'cancelled' ? (
                    <p className="mt-2 text-[10px] font-mono text-[color:var(--brass-300)]">
                      Cancelled{job.error ? `: ${job.error}` : ''} — usually the request expired before the worker reached it. Re-run it if you still need the report.
                    </p>
                  ) : null}
                </button>
              ))}
            </div>
          )}
        </section>

        {/* BOARD SUMMARIES */}
        {canViewOrgMetrics && boardJobs.length > 0 ? (
          <section className="border-2 border-[color:var(--hide-600)] bg-[#151515] p-5">
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-[color:var(--brass-300)]">
              Board Summaries ({boardJobs.length})
            </p>
            <div className="mt-4 space-y-3">
              {boardJobs.slice(0, 10).map((job) => (
                <div key={job.jobId} className="border border-[color:var(--hide-600)] bg-[var(--hide-950)] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <StatusBadge status={job.status} />
                    <p className="text-[10px] text-[color:var(--bone-400)] font-mono">{job.jobId.slice(0, 8)}… · {new Date(job.createdAt).toLocaleDateString()}</p>
                  </div>
                  {safeCompleted(job) && typeof job.output?.summary === 'string' ? (
                    <p className="mt-3 whitespace-pre-wrap text-xs leading-6 text-[color:var(--bone-300)]">{job.output.summary}</p>
                  ) : job.status === 'completed' ? (
                    <p className="mt-3 text-xs text-[color:var(--bone-400)] font-mono">Result withheld or unavailable — no validated summary to display.</p>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {/* HEAVY BAG HISTORY */}
        {heavyBagJobs.length > 0 ? (
          <section className="border-2 border-[color:var(--hide-600)] bg-[#151515] p-5">
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-[color:var(--bone-400)]">
              Heavy Bag Session History ({heavyBagJobs.length})
            </p>
            <div className="mt-3 space-y-2">
              {heavyBagJobs.slice(0, 10).map((job) => (
                <div
                  key={job.jobId}
                  className="flex items-center justify-between border border-[#3a2a2a] bg-[var(--hide-950)] px-3 py-2"
                >
                  <div className="flex items-center gap-3">
                    <StatusBadge status={job.status} />
                    <span className="text-[10px] font-mono text-[color:var(--bone-400)]">{new Date(job.createdAt).toLocaleString()}</span>
                  </div>
                  {job.status === 'completed' && job.completedAt ? (
                    <span className="text-[9px] font-mono text-[var(--bone-400)]">
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
    pending:   'text-[color:var(--bone-400)] border-[color:var(--hide-600)]',
    running:   'text-[color:var(--brass-300)] border-[color:var(--brass-300)]',
    completed: 'text-[#4a8a4a] border-[#4a8a4a]',
    failed:    'text-[color:var(--locked)] border-[color:var(--locked)]',
    cancelled: 'text-[#6a5a4a] border-[color:var(--hide-600)]',
  };
  return (
    <span className={`border px-2 py-0.5 text-[9px] font-mono uppercase tracking-[0.1em] ${styles[status]}`}>
      {status}
    </span>
  );
}
