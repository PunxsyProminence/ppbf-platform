'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import type { RoundTimerView } from '@/src/server/pilot/roundTimers';

// The coach's round timer controls for a live run (WO-N1-03). Every change is one named action on
// /api/pilot/session-scripts/runs/[runId]/timer, and the timer the server answers with is what the
// screen shows. THE SERVER OWNS THE CLOCK: between reads the seconds left tick down for display
// only, and a read every few seconds (and once when a period runs out) puts the screen back on the
// server's reading -- which is also how a second screen of the same coach stays in step.
//
// The timer starts only when the coach presses Start (N1-03-Q1 A). Setting the rounds never starts
// it. A run that is no longer live is handed to the live screen's own recovery (onRunNotLive), the
// same path its session buttons take.

const REFRESH_MS = 10_000;

const PHASE_WORD: Record<RoundTimerView['phase'], string> = {
  ready: 'Ready',
  work: 'Work',
  rest: 'Rest',
  done: 'All rounds done',
  ended: 'Ended',
};

const RUN_GONE = new Set(['SESSION_RUN_NOT_LIVE', 'SESSION_RUN_NOT_FOUND']);

type Load = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; timer: RoundTimerView | null; stale: boolean };

function clock(totalSeconds: number): string {
  const seconds = Math.max(0, totalSeconds);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function wholeNumber(text: string): number | null {
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;
}

interface Props {
  readonly runId: string;
  /** The server says this run is no longer live (or not this coach's): the live screen resyncs. */
  readonly onRunNotLive?: () => void;
}

export default function RoundTimerControls({ runId, onRunNotLive }: Props) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [roundSeconds, setRoundSeconds] = useState('180');
  const [restSeconds, setRestSeconds] = useState('60');
  const [roundsTotal, setRoundsTotal] = useState('3');
  // Every request takes a number; a read answered after a newer write never puts back the older
  // state (a poll that crossed a Start in flight must not show "Ready" again).
  const sequence = useRef(0);
  const lastWrite = useRef(0);
  // Held in a ref: the live screen re-renders every second, and a new callback each time must not
  // restart the reads.
  const runGone = useRef(onRunNotLive);
  useEffect(() => {
    runGone.current = onRunNotLive;
  }, [onRunNotLive]);

  const url = `${apiBase()}/api/pilot/session-scripts/runs/${encodeURIComponent(runId)}/timer`;

  const show = useCallback((timer: RoundTimerView | null) => {
    setLoad({ state: 'ready', timer, stale: false });
    setSecondsLeft(timer?.seconds_left ?? 0);
  }, []);

  // A read that fails after a good one keeps the last state, marked as the last reading.
  const readFailed = useCallback(() => {
    setLoad((current) => (current.state === 'ready' ? { ...current, stale: true } : { state: 'failed' }));
  }, []);

  const read = useCallback(async () => {
    const mine = ++sequence.current;
    try {
      const response = await fetch(url, { credentials: 'include', cache: 'no-store' });
      const payload = (await response.json().catch(() => null)) as { timer?: RoundTimerView | null; error?: string } | null;
      if (mine < lastWrite.current) return;
      if (!response.ok && payload?.error && RUN_GONE.has(payload.error)) {
        runGone.current?.();
        return;
      }
      if (!response.ok || !payload || !('timer' in payload)) {
        readFailed();
        return;
      }
      show(payload.timer ?? null);
    } catch {
      readFailed();
    }
  }, [readFailed, show, url]);

  // No state is set before read's first await (the convention SessionScriptLiveDelivery follows).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void read();
    const id = setInterval(() => void read(), REFRESH_MS);
    return () => clearInterval(id);
  }, [read]);

  const timer = load.state === 'ready' ? load.timer : null;
  const counting = timer?.state === 'running' && (timer.phase === 'work' || timer.phase === 'rest') && secondsLeft > 0;

  // Display tick only. It stops at 0:00, and the server is asked once what comes next.
  useEffect(() => {
    if (!counting) return;
    const id = setInterval(() => setSecondsLeft((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => clearInterval(id);
  }, [counting]);

  const periodOver = timer?.state === 'running' && (timer.phase === 'work' || timer.phase === 'rest') && secondsLeft === 0;
  useEffect(() => {
    // read() sets no state before its first await (as above).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (periodOver) void read();
  }, [periodOver, read]);

  async function send(body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    const mine = ++sequence.current;
    try {
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as { timer?: RoundTimerView; error?: string };
      if (!response.ok || !payload.timer) {
        if (payload.error && RUN_GONE.has(payload.error)) {
          runGone.current?.();
          return;
        }
        setError(`The server refused: ${payload.error ?? `HTTP ${response.status}`}`);
        // Another screen may have moved the timer: show the server's state, not this one's guess.
        void read();
        return;
      }
      lastWrite.current = mine;
      show(payload.timer);
    } catch {
      setError('Network error -- this may not have reached the server.');
      void read();
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
  const done = timer?.phase === 'done';
  const roundWords = timer && timer.round > 0 ? `Round ${timer.round} of ${timer.rounds_total}, ` : '';

  return (
    <section aria-labelledby={`round-timer-${runId}`} className="mt-[var(--s4)] rounded-[var(--r-md)] border-2 border-[var(--bone-700)] px-[var(--s4)] py-[var(--s3)]">
      <h3 id={`round-timer-${runId}`} className="t-eyebrow text-[color:var(--bone-300)]">Round timer</h3>

      {load.state === 'loading' && <p className="t-body text-[color:var(--bone-300)]">Loading the round timer...</p>}
      {load.state === 'failed' && <p className="t-body text-[color:var(--bone-300)]">The round timer could not be loaded.</p>}

      {load.state === 'ready' && timer && (
        <>
          <p data-testid="round-timer-status" className="font-mono text-[length:var(--t-xl)] font-black text-[color:var(--bone-100)]">
            {timer.round > 0 ? `Round ${timer.round} of ${timer.rounds_total} · ` : ''}
            {PHASE_WORD[timer.phase]}
            {counting || periodOver ? ` · ${clock(secondsLeft)} left` : ''}
            {timer.is_paused ? ` · Paused at ${clock(secondsLeft)}` : ''}
          </p>
          {/* Announced when the round or phase changes, not every second. */}
          <p role="status" className="sr-only">{`${roundWords}${PHASE_WORD[timer.phase]}${timer.is_paused ? ', paused' : ''}`}</p>
          {load.stale && <p className="t-data text-[color:var(--bone-400)]">Last reading -- the server could not be reached just now.</p>}
        </>
      )}
      {load.state === 'ready' && !timer && <p className="t-body text-[color:var(--bone-300)]">No rounds set for this session.</p>}

      {canConfigure && (
        <div className="mt-[var(--s2)] flex flex-wrap items-end gap-[var(--s3)]">
          <label className="t-data flex flex-col">
            Round (seconds)
            <input type="number" min={1} max={3600} inputMode="numeric" value={roundSeconds} onChange={(event) => setRoundSeconds(event.target.value)} className="input w-[7rem]" />
          </label>
          <label className="t-data flex flex-col">
            Rest (seconds)
            <input type="number" min={0} max={3600} inputMode="numeric" value={restSeconds} onChange={(event) => setRestSeconds(event.target.value)} className="input w-[7rem]" />
          </label>
          <label className="t-data flex flex-col">
            Rounds
            <input type="number" min={1} max={100} inputMode="numeric" value={roundsTotal} onChange={(event) => setRoundsTotal(event.target.value)} className="input w-[5rem]" />
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
          {timer.state === 'running' && !done && (
            <button type="button" onClick={() => void send({ action: 'pause' })} disabled={busy} className="btn px-[var(--s5)] py-[var(--s4)] disabled:cursor-not-allowed disabled:opacity-60">
              Pause rounds
            </button>
          )}
          {timer.state === 'paused' && !done && (
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
