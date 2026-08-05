'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import useGymSound from './useGymSound';
import { apiBase } from '@/lib/apiBase';
import { RECOGNITION_NOTE_MAX, RECOGNITION_PHRASES } from '@/src/shared/achievementPaths';

/**
 * THE PAD — a coach telling an athlete they did well, in about eight seconds.
 *
 * This is the single largest thing the platform did not have. Every existing
 * coach-to-athlete write is a gap, a drill assignment, a review decision or a
 * restriction. There was no path at all for "that was the best round you've had"
 * to reach the person it was about.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS TWO TAPS AND NOT A FORM
 * ---------------------------------------------------------------------------
 *
 * A coach on the floor has taped hands, forty seconds between rounds, and a
 * tablet on a shelf. A form with a dropdown, a text area and a Send button is a
 * feature that exists in the codebase and never once gets used, because the
 * moment it is describing is already over by the time the keyboard opens.
 *
 * So: TAP THE NAME, TAP THE SENTENCE, IT IS SENT. There is no Send button, no
 * confirmation step, and no required typing anywhere in the path. The optional
 * note is behind a toggle that a coach who is in a hurry never opens.
 *
 * The ten sentences are whole sentences rather than tags, because what lands on
 * the athlete's screen has to read like something a person said. A system that
 * composes "RECOGNITION: TEAMWORK" out of fields has thrown away the only thing
 * that made it worth sending.
 *
 * ---------------------------------------------------------------------------
 * THE ROSTER IS DELIBERATELY DULL
 * ---------------------------------------------------------------------------
 *
 * Names, alphabetical, and nothing else. No count of how many each athlete has
 * received, no "last recognized" date, no sort by anything, no "these three
 * have not had one lately" prompt. Every one of those turns this list into a
 * scoreboard — first for the coach, and then, once a kid glances at the tablet,
 * for the kids. A visible ranking is how you find out which child is at the
 * bottom of it, and a child at the bottom of a visible list is a child who
 * quits. The absence of those numbers is the feature.
 *
 * ---------------------------------------------------------------------------
 * IT CANNOT BE USED THE OTHER WAY
 * ---------------------------------------------------------------------------
 *
 * There is no negative sentence to pick, because the vocabulary shipped in
 * achievementPaths.ts contains none and pilot.recognitions' check constraint
 * would refuse one anyway. There is no severity, no rating, no private-to-staff
 * option, and no delete. The athlete reads every row that is written about
 * them, which is the property that stops a record of good things quietly
 * becoming a file kept on somebody.
 */

export interface RosterAthlete {
  athlete_id: string;
  full_name?: string;
}

type SendState =
  | { kind: 'idle' }
  | { kind: 'sending'; athleteId: string }
  | { kind: 'sent'; athleteId: string; name: string; said: string }
  | { kind: 'failed'; message: string };

export default function CoachRecognitionPad() {
  const [roster, setRoster] = useState<RosterAthlete[]>([]);
  const [rosterState, setRosterState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [send, setSend] = useState<SendState>({ kind: 'idle' });

  // Held in a ref as well as state: a second tap lands before React has
  // re-rendered the disabled button, and two identical recognitions a second
  // apart read as a glitch on the athlete's wall.
  const sendingRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/athletes/list`, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('unavailable');
        const body = (await response.json()) as { items?: RosterAthlete[] };
        if (controller.signal.aborted) return;
        setRoster(body.items ?? []);
        setRosterState('ready');
      } catch {
        if (controller.signal.aborted) return;
        setRosterState('unavailable');
      }
    })();
    return () => controller.abort();
  }, []);

  /* Alphabetical, and only alphabetical. Sorting by anything else -- most
     recent, fewest received, most active -- is the first step to a ranking, and
     a ranking is the thing this surface must never grow. */
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return [...roster]
      .sort((a, b) => (a.full_name ?? '').localeCompare(b.full_name ?? ''))
      .filter((athlete) => !needle || (athlete.full_name ?? '').toLowerCase().includes(needle));
  }, [roster, filter]);

  const selected = shown.find((athlete) => athlete.athlete_id === selectedId)
    ?? roster.find((athlete) => athlete.athlete_id === selectedId)
    ?? null;

  const { play } = useGymSound();

  const sendRecognition = useCallback(async (kind: string, said: string) => {
    if (!selected || sendingRef.current) return;

    sendingRef.current = true;
    setSend({ kind: 'sending', athleteId: selected.athlete_id });

    try {
      const response = await fetch(`${apiBase()}/api/pilot/achievements/recognition`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          athlete_id: selected.athlete_id,
          kind,
          note: note.trim(),
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setSend({ kind: 'failed', message: payload.error || 'That did not send. Try it again.' });
        return;
      }

      /* The stamp, not the bell: the bell belongs to the athlete earning
         something. play() is safe unconditionally -- silent when sound is off,
         which is the default on every floor tablet, and the line of type below
         carries the whole message on its own. */
      play('stamp');
      setSend({
        kind: 'sent',
        athleteId: selected.athlete_id,
        name: selected.full_name ?? 'them',
        said,
      });
      setNote('');
      setShowNote(false);
      // Cleared so the next thing a coach does is pick the next athlete rather
      // than accidentally send a second one to the same person.
      setSelectedId(null);
    } catch {
      setSend({ kind: 'failed', message: 'That did not send. Try it again.' });
    } finally {
      sendingRef.current = false;
    }
  }, [selected, note, play]);

  return (
    <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]" aria-label="Send recognition">
      <header>
        <h2 className="t-command text-[length:var(--t-lg)]">Caught someone being good</h2>
        <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
          Tap the name, tap the sentence. It is sent. Nothing else is required.
        </p>
      </header>

      {send.kind === 'sent' && (
        <p
          role="status"
          className="mt-[var(--s4)] rounded-[var(--r-md)] border-2 border-[color:var(--cleared)] bg-[rgba(0,0,0,.28)] px-[var(--s4)] py-[var(--s3)] text-[length:var(--t-sm)] font-semibold text-[color:var(--cleared-ink)]"
        >
          <span aria-hidden="true">✓ </span>
          Sent to {send.name}: “{send.said}”
        </p>
      )}

      {send.kind === 'failed' && (
        <p
          role="alert"
          className="mt-[var(--s4)] rounded-[var(--r-md)] border-2 border-[color:var(--locked)] bg-[rgba(0,0,0,.28)] px-[var(--s4)] py-[var(--s3)] text-[length:var(--t-sm)] font-semibold text-[color:var(--locked-ink)]"
        >
          {send.message}
        </p>
      )}

      {rosterState === 'unavailable' && (
        <p className="t-body mt-[var(--s4)] text-[color:var(--bone-300)]">
          Your roster did not load, so there is nobody to pick. That is a connection problem.
        </p>
      )}

      {/* STEP ONE — the name. */}
      <div className="mt-[var(--s5)]">
        <label htmlFor="recognition-filter" className="t-label">Who</label>
        <input
          id="recognition-filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="input input--kiosk mt-[var(--s2)]"
          placeholder="Start typing a name"
          autoComplete="off"
        />

        <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s2)]">
          {rosterState === 'loading' && (
            <span className="working">Loading the roster...</span>
          )}

          {/* Names only. No counts, no dates, no ordering by anything but the
              alphabet -- see the header note on why that absence is the
              feature. */}
          {shown.map((athlete) => {
            const chosen = athlete.athlete_id === selectedId;
            return (
              <button
                key={athlete.athlete_id}
                type="button"
                aria-pressed={chosen}
                onClick={() => setSelectedId(chosen ? null : athlete.athlete_id)}
                className={
                  'inline-flex min-h-[var(--tap)] items-center rounded-[var(--r-md)] border-2 px-[var(--s4)] text-[length:var(--t-md)] font-semibold transition focus-visible:outline-none focus-visible:shadow-[var(--focus)] '
                  + (chosen
                    ? 'border-[color:var(--brass-600)] bg-[var(--brass-500)] text-[color:var(--hide-950)]'
                    : 'border-[color:rgba(212,175,74,.28)] bg-[rgba(0,0,0,.26)] text-[color:var(--bone-200)]')
                }
              >
                {athlete.full_name || athlete.athlete_id}
              </button>
            );
          })}

          {rosterState === 'ready' && shown.length === 0 && (
            <p className="t-body text-[color:var(--bone-300)]">Nobody matches that.</p>
          )}
        </div>
      </div>

      {/* STEP TWO — the sentence. Tapping one SENDS. There is no third step. */}
      {selected && (
        <div className="mt-[var(--s5)]">
          <h3 className="t-label">
            What {selected.full_name || 'they'} did
          </h3>
          <p className="tcard-sub mt-[var(--s2)]">
            Tapping one sends it. They will see it on their own screen, signed with your name.
          </p>

          <div className="mt-[var(--s3)] grid gap-[var(--s3)] md:grid-cols-2">
            {RECOGNITION_PHRASES.map((phrase) => (
              <button
                key={phrase.kind}
                type="button"
                disabled={send.kind === 'sending'}
                onClick={() => void sendRecognition(phrase.kind, phrase.said)}
                title={phrase.said}
                className="inline-flex min-h-[var(--tap)] items-center rounded-[var(--r-md)] border-2 border-[color:var(--brass-700)] bg-[rgba(0,0,0,.3)] px-[var(--s4)] py-[var(--s3)] text-left text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)] transition hover:border-[color:var(--brass-400)] focus-visible:outline-none focus-visible:shadow-[var(--focus)] disabled:opacity-60"
              >
                {phrase.button}
              </button>
            ))}
          </div>

          {/* Optional, and behind a toggle so it is never in the way of the two
              taps. A coach in a hurry never opens it. */}
          <div className="mt-[var(--s4)]">
            {!showNote ? (
              <button
                type="button"
                onClick={() => setShowNote(true)}
                className="btn btn--ghost min-h-[var(--tap)]"
              >
                Add a word (optional)
              </button>
            ) : (
              <div>
                <label htmlFor="recognition-note" className="t-label">
                  In your own words — optional, one line
                </label>
                <input
                  id="recognition-note"
                  value={note}
                  maxLength={RECOGNITION_NOTE_MAX}
                  onChange={(event) => setNote(event.target.value)}
                  className="input input--kiosk mt-[var(--s2)]"
                  placeholder="Best round you've had, kid."
                />
                <p className="tcard-sub mt-[var(--s2)]">
                  Goes with whichever sentence you tap. {RECOGNITION_NOTE_MAX} characters — it is a
                  sentence, not a report.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
