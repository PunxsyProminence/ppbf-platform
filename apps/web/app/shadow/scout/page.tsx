'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { readRoleSession } from '@/components/roleSession';
import { apiBase } from '@/lib/apiBase';

// ─── Types ────────────────────────────────────────────────────────────────────

interface JobStatusResult {
  jobId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  sessionType: string;
  output?: {
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
  organizationId: string;
  period: string;
  totalInteractions: number;
  positiveOutcomes: number;
  negativeOutcomes: number;
  positiveRate: number;
  factsExtracted: number;
  topEngagedTopics: string[];
  profilesAtGold: number;
  profilesAtSilver: number;
  profilesAtBronze: number;
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
  const [requestingReport, setRequestingReport] = useState(false);
  const [runningMigration, setRunningMigration] = useState(false);
  const [migrationResult, setMigrationResult] = useState<string | null>(null);
  const [error, setError] = useState('');

  const canAccessAdmin = ['admin', 'organization_admin', 'platform_owner', 'coach'].includes(userRole);

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

  useEffect(() => {
    void loadData();
  }, []);

  async function loadData() {
    setLoadingJobs(true);
    setError('');
    try {
      const [jobsRes, scoreRes] = await Promise.allSettled([
        fetch(`${apiBase()}/api/pilot/shadow/jobs?limit=30`, { credentials: 'include' }),
        fetch(`${apiBase()}/api/pilot/shadow/metrics?days=30`, { credentials: 'include' }),
      ]);

      if (jobsRes.status === 'fulfilled' && jobsRes.value.ok) {
        const data = (await jobsRes.value.json()) as OrgJobsResponse;
        setJobs(data.jobs ?? []);
      }

      if (scoreRes.status === 'fulfilled' && scoreRes.value.ok) {
        const data = await scoreRes.value.json();
        setScoreboard(data as ScoreboardResponse);
      }
    } catch {
      setError('Failed to load data');
    } finally {
      setLoadingJobs(false);
    }
  }

  async function requestScoutReport() {
    setRequestingReport(true);
    try {
      const res = await fetch(`${apiBase()}/api/pilot/shadow/chat`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Generate a Scout Report for my profile',
          sessionType: 'scout_report',
          preferAsync: true,
        }),
      });
      if (!res.ok) throw new Error('Request failed');
      const data = await res.json();
      if (data.jobId) {
        setTimeout(() => void loadData(), 1500);
      }
    } catch {
      setError('Failed to request Scout Report');
    } finally {
      setRequestingReport(false);
    }
  }

  async function runProcessor() {
    try {
      const res = await fetch(`${apiBase()}/api/pilot/shadow/jobs/process`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      if (data.processed) {
        setTimeout(() => void loadData(), 1000);
      }
    } catch {
      setError('Processor error');
    }
  }

  async function runMigrations() {
    setRunningMigration(true);
    setMigrationResult(null);
    try {
      const res = await fetch(`${apiBase()}/api/pilot/shadow/migrate`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      const summary = (data.results as Array<{ migration: string; status: string; error?: string }>)
        .map((r) => `${r.status === 'ok' ? '✅' : '❌'} ${r.migration}${r.error ? `: ${r.error}` : ''}`)
        .join('\n');
      setMigrationResult(summary);
    } catch {
      setMigrationResult('Migration request failed');
    } finally {
      setRunningMigration(false);
    }
  }

  const scoutJobs = jobs.filter((j) => j.sessionType === 'scout_report');
  const heavyBagJobs = jobs.filter((j) => j.sessionType === 'heavy_bag');
  const pendingCount = jobs.filter((j) => j.status === 'pending' || j.status === 'running').length;

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-[#e8d7c6]">
      {/* HEADER */}
      <header className="border-b-4 border-[#8b4444] bg-[#1a1a1a] px-4 py-4 md:px-8">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-[#dc2626]">SHADOW Intelligence</p>
            <h1 className="font-display text-2xl font-black tracking-tight text-[#e8d7c6]">Scout Reports</h1>
            <p className="mt-1 text-xs text-[#b0a095]">Profile intelligence, Recovery Round jobs, and The Scorecard</p>
          </div>
          <div className="flex gap-3">
            <Link
              href="/shadow"
              className="border-2 border-[#5a4a3a] bg-[#1a1a1a] px-3 py-2 text-xs font-mono text-[#b0a095] transition hover:border-[#8b4444] hover:text-[#e8d7c6]"
            >
              ← SHADOW
            </Link>
            <button
              onClick={() => void requestScoutReport()}
              disabled={requestingReport}
              className="border-2 border-[#d4a574] bg-[#2a1f0f] px-4 py-2 text-xs font-mono font-bold text-[#d4a574] transition hover:border-[#e8d7c6] hover:text-[#e8d7c6] disabled:opacity-50"
            >
              {requestingReport ? 'Queuing...' : '+ Request Scout Report'}
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-5xl p-4 md:p-8 space-y-6">
        {error ? (
          <p className="border border-[#dc2626] bg-[#1a0a0a] px-4 py-2 text-xs font-mono text-[#dc2626]">{error}</p>
        ) : null}

        {/* METRICS DASHBOARD */}
        {scoreboard ? (
          <section className="border-2 border-[#8b4444] bg-[#151515] p-5 space-y-4">
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-[#d4a574]">Metrics Dashboard — {scoreboard.period}</p>

            {/* Tier Distribution */}
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <p className="text-xs font-mono text-[#b0a095] mb-2">Tier Distribution</p>
                <div className="space-y-2">
                  {[
                    { label: '🥇 Gold', count: scoreboard.profilesAtGold, percent: ((scoreboard.profilesAtGold / Math.max(scoreboard.profilesAtGold + scoreboard.profilesAtSilver + scoreboard.profilesAtBronze, 1)) * 100).toFixed(0) },
                    { label: '🥈 Silver', count: scoreboard.profilesAtSilver, percent: ((scoreboard.profilesAtSilver / Math.max(scoreboard.profilesAtGold + scoreboard.profilesAtSilver + scoreboard.profilesAtBronze, 1)) * 100).toFixed(0) },
                    { label: '🥉 Bronze', count: scoreboard.profilesAtBronze, percent: ((scoreboard.profilesAtBronze / Math.max(scoreboard.profilesAtGold + scoreboard.profilesAtSilver + scoreboard.profilesAtBronze, 1)) * 100).toFixed(0) },
                  ].map(({ label, count, percent }: { label: string; count: number; percent: string }) => (
                    <div key={label} className="space-y-1">
                      <div className="flex justify-between text-[9px] text-[#b0a095]">
                        <span>{label} {count} users</span>
                        <span>{percent}%</span>
                      </div>
                      <div className="h-1.5 bg-[#0f0f0f] border border-[#3a2a2a] overflow-hidden">
                        <div
                          className="h-full bg-[#d4a574]"
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Effectiveness */}
              <div>
                <p className="text-xs font-mono text-[#b0a095] mb-2">Effectiveness Metrics</p>
                <div className="space-y-2">
                  {[
                    { label: 'Positive Outcomes', value: scoreboard.positiveOutcomes, color: '#4a8a4a' },
                    { label: 'Negative Outcomes', value: scoreboard.negativeOutcomes, color: '#dc2626' },
                    { label: 'Positive Rate', value: `${Math.round(scoreboard.positiveRate * 100)}%`, color: '#d4a574' },
                  ].map(({ label, value, color }) => (
                    <div key={label} className="flex justify-between border border-[#3a2a2a] bg-[#0f0f0f] px-3 py-2">
                      <span className="text-[9px] text-[#b0a095]">{label}</span>
                      <span className="text-[9px] font-mono font-bold" style={{ color }}>{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Engagement Summary */}
            <div className="border-t border-[#3a2a2a] pt-3">
              <p className="text-xs font-mono text-[#b0a095] mb-2">Engagement Summary</p>
              <div className="grid md:grid-cols-3 gap-2">
                {[
                  { label: 'Total Interactions', value: scoreboard.totalInteractions },
                  { label: 'Facts Extracted', value: scoreboard.factsExtracted },
                  { label: 'Avg per Profile', value: (scoreboard.totalInteractions / Math.max(scoreboard.profilesAtGold + scoreboard.profilesAtSilver + scoreboard.profilesAtBronze, 1)).toFixed(1) },
                ].map(({ label, value }) => (
                  <div key={label} className="border border-[#3a2a2a] bg-[#0f0f0f] px-3 py-2 text-center">
                    <p className="text-[9px] text-[#8a8a8a]">{label}</p>
                    <p className="mt-1 text-sm font-mono font-bold text-[#d4a574]">{value}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Top Topics */}
            {scoreboard.topEngagedTopics.length > 0 ? (
              <div className="border-t border-[#3a2a2a] pt-3">
                <p className="text-xs font-mono text-[#b0a095] mb-2">Top Engaged Topics</p>
                <div className="flex flex-wrap gap-2">
                  {scoreboard.topEngagedTopics.map((topic, idx) => (
                    <span key={topic} className="border border-[#5a4a3a] bg-[#0f0f0f] px-3 py-1 text-[9px] font-mono text-[#d4a574]">
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
          <section className="border-2 border-[#8b4444] bg-[#151515] p-5">
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-[#d4a574]">The Scorecard — {scoreboard.period}</p>
            <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
              {[
                { label: 'Total Interactions', value: scoreboard.totalInteractions },
                { label: 'Positive Rate', value: `${Math.round(scoreboard.positiveRate * 100)}%` },
                { label: 'Facts Extracted', value: scoreboard.factsExtracted },
                { label: 'Gold Profiles', value: scoreboard.profilesAtGold },
              ].map(({ label, value }) => (
                <div key={label} className="border border-[#5a4a3a] bg-[#0f0f0f] p-3 text-center">
                  <p className="text-xs font-mono text-[#8a8a8a]">{label}</p>
                  <p className="mt-1 text-xl font-black text-[#d4a574]">{value}</p>
                </div>
              ))}
            </div>
            <div className="mt-4 flex gap-4">
              {[
                { label: '🥇 Gold', count: scoreboard.profilesAtGold },
                { label: '🥈 Silver', count: scoreboard.profilesAtSilver },
                { label: '🥉 Bronze', count: scoreboard.profilesAtBronze },
              ].map(({ label, count }) => (
                <div key={label} className="text-xs font-mono text-[#b0a095]">
                  <span className="text-[#d4a574]">{label}</span> {count} users
                </div>
              ))}
              {scoreboard.topEngagedTopics.length > 0 ? (
                <div className="text-xs font-mono text-[#b0a095]">
                  Top topics: <span className="text-[#d4a574]">{scoreboard.topEngagedTopics.join(', ')}</span>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {/* SCOUT REPORTS */}
        <section className="border-2 border-[#8b4444] bg-[#151515] p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-[#d4a574]">
              Scout Reports ({scoutJobs.length})
            </p>
            {pendingCount > 0 ? (
              <button
                onClick={() => void runProcessor()}
                className="border border-[#5a4a3a] bg-[#1a1a1a] px-3 py-1 text-[9px] font-mono text-[#8a8a8a] transition hover:border-[#8b4444] hover:text-[#e8d7c6]"
              >
                ▶ Process {pendingCount} pending
              </button>
            ) : null}
          </div>

          {loadingJobs ? (
            <p className="mt-4 text-xs text-[#6a5a4a] font-mono">Loading...</p>
          ) : scoutJobs.length === 0 ? (
            <p className="mt-4 text-xs text-[#6a5a4a] font-mono">No Scout Reports yet. Click &quot;+ Request Scout Report&quot; to generate one.</p>
          ) : (
            <div className="mt-4 space-y-3">
              {scoutJobs.map((job) => (
                <article
                  key={job.jobId}
                  className={`border bg-[#0f0f0f] p-4 cursor-pointer transition ${
                    selectedJob?.jobId === job.jobId ? 'border-[#d4a574]' : 'border-[#5a4a3a] hover:border-[#8b4444]'
                  }`}
                  onClick={() => setSelectedJob(selectedJob?.jobId === job.jobId ? null : job)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <StatusBadge status={job.status} />
                      <p className="mt-1 text-[10px] text-[#8a8a8a] font-mono">{job.jobId.slice(0, 8)}... · {new Date(job.createdAt).toLocaleDateString()}</p>
                    </div>
                    {job.status === 'completed' && job.output?.profileTier ? (
                      <span className="text-[10px] font-mono text-[#d4a574] border border-[#5a4a3a] px-2 py-0.5">
                        {job.output.profileTier.toUpperCase()}
                      </span>
                    ) : null}
                  </div>

                  {/* Expanded report */}
                  {selectedJob?.jobId === job.jobId && job.status === 'completed' && job.output ? (
                    <div className="mt-4 space-y-3 text-xs">
                      {job.output.summary ? (
                        <div>
                          <p className="font-mono text-[#d4a574] uppercase tracking-[0.1em]">Summary</p>
                          <p className="mt-1 leading-6 text-[#cfbfae]">{job.output.summary}</p>
                        </div>
                      ) : null}
                      {job.output.strengths?.length ? (
                        <div>
                          <p className="font-mono text-[#d4a574] uppercase tracking-[0.1em]">Strengths</p>
                          <ul className="mt-1 space-y-1 text-[#cfbfae]">
                            {job.output.strengths.map((s, i) => <li key={i}>→ {s}</li>)}
                          </ul>
                        </div>
                      ) : null}
                      {job.output.growthAreas?.length ? (
                        <div>
                          <p className="font-mono text-[#d4a574] uppercase tracking-[0.1em]">Growth Areas</p>
                          <ul className="mt-1 space-y-1 text-[#cfbfae]">
                            {job.output.growthAreas.map((a, i) => <li key={i}>→ {a}</li>)}
                          </ul>
                        </div>
                      ) : null}
                      {job.output.recommendedTopics?.length ? (
                        <div>
                          <p className="font-mono text-[#d4a574] uppercase tracking-[0.1em]">Recommended Topics</p>
                          <div className="mt-1 flex flex-wrap gap-2">
                            {job.output.recommendedTopics.map((t, i) => (
                              <span key={i} className="border border-[#5a4a3a] px-2 py-0.5 text-[9px] text-[#b0a095]">{t}</span>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {job.output.insightNotes ? (
                        <div>
                          <p className="font-mono text-[#d4a574] uppercase tracking-[0.1em]">Insight Notes</p>
                          <p className="mt-1 leading-6 text-[#cfbfae]">{job.output.insightNotes}</p>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {selectedJob?.jobId === job.jobId && job.status === 'pending' ? (
                    <p className="mt-2 text-[10px] font-mono text-[#8a8a8a]">Queued — click &quot;Process pending&quot; to execute</p>
                  ) : null}

                  {selectedJob?.jobId === job.jobId && job.status === 'failed' ? (
                    <p className="mt-2 text-[10px] font-mono text-[#dc2626]">Error: {job.error}</p>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </section>

        {/* HEAVY BAG HISTORY */}
        {heavyBagJobs.length > 0 ? (
          <section className="border-2 border-[#5a4a3a] bg-[#151515] p-5">
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-[#b0a095]">
              Heavy Bag Session History ({heavyBagJobs.length})
            </p>
            <div className="mt-3 space-y-2">
              {heavyBagJobs.slice(0, 10).map((job) => (
                <div
                  key={job.jobId}
                  className="flex items-center justify-between border border-[#3a2a2a] bg-[#0f0f0f] px-3 py-2"
                >
                  <div className="flex items-center gap-3">
                    <StatusBadge status={job.status} />
                    <span className="text-[10px] font-mono text-[#8a8a8a]">{new Date(job.createdAt).toLocaleString()}</span>
                  </div>
                  {job.status === 'completed' && job.completedAt ? (
                    <span className="text-[9px] font-mono text-[#6a5a4a]">
                      {Math.round((new Date(job.completedAt).getTime() - new Date(job.createdAt).getTime()) / 1000)}s
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {/* ADMIN: DB MIGRATIONS */}
        {['platform_owner', 'admin'].includes(userRole) ? (
          <section className="border border-[#3a2a2a] bg-[#0f0f0f] p-4">
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-[#6a5a4a]">Platform Admin — DB Migrations</p>
            <p className="mt-1 text-[10px] text-[#6a5a4a] font-mono">
              Creates shadow_jobs, shadow_learning_events, shadow_library_review_flags tables (idempotent).
            </p>
            <div className="mt-3 flex items-center gap-3">
              <button
                onClick={() => void runMigrations()}
                disabled={runningMigration}
                className="border border-[#5a4a3a] bg-[#1a1a1a] px-3 py-1.5 text-[10px] font-mono text-[#8a8a8a] transition hover:border-[#d4a574] hover:text-[#d4a574] disabled:opacity-50"
              >
                {runningMigration ? 'Running...' : 'Run Migrations'}
              </button>
              {migrationResult ? (
                <pre className="text-[10px] font-mono text-[#b0a095] whitespace-pre-wrap">{migrationResult}</pre>
              ) : null}
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}

function StatusBadge({ status }: { status: JobStatusResult['status'] }) {
  const styles: Record<JobStatusResult['status'], string> = {
    pending:   'text-[#8a8a8a] border-[#5a4a3a]',
    running:   'text-[#d4a574] border-[#d4a574]',
    completed: 'text-[#4a8a4a] border-[#4a8a4a]',
    failed:    'text-[#dc2626] border-[#dc2626]',
    cancelled: 'text-[#6a5a4a] border-[#5a4a3a]',
  };
  return (
    <span className={`border px-2 py-0.5 text-[9px] font-mono uppercase tracking-[0.1em] ${styles[status]}`}>
      {status}
    </span>
  );
}
