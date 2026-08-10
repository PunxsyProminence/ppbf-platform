'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { RosterAthlete } from './CoachRecognitionPad';
import { apiBase } from '@/lib/apiBase';

/**
 * PAIRING A MENTOR WITH A MENTEE.
 *
 * A roster is a list of names. A gym is a structure of people who look after
 * each other, and until this the platform could not represent the second one at
 * all — so the older athlete who quietly takes the new kid through the warm-up
 * every week was, to the system, indistinguishable from anybody else.
 *
 * A COACH MAKES THE PAIRING, not the athletes. Self-declared mentorship is a
 * status claim, and status claims between kids are exactly what the rest of
 * this system refuses to build.
 *
 * IT IS VISIBLE ON BOTH SIDES. The pairing shows on the mentor's screen and on
 * the mentee's, in their own words for each. That symmetry is the point: a
 * mentee who could only see up, or a mentor who could only see down, is half a
 * community structure.
 *
 * ENDING ONE IS NOT A JUDGEMENT. Closing a pairing writes an end date and
 * nothing else. There is no outcome field and no reason field in
 * pilot.mentorships, so this surface has nothing to say about why — people move
 * on, and last season's mentorship is still a true thing that happened.
 *
 * NO COUNTS. This lists pairings, not "mentors ranked by mentees". A tally of
 * how many people each athlete mentors is a leaderboard with a kinder name.
 */

interface MentorshipRow {
  mentorship_id: string;
  mentor_athlete_id: string;
  mentor_name: string;
  mentee_athlete_id: string;
  mentee_name: string;
  started_on: string;
  ended_on: string | null;
}

export interface CoachMentorshipPairingProps {
  /** Loaded once by the page and shared, so the roster is not fetched twice. */
  roster: readonly RosterAthlete[];
}

export default function CoachMentorshipPairing({ roster }: CoachMentorshipPairingProps) {
  const [mentorId, setMentorId] = useState('');
  const [menteeId, setMenteeId] = useState('');
  const [pairings, setPairings] = useState<MentorshipRow[]>([]);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  const named = useMemo(
    () => [...roster].sort((a, b) => (a.full_name ?? '').localeCompare(b.full_name ?? '')),
    [roster],
  );

  /* Pairings are read one athlete at a time, because that is the only read the
     API has — there is deliberately no "every mentorship in the gym" endpoint,
     since a whole-gym list is one `group by` away from a ranking. The mentor
     selected here is the athlete asked about. */
  const loadFor = useCallback(async (athleteId: string) => {
    if (!athleteId) {
      setPairings([]);
      return;
    }
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/achievements/mentorships?athlete_id=${encodeURIComponent(athleteId)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) throw new Error('unavailable');
      const body = (await response.json()) as { items?: MentorshipRow[] };
      setPairings(body.items ?? []);
    } catch {
      setPairings([]);
    }
  }, []);

  useEffect(() => {
    // Deferred behind an await so no state is set while the effect body runs.
    void (async () => {
      await loadFor(mentorId);
    })();
  }, [mentorId, loadFor]);

  const pair = useCallback(async () => {
    if (saving) return;
    if (!mentorId || !menteeId) {
      setMessage('Pick both people.');
      return;
    }
    if (mentorId === menteeId) {
      setMessage('Nobody mentors themselves.');
      return;
    }

    setSaving(true);
    setMessage('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/achievements/mentorships`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mentor_athlete_id: mentorId, mentee_athlete_id: menteeId }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setMessage(payload.error || 'That did not save.');
        return;
      }
      setMessage('Paired. Both of them can see it.');
      setMenteeId('');
      await loadFor(mentorId);
    } catch {
      setMessage('That did not save.');
    } finally {
      setSaving(false);
    }
  }, [mentorId, menteeId, saving, loadFor]);

  const close = useCallback(async (mentorshipId: string) => {
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/achievements/mentorships?mentorship_id=${encodeURIComponent(mentorshipId)}`,
        { method: 'DELETE', credentials: 'include' },
      );
      if (response.ok) {
        setMessage('Closed. It stays in the record as something that happened.');
        await loadFor(mentorId);
      }
    } catch {
      /* Silent: the pairing stays open, which is what the server still holds. */
    }
  }, [mentorId, loadFor]);

  return (
    <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]" aria-label="Mentorship pairing">
      <header>
        <h2 className="t-command text-[length:var(--t-lg)]">Who looks after whom</h2>
        <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
          Pair an older athlete with a newer one. Both of them see it on their own screen.
        </p>
      </header>

      <div className="mt-[var(--s4)] grid gap-[var(--s4)] md:grid-cols-2">
        <div className="field">
          <label htmlFor="mentor-select" className="t-label">Mentor</label>
          <select
            id="mentor-select"
            value={mentorId}
            onChange={(event) => setMentorId(event.target.value)}
            className="select input--kiosk"
          >
            <option value="">Pick somebody</option>
            {named.map((athlete) => (
              <option key={athlete.athlete_id} value={athlete.athlete_id}>
                {athlete.full_name || athlete.athlete_id}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="mentee-select" className="t-label">Looking after</label>
          <select
            id="mentee-select"
            value={menteeId}
            onChange={(event) => setMenteeId(event.target.value)}
            className="select input--kiosk"
          >
            <option value="">Pick somebody</option>
            {named
              .filter((athlete) => athlete.athlete_id !== mentorId)
              .map((athlete) => (
                <option key={athlete.athlete_id} value={athlete.athlete_id}>
                  {athlete.full_name || athlete.athlete_id}
                </option>
              ))}
          </select>
        </div>
      </div>

      <button
        type="button"
        onClick={() => void pair()}
        disabled={saving}
        className="btn btn--kiosk mt-[var(--s4)] disabled:opacity-60"
      >
        {saving ? 'Pairing...' : 'Pair them up'}
      </button>

      {message && (
        <p className="t-body mt-[var(--s3)] text-[color:var(--bone-200)]" role="status">{message}</p>
      )}

      {mentorId && (
        <div className="mt-[var(--s5)]">
          <h3 className="t-label">Already paired</h3>
          {pairings.length === 0 ? (
            <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">Nothing yet for this athlete.</p>
          ) : (
            <ul className="mt-[var(--s3)] space-y-[var(--s2)]" role="list">
              {pairings.map((row) => (
                <li
                  key={row.mentorship_id}
                  className="flex flex-wrap items-center justify-between gap-[var(--s3)] rounded-[var(--r-md)] border border-[color:rgba(212,175,74,.22)] bg-[rgba(0,0,0,.26)] px-[var(--s4)] py-[var(--s3)] text-[length:var(--t-sm)] text-[color:var(--bone-200)]"
                >
                  <span>
                    {row.mentor_name || row.mentor_athlete_id} looks after {row.mentee_name || row.mentee_athlete_id}
                    <span className="tcard-sub ml-[var(--s3)]">
                      {row.ended_on ? `until ${row.ended_on.slice(0, 10)}` : `since ${row.started_on.slice(0, 10)}`}
                    </span>
                  </span>
                  {!row.ended_on && (
                    <button
                      type="button"
                      onClick={() => void close(row.mentorship_id)}
                      className="btn btn--ghost min-h-[var(--tap)]"
                    >
                      Close it out
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
