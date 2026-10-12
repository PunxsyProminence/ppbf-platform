'use client';

import { useCallback, useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import type { RoundTimerView } from '@/src/server/pilot/roundTimers';

// The coach's round timer controls for a live run (WO-N1-03). Every change is one named action on
// /api/pilot/session-scripts/runs/[runId]/timer, and the timer the server answers with is what the
// screen shows. THE SERVER OWNS THE CLOCK: between reads the seconds left tick down for display
// only, and a read every few seconds (and whenever a period runs out) puts the screen back on the
// server's reading -- which is also how a second screen of the same coach stays in step.
//
// The timer starts only when the coach presses Start (N1-03-Q1 A). Setting the rounds never starts
// it.

const REFRESH_MS = 10_000;

const PHASE_WORD: Record<RoundTimerView['phase'], string> = {
  ready: 'Ready',
  work: 'Work',
  rest: 'Rest',
  done: 'All rounds done',
  ended: 'Ended',
};

type Load = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; timer: RoundTimerView | null };

function clock(totalSeconds: number): string {
  const seconds = Math.max(0, totalSeconds);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function wholeNumber(text: string): number | null {
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;
}

export default function RoundTimerControls({ runId }: { readonly runId: string }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [roundSeconds, setRoundSeconds] = useState('180');
  const [restSeconds, setRestSeconds] = useState('60');
  const [roundsTotal, setRoundsTotal] = useState('3');

  const url = `${apiBase()}/api/pilot/session-scripts/runs/${encodeURIComponent(runId)}/timer`;

  const show = useCallback((timer: RoundTimerView | null) => {
    setLoad({ state: 'ready', timer });
    setSecondsLeft(timer?.seconds_left ?? 0);
  }, []);

  const read = useCallback(async () => {
    try {
      const response = await fetch(url, { credentials: 'include', cache: 'no-store' });
      const payload = (await response.json().catch(() => null)) as { timer?: RoundTimerView | null } | null;
      if (!response.ok || !payload || !('timer' in payload)) {
        setLoad((current) => (current.state === 'ready' ? current : { state: 'failed' }));
        return;
      }
      show(payload.timer ?? null);
    } catch {
      setLoad((current) => (current.state === 'ready' ? current : { state: 'failed' }));
    }
  }, [show, url]);

  // No state is set before read's first await (the convention SessionScriptLiveDelivery follows).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void read();
    const id = setInterval(() => void read(), REFRESH_MS);
    return () => clearInterval(id);
  }, [read]);

  const timer = load.state === 'ready' ? load.timer : null;
  const counting = timer?.state === 'running' && (timer.phase === 'work' || timer.phase === 'rest');

  // Display tick only. When a period runs out the server is asked what comes next.
  useEffect(() => {
    if (!counting) return;
    const id = setInterval(() => {
      setSecondsLeft((seconds) => {
        if (seconds <= 1) {
          void read();
          return 0;
        }
        return seconds - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [counting, read]);

  async function send(body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as { timer?: RoundTimerView; error?: string };
      if (!response.ok || !payload.timer) {
        setError(`The server refused: ${payload.error ?? `HTTP ${response.status}`}`);
        return;
      }
      show(payload.timer);
    } catch {
      setError('Network error -- nothing was changed on the server.');
    } finally {
      setBusy(false);
    }
  }

  function configure() {
    const round = wholeNumber(roundSeconds);
    const rest = wholeNumber(restSeconds);
    const rounds = wholeNumber(roundsTotal);
    if (round === null || rest === null || rounds === null) {
      setError('Round, rest and rounds must be whole numbers.');
      return;
    }
    void send({ action: 'configure', round_seconds: round, rest_seconds: rest, rounds_total: rounds });
  }

  const canConfigure = load.state === 'ready' && (!timer || timer.state === 'ready' || timer.state === 'ended');

  return (
    <section aria-label="Round timer" className="mt-[var(--s4)] rounded-[var(--r-md)] border-2 border-[var(--bone-700)] px-[var(--s4)] py-[var(--s3)]">
      <h3 className="t-eyebrow text-[color:var(--bone-300)]">Round timer</h3>

      {load.state === 'loading' && <p className="t-body text-[color:var(--bone-300)]">Loading the round timer...</p>}
      {load.state === 'failed' && <p className="t-body text-[color:var(--bone-300)]">The round timer could not be loaded.</p>}

      {load.state === 'ready' && timer && (
        <p aria-label="Round timer status" className="font-mono text-[length:var(--t-xl)] font-black text-[color:var(--bone-100)]">
          {timer.round > 0 ? `Round ${timer.round} of ${timer.rounds_total} · ` : ''}
          {PHASE_WORD[timer.phase]}
          {counting ? ` · ${clock(secondsLeft)} left` : ''}
          {timer.is_paused ? ` · Paused at ${clock(secondsLeft)}` : ''}
        </p>
      )}
      {load.state === 'ready' && !timer && <p className="t-body text-[color:var(--bone-300)]">No rounds set for this session.</p>}

      {canConfigure && (
        <div className="mt-[var(--s2)] flex flex-wrap items-end gap-[var(--s3)]">
          <label className="t-data flex flex-col">
            Round (seconds)
            <input inputMode="numeric" value={roundSeconds} onChange={(event) => setRoundSeconds(event.target.value)} className="input w-[7rem]" />
          </label>
          <label className="t-data flex flex-col">
            Rest (seconds)
            <input inputMode="numeric" value={restSeconds} onChange={(event) => setRestSeconds(event.target.value)} className="input w-[7rem]" />
          </label>
          <label className="t-data flex flex-col">
            Rounds
            <input inputMode="numeric" value={roundsTotal} onChange={(event) => setRoundsTotal(event.target.value)} className="input w-[5rem]" />
          </label>
          <button type="button" onClick={configure} disabled={busy} className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60">
            Set rounds
          </button>
        </div>
      )}

      {timer && (
        <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s3)]">
          {timer.state === 'ready' && (
            <button type="button" onClick={() => void send({ action: 'start' })} disabled={busy} className="btn px-[var(--s5)] py-[var(--s4)] disabled:cursor-not-allowed disabled:opacity-60">
              Start rounds
            </button>
          )}
          {timer.state === 'running' && (
            <button type="button" onClick={() => void send({ action: 'pause' })} disabled={busy} className="btn px-[var(--s5)] py-[var(--s4)] disabled:cursor-not-allowed disabled:opacity-60">
              Pause rounds
            </button>
          )}
          {timer.state === 'paused' && (
            <button type="button" onClick={() => void send({ action: 'resume' })} disabled={busy} className="btn px-[var(--s5)] py-[var(--s4)] disabled:cursor-not-allowed disabled:opacity-60">
              Resume rounds
            </button>
          )}
          {timer.state !== 'ended' && (
            <button type="button" onClick={() => void send({ action: 'end' })} disabled={busy} className="btn btn--ghost px-[var(--s5)] py-[var(--s4)] disabled:cursor-not-allowed disabled:opacity-60">
              End rounds
            </button>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-[var(--s2)] text-[length:var(--t-md)] font-semibold text-[var(--locked-ink)]">
          {error}
        </p>
      )}
    </section>
  );
}
