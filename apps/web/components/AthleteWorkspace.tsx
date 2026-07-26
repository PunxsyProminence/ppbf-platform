'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

type TabID =
  | 'my-dashboard'
  | 'session-history'
  | 'athlete-floor'
  | 'smart-goals'
  | 'tracks'
  | 'assessments'
  | 'bio-checkin'
  | 'drill-library'
  | 'rabbit-holes'
  | 'message-coach'
  | 'schedule-session'
  | 'shadow';

type ConnectionStatus = 'loading' | 'connected' | 'not-connected' | 'error';

interface GoalApiItem {
  goal_id: string;
  title: string;
  target_date?: string | null;
  metric?: string | null;
  progress_percent?: number | null;
  status?: string | null;
}

interface SessionApiItem {
  session_id: string;
  date?: string | null;
  rpe?: number | null;
  notes?: string | null;
  completed_flag?: boolean | null;
}

interface ShadowObservationItem {
  id: string;
  source: 'event' | 'telemetry';
  label: string;
  review_state: 'pending_review' | 'approved' | 'rejected' | 'promoted' | 'unknown';
  created_at: string;
}

interface AsyncStateProps {
  label: string;
  message: string;
  onRetry?: () => void;
}

const tabs: Array<{ id: TabID; label: string }> = [
  { id: 'my-dashboard', label: 'Dashboard' },
  { id: 'session-history', label: 'Sessions' },
  { id: 'athlete-floor', label: 'Floor' },
  { id: 'smart-goals', label: 'Goals' },
  { id: 'tracks', label: 'Tracks' },
  { id: 'assessments', label: 'Assessments' },
  { id: 'bio-checkin', label: 'Bio Check-In' },
  { id: 'drill-library', label: 'Drills' },
  { id: 'rabbit-holes', label: 'Learn' },
  { id: 'message-coach', label: 'Messages' },
  { id: 'schedule-session', label: 'Schedule' },
  { id: 'shadow', label: 'SHADOW' },
];

function formatStatus(value: string | null | undefined): string {
  if (!value) return 'Status unavailable';
  return value
    .replaceAll('_', ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function AsyncState({ label, message, onRetry }: Readonly<AsyncStateProps>) {
  return (
    <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6" role="status">
      <p className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-[#d4a574]">{label}</p>
      <p className="mt-2 text-sm text-[#cfbfae]">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 min-h-[40px] border-2 border-[#8b4444] bg-[#2a1414] px-4 text-xs font-bold uppercase tracking-[0.08em] text-[#e8d7c6] transition hover:bg-[#3a1a1a]"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

function NotConnectedPanel({
  title,
  children,
}: Readonly<{ title: string; children: React.ReactNode }>) {
  return (
    <section className="border-2 border-[#8b4444] bg-[#1a1a1a] p-6">
      <p className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-[#d4a574]">
        {title}
      </p>
      <div className="mt-3 space-y-3 text-sm text-[#cfbfae]">{children}</div>
    </section>
  );
}

export default function AthleteWorkspace() {
  const [activeTab, setActiveTab] = useState<TabID>('my-dashboard');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('loading');
  const [connectionError, setConnectionError] = useState('');
  const [backendAthleteId, setBackendAthleteId] = useState<string | null>(null);

  const [goals, setGoals] = useState<GoalApiItem[]>([]);
  const [goalsLoading, setGoalsLoading] = useState(false);
  const [goalsError, setGoalsError] = useState('');
  const [showGoalForm, setShowGoalForm] = useState(false);
  const [newGoalTitle, setNewGoalTitle] = useState('');
  const [newGoalTargetDate, setNewGoalTargetDate] = useState('');
  const [newGoalMetric, setNewGoalMetric] = useState('');
  const [goalSaveStatus, setGoalSaveStatus] = useState('');
  const [goalSaving, setGoalSaving] = useState(false);

  const [sessions, setSessions] = useState<SessionApiItem[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState('');

  const [shadowObservations, setShadowObservations] = useState<ShadowObservationItem[]>([]);
  const [shadowLoading, setShadowLoading] = useState(true);
  const [shadowError, setShadowError] = useState('');

  const activeGoalCount = useMemo(
    () => goals.filter((goal) => goal.status?.toLowerCase() === 'active').length,
    [goals]
  );

  const loadCurrentSession = useCallback(async () => {
    setConnectionStatus('loading');
    setConnectionError('');

    try {
      const response = await fetch('/api/pilot/auth/session', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = (await response.json().catch(() => ({}))) as {
        authenticated?: boolean;
        athlete_id?: string;
      };

      if (!response.ok) {
        throw new Error('The athlete session could not be verified.');
      }

      if (!payload.authenticated || !payload.athlete_id) {
        setBackendAthleteId(null);
        setGoals([]);
        setSessions([]);
        setGoalsLoading(false);
        setSessionsLoading(false);
        setConnectionStatus('not-connected');
        return;
      }

      setBackendAthleteId(payload.athlete_id);
      setConnectionStatus('connected');
    } catch (error) {
      setBackendAthleteId(null);
      setGoalsLoading(false);
      setSessionsLoading(false);
      setConnectionStatus('error');
      setConnectionError(
        error instanceof Error ? error.message : 'The athlete session could not be verified.'
      );
    }
  }, []);

  const loadGoals = useCallback(async (athleteId: string) => {
    setGoalsLoading(true);
    setGoalsError('');

    try {
      const response = await fetch(
        `/api/pilot/goals/list?athlete_id=${encodeURIComponent(athleteId)}`,
        {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
        }
      );
      const payload = (await response.json().catch(() => ({}))) as {
        items?: GoalApiItem[];
      };

      if (!response.ok) {
        throw new Error('Goals could not be loaded from the athlete account.');
      }

      setGoals(Array.isArray(payload.items) ? payload.items : []);
    } catch (error) {
      setGoals([]);
      setGoalsError(
        error instanceof Error ? error.message : 'Goals could not be loaded from the athlete account.'
      );
    } finally {
      setGoalsLoading(false);
    }
  }, []);

  const loadSessions = useCallback(async (athleteId: string) => {
    setSessionsLoading(true);
    setSessionsError('');

    try {
      const response = await fetch(
        `/api/pilot/sessions/list?athlete_id=${encodeURIComponent(athleteId)}`,
        {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
        }
      );
      const payload = (await response.json().catch(() => ({}))) as {
        items?: SessionApiItem[];
      };

      if (!response.ok) {
        throw new Error('Session history could not be loaded from the athlete account.');
      }

      setSessions(Array.isArray(payload.items) ? payload.items : []);
    } catch (error) {
      setSessions([]);
      setSessionsError(
        error instanceof Error
          ? error.message
          : 'Session history could not be loaded from the athlete account.'
      );
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  const loadShadowObservations = useCallback(async () => {
    setShadowLoading(true);
    setShadowError('');

    try {
      const response = await fetch('/api/pilot/shadow/observation-projection', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 20 }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        items?: ShadowObservationItem[];
      };

      if (!response.ok) {
        throw new Error('SHADOW observations could not be loaded.');
      }

      setShadowObservations(Array.isArray(payload.items) ? payload.items : []);
    } catch (error) {
      setShadowObservations([]);
      setShadowError(
        error instanceof Error ? error.message : 'SHADOW observations could not be loaded.'
      );
    } finally {
      setShadowLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadCurrentSession();
      void loadShadowObservations();
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [loadCurrentSession, loadShadowObservations]);

  useEffect(() => {
    if (!backendAthleteId) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void loadGoals(backendAthleteId);
      void loadSessions(backendAthleteId);
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [backendAthleteId, loadGoals, loadSessions]);

  const handleCreateGoal = async () => {
    setGoalSaveStatus('');

    if (!backendAthleteId || connectionStatus !== 'connected') {
      setGoalSaveStatus('No goal was saved because an athlete account is not connected.');
      return;
    }

    if (!newGoalTitle.trim() || !newGoalTargetDate || !newGoalMetric.trim()) {
      setGoalSaveStatus('Enter a title, target date, and measurable outcome before saving.');
      return;
    }

    setGoalSaving(true);
    const now = new Date().toISOString();

    try {
      const response = await fetch('/api/pilot/goals', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal_id: `goal_${Date.now()}`,
          athlete_id: backendAthleteId,
          title: newGoalTitle.trim(),
          target_date: newGoalTargetDate,
          metric: newGoalMetric.trim(),
          status: 'active',
          created_at: now,
          updated_at: now,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };

      if (!response.ok) {
        throw new Error(payload.error || 'The goal could not be saved.');
      }

      await loadGoals(backendAthleteId);
      setNewGoalTitle('');
      setNewGoalTargetDate('');
      setNewGoalMetric('');
      setShowGoalForm(false);
      setGoalSaveStatus('Goal saved to your athlete account.');
    } catch (error) {
      setGoalSaveStatus(error instanceof Error ? error.message : 'The goal could not be saved.');
    } finally {
      setGoalSaving(false);
    }
  };

  const renderConnectionState = () => {
    if (connectionStatus === 'loading') {
      return (
        <AsyncState
          label="Checking athlete connection"
          message="Verifying the signed-in athlete account."
        />
      );
    }

    if (connectionStatus === 'error') {
      return (
        <AsyncState
          label="Connection error"
          message={connectionError || 'The athlete account could not be verified.'}
          onRetry={() => void loadCurrentSession()}
        />
      );
    }

    if (connectionStatus === 'not-connected') {
      return (
        <AsyncState
          label="Athlete account not connected"
          message="Sign in with an athlete account to load goals and session history. Nothing shown here is filled with sample athlete data."
          onRetry={() => void loadCurrentSession()}
        />
      );
    }

    return null;
  };

  const renderGoals = () => {
    if (connectionStatus !== 'connected') {
      return renderConnectionState();
    }

    if (goalsLoading) {
      return <AsyncState label="Loading goals" message="Loading goals from your athlete account." />;
    }

    if (goalsError) {
      return (
        <AsyncState
          label="Goal loading error"
          message={goalsError}
          onRetry={
            backendAthleteId ? () => void loadGoals(backendAthleteId) : undefined
          }
        />
      );
    }

    if (goals.length === 0) {
      return (
        <AsyncState
          label="No goals yet"
          message="The connected athlete account has no saved goals."
        />
      );
    }

    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {goals.map((goal) => (
          <article key={goal.goal_id} className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
            <div className="flex items-start justify-between gap-4">
              <h3 className="font-semibold text-[#e8d7c6]">{goal.title}</h3>
              <span className="text-xs font-mono uppercase text-[#d4a574]">
                {formatStatus(goal.status)}
              </span>
            </div>
            <p className="mt-3 text-sm text-[#cfbfae]">
              Target: {formatDate(goal.target_date)}
            </p>
            <p className="mt-1 text-sm text-[#cfbfae]">
              Measure: {goal.metric || 'Measure unavailable'}
            </p>
            <p className="mt-1 text-sm text-[#cfbfae]">
              Progress:{' '}
              {typeof goal.progress_percent === 'number'
                ? `${goal.progress_percent}%`
                : 'Not recorded'}
            </p>
          </article>
        ))}
      </div>
    );
  };

  const renderSessions = (limit?: number) => {
    if (connectionStatus !== 'connected') {
      return renderConnectionState();
    }

    if (sessionsLoading) {
      return (
        <AsyncState
          label="Loading session history"
          message="Loading recorded sessions from your athlete account."
        />
      );
    }

    if (sessionsError) {
      return (
        <AsyncState
          label="Session loading error"
          message={sessionsError}
          onRetry={
            backendAthleteId ? () => void loadSessions(backendAthleteId) : undefined
          }
        />
      );
    }

    if (sessions.length === 0) {
      return (
        <AsyncState
          label="No recorded sessions"
          message="The connected athlete account has no session records."
        />
      );
    }

    const visibleSessions = typeof limit === 'number' ? sessions.slice(0, limit) : sessions;

    return (
      <div className="space-y-3">
        {visibleSessions.map((session) => (
          <article
            key={session.session_id}
            className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold text-[#e8d7c6]">{formatDate(session.date)}</h3>
              <span className="text-xs font-mono uppercase text-[#d4a574]">
                {session.completed_flag === true
                  ? 'Completed'
                  : session.completed_flag === false
                    ? 'Open'
                    : 'Status unavailable'}
              </span>
            </div>
            <p className="mt-2 text-sm text-[#cfbfae]">
              Session RPE:{' '}
              {typeof session.rpe === 'number' ? session.rpe : 'Not recorded'}
            </p>
            {session.notes ? (
              <p className="mt-1 text-sm text-[#cfbfae]">Notes: {session.notes}</p>
            ) : null}
          </article>
        ))}
      </div>
    );
  };

  const renderShadow = () => (
    <div className="space-y-5">
      <NotConnectedPanel title="SHADOW workspace">
        <p>
          SHADOW chat and recommendations live on the dedicated SHADOW surface. This athlete
          dashboard does not generate sample conversations or pretend an automated recommendation
          was made.
        </p>
        <Link
          href="/shadow"
          className="inline-flex min-h-[42px] items-center border-2 border-[#d4a574] bg-[#2a2118] px-4 text-xs font-bold uppercase tracking-[0.08em] text-[#e8d7c6] transition hover:bg-[#3a2b1e]"
        >
          Open SHADOW
        </Link>
      </NotConnectedPanel>

      {shadowLoading ? (
        <AsyncState
          label="Loading SHADOW observations"
          message="Loading the connected observation projection."
        />
      ) : null}

      {!shadowLoading && shadowError ? (
        <AsyncState
          label="SHADOW loading error"
          message={shadowError}
          onRetry={() => void loadShadowObservations()}
        />
      ) : null}

      {!shadowLoading && !shadowError && shadowObservations.length === 0 ? (
        <AsyncState
          label="No SHADOW observations"
          message="The observation projection returned no records. No sample observations are shown."
        />
      ) : null}

      {!shadowLoading && !shadowError && shadowObservations.length > 0 ? (
        <div className="space-y-3">
          {shadowObservations.map((item) => (
            <article key={item.id} className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold text-[#e8d7c6]">{item.label}</h3>
                <span className="text-xs font-mono uppercase text-[#d4a574]">
                  {formatStatus(item.review_state)}
                </span>
              </div>
              <p className="mt-2 text-xs text-[#b0a095]">
                {formatStatus(item.source)} · {formatDate(item.created_at)}
              </p>
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-[#e8d7c6]">
      <div className="mx-auto max-w-7xl space-y-7 p-4 md:p-6">
        <header className="border-b-2 border-[#8b4444] pb-6">
          <p className="text-xs font-mono uppercase tracking-[0.15em] text-[#d4a574]">
            Athlete Development Workspace
          </p>
          <h1 className="mt-2 text-3xl font-black md:text-4xl">My Training Dashboard</h1>
          <p className="mt-2 max-w-3xl text-sm text-[#cfbfae]">
            This V1 shows only information returned by connected services. Missing integrations
            stay clearly marked instead of being filled with sample schedules, tasks, training
            prescriptions, or health decisions.
          </p>
        </header>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Athlete summary">
          <article className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
            <p className="text-xs font-mono uppercase tracking-[0.1em] text-[#d4a574]">
              Athlete connection
            </p>
            <p className="mt-2 font-semibold">
              {connectionStatus === 'connected'
                ? 'Connected'
                : connectionStatus === 'loading'
                  ? 'Checking'
                  : connectionStatus === 'error'
                    ? 'Error'
                    : 'Not connected'}
            </p>
          </article>
          <article className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
            <p className="text-xs font-mono uppercase tracking-[0.1em] text-[#d4a574]">
              Recorded sessions
            </p>
            <p className="mt-2 text-2xl font-black">
              {connectionStatus === 'connected' && !sessionsLoading && !sessionsError
                ? sessions.length
                : '—'}
            </p>
          </article>
          <article className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
            <p className="text-xs font-mono uppercase tracking-[0.1em] text-[#d4a574]">
              Active goals
            </p>
            <p className="mt-2 text-2xl font-black">
              {connectionStatus === 'connected' && !goalsLoading && !goalsError
                ? activeGoalCount
                : '—'}
            </p>
          </article>
          <article className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
            <p className="text-xs font-mono uppercase tracking-[0.1em] text-[#d4a574]">
              SHADOW observations
            </p>
            <p className="mt-2 text-2xl font-black">
              {!shadowLoading && !shadowError ? shadowObservations.length : '—'}
            </p>
          </article>
        </section>

        <nav className="overflow-x-auto border-y-2 border-[#8b4444]" aria-label="Athlete workspace">
          <div className="flex min-w-max">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`min-h-[44px] border-r border-[#5a4a3a] px-4 text-xs font-bold uppercase tracking-[0.08em] transition ${
                  activeTab === tab.id
                    ? 'bg-[#8b4444] text-white'
                    : 'bg-[#111111] text-[#cfbfae] hover:bg-[#2a1414]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </nav>

        {activeTab === 'my-dashboard' ? (
          <div className="space-y-6">
            {renderConnectionState()}
            <section>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-[#d4a574]">
                    Recent session records
                  </p>
                  <p className="mt-1 text-sm text-[#cfbfae]">
                    Read-only history from the connected athlete account.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab('session-history')}
                  className="min-h-[40px] border-2 border-[#8b4444] bg-[#2a1414] px-4 text-xs font-bold uppercase tracking-[0.08em]"
                >
                  View sessions
                </button>
              </div>
              {renderSessions(3)}
            </section>
          </div>
        ) : null}

        {activeTab === 'session-history' ? (
          <section className="space-y-4">
            <div>
              <p className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-[#d4a574]">
                Session history
              </p>
              <h2 className="mt-1 text-2xl font-black">Recorded training sessions</h2>
              <p className="mt-2 text-sm text-[#cfbfae]">
                Readiness check-in is not used as session RPE. This surface only displays session
                records already saved by the supported session workflow.
              </p>
            </div>
            {renderSessions()}
          </section>
        ) : null}

        {activeTab === 'smart-goals' ? (
          <section className="space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-[#d4a574]">
                  Goals
                </p>
                <h2 className="mt-1 text-2xl font-black">Saved athlete goals</h2>
                <p className="mt-2 text-sm text-[#cfbfae]">
                  Goals appear only after the connected goal service returns them.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowGoalForm((current) => !current);
                  setGoalSaveStatus('');
                }}
                disabled={connectionStatus !== 'connected'}
                className="min-h-[42px] border-2 border-[#8b4444] bg-[#2a1414] px-4 text-xs font-bold uppercase tracking-[0.08em] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {showGoalForm ? 'Close form' : 'Create goal'}
              </button>
            </div>

            {showGoalForm ? (
              <div className="space-y-4 border-2 border-[#d4a574] bg-[#1a1a1a] p-5">
                <div>
                  <label htmlFor="athlete-goal-title" className="text-sm font-semibold">
                    Goal title
                  </label>
                  <input
                    id="athlete-goal-title"
                    value={newGoalTitle}
                    onChange={(event) => setNewGoalTitle(event.target.value)}
                    className="mt-2 w-full border-2 border-[#8b4444] bg-[#0f0f0f] px-3 py-2 text-[#e8d7c6]"
                  />
                </div>
                <div>
                  <label htmlFor="athlete-goal-date" className="text-sm font-semibold">
                    Target date
                  </label>
                  <input
                    id="athlete-goal-date"
                    type="date"
                    value={newGoalTargetDate}
                    onChange={(event) => setNewGoalTargetDate(event.target.value)}
                    className="mt-2 w-full border-2 border-[#8b4444] bg-[#0f0f0f] px-3 py-2 text-[#e8d7c6]"
                  />
                </div>
                <div>
                  <label htmlFor="athlete-goal-metric" className="text-sm font-semibold">
                    Measurable outcome
                  </label>
                  <input
                    id="athlete-goal-metric"
                    value={newGoalMetric}
                    onChange={(event) => setNewGoalMetric(event.target.value)}
                    className="mt-2 w-full border-2 border-[#8b4444] bg-[#0f0f0f] px-3 py-2 text-[#e8d7c6]"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void handleCreateGoal()}
                  disabled={goalSaving}
                  className="min-h-[42px] w-full bg-[#8b4444] px-4 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-60"
                >
                  {goalSaving ? 'Saving…' : 'Save goal'}
                </button>
              </div>
            ) : null}

            {goalSaveStatus ? (
              <p className="border border-[#694838] bg-[#14100d] p-3 text-sm text-[#d4a574]" role="status">
                {goalSaveStatus}
              </p>
            ) : null}

            {renderGoals()}
          </section>
        ) : null}

        {activeTab === 'athlete-floor' ? (
          <NotConnectedPanel title="Athlete floor">
            <p>
              Live coach-assigned floor tasks are not connected to this athlete dashboard yet. No
              workout is generated from readiness answers, and no sample task list is displayed.
            </p>
            <p>Ask a coach for today&apos;s assigned work until the task service is connected.</p>
          </NotConnectedPanel>
        ) : null}

        {activeTab === 'bio-checkin' ? (
          <NotConnectedPanel title="Biological check-in">
            <p>
              A validated check-in persistence flow is not connected here yet. This V1 does not
              classify readiness, prescribe training, treat readiness as RPE, or save pain details.
            </p>
            <p>
              Report pain or injury concerns directly to a coach or qualified healthcare
              professional. The app does not make medical or sparring-clearance decisions.
            </p>
          </NotConnectedPanel>
        ) : null}

        {activeTab === 'schedule-session' ? (
          <NotConnectedPanel title="Schedule">
            <p>
              This dashboard does not contain a verified class feed. Open the unified scheduler to
              see whatever live scheduling data is available there.
            </p>
            <Link
              href="/schedule"
              className="inline-flex min-h-[42px] items-center border-2 border-[#8b4444] bg-[#2a1414] px-4 text-xs font-bold uppercase tracking-[0.08em] text-[#e8d7c6]"
            >
              Open scheduler
            </Link>
          </NotConnectedPanel>
        ) : null}

        {activeTab === 'shadow' ? renderShadow() : null}

        {activeTab === 'tracks' ? (
          <NotConnectedPanel title="Track assignment">
            <p>
              A verified athlete track and membership feed is not connected to this dashboard.
              Track, rank, scholarship, and support status are not inferred or filled with sample
              values.
            </p>
          </NotConnectedPanel>
        ) : null}

        {activeTab === 'assessments' ? (
          <NotConnectedPanel title="Assessments">
            <p>
              No validated assessment workflow is connected on this surface. No assessment is
              marked available or complete without a supporting service.
            </p>
          </NotConnectedPanel>
        ) : null}

        {activeTab === 'drill-library' ? (
          <NotConnectedPanel title="Drill library">
            <p>
              A verified drill library and completion service is not connected here yet. This V1
              does not assign drills or claim that a drill was completed.
            </p>
          </NotConnectedPanel>
        ) : null}

        {activeTab === 'rabbit-holes' ? (
          <NotConnectedPanel title="Learning library">
            <p>
              Curated learning content is not connected to this athlete dashboard yet. Training
              instructions are not generated from unvalidated readiness data.
            </p>
          </NotConnectedPanel>
        ) : null}

        {activeTab === 'message-coach' ? (
          <NotConnectedPanel title="Coach messaging">
            <p>
              Coach messaging is not connected on this surface. This V1 does not claim that a
              message was sent, logged, or copied to another account.
            </p>
          </NotConnectedPanel>
        ) : null}
      </div>
    </main>
  );
}
