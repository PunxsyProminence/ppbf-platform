// The gym TV's round clock rules (WO-N1-04): counting on from the server's reading, and which
// transitions sound. Pure: no screen, no audio.

import type { RoundTimerView } from '@/src/server/pilot/roundTimers';

import { advanceRoundTimer, isNewSet, KNOCK_SECONDS, releasedKeys, roundPanelText, roundSounds, type WallRoundReading } from './wallRoundTimer';

function view(overrides: Partial<RoundTimerView> = {}): RoundTimerView {
  return {
    state: 'running',
    phase: 'work',
    round: 1,
    rounds_total: 3,
    round_seconds: 180,
    rest_seconds: 60,
    seconds_left: 180,
    is_paused: false,
    ...overrides,
  };
}

const CONFIG = { round_seconds: 180, rest_seconds: 60 };

function reading(overrides: Partial<WallRoundReading> = {}): WallRoundReading {
  return { state: 'running', phase: 'work', round: 1, rounds_total: 3, seconds_left: 180, ...overrides };
}

describe('advanceRoundTimer', () => {
  test.each([
    [0, 'work', 1, 180],
    [179, 'work', 1, 1],
    [180, 'rest', 1, 60],
    [240, 'work', 2, 180],
    [659, 'work', 3, 1],
  ] as const)('%ss after a fresh start: %s, round %s, %s left', (elapsed, phase, round, left) => {
    expect(advanceRoundTimer(view(), elapsed)).toMatchObject({ phase, round, seconds_left: left });
  });

  test('done at the end of the last round, with no rest after it', () => {
    expect(advanceRoundTimer(view(), 660)).toMatchObject({ phase: 'done', round: 3, seconds_left: 0, seconds_since_done: 0 });
    expect(advanceRoundTimer(view(), 700)).toMatchObject({ phase: 'done', seconds_since_done: 40 });
    expect(advanceRoundTimer(view({ round: 3, seconds_left: 5 }), 99)).toMatchObject({ phase: 'done', round: 3 });
  });

  test('counts on from a mid-rest reading', () => {
    expect(advanceRoundTimer(view({ phase: 'rest', round: 1, seconds_left: 20 }), 25)).toMatchObject({
      phase: 'work',
      round: 2,
      seconds_left: 175,
    });
  });

  test('with no rest, rounds run back to back', () => {
    expect(advanceRoundTimer(view({ rest_seconds: 0 }), 181)).toMatchObject({ phase: 'work', round: 2, seconds_left: 179 });
  });

  test.each([
    ['paused', view({ state: 'paused', seconds_left: 42, is_paused: true })],
    ['ready', view({ state: 'ready', phase: 'ready', round: 0, seconds_left: 0 })],
    ['ended', view({ state: 'ended', phase: 'ended', round: 0, seconds_left: 0 })],
    ['done', view({ phase: 'done', round: 3, seconds_left: 0 })],
  ] as const)('a %s timer does not move', (_name, frozen) => {
    expect(advanceRoundTimer(frozen, 500)).toEqual(advanceRoundTimer(frozen, 0));
  });
});

describe('roundSounds', () => {
  test('the first reading after a load sounds nothing, wherever it lands', () => {
    expect(roundSounds('r', null, reading({ seconds_left: 180 }), CONFIG, 7)).toEqual([]);
    expect(roundSounds('r', null, reading({ phase: 'rest', seconds_left: 60 }), CONFIG, 7)).toEqual([]);
  });

  test('the bell when a round ends into rest, and when the next round starts', () => {
    expect(roundSounds('r', reading({ seconds_left: 1 }), reading({ phase: 'rest', seconds_left: 60 }), CONFIG, 7)).toEqual([
      { voice: 'bell', keys: ['r:1:end'] },
    ]);
    expect(roundSounds('r', reading({ phase: 'rest', seconds_left: 1 }), reading({ round: 2, seconds_left: 180 }), CONFIG, 7)).toEqual([
      { voice: 'bell', keys: ['r:2:start'] },
    ]);
  });

  test('with no rest, the end of one round and the start of the next are one strike carrying both keys', () => {
    const config = { round_seconds: 180, rest_seconds: 0 };
    expect(roundSounds('r', reading({ seconds_left: 1 }), reading({ round: 2, seconds_left: 180 }), config, 7)).toEqual([
      { voice: 'bell', keys: ['r:1:end', 'r:2:start'] },
    ]);
  });

  test("the coach's Start learned on a later poll rings if recent, and stays silent if it is old", () => {
    const ready = reading({ state: 'ready', phase: 'ready', round: 0, seconds_left: 0 });
    expect(roundSounds('r', ready, reading({ seconds_left: 175 }), CONFIG, 7)).toEqual([{ voice: 'bell', keys: ['r:1:start'] }]);
    expect(roundSounds('r', ready, reading({ seconds_left: 172 }), CONFIG, 7)).toEqual([]);
  });

  test('the last bell rings at the end of the last round, but not on waking long after it', () => {
    expect(roundSounds('r', reading({ round: 3, seconds_left: 1 }), reading({ round: 3, phase: 'done', seconds_left: 0, seconds_since_done: 0 }), CONFIG, 7)).toEqual([
      { voice: 'bell', keys: ['r:3:end'] },
    ]);
    // A tab that slept through the end: counted on here, ten minutes past it.
    expect(roundSounds('r', reading({ round: 3, seconds_left: 5 }), reading({ round: 3, phase: 'done', seconds_left: 0, seconds_since_done: 600 }), CONFIG, 7)).toEqual([]);
    // "done" as the server reports it has no known age, so it is past.
    expect(roundSounds('r', reading({ round: 3, seconds_left: 1 }), reading({ round: 3, phase: 'done', seconds_left: 0 }), CONFIG, 7)).toEqual([]);
  });

  test('a paused round resumed across its end still rings its end bell', () => {
    expect(roundSounds('r', reading({ state: 'paused', seconds_left: 2 }), reading({ phase: 'rest', seconds_left: 57 }), CONFIG, 7)).toEqual([
      { voice: 'bell', keys: ['r:1:end'] },
    ]);
  });

  test('with a short rest, a poll pulling the count back from the next round into the rest rings nothing', () => {
    const config = { round_seconds: 30, rest_seconds: 5 };
    expect(roundSounds('r', reading({ round: 2, seconds_left: 30 }), reading({ phase: 'rest', round: 1, seconds_left: 1 }), config, 7)).toEqual([]);
  });

  test('a new set on the same run starts from the top: its first bell rings', () => {
    // Ended, reconfigured and started between two polls: round 1 again, just begun.
    const prev = reading({ round: 3, phase: 'done', seconds_left: 0 });
    const next = reading({ round: 1, seconds_left: 178 });
    expect(isNewSet(prev, next, CONFIG, 7)).toBe(true);
    expect(roundSounds('r#2', prev, next, CONFIG, 7)).toEqual([{ voice: 'bell', keys: ['r#2:1:start'] }]);
    expect(isNewSet(prev, reading({ state: 'ready', phase: 'ready', round: 0, seconds_left: 0 }), CONFIG, 7)).toBe(true);
    expect(isNewSet(prev, reading({ state: 'ended', phase: 'ended', round: 0, seconds_left: 0 }), CONFIG, 7)).toBe(true);
    // A small backwards correction is not a new set.
    expect(isNewSet(reading({ round: 2, seconds_left: 179 }), reading({ phase: 'rest', round: 1, seconds_left: 1 }), CONFIG, 7)).toBe(false);
    expect(isNewSet(reading({ round: 2, seconds_left: 179 }), reading({ round: 1, seconds_left: 1 }), { round_seconds: 180, rest_seconds: 0 }, 7)).toBe(false);
  });

  // Codex on #1504: ended, reconfigured and started again between polls, both readings in round 1.
  test('a restart within the same round is a new set: its start bell rings again', () => {
    const prev = reading({ round: 1, seconds_left: 150 });
    const next = reading({ round: 1, seconds_left: 178 });
    expect(isNewSet(prev, next, CONFIG, 7)).toBe(true);
    expect(roundSounds('r#2', prev, next, CONFIG, 7)).toEqual([{ voice: 'bell', keys: ['r#2:1:start'] }]);
    // A poll that steps the count back a second or two is the same set, and rings nothing.
    expect(isNewSet(reading({ seconds_left: 176 }), reading({ seconds_left: 178 }), CONFIG, 7)).toBe(false);
    expect(roundSounds('r#1', reading({ seconds_left: 176 }), reading({ seconds_left: 178 }), CONFIG, 7)).toEqual([]);
    // A jump back late in a round is not a fresh start, and a paused reading is not a restart.
    expect(isNewSet(reading({ seconds_left: 40 }), reading({ seconds_left: 60 }), CONFIG, 7)).toBe(false);
    expect(isNewSet(reading({ seconds_left: 150 }), reading({ state: 'paused', seconds_left: 178 }), CONFIG, 7)).toBe(false);
  });

  test('no knock for a jump straight past it (a tab that slept, or a late poll)', () => {
    expect(roundSounds('r', reading({ seconds_left: 40 }), reading({ seconds_left: 1 }), CONFIG, 7)).toEqual([]);
  });

  test(`the knock once, as a round passes ${KNOCK_SECONDS} seconds left`, () => {
    expect(roundSounds('r', reading({ seconds_left: 11 }), reading({ seconds_left: 10 }), CONFIG, 7)).toEqual([
      { voice: 'knock', keys: ['r:1:knock'] },
    ]);
    expect(roundSounds('r', reading({ seconds_left: 10 }), reading({ seconds_left: 9 }), CONFIG, 7)).toEqual([]);
    expect(roundSounds('r', reading({ seconds_left: 30 }), reading({ seconds_left: 29 }), CONFIG, 7)).toEqual([]);
  });

  test('a paused, ended or ready timer sounds nothing, and resuming is not a new round', () => {
    expect(roundSounds('r', reading({ seconds_left: 11 }), reading({ state: 'paused', seconds_left: 10 }), CONFIG, 7)).toEqual([]);
    expect(roundSounds('r', reading({ seconds_left: 50 }), reading({ state: 'ended', phase: 'ended', round: 0, seconds_left: 0 }), CONFIG, 7)).toEqual([]);
    expect(roundSounds('r', reading({ state: 'paused', seconds_left: 100 }), reading({ seconds_left: 100 }), CONFIG, 7)).toEqual([]);
  });

  test('a poll that pulls the count back across a boundary does not start a new round', () => {
    expect(roundSounds('r', reading({ round: 2, seconds_left: 179 }), reading({ phase: 'rest', round: 1, seconds_left: 1 }), CONFIG, 7)).toEqual([]);
  });
});

describe('roundPanelText', () => {
  test.each([
    [reading({ seconds_left: 125 }), 'Round 1 of 3', '2:05'],
    [reading({ state: 'paused', round: 2, seconds_left: 42 }), 'Round 2 of 3 · Paused', '0:42'],
    [reading({ phase: 'rest', seconds_left: 30 }), 'Rest · round 2 of 3 next', '0:30'],
    [reading({ state: 'ready', phase: 'ready', round: 0, seconds_left: 0 }), 'Round 1 of 3 · Ready', '3:00'],
    [reading({ phase: 'done', round: 3, seconds_left: 0 }), 'Rounds done', ''],
    [reading({ state: 'ended', phase: 'ended', round: 0, seconds_left: 0 }), 'Rounds stopped', ''],
  ])('%j reads "%s" %s', (value, label, time) => {
    expect(roundPanelText(value, 180)).toEqual({ label, time });
  });
});

// +30 SEC and REPEAT on the TV (OD-2026-10-17-010). The server moves the clock back; the TV sees a
// reading and decides what to ring. 180 s rounds, 60 s rest; the TV's freshness window is 7 s.
describe('the TV after +30 SEC and REPEAT', () => {
  const CONFIG = { round_seconds: 180, rest_seconds: 60 };
  const FRESH = 7;
  const read = (seconds_left: number, round = 2, phase: 'work' | 'rest' = 'work') =>
    ({ state: 'running' as const, phase, round, rounds_total: 3, seconds_left });

  test('+30 well into a round is the same set and rings nothing', () => {
    const prev = read(100); // 80 s in
    const next = read(130);
    expect(isNewSet(prev, next, CONFIG, FRESH)).toBe(false);
    expect(roundSounds('run#0', prev, next, CONFIG, FRESH)).toEqual([]);
  });

  test('REPEAT is a fresh start of the round: the start bell rings once', () => {
    const prev = read(60); // 120 s into round 2
    const next = read(178); // back at the start, read 2 s later
    expect(isNewSet(prev, next, CONFIG, FRESH)).toBe(true);
    expect(roundSounds('run#1', prev, next, CONFIG, FRESH)).toEqual([{ voice: 'bell', keys: ['run#1:2:start'] }]);
  });

  test('REPEAT from a rest goes back to the round just finished and rings its start', () => {
    const prev = read(30, 2, 'rest');
    const next = read(179, 2, 'work');
    expect(isNewSet(prev, next, CONFIG, FRESH)).toBe(true);
    expect(roundSounds('run#1', prev, next, CONFIG, FRESH)).toEqual([{ voice: 'bell', keys: ['run#1:2:start'] }]);
  });

  test('KNOWN LIMIT: +30 in the 30-37 s window lands within the fresh window of the start and rings like a restart', () => {
    // The TV cannot tell this reading from a REPEAT; documented in roundTimers.ts and the PR.
    const prev = read(147); // 33 s in
    const next = read(177); // after +30: 3 s in
    expect(isNewSet(prev, next, CONFIG, FRESH)).toBe(true);
  });
});

describe('releasedKeys: the bells still to come after +30 SEC', () => {
  const CONFIG = { round_seconds: 180, rest_seconds: 60 };
  const read = (seconds_left: number, round = 2, phase: 'work' | 'rest' = 'work', state: 'running' | 'paused' = 'running') =>
    ({ state, phase, round, rounds_total: 3, seconds_left });

  test('+30 in the last ten seconds gives back this round\'s knock and end, and the next start', () => {
    expect(releasedKeys('run#0', read(5), read(35), CONFIG, 7).sort()).toEqual(['run#0:2:end', 'run#0:2:knock', 'run#0:3:start']);
  });

  test('a TV that counted on past an end the server had not reached gives that end back', () => {
    // The TV rang round 2's end and went into rest locally; the server says round 2 has 25 s left.
    expect(releasedKeys('run#0', read(55, 2, 'rest'), read(25), CONFIG, 7).sort()).toEqual(['run#0:2:end', 'run#0:2:knock', 'run#0:3:start']);
  });

  test('+30 during a rest gives back only the next start', () => {
    expect(releasedKeys('run#0', read(5, 2, 'rest'), read(35, 2, 'rest'), CONFIG, 7)).toEqual(['run#0:3:start']);
  });

  test('a poll correction of a few seconds gives nothing back', () => {
    expect(releasedKeys('run#0', read(1), read(4), CONFIG, 7)).toEqual([]);
    expect(releasedKeys('run#0', read(58, 2, 'rest'), read(1), CONFIG, 7)).toEqual([]);
  });

  test('a new set gives nothing back: it has keys of its own', () => {
    expect(releasedKeys('run#0', read(60), read(178), CONFIG, 7)).toEqual([]);
  });

  test('REPEAT while paused gives back the round\'s start, knock and end, so they ring once it resumes', () => {
    expect(releasedKeys('run#0', read(60, 2, 'work', 'paused'), read(180, 2, 'work', 'paused'), CONFIG, 7).sort()).toEqual(
      ['run#0:2:end', 'run#0:2:knock', 'run#0:2:start', 'run#0:3:start'],
    );
  });

  test('Resume at the start of a round sounds its start bell (the key decides whether it rings)', () => {
    // Paused right after a REPEAT, then resumed a second later.
    expect(roundSounds('run#0', read(180, 2, 'work', 'paused'), read(179), CONFIG, 7)).toEqual([
      { voice: 'bell', keys: ['run#0:2:start'] },
    ]);
  });

  test('Resume well into a round sounds nothing', () => {
    expect(roundSounds('run#0', read(100, 2, 'work', 'paused'), read(99), CONFIG, 7)).toEqual([]);
  });
});
