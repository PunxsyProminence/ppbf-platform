'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import { formatGymDay } from '@/src/lib/gymTime';
import BackHome from '@/components/BackHome';

/*
 * ONE athlete's Passbook, for staff (work order N7-01).
 *
 * A coach picks an athlete from the athletes they may act on
 * (/api/pilot/coach/athletes, the same picker /coach/assessments uses) and
 * reads that one book from GET /api/pilot/passbook?athlete_id=. The endpoint
 * takes exactly one athlete and runs assertActorCanAccessAthlete on it; this
 * page never asks for more than one book, and there is no gym-wide view.
 *
 * What is shown is what the server returned, with two deliberate omissions:
 * account identifiers (coach_id, coach_account_id) and date of birth are not
 * rendered, because nothing on this page needs them. Gap wording is rendered
 * as sent: the server gives family readers the family wording
 * (getAthletePassbook), and this page is staff-only.
 *
 * ?athlete_id= in the address opens that athlete's book only when the id is
 * on the coach's own roster; anything else is ignored, not fetched.
 */

interface AuthorizedAthlete {
  athlete_id: string;
  full_name: string;
}

interface Passbook {
  athlete: { athlete_id: string; full_name: string; weight_class: string; gym_status: string };
  pages: {
    attendance: Array<{ attendance_id: string; attendance_date: string; status: string; stamp_code: string | null; notes?: string }>;
    sessions: Array<{ session_id: string; date: string; rpe: number | null; notes?: string; completed_flag: boolean }>;
    readiness: Array<{ readiness_id: string; score: number; category: string; measured_at: string }>;
    // An own-words goal (achievements.ts createPersonalGoal) has an empty metric
    // and may have no target date.
    goals: Array<{ goal_id: string; title: string; target_date: string | null; metric: string; status: string }>;
    corner: {
      guardians: Array<{ parent_id: string; full_name: string; relationship_to_athlete: string }>;
      observations: Array<{ note_id: string; note_type: string; note_text: string; created_at: string }>;
    };
    progression_gaps: Array<{
      gap_id: string;
      gap_type: string;
      gap_description: string;
      severity: string;
      status: string;
      created_at: string;
    }>;
  };
}

type BookState = 'idle' | 'loading' | 'loaded' | 'refused' | 'missing' | 'unavailable';

const humanize = (value: string) => value.replace(/_/g, ' ');
const day = (value: string) => formatGymDay(value) ?? value;

function Page({ title, empty, children }: { title: string; empty: boolean; children: React.ReactNode }) {
  return (
    <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s3)]">
      <h2 className="t-eyebrow">{title}</h2>
      {empty ? <p className="t-body text-[color:var(--bone-300)]">Nothing recorded.</p> : children}
    </section>
  );
}

export default function CoachPassbookPage() {
  const [athletes, setAthletes] = useState<AuthorizedAthlete[]>([]);
  const [rosterState, setRosterState] = useState<'loading' | 'loaded' | 'unavailable'>('loading');
  const [athleteId, setAthleteId] = useState('');
  const [book, setBook] = useState<Passbook | null>(null);
  const [bookState, setBookState] = useState<BookState>('idle');

  // The latest selection. A response to any earlier one (a slow load for an
  // athlete the coach has since switched away from, or an older request for
  // the same athlete) is dropped, so one athlete's book never renders under
  // another's name and a late failure never hides a newer book.
  const latestRequest = useRef(0);

  const selectAthlete = useCallback(async (id: string) => {
    const request = ++latestRequest.current;
    const stale = () => latestRequest.current !== request;
    setAthleteId(id);
    setBook(null);
    if (!id) {
      setBookState('idle');
      return;
    }
    setBookState('loading');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/passbook?athlete_id=${encodeURIComponent(id)}`, {
        method: 'GET',
        credentials: 'include',
      });
      if (stale()) return;
      if (response.status === 403) {
        setBookState('refused');
        return;
      }
      if (response.status === 404) {
        setBookState('missing');
        return;
      }
      if (!response.ok) throw new Error('passbook');
      const payload = (await response.json()) as { passbook?: Passbook };
      if (stale()) return;
      // A book for a different athlete than the one asked for is not shown.
      if (!payload.passbook?.pages || payload.passbook.athlete?.athlete_id !== id) throw new Error('passbook');
      setBook(payload.passbook);
      setBookState('loaded');
    } catch {
      if (stale()) return;
      setBookState('unavailable');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/coach/athletes`, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('roster');
        const items = ((await response.json()) as { items?: AuthorizedAthlete[] }).items ?? [];
        setAthletes(items);
        setRosterState('loaded');
        const wanted = new URLSearchParams(window.location.search).get('athlete_id') ?? '';
        if (wanted && items.some((a) => a.athlete_id === wanted)) void selectAthlete(wanted);
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return;
        setAthletes([]);
        setRosterState('unavailable');
      }
    })();
    return () => controller.abort();
  }, [selectAthlete]);

  const pages = book?.pages;

  return (
    <RoleStandaloneView
      roleLabel="Coach Workspace"
      routeLabel="/coach/passbook"
      allowedRoles={['coach', 'admin']}
      room="floor"
      showShellHeader={false}
    >
      <div className="space-y-[var(--s5)]">
        <header className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
          <p className="t-eyebrow">Records</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-xl)]">Passbook</h1>
          <div className="mt-[var(--s3)]"><BackHome /></div>
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
            One athlete&apos;s book: attendance, sessions, readiness, goals, their corner and progression gaps.
          </p>
        </header>

        <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
          <div className="field">
            <label htmlFor="passbookAthlete" className="t-label">Which athlete</label>
            <select
              id="passbookAthlete"
              value={athleteId}
              onChange={(event) => void selectAthlete(event.target.value)}
              disabled={rosterState !== 'loaded' || athletes.length === 0}
              className="select"
            >
              <option value="">{rosterState === 'loading' ? 'Loading your athletes...' : 'Choose an athlete'}</option>
              {athletes.map((item) => (
                <option key={item.athlete_id} value={item.athlete_id}>{item.full_name}</option>
              ))}
            </select>
          </div>
          {rosterState === 'unavailable' && (
            <p role="alert" className="t-body text-[color:var(--restricted-ink)]">
              Your athletes could not be loaded. This is not a statement that you have none — reload and try again.
            </p>
          )}
          {rosterState === 'loaded' && athletes.length === 0 && (
            <p className="t-body text-[color:var(--bone-300)]">No athletes are available to choose.</p>
          )}
          {bookState === 'loading' && <p className="t-body">Loading…</p>}
          {bookState === 'refused' && (
            <p role="alert" className="t-body text-[color:var(--restricted-ink)]">
              You do not have access to this athlete&apos;s passbook.
            </p>
          )}
          {bookState === 'missing' && (
            <p className="t-body text-[color:var(--bone-300)]">No passbook was found for this athlete.</p>
          )}
          {bookState === 'unavailable' && (
            <p role="alert" className="t-body text-[color:var(--restricted-ink)]">
              This passbook could not be loaded. Reload and try again.
            </p>
          )}
        </section>

        {book && pages && bookState === 'loaded' && (
          <>
            <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
              <h2 className="t-command text-[length:var(--t-lg)]">{book.athlete.full_name}</h2>
              <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
                {book.athlete.weight_class || 'No weight class recorded'} · {humanize(book.athlete.gym_status)}
              </p>
            </section>

            <Page title="Attendance" empty={pages.attendance.length === 0}>
              <ul className="space-y-[var(--s1)]">
                {pages.attendance.map((a) => (
                  <li key={a.attendance_id}>
                    {day(a.attendance_date)}: <span className="font-semibold">{a.stamp_code ?? a.status}</span>
                    {a.notes ? <span className="text-[color:var(--bone-300)]"> — {a.notes}</span> : null}
                  </li>
                ))}
              </ul>
            </Page>

            <Page title="Sessions" empty={pages.sessions.length === 0}>
              <ul className="space-y-[var(--s1)]">
                {pages.sessions.map((s) => (
                  <li key={s.session_id}>
                    {day(s.date)}: {s.completed_flag ? 'completed' : 'not completed'} ·{' '}
                    {s.rpe === null ? 'RPE not recorded' : `RPE ${s.rpe}`}
                    {s.notes ? <span className="text-[color:var(--bone-300)]"> — {s.notes}</span> : null}
                  </li>
                ))}
              </ul>
            </Page>

            <Page title="Readiness" empty={pages.readiness.length === 0}>
              <ul className="space-y-[var(--s1)]">
                {pages.readiness.map((r) => (
                  <li key={r.readiness_id}>
                    {day(r.measured_at)}: <span className="font-semibold">{r.score}</span> {humanize(r.category)}
                  </li>
                ))}
              </ul>
            </Page>

            <Page title="Goals" empty={pages.goals.length === 0}>
              <ul className="space-y-[var(--s1)]">
                {pages.goals.map((g) => (
                  <li key={g.goal_id}>
                    <span className="font-semibold">{g.title}</span>
                    {g.metric ? ` · ${g.metric}` : ''}
                    {g.target_date ? ` · by ${day(g.target_date)}` : ' · no target date'} · {humanize(g.status)}
                  </li>
                ))}
              </ul>
            </Page>

            <Page
              title="Corner"
              empty={pages.corner.guardians.length === 0 && pages.corner.observations.length === 0}
            >
              {pages.corner.guardians.length > 0 && (
                <ul className="space-y-[var(--s1)]">
                  {pages.corner.guardians.map((g) => (
                    <li key={g.parent_id}>{g.full_name} ({humanize(g.relationship_to_athlete)})</li>
                  ))}
                </ul>
              )}
              {pages.corner.observations.length > 0 && (
                <ul className="space-y-[var(--s2)]">
                  {pages.corner.observations.map((o) => (
                    <li key={o.note_id}>
                      <span className="t-label">{humanize(o.note_type)} · {day(o.created_at)}</span>
                      <span className="block">{o.note_text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Page>

            <Page title="Progression gaps" empty={pages.progression_gaps.length === 0}>
              <ul className="space-y-[var(--s2)]">
                {pages.progression_gaps.map((g) => (
                  <li key={g.gap_id}>
                    <span className="font-semibold">{humanize(g.gap_type)}</span> — {g.gap_description}
                    <span className="block text-[length:var(--t-sm)] text-[color:var(--bone-300)]">
                      {g.severity} · {humanize(g.status)} · opened {day(g.created_at)}
                    </span>
                  </li>
                ))}
              </ul>
            </Page>
          </>
        )}
      </div>
    </RoleStandaloneView>
  );
}
