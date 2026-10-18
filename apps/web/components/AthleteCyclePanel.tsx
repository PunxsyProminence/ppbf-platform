'use client';

import { useId, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { formatCalendarDay } from '@/lib/calendarDay';
import { gymDayIso } from '@/src/lib/gymTime';

// The athlete's private cycle card (OD-2026-10-17-023 item 4, "C: Now").
// Opt-in, the athlete's alone: it talks only to /api/pilot/athlete/cycle,
// which only the athlete reaches, and no other screen shows any of it. Dates
// only: nothing here works out a length, a phase or a prediction, and nothing
// changes training. Copy PROPOSED.
//
// CLOSED UNTIL TAPPED, EVERY TIME. "How I feel today" is the screen at the gym
// door, on a shared tablet, often with a coach beside the child. So the card
// shows one button, the same for every athlete whether or not they track
// anything, and reads nothing until the athlete opens it; leaving the tab or
// the page closes it again.

interface CycleView {
  opted_in: boolean;
  entries: Array<{ entry_id: string; period_started_on: string }>;
}

const PRIVATE_LINE = 'Only you can see this in the app: not your coaches, your parents or the gym TV. It never changes your training.';

/** The server's words, in a child's. */
function friendly(error: unknown): string {
  switch (error) {
    case 'day cannot be after today.': return "That day hasn't happened yet.";
    case 'Not found': return 'That date was already removed.';
    case 'Turn cycle tracking on first.': return 'Tracking is off. Turn it on to add a date.';
    default: return 'That was not saved. Try again.';
  }
}

export default function AthleteCyclePanel() {
  const headingId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<CycleView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [otherDay, setOtherDay] = useState('');
  const [confirmOff, setConfirmOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  const load = async () => {
    setLoadFailed(false);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/athlete/cycle`, { credentials: 'include' });
      if (!response.ok) throw new Error('read failed');
      setView((await response.json()) as CycleView);
    } catch {
      setLoadFailed(true);
    }
  };

  const toggle = () => {
    if (open) {
      setOpen(false);
      setView(null);
      setConfirmOff(false);
      setError('');
      setSaved('');
      return;
    }
    setOpen(true);
    void load();
  };

  const act = async (body: Record<string, unknown>, savedLine = '') => {
    if (busy) return;
    setBusy(true);
    setError('');
    setSaved('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/athlete/cycle`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(friendly(payload?.error));
        // What is on screen may be stale (changed on another device): read it again.
        await load();
        return;
      }
      setView(payload as CycleView);
      setOtherDay('');
      setConfirmOff(false);
      setSaved(savedLine);
      // The button pressed may be gone now; keep the place on the card.
      toggleRef.current?.focus();
    } catch {
      setError('That was not saved. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const today = gymDayIso() ?? undefined;

  return (
    <section className="space-y-[var(--s3)]" aria-labelledby={headingId}>
      <h3 className="t-label" id={headingId}>
        <button
          ref={toggleRef}
          type="button"
          className="btn btn--ghost"
          aria-expanded={open}
          onClick={toggle}
        >
          My cycle (private)
        </button>
      </h3>

      {open && (
        <>
          <p style={{ fontSize: 'var(--t-sm)', color: 'var(--bone-300)' }}>{PRIVATE_LINE}</p>

          {loadFailed && (
            <div className="flex items-center gap-[var(--s2)]">
              <p className="t-data" role="alert">That didn&apos;t load.</p>
              <button type="button" className="btn btn--ghost" onClick={() => void load()}>Try again</button>
            </div>
          )}

          {view && !view.opted_in && (
            <>
              <p className="t-data">You can track the days your period starts here, if you want to.</p>
              <button type="button" className="btn btn--kiosk" disabled={busy} onClick={() => void act({ action: 'turn_on' })}>
                Turn on
              </button>
            </>
          )}

          {view?.opted_in && (
            <>
              <button
                type="button"
                className="btn btn--kiosk"
                disabled={busy}
                onClick={() => void act({ action: 'add' }, today ? `Saved: ${formatCalendarDay(today)}.` : 'Saved.')}
              >
                My period started today
              </button>
              <div className="flex gap-[var(--s2)] items-end">
                <div className="space-y-[var(--s2)]">
                  <label className="t-label block" htmlFor="cycle-other-day">It started on another day</label>
                  <input
                    id="cycle-other-day"
                    type="date"
                    max={today}
                    value={otherDay}
                    onChange={(event) => setOtherDay(event.target.value)}
                    className="input input--kiosk"
                  />
                </div>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={busy || otherDay === ''}
                  onClick={() => void act({ action: 'add', day: otherDay }, `Saved: ${formatCalendarDay(otherDay)}.`)}
                >
                  Add that day
                </button>
              </div>

              {view.entries.length === 0 ? (
                <p className="t-data">No dates yet.</p>
              ) : (
                <ul className="space-y-[var(--s2)]" aria-label="Days your period started">
                  {view.entries.map((entry) => (
                    <li key={entry.entry_id} className="flex items-center gap-[var(--s3)]">
                      <span className="t-data">{formatCalendarDay(entry.period_started_on)}</span>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        disabled={busy}
                        aria-label={`Remove ${formatCalendarDay(entry.period_started_on)}`}
                        onClick={() => void act(
                          { action: 'remove', entry_id: entry.entry_id },
                          `Removed: ${formatCalendarDay(entry.period_started_on)}.`,
                        )}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {confirmOff ? (
                <div className="space-y-[var(--s2)]" role="group" aria-label="Turn off and delete all">
                  <p className="t-data">Turning this off deletes every date you logged.</p>
                  <div className="flex gap-[var(--s2)]">
                    <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void act({ action: 'turn_off' }, 'Turned off. Every date is deleted.')}>
                      Delete all and turn off
                    </button>
                    <button type="button" className="btn btn--ghost" onClick={() => { setConfirmOff(false); toggleRef.current?.focus(); }}>
                      Keep it on
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" className="btn btn--ghost" onClick={() => setConfirmOff(true)}>
                  Turn off and delete all
                </button>
              )}
            </>
          )}

          {saved !== '' && <p className="t-data" role="status">{saved}</p>}
          {error !== '' && <p className="t-data" role="alert">{error}</p>}
        </>
      )}
    </section>
  );
}
