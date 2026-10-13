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
  /** For a reading counted on into "done" here: how many seconds ago the last round ended. */
  seconds_since_done?: number;
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
        return { ...base, phase: 'done', round, seconds_left: 0, seconds_since_done: remaining };
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
  // "done" read from the server has no known age: treat it as old.
  return reading.seconds_since_done ?? Number.POSITIVE_INFINITY;
}

/** Where a reading is in the set: later rounds and later phases sort higher. */
function position(reading: WallRoundReading): number {
  const phase = reading.phase === 'work' ? 0 : reading.phase === 'rest' ? 1 : reading.phase === 'done' ? 2 : -1;
  return reading.round * 3 + phase;
}

/** How far a running round's count may step back on a poll (rounding, latency) and still be the same set. */
export const RESTART_TOLERANCE_SECONDS = 2;

/**
 * A new set of rounds on the same run: the coach ended or reset the timer, or ended, reconfigured
 * and started again between two polls -- a fresh round that is EARLIER than the last reading, or
 * the same round of a running set jumped back to its start by more than a poll's correction. A
 * poll's small backwards correction never looks like this: it lands near the end of a period, or
 * moves the count back by a second or two at most.
 */
export function isNewSet(prev: WallRoundReading | null, next: WallRoundReading, config: RoundConfig, fresh: number): boolean {
  if (next.state === 'ready' || next.state === 'ended') return true;
  if (!prev) return false;
  if (next.phase !== 'work' || periodAge(next, config) > fresh) return false;
  if (position(next) < position(prev)) return true;
  return (
    position(next) === position(prev)
    && next.state === 'running'
    && prev.state === 'running'
    && next.seconds_left - prev.seconds_left > RESTART_TOLERANCE_SECONDS
  );
}

const BEFORE_START: WallRoundReading = { state: 'ready', phase: 'ready', round: 0, rounds_total: 0, seconds_left: 0 };

/**
 * What to sound going from one reading to the next:
 *   - the bell when a round ends and when the next one starts (one strike when they are the same
 *     moment, with no rest);
 *   - the knock when a round passes KNOCK_SECONDS left.
 * Only forward motion sounds: a poll that pulls the count back across a boundary rings nothing.
 * `fresh` is how many seconds old a transition may be and still sound; anything older (a reload,
 * a TV that slept) is past and stays silent. The first reading after a load has no `prev` and
 * sounds nothing. The caller gives a new set its own keys (isNewSet).
 */
export function roundSounds(
  setKey: string,
  prevReading: WallRoundReading | null,
  next: WallRoundReading,
  config: RoundConfig,
  fresh: number,
): WallRoundSound[] {
  if (!prevReading || next.state !== 'running') return [];
  const prev = isNewSet(prevReading, next, config, fresh) ? BEFORE_START : prevReading;
  const isFresh = periodAge(next, config) <= fresh;
  const movedOn = position(next) > position(prev);
  const bellKeys: string[] = [];
  if (movedOn && isFresh && prev.phase === 'work') {
    bellKeys.push(`${setKey}:${prev.round}:end`);
  }
  if (movedOn && isFresh && next.phase === 'work') {
    bellKeys.push(`${setKey}:${next.round}:start`);
  }
  const sounds: WallRoundSound[] = bellKeys.length > 0 ? [{ voice: 'bell', keys: bellKeys }] : [];
  if (
    next.phase === 'work'
    && prev.phase === 'work'
    && prev.round === next.round
    && prev.seconds_left > KNOCK_SECONDS
    && next.seconds_left <= KNOCK_SECONDS
    && next.seconds_left >= KNOCK_SECONDS - 3
  ) {
    sounds.push({ voice: 'knock', keys: [`${setKey}:${next.round}:knock`] });
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
