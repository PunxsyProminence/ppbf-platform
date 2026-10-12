// The gym TV's round clock rules (WO-N1-04): counting on from the server's reading, and which
// transitions sound. Pure: no screen, no audio.

import type { RoundTimerView } from '@/src/server/pilot/roundTimers';

import { advanceRoundTimer, isNewSet, KNOCK_SECONDS, roundPanelText, roundSounds, type WallRoundReading } from './wallRoundTimer';

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
