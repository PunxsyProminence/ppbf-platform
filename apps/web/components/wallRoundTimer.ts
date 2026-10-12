import type { RoundTimerView } from '@/src/server/pilot/roundTimers';

// The gym TV's round clock (WO-N1-04), as pure functions so every rule here is testable without a
// screen. The server owns the timer (roundTimers.ts): each poll brings its reading, and between
// polls the TV only counts on from that reading by the seconds its own clock says have passed.
// Nothing is stored on the TV.

export interface WallRoundReading {
  state: RoundTimerView['state'];
  phase: RoundTimerView['phase'];
  round: number;
  rounds_total: number;
  seconds_left: number;
}

/** The reading `elapsed` whole seconds after `view` was read. Only a running timer moves. */
export function advanceRoundTimer(view: RoundTimerView, elapsed: number): WallRoundReading {
  const base = { state: view.state, rounds_total: view.rounds_total };
  if (view.state !== 'running' || (view.phase !== 'work' && view.phase !== 'rest')) {
    return { ...base, phase: view.phase, round: view.round, seconds_left: view.seconds_left };
  }
  let phase: 'work' | 'rest' = view.phase;
  let round = view.round;
  let left = view.seconds_left;
  let remaining = Math.max(0, Math.floor(elapsed));
  while (remaining >= left) {
    remaining -= left;
    if (phase === 'work') {
      if (round >= view.rounds_total) {
        return { ...base, phase: 'done', round, seconds_left: 0 };
      }
      if (view.rest_seconds > 0) {
        phase = 'rest';
        left = view.rest_seconds;
      } else {
        round += 1;
        left = view.round_seconds;
      }
    } else {
      phase = 'work';
      round += 1;
      left = view.round_seconds;
    }
  }
  return { ...base, phase, round, seconds_left: left - remaining };
}

/** Seconds before the end of a round when the knock sounds (the gym's ten-second clapper). */
export const KNOCK_SECONDS = 10;

export interface WallRoundSound {
  voice: 'bell' | 'knock';
  /** One per run, round and event. A key sounds at most once on a TV; one strike may carry two. */
  keys: string[];
}

export interface RoundConfig {
  round_seconds: number;
  rest_seconds: number;
}

/** How long the reading has been in its current period, in seconds. */
function periodAge(reading: WallRoundReading, config: RoundConfig): number {
  if (reading.phase === 'work') return config.round_seconds - reading.seconds_left;
  if (reading.phase === 'rest') return config.rest_seconds - reading.seconds_left;
  return 0;
}

/**
 * What to sound going from one reading to the next:
 *   - the bell when a round ends and when the next one starts (one strike when they are the same
 *     moment, with no rest);
 *   - the knock when a round passes KNOCK_SECONDS left.
 * `fresh` is how many seconds old a transition may be and still sound. A start the TV learns about
 * on a later poll sounds if it is that recent; anything older (a reload, a TV that slept) is past
 * and stays silent. The first reading after a load has no `prev` and sounds nothing.
 */
export function roundSounds(
  runId: string,
  prev: WallRoundReading | null,
  next: WallRoundReading,
  config: RoundConfig,
  fresh: number,
): WallRoundSound[] {
  if (!prev || next.state !== 'running') return [];
  // A finished timer has no period to age, so "done" is fresh only if the last reading was about
  // to end -- a TV that slept through the last bell does not ring it on waking.
  const isFresh = next.phase === 'done' ? prev.seconds_left <= fresh : periodAge(next, config) <= fresh;
  const movedOn = next.round > prev.round || next.phase !== prev.phase;
  const bellKeys: string[] = [];
  if (movedOn && isFresh && prev.phase === 'work' && prev.state === 'running') {
    bellKeys.push(`${runId}:${prev.round}:end`);
  }
  if (movedOn && isFresh && next.phase === 'work') {
    bellKeys.push(`${runId}:${next.round}:start`);
  }
  const sounds: WallRoundSound[] = bellKeys.length > 0 ? [{ voice: 'bell', keys: bellKeys }] : [];
  if (
    next.phase === 'work'
    && prev.phase === 'work'
    && prev.round === next.round
    && prev.seconds_left > KNOCK_SECONDS
    && next.seconds_left <= KNOCK_SECONDS
    && next.seconds_left > 0
  ) {
    sounds.push({ voice: 'knock', keys: [`${runId}:${next.round}:knock`] });
  }
  return sounds;
}

function clock(seconds: number): string {
  const whole = Math.max(0, seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** The words on the wall. Never only a colour: rest, paused and stopped are said. */
export function roundPanelText(reading: WallRoundReading, roundSeconds: number): { label: string; time: string } {
  if (reading.state === 'ended') return { label: 'Rounds stopped', time: '' };
  if (reading.phase === 'done') return { label: 'Rounds done', time: '' };
  if (reading.state === 'ready') return { label: `Round 1 of ${reading.rounds_total} · Ready`, time: clock(roundSeconds) };
  const paused = reading.state === 'paused' ? ' · Paused' : '';
  if (reading.phase === 'rest') {
    return { label: `Rest · round ${reading.round + 1} of ${reading.rounds_total} next${paused}`, time: clock(reading.seconds_left) };
  }
  return { label: `Round ${reading.round} of ${reading.rounds_total}${paused}`, time: clock(reading.seconds_left) };
}
