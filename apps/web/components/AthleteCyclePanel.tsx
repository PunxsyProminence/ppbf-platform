'use client';

import { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { formatCalendarDay } from '@/lib/calendarDay';

// The athlete's private cycle card (OD-2026-10-17-023 item 4, "C: Now").
// Opt-in, the athlete's alone: it talks only to /api/pilot/athlete/cycle,
// which only the athlete reaches, and no other screen shows any of it. Dates
// only: nothing here works out a length, a phase or a prediction, and nothing
// changes training. Copy PROPOSED.

interface CycleView {
  opted_in: boolean;
  entries: Array<{ entry_id: string; period_started_on: string }>;
}

const PRIVATE_LINE = 'Only you can see this in the app: not your coaches, your parents or the gym TV. It never changes your training.';

export default function AthleteCyclePanel() {
  const [view, setView] = useState<CycleView | null>(null);
  const [otherDay, setOtherDay] = useState('');
  const [confirmOff, setConfirmOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const response = await fetch(`${apiBase()}/api/pilot/athlete/cycle`, { credentials: 'include' }).catch(() => null);
      if (!response?.ok || cancelled) return;
      setView((await response.json()) as CycleView);
    })();
    return () => { cancelled = true; };
  }, []);

  if (!view) return null;

  const act = async (body: Record<string, unknown>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/athlete/cycle`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof payload?.error === 'string' ? payload.error : 'That was not saved. Try again.');
        return;
      }
      setView(payload as CycleView);
      setOtherDay('');
      setConfirmOff(false);
    } catch {
      setError('That was not saved. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-[var(--s3)]" aria-label="My cycle (private)">
      <h3 className="t-label">My cycle (private)</h3>
      <p style={{ fontSize: 'var(--t-sm)', color: 'var(--bone-300)' }}>{PRIVATE_LINE}</p>

      {!view.opted_in ? (
        <>
          <p className="t-data">You can track the days your period starts here, if you want to.</p>
          <button type="button" className="btn btn--kiosk" disabled={busy} onClick={() => void act({ action: 'turn_on' })}>
            Turn on
          </button>
        </>
      ) : (
        <>
          <button type="button" className="btn btn--kiosk" disabled={busy} onClick={() => void act({ action: 'add' })}>
            My period started today
          </button>
          <div className="flex gap-[var(--s2)] items-end">
            <div className="space-y-[var(--s2)]">
              <label className="t-label block" htmlFor="cycle-other-day">It started on another day</label>
              <input
                id="cycle-other-day"
                type="date"
                value={otherDay}
                onChange={(event) => setOtherDay(event.target.value)}
                className="input input--kiosk"
              />
            </div>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy || otherDay === ''}
              onClick={() => void act({ action: 'add', day: otherDay })}
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
                    onClick={() => void act({ action: 'remove', entry_id: entry.entry_id })}
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
                <button type="button" className="btn btn--kiosk" disabled={busy} onClick={() => void act({ action: 'turn_off' })}>
                  Delete all and turn off
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => setConfirmOff(false)}>
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

      {error !== '' && <p className="t-data" role="alert">{error}</p>}
    </section>
  );
}
