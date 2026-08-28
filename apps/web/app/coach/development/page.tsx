'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';

/*
 * A coach's own development: what they are trying to get better at, and the
 * work they did about it.
 *
 * WHAT THIS PAGE IS NOT, and the omissions are the point.
 *
 * There is no progress bar, no percentage, no completion ratio, no score, no
 * level and no "development hours this year" total. The Coach Goals tab this
 * page replaces shipped with three hardcoded goals carrying progress bars
 * that read the same figures -- "68%", "45%" -- for every coach who logged
 * in, regardless of who they were. They were deleted as fake personal data,
 * and nothing here brings them back: how far along somebody is in their own
 * development is not a number this platform can compute, and a bar that moved
 * when a row was inserted would be measuring typing.
 *
 * NOTHING HERE IS A CREDENTIAL. Certifications, background checks, SafeSport
 * and CPR live in the credential record, are uploaded on /coach/credentials
 * and are verified by an administrator. What a coach writes here is
 * SELF-ENTERED AND UNVERIFIED. Logging "SafeSport refresher" is a note to
 * yourself; it clears you for nothing, and this page says so on screen rather
 * than leaving a coach to infer it. The two panels are deliberately
 * cross-linked so nobody has to guess which one is the real record.
 *
 * IT IS YOUR RECORD AND NOBODY ELSE'S. The route takes no account id, so
 * there is no version of this page that shows a colleague's goals. Whether a
 * head coach should be able to see their staff's development is a real
 * question that nobody has answered, and it is not answered here by accident.
 */

interface DevelopmentGoal {
  goal_id: string;
  title: string;
  development_focus: string;
  target_on: string | null;
  status: 'draft' | 'active' | 'completed' | 'cancelled';
  created_at: string;
  updated_at: string;
}

interface DevelopmentActivity {
  activity_id: string;
  goal_id: string | null;
  title: string;
  provider: string;
  occurred_on: string;
  duration_minutes: number | null;
  notes: string;
  created_at: string;
}

const STATUSES = ['draft', 'active', 'completed', 'cancelled'] as const;
type GoalStatus = (typeof STATUSES)[number];

/* The design system's four-rung ladder. A development goal's status is a
   personal planning state, not a safety state, so none of these wears a
   saturated safety rung: 'cancelled' is filed, not restricted -- a coach who
   stopped pursuing a goal is not a person who may not participate, and
   painting it like one is exactly the confusion the safeguarding red is
   reserved against. */
const STATUS_BADGE: Record<GoalStatus, { className: string; label: string }> = {
  draft: { className: 'badge--filed', label: 'Draft' },
  active: { className: 'badge--cleared', label: 'Working on it' },
  completed: { className: 'badge--monitor', label: 'Completed' },
  cancelled: { className: 'badge--filed', label: 'Cancelled' },
};

/* The reference list the Coach Development tab has carried since it was
   built. It is a PROMPT, not a curriculum and not a vocabulary: clicking one
   fills the title box in, and a coach can type anything else instead. Making
   these a database vocabulary would make this platform the author of a
   coaching syllabus it does not possess -- the same refusal the athlete
   development block makes about periodization taxonomies. */
const TOPIC_PROMPTS = [
  'Boxing Technique Instruction',
  'Youth Development Psychology',
  'Injury Prevention Basics',
  'Class Management Skills',
  'Adaptive Coaching',
] as const;

const EMPTY_GOAL_FORM = { title: '', development_focus: '', target_on: '', status: 'draft' as GoalStatus };
const EMPTY_ACTIVITY_FORM = {
  title: '', provider: '', occurred_on: '', duration_minutes: '', notes: '', goal_id: '',
};

type LoadState = 'loading' | 'loaded' | 'unavailable';

/** "3h 00m" / "45m" from whole minutes. Displayed as typed, never summed. */
function formatDuration(minutes: number | null): string | null {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return `${hours}h ${String(rest).padStart(2, '0')}m`;
}

export default function CoachDevelopmentPage() {
  const [goals, setGoals] = useState<DevelopmentGoal[]>([]);
  const [activities, setActivities] = useState<DevelopmentActivity[]>([]);
  const [state, setState] = useState<LoadState>('loading');

  const [goalForm, setGoalForm] = useState(EMPTY_GOAL_FORM);
  const [activityForm, setActivityForm] = useState(EMPTY_ACTIVITY_FORM);
  const [goalBusy, setGoalBusy] = useState(false);
  const [activityBusy, setActivityBusy] = useState(false);
  const [statusBusyId, setStatusBusyId] = useState<string | null>(null);

  const [message, setMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/development`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('development');
      const payload = (await response.json()) as {
        goals?: DevelopmentGoal[];
        activities?: DevelopmentActivity[];
      };
      setGoals(payload.goals ?? []);
      setActivities(payload.activities ?? []);
      setState('loaded');
    } catch {
      // A failed read is not an empty record. "You have no goals" is a
      // statement about a coach that this read did not establish, and a coach
      // who believed it would write down a goal they already had.
      setGoals([]);
      setActivities([]);
      setState('unavailable');
    }
  }, []);

  useEffect(() => {
    /* `load` is the same function the write paths call to read the record
       back, so it stays a useCallback rather than being inlined here. Its
       setState calls all happen after an awaited fetch, never synchronously
       in the effect body -- the rule cannot see through the callback, so it
       is suppressed the same way CoachWorkspace suppresses it for its own
       loaders. */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function submitGoal(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // A second click must not write a second goal. The guard is the busy flag
    // AND the disabled button, because a form can be submitted by keyboard
    // while a pointer is nowhere near the control.
    if (goalBusy) return;

    setGoalBusy(true);
    setMessage('');
    setErrorMessage('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/development`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'goal',
          title: goalForm.title,
          development_focus: goalForm.development_focus,
          target_on: goalForm.target_on || null,
          status: goalForm.status,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        // The server's own words. A goal refused for a blank focus must say
        // that, not "something went wrong".
        setErrorMessage(payload.error ?? 'That goal could not be saved.');
        return;
      }
      setGoalForm(EMPTY_GOAL_FORM);
      setMessage('Goal saved.');
      // Read it back from the server rather than pushing the local copy into
      // the list: what is on screen should be what was stored.
      await load();
    } catch {
      setErrorMessage('That goal could not be saved. Nothing was stored.');
    } finally {
      setGoalBusy(false);
    }
  }

  async function submitActivity(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (activityBusy) return;

    setActivityBusy(true);
    setMessage('');
    setErrorMessage('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/development`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'activity',
          title: activityForm.title,
          provider: activityForm.provider,
          occurred_on: activityForm.occurred_on,
          // Blank stays blank all the way down: the route reads '' as "not
          // recorded" and stores null, never a zero nobody typed.
          duration_minutes: activityForm.duration_minutes || null,
          notes: activityForm.notes,
          goal_id: activityForm.goal_id || null,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setErrorMessage(payload.error ?? 'That activity could not be saved.');
        return;
      }
      setActivityForm(EMPTY_ACTIVITY_FORM);
      setMessage('Recorded.');
      await load();
    } catch {
      setErrorMessage('That activity could not be saved. Nothing was stored.');
    } finally {
      setActivityBusy(false);
    }
  }

  async function setGoalStatus(goalId: string, status: GoalStatus) {
    if (statusBusyId) return;

    setStatusBusyId(goalId);
    setMessage('');
    setErrorMessage('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/development`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal_id: goalId, status }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setErrorMessage(payload.error ?? 'That change could not be saved.');
        return;
      }
      await load();
    } catch {
      setErrorMessage('That change could not be saved. Nothing was stored.');
    } finally {
      setStatusBusyId(null);
    }
  }

  const goalTitleById = new Map(goals.map((item) => [item.goal_id, item.title]));

  return (
    <RoleStandaloneView
      roleLabel="Coach Workspace"
      routeLabel="/coach/development"
      /* MATCHES THE ROUTE, which gates on STAFF_CREDENTIAL_ROLES. The page
         admitted only coach and admin, so staff, volunteers and organization
         admins could call the API that serves this feature and were redirected
         away from its only UI. This record is self-scoped -- the route takes
         no account id and answers about the caller -- so there is no reason
         for anyone with staff standing to be shut out of their own.

         'organization_admin' is absent because ClubRole, the client-side role
         vocabulary, has no such member -- the same reason /coach/credentials
         lists these exact four. An org admin can still reach the API. Closing
         that last gap means widening ClubRole, which is a change to a shared
         type this slice has no business making on the way past. */
      allowedRoles={['coach', 'admin', 'staff', 'volunteer']}
      room="office"
      showShellHeader={false}
    >
      <div className="space-y-[var(--s5)]">
        <header className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
          <p className="t-eyebrow">Coach Development</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-xl)]">Your Own Work</h1>
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
            What you are trying to get better at, in your own words, and the development work you
            actually did. The platform stores it and reads it back. It does not score it, rank it,
            grade it, or move it along on its own.
          </p>
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-400)]">
            This is your record and nobody else&apos;s — no other coach sees it. It is also not your
            certification record: what you write here is self-entered and confirms nothing.
            Certifications, background checks, SafeSport and CPR live on your credentials page, where
            an administrator verifies them.
          </p>
          <Link href="/coach/credentials" className="btn btn--ghost mt-[var(--s4)]">
            Your credentials
          </Link>
        </header>

        {state === 'unavailable' && (
          <div className="rounded-[var(--r-md)] border-2 border-[var(--restricted)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
            <p className="m-0 text-[length:var(--t-sm)] font-semibold text-[var(--restricted-ink)]">
              Your development record could not be read. This does not mean you have nothing recorded —
              nobody could look. Reload and try again before writing anything down twice.
            </p>
          </div>
        )}

        {message && <p className="t-body text-[color:var(--cleared-ink)]">{message}</p>}
        {errorMessage && (
          <div className="rounded-[var(--r-md)] border-2 border-[var(--restricted)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
            <p className="m-0 text-[length:var(--t-sm)] font-semibold text-[var(--restricted-ink)]">
              {errorMessage}
            </p>
          </div>
        )}

        <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
          <h2 className="t-eyebrow">A new goal</h2>

          <form onSubmit={submitGoal} className="space-y-[var(--s4)]">
            <div className="field">
              <label htmlFor="goalTitle" className="t-label">Title</label>
              <input
                id="goalTitle"
                value={goalForm.title}
                onChange={(event) => setGoalForm({ ...goalForm, title: event.target.value })}
                className="input"
                placeholder="Corner work under pressure"
              />
            </div>

            <div className="field">
              <label htmlFor="goalFocus" className="t-label">What you are trying to get better at</label>
              <textarea
                id="goalFocus"
                value={goalForm.development_focus}
                onChange={(event) => setGoalForm({ ...goalForm, development_focus: event.target.value })}
                rows={3}
                className="textarea"
                placeholder="In your own words. Nothing reinterprets this."
              />
            </div>

            <div className="grid gap-[var(--s4)] sm:grid-cols-2">
              <div className="field">
                <label htmlFor="goalTarget" className="t-label">Target date (optional)</label>
                <input
                  id="goalTarget"
                  type="date"
                  value={goalForm.target_on}
                  onChange={(event) => setGoalForm({ ...goalForm, target_on: event.target.value })}
                  className="input"
                />
                <p className="t-muted">
                  Leave it empty if there is no deadline. Plenty of real development has none.
                </p>
              </div>
              <div className="field">
                <label htmlFor="goalStatus" className="t-label">State</label>
                <select
                  id="goalStatus"
                  value={goalForm.status}
                  onChange={(event) => setGoalForm({
                    ...goalForm, status: event.target.value as GoalStatus,
                  })}
                  className="select"
                >
                  {STATUSES.map((status) => (
                    <option key={status} value={status}>{STATUS_BADGE[status].label}</option>
                  ))}
                </select>
              </div>
            </div>

            <button type="submit" className="btn" disabled={goalBusy}>
              {goalBusy ? 'Saving...' : 'Save goal'}
            </button>
          </form>
        </section>

        <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
          <h2 className="t-eyebrow">Your goals</h2>

          {state === 'loading' && <p className="t-muted">Loading your development record...</p>}

          {state === 'loaded' && goals.length === 0 && (
            <p className="t-body text-[color:var(--bone-300)]">
              You have not written down a development goal yet.
            </p>
          )}

          {state === 'loaded' && goals.map((item) => {
            /* Unguarded, this took the whole surface down rather than one row:
       an unrecognised status yields undefined and the next property
       read throws during render. The status union here is a private
       copy of the server's vocabulary, so a fifth state added
       server-side compiles clean and fails only at runtime. An
       unknown state is shown as unknown -- which is also the honest
       rendering of a value this page does not understand. */
    const badge = STATUS_BADGE[item.status]
      ?? { className: 'badge--filed', label: item.status || 'Unknown' };
            return (
              <article
                key={item.goal_id}
                className="rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)] space-y-[var(--s3)]"
              >
                <div className="flex flex-wrap items-center justify-between gap-[var(--s2)]">
                  <h3 className="t-body font-semibold">{item.title}</h3>
                  <span className={`badge ${badge.className}`}>{badge.label}</span>
                </div>

                <p className="t-body text-[color:var(--bone-300)]">{item.development_focus}</p>

                {/* Shown only when there is one. A goal with no deadline shows
                    no date line at all, rather than an empty field or a
                    stand-in date nobody chose. */}
                {item.target_on ? (
                  <p className="t-muted">Target date {item.target_on}</p>
                ) : null}

                <div className="flex flex-wrap gap-[var(--s2)]">
                  {STATUSES.filter((status) => status !== item.status).map((status) => (
                    <button
                      key={status}
                      type="button"
                      className="btn btn--ghost"
                      disabled={statusBusyId !== null}
                      onClick={() => void setGoalStatus(item.goal_id, status)}
                    >
                      {STATUS_BADGE[status].label}
                    </button>
                  ))}
                </div>
              </article>
            );
          })}
        </section>

        <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
          <h2 className="t-eyebrow">Record what you did</h2>

          <p className="t-body text-[color:var(--bone-400)]">
            A course, a clinic, a workshop, a topic you worked through, an afternoon watching somebody
            else&apos;s class. Self-entered: this records that you did it, and confirms nothing about
            it.
          </p>

          <form onSubmit={submitActivity} className="space-y-[var(--s4)]">
            <div className="field">
              <label htmlFor="activityTitle" className="t-label">What it was</label>
              <input
                id="activityTitle"
                value={activityForm.title}
                onChange={(event) => setActivityForm({ ...activityForm, title: event.target.value })}
                className="input"
                placeholder="Youth coaching clinic"
              />
              <div className="flex flex-wrap gap-[var(--s2)] mt-[var(--s2)]">
                {TOPIC_PROMPTS.map((topic) => (
                  <button
                    key={topic}
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setActivityForm({ ...activityForm, title: topic })}
                  >
                    {topic}
                  </button>
                ))}
              </div>
              <p className="t-muted">
                Those are prompts, not a syllabus — type anything else instead.
              </p>
            </div>

            <div className="grid gap-[var(--s4)] sm:grid-cols-2">
              <div className="field">
                <label htmlFor="activityDate" className="t-label">When it happened</label>
                <input
                  id="activityDate"
                  type="date"
                  value={activityForm.occurred_on}
                  onChange={(event) => setActivityForm({
                    ...activityForm, occurred_on: event.target.value,
                  })}
                  className="input"
                />
              </div>
              <div className="field">
                <label htmlFor="activityProvider" className="t-label">Who ran it (optional)</label>
                <input
                  id="activityProvider"
                  value={activityForm.provider}
                  onChange={(event) => setActivityForm({
                    ...activityForm, provider: event.target.value,
                  })}
                  className="input"
                  placeholder="USA Boxing"
                />
              </div>
            </div>

            <div className="grid gap-[var(--s4)] sm:grid-cols-2">
              <div className="field">
                <label htmlFor="activityMinutes" className="t-label">How long, in minutes (optional)</label>
                <input
                  id="activityMinutes"
                  type="number"
                  min={1}
                  step={1}
                  value={activityForm.duration_minutes}
                  onChange={(event) => setActivityForm({
                    ...activityForm, duration_minutes: event.target.value,
                  })}
                  className="input"
                />
                <p className="t-muted">
                  Nothing adds these up. A total built from self-entered rows would read like proof of
                  hours, and it would not be.
                </p>
              </div>
              <div className="field">
                <label htmlFor="activityGoal" className="t-label">Toward a goal (optional)</label>
                <select
                  id="activityGoal"
                  value={activityForm.goal_id}
                  onChange={(event) => setActivityForm({
                    ...activityForm, goal_id: event.target.value,
                  })}
                  className="select"
                  disabled={state !== 'loaded' || goals.length === 0}
                >
                  <option value="">Not toward a particular goal</option>
                  {goals.map((item) => (
                    <option key={item.goal_id} value={item.goal_id}>{item.title}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="field">
              <label htmlFor="activityNotes" className="t-label">Notes (optional)</label>
              <textarea
                id="activityNotes"
                value={activityForm.notes}
                onChange={(event) => setActivityForm({ ...activityForm, notes: event.target.value })}
                rows={2}
                className="textarea"
              />
            </div>

            <button type="submit" className="btn" disabled={activityBusy}>
              {activityBusy ? 'Saving...' : 'Record it'}
            </button>
          </form>
        </section>

        <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
          <h2 className="t-eyebrow">What you have done</h2>

          {state === 'loading' && <p className="t-muted">Loading your development record...</p>}

          {state === 'loaded' && activities.length === 0 && (
            <p className="t-body text-[color:var(--bone-300)]">
              You have not recorded any development work yet.
            </p>
          )}

          {state === 'loaded' && activities.map((item) => {
            const duration = formatDuration(item.duration_minutes);
            const goalTitle = item.goal_id ? goalTitleById.get(item.goal_id) : undefined;
            /* Every optional part is present only when it was recorded. A row
               with no provider and no duration renders one clean line, never
               "Provider: " with nothing after it and never the word null. */
            const detail = [
              item.occurred_on,
              item.provider || null,
              duration,
              goalTitle ? `Toward: ${goalTitle}` : null,
            ].filter(Boolean).join(' · ');
            return (
              <article
                key={item.activity_id}
                className="rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)] space-y-[var(--s2)]"
              >
                <h3 className="t-body font-semibold">{item.title}</h3>
                <p className="t-muted">{detail}</p>
                {item.notes ? (
                  <p className="t-body text-[color:var(--bone-300)]">{item.notes}</p>
                ) : null}
              </article>
            );
          })}
        </section>
      </div>
    </RoleStandaloneView>
  );
}
