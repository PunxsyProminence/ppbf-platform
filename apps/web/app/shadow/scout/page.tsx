'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { readRoleSession } from '@/components/roleSession';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateNumeric, formatGymStamp } from '@/src/lib/gymTime';

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
    <main className="room room--night min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      {/* HEADER */}
      <header className="mat-leather--raised border-b border-[color:rgba(212,175,74,.22)] px-[var(--s5)] py-[var(--s5)]">
        <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-end justify-between gap-[var(--s4)]">
          <div>
            <p className="t-eyebrow">SHADOW Intelligence</p>
            <h1 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-xl)' }}>
              Scout Reports
            </h1>
            <p className="t-muted mt-[var(--s2)]">Profile intelligence, Recovery Round jobs, and The Scorecard</p>
          </div>
          <div className="flex flex-wrap items-center gap-[var(--s3)]">
            <Link href="/shadow" className="btn btn--ghost">
              ← SHADOW
            </Link>
            <button
              type="button"
              disabled
              title="Requires the secure scheduled SHADOW worker"
              className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
            >
              Scout Report worker not active
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[1200px] space-y-[var(--s5)] p-[var(--s5)]">
        {error ? (
          <div role="alert" className="mat-leather rounded-[var(--r-md)] border-2 border-[color:var(--locked)] p-[var(--s4)]">
            <span className="badge badge--locked">
              <i>✕</i>Load Failed
            </span>
            <p className="t-body mt-[var(--s3)]">{error}</p>
          </div>
        ) : null}

        {/* METRICS DASHBOARD */}
        {scoreboard ? (
          <section className="mat-leather space-y-[var(--s4)] rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
            <p className="t-eyebrow">Metrics Dashboard — {scoreboard.period}</p>

            {/* Tier Distribution */}
            <div className="grid gap-[var(--s4)] md:grid-cols-2">
              <div>
                <p className="t-label mb-[var(--s3)]">Tier Distribution</p>
                <div className="space-y-[var(--s3)]">
                  {[
                    { label: 'Gold', count: scoreboard.engagement.usersByTier.gold, percent: ((scoreboard.engagement.usersByTier.gold / Math.max(scoreboard.engagement.usersByTier.gold + scoreboard.engagement.usersByTier.silver + scoreboard.engagement.usersByTier.bronze, 1)) * 100).toFixed(0) },
                    { label: 'Silver', count: scoreboard.engagement.usersByTier.silver, percent: ((scoreboard.engagement.usersByTier.silver / Math.max(scoreboard.engagement.usersByTier.gold + scoreboard.engagement.usersByTier.silver + scoreboard.engagement.usersByTier.bronze, 1)) * 100).toFixed(0) },
                    { label: 'Bronze', count: scoreboard.engagement.usersByTier.bronze, percent: ((scoreboard.engagement.usersByTier.bronze / Math.max(scoreboard.engagement.usersByTier.gold + scoreboard.engagement.usersByTier.silver + scoreboard.engagement.usersByTier.bronze, 1)) * 100).toFixed(0) },
                  ].map(({ label, count, percent }: { label: string; count: number; percent: string }) => (
                    <div key={label} className="space-y-[var(--s1)]">
                      <div className="t-data flex justify-between text-[color:var(--bone-300)]">
                        <span>{label} · {count} users</span>
                        <span>{percent}%</span>
                      </div>
                      {/* Law 1: the meter fill is chassis, so it is brass. */}
                      <div className="h-[var(--s2)] overflow-hidden rounded-[var(--r-sm)] border border-[color:var(--hide-600)] bg-[rgba(0,0,0,.4)]">
                        <div
                          className="h-full bg-[var(--brass-500)]"
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Effectiveness */}
              <div>
                <p className="t-label mb-[var(--s3)]">Effectiveness Metrics</p>
                <div className="space-y-[var(--s3)]">
                  {[
                    { label: 'Positive Outcome Rate', value: scoreboard.growth.positiveOutcomeRate == null ? 'Unavailable' : `${Math.round(scoreboard.growth.positiveOutcomeRate * 100)}%` },
                    { label: 'Reviewed Recommendation Score', value: scoreboard.effectiveness.avgRecommendationScore == null ? 'Unavailable' : `${scoreboard.effectiveness.avgRecommendationScore}%` },
                    { label: 'Human Escalations', value: scoreboard.safety.escalationsToHuman },
                  ].map(({ label, value }) => (
                    <div key={label} className="mat-leather--raised flex justify-between gap-[var(--s3)] rounded-[var(--r-sm)] px-[var(--s4)] py-[var(--s3)]">
                      <span className="t-muted">{label}</span>
                      <span className="t-data text-[color:var(--bone-100)]">{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Engagement Summary */}
            <div className="border-t border-[color:var(--hide-600)] pt-[var(--s4)]">
              <p className="t-label mb-[var(--s3)]">Engagement Summary</p>
              <div className="grid gap-[var(--s3)] md:grid-cols-3">
                {[
                  { label: 'Total Interactions', value: scoreboard.growth.totalInteractions },
                  { label: 'Daily Active Users', value: scoreboard.engagement.dailyActiveUsers },
                  { label: 'Avg Messages / Session', value: scoreboard.engagement.avgMessagesPerSession?.toFixed(1) ?? 'Unavailable' },
                ].map(({ label, value }) => (
                  <div key={label} className="mat-leather--raised rounded-[var(--r-md)] px-[var(--s4)] py-[var(--s3)] text-center">
                    <p className="t-label">{label}</p>
                    <p className="t-data mt-[var(--s2)] text-[length:var(--t-md)] text-[color:var(--bone-100)]">{value}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Top Topics */}
            {scoreboard.effectiveness.concernedTopics.length > 0 ? (
              <div className="border-t border-[color:var(--hide-600)] pt-[var(--s4)]">
                <p className="t-label mb-[var(--s3)]">Top Engaged Topics</p>
                <div className="flex flex-wrap gap-[var(--s3)]">
                  {scoreboard.effectiveness.concernedTopics.map((topic, idx) => (
                    <span key={topic} className="plaque">
                      #{idx + 1} {topic.toUpperCase()}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        {/* THE SCORECARD */}
        {scoreboard ? (
          <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
            <p className="t-eyebrow">The Scorecard — {scoreboard.period}</p>
            <div className="mt-[var(--s4)] grid grid-cols-2 gap-[var(--s3)] md:grid-cols-4">
              {[
                { label: 'Total Interactions', value: scoreboard.growth.totalInteractions },
                { label: 'Positive Rate', value: scoreboard.growth.positiveOutcomeRate == null ? 'Unavailable' : `${Math.round(scoreboard.growth.positiveOutcomeRate * 100)}%` },
                { label: 'Active Users', value: scoreboard.engagement.dailyActiveUsers },
                { label: 'Gold Profiles', value: scoreboard.engagement.usersByTier.gold },
              ].map(({ label, value }) => (
                <div key={label} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)] text-center">
                  <p className="t-label">{label}</p>
                  <p className="t-data mt-[var(--s2)] text-[length:var(--t-lg)] font-bold text-[color:var(--bone-100)]">{value}</p>
                </div>
              ))}
            </div>
            <div className="mt-[var(--s4)] flex flex-wrap gap-[var(--s4)]">
              {[
                { label: 'Gold', count: scoreboard.engagement.usersByTier.gold },
                { label: 'Silver', count: scoreboard.engagement.usersByTier.silver },
                { label: 'Bronze', count: scoreboard.engagement.usersByTier.bronze },
              ].map(({ label, count }) => (
                <div key={label} className="t-data text-[color:var(--bone-300)]">
                  <span className="text-[color:var(--brass-300)]">{label}</span> {count} users
                </div>
              ))}
              {scoreboard.effectiveness.concernedTopics.length > 0 ? (
                <div className="t-data text-[color:var(--bone-300)]">
                  Topics needing review: <span className="text-[color:var(--brass-300)]">{scoreboard.effectiveness.concernedTopics.join(', ')}</span>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {/* SCOUT REPORTS */}
        <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
          <div className="flex items-center justify-between gap-[var(--s3)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>
              Scout Reports ({scoutJobs.length})
            </h2>
          </div>

          <div className="mat-leather--raised mt-[var(--s4)] rounded-[var(--r-md)] p-[var(--s4)]">
            <label htmlFor="generate-focus" className="t-label block">
              Generate (optional focus)
            </label>
            <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s3)]">
              <input
                id="generate-focus"
                type="text"
                value={generateFocus}
                onChange={(event) => setGenerateFocus(event.target.value)}
                maxLength={500}
                placeholder="e.g. progress since the last competition cycle"
                className="input min-w-[220px] flex-1"
                disabled={generateBusy}
              />
              <button
                type="button"
                onClick={() => void requestGeneration('scout_report')}
                disabled={generateBusy}
                className="btn disabled:cursor-not-allowed disabled:opacity-60"
              >
                {generateBusy ? 'Queuing…' : 'Generate scout report'}
              </button>
              {canViewOrgMetrics ? (
                <button
                  type="button"
                  onClick={() => void requestGeneration('board_summary')}
                  disabled={generateBusy}
                  className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Generate board summary
                </button>
              ) : null}
            </div>
            {generateNotice ? <p role="status" className="t-body mt-[var(--s3)] text-[color:var(--brass-300)]">{generateNotice}</p> : null}
            {generateError ? (
              <div role="alert" className="mt-[var(--s3)]">
                <span className="badge badge--locked">
                  <i>✕</i>Not Queued
                </span>
                <p className="t-body mt-[var(--s2)]">{generateError}</p>
              </div>
            ) : null}
          </div>

          {loadingJobs ? (
            <p className="t-muted mt-[var(--s4)]">Loading...</p>
          ) : scoutJobs.length === 0 ? (
            <p className="t-muted mt-[var(--s4)]">No Scout Reports yet. Generate one above — it is processed by the background worker and listed here when complete.</p>
          ) : (
            <div className="mt-[var(--s4)] space-y-[var(--s3)]">
              {scoutJobs.map((job) => (
                <button
                  key={job.jobId}
                  className={`mat-leather--raised w-full cursor-pointer rounded-[var(--r-md)] p-[var(--s4)] text-left transition ${
                    selectedJob?.jobId === job.jobId
                      ? 'border-2 border-[color:var(--brass-400)]'
                      : 'border border-[color:rgba(212,175,74,.18)] hover:border-[color:var(--brass-500)]'
                  }`}
                  onClick={() => setSelectedJob(selectedJob?.jobId === job.jobId ? null : job)}
                >
                  <div className="flex items-center justify-between gap-[var(--s3)]">
                    <div>
                      <StatusBadge status={job.status} />
                      {/* Law 4: job identity and date are records -- mono voice. */}
                      <p className="t-data mt-[var(--s2)] text-[color:var(--bone-400)]">{job.jobId.slice(0, 8)}... · {formatGymDateNumeric(job.createdAt)}</p>
                    </div>
                    {safeCompleted(job) && job.output?.profileTier ? (
                      <span className="plaque">{job.output.profileTier.toUpperCase()}</span>
                    ) : null}
                  </div>

                  {/* Expanded report */}
                  {selectedJob?.jobId === job.jobId && safeCompleted(job) && job.output ? (
                    <div className="mt-[var(--s4)] space-y-[var(--s4)]">
                      {job.output.summary ? (
                        <div>
                          <p className="t-label">Summary</p>
                          <p className="t-body mt-[var(--s2)]">{job.output.summary}</p>
                        </div>
                      ) : null}
                      {job.output.strengths?.length ? (
                        <div>
                          <p className="t-label">Strengths</p>
                          <ul className="mt-[var(--s2)] space-y-[var(--s2)]">
                            {job.output.strengths.map((s) => <li key={s} className="t-body">→ {s}</li>)}
                          </ul>
                        </div>
                      ) : null}
                      {job.output.growthAreas?.length ? (
                        <div>
                          <p className="t-label">Growth Areas</p>
                          <ul className="mt-[var(--s2)] space-y-[var(--s2)]">
                            {job.output.growthAreas.map((a) => <li key={a} className="t-body">→ {a}</li>)}
                          </ul>
                        </div>
                      ) : null}
                      {job.output.recommendedTopics?.length ? (
                        <div>
                          <p className="t-label">Recommended Topics</p>
                          <div className="mt-[var(--s2)] flex flex-wrap gap-[var(--s3)]">
                            {job.output.recommendedTopics.map((t) => (
                              <span key={t} className="plaque">{t.toUpperCase()}</span>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {job.output.insightNotes ? (
                        <div>
                          <p className="t-label">Insight Notes</p>
                          <p className="t-body mt-[var(--s2)]">{job.output.insightNotes}</p>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {/* Law 7: a result withheld at the safety boundary is a
                      governance refusal -- a static ink stamp, never a toast. */}
                  {selectedJob?.jobId === job.jobId
                    && job.status === 'completed'
                    && !safeCompleted(job) ? (
                      <div className="mt-[var(--s4)]">
                        <span className="stamp">Withheld</span>
                        <p className="t-muted mt-[var(--s3)]">
                          This result is unavailable because it did not pass the server safety boundary or the required model capability is not active.
                        </p>
                      </div>
                    ) : null}

                  {selectedJob?.jobId === job.jobId && job.status === 'pending' ? (
                    <p className="t-muted mt-[var(--s3)]">Queued for secure background processing.</p>
                  ) : null}

                  {selectedJob?.jobId === job.jobId && job.status === 'failed' ? (
                    <p className="t-data mt-[var(--s3)] text-[color:var(--locked-ink)]">Error: {job.error}</p>
                  ) : null}

                  {selectedJob?.jobId === job.jobId && job.status === 'cancelled' ? (
                    <p className="t-muted mt-[var(--s3)]">
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
          <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s5)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>
              Board Summaries ({boardJobs.length})
            </h2>
            <div className="mt-[var(--s4)] space-y-[var(--s3)]">
              {boardJobs.slice(0, 10).map((job) => (
                <div key={job.jobId} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                  <div className="flex items-center justify-between gap-[var(--s3)]">
                    <StatusBadge status={job.status} />
                    <p className="t-data text-[color:var(--bone-400)]">{job.jobId.slice(0, 8)}… · {formatGymDateNumeric(job.createdAt)}</p>
                  </div>
                  {safeCompleted(job) && typeof job.output?.summary === 'string' ? (
                    <p className="t-body mt-[var(--s3)] whitespace-pre-wrap">{job.output.summary}</p>
                  ) : job.status === 'completed' ? (
                    <div className="mt-[var(--s3)]">
                      <span className="stamp">Withheld</span>
                      <p className="t-muted mt-[var(--s2)]">Result withheld or unavailable — no validated summary to display.</p>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {/* HEAVY BAG HISTORY */}
        {heavyBagJobs.length > 0 ? (
          <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s5)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>
              Heavy Bag Session History ({heavyBagJobs.length})
            </h2>
            <div className="mt-[var(--s4)] space-y-[var(--s3)]">
              {heavyBagJobs.slice(0, 10).map((job) => (
                <div
                  key={job.jobId}
                  className="mat-leather--raised flex items-center justify-between gap-[var(--s3)] rounded-[var(--r-sm)] px-[var(--s4)] py-[var(--s3)]"
                >
                  <div className="flex items-center gap-[var(--s3)]">
                    <StatusBadge status={job.status} />
                    <span className="t-data text-[color:var(--bone-400)]">{formatGymStamp(job.createdAt)}</span>
                  </div>
                  {job.status === 'completed' && job.completedAt ? (
                    <span className="t-data text-[color:var(--bone-400)]">
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

/* Law 2/3: a job status is a queue outcome, so it rides the status ladder --
   glyph + uppercase label, never colour alone. Pending is not yet an outcome
   and wears a neutral chip off the saturated rungs. */
function StatusBadge({ status }: { readonly status: JobStatusResult['status'] }) {
  const badges: Record<JobStatusResult['status'], { className: string; glyph: string; label: string }> = {
    /* The sheet's own administrative rung (badge--filed) replaced the
       hand-rolled chip this entry used to carry -- same ◌, same job. */
    pending: { className: 'badge badge--filed', glyph: '◌', label: 'Pending' },
    running: { className: 'badge badge--monitor', glyph: '◉', label: 'Running' },
    completed: { className: 'badge badge--cleared', glyph: '✓', label: 'Completed' },
    failed: { className: 'badge badge--locked', glyph: '✕', label: 'Failed' },
    cancelled: { className: 'badge badge--restricted', glyph: '▲', label: 'Cancelled' },
  };
  const badge = badges[status];
  return (
    <span className={badge.className}>
      <i>{badge.glyph}</i>
      {badge.label}
    </span>
  );
}
