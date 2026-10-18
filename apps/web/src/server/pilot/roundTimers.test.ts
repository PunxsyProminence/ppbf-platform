// The room's reading of a round timer, derived on the server (WO-N1-03). Pure: no database here.

import { ROUND_TIMER_FIELDS, adjustmentShift, deriveRoundTimer, type RoundTimerRow } from './roundTimers';

const START = '2026-10-12T18:00:00.000Z';

function at(secondsAfterStart: number, row: Partial<RoundTimerRow> = {}): ReturnType<typeof deriveRoundTimer> {
  return deriveRoundTimer({
    round_seconds: 180,
    rest_seconds: 60,
    rounds_total: 3,
    state: 'running',
    started_at: START,
    paused_at: null,
    paused_seconds: 0,
    server_time: new Date(Date.parse(START) + secondsAfterStart * 1000).toISOString(),
    ...row,
  });
}

describe('deriveRoundTimer', () => {
  test('ready: no round, nothing counting', () => {
    expect(at(500, { state: 'ready', started_at: null })).toEqual({
      state: 'ready',
      phase: 'ready',
      round: 0,
      rounds_total: 3,
      round_seconds: 180,
      rest_seconds: 60,
      seconds_left: 0,
      is_paused: false,
    });
  });

  test.each([
    [0, 'work', 1, 180],
    [179, 'work', 1, 1],
    [180, 'rest', 1, 60],
    [239, 'rest', 1, 1],
    [240, 'work', 2, 180],
    [420, 'rest', 2, 60],
    [480, 'work', 3, 180],
    [659, 'work', 3, 1],
  ] as const)('%ss in: %s, round %s, %ss left', (seconds, phase, round, left) => {
    expect(at(seconds)).toMatchObject({ phase, round, seconds_left: left });
  });

  test('no rest after the last round: done the moment it ends, and after', () => {
    expect(at(660)).toMatchObject({ phase: 'done', round: 3, seconds_left: 0, state: 'running' });
    expect(at(5000)).toMatchObject({ phase: 'done', round: 3, seconds_left: 0 });
  });

  test('paused time is taken off, and a paused timer is frozen at its pause instant', () => {
    expect(at(200, { paused_seconds: 30 })).toMatchObject({ phase: 'work', round: 1, seconds_left: 10 });
    const pausedAt = new Date(Date.parse(START) + 100_000).toISOString();
    for (const later of [100, 400, 4000]) {
      expect(at(later, { state: 'paused', paused_at: pausedAt })).toMatchObject({
        phase: 'work',
        round: 1,
        seconds_left: 80,
        is_paused: true,
      });
    }
  });

  test('with no rest, rounds run back to back', () => {
    expect(at(180, { rest_seconds: 0 })).toMatchObject({ phase: 'work', round: 2, seconds_left: 180 });
  });

  test('ended: no round, nothing counting, whether or not it ever started', () => {
    expect(at(100, { state: 'ended' })).toMatchObject({ phase: 'ended', round: 0, seconds_left: 0 });
    expect(at(100, { state: 'ended', started_at: null })).toMatchObject({ phase: 'ended', round: 0, seconds_left: 0 });
  });

  test('a server clock behind the start never reads a negative time', () => {
    expect(at(-5)).toMatchObject({ phase: 'work', round: 1, seconds_left: 180 });
  });

  test('the view is exactly the allowlisted fields', () => {
    expect(Object.keys(at(10)).sort()).toEqual([...ROUND_TIMER_FIELDS].sort());
    expect([...ROUND_TIMER_FIELDS].sort()).toEqual(
      ['is_paused', 'phase', 'rest_seconds', 'round', 'round_seconds', 'rounds_total', 'seconds_left', 'state'],
    );
  });
});

// +30 SEC and REPEAT (OD-2026-10-17-010; +30 timing "A: After 30 sec"). 180 s rounds, 60 s rest,
// three rounds: round 1 work 0-179, rest 180-239, round 2 work 240-419, rest 420-479, round 3
// 480-659, then done.
describe('adjustmentShift: +30 SEC and REPEAT', () => {
  function row(secondsAfterStart: number, over: Partial<RoundTimerRow> = {}): RoundTimerRow {
    return {
      round_seconds: 180,
      rest_seconds: 60,
      rounds_total: 3,
      state: 'running',
      started_at: START,
      paused_at: null,
      paused_seconds: 0,
      server_time: new Date(Date.parse(START) + secondsAfterStart * 1000).toISOString(),
      ...over,
    };
  }
  function after(r: RoundTimerRow, adjustment: 'add_30' | 'repeat') {
    const move = adjustmentShift(r, adjustment);
    if ('refused' in move) throw new Error(move.refused);
    return deriveRoundTimer({ ...r, paused_seconds: r.paused_seconds + move.shift });
  }

  test('+30 is refused in the first 30 seconds of a round or a rest', () => {
    expect(adjustmentShift(row(29), 'add_30')).toEqual({ refused: 'ROUND_TIMER_TOO_EARLY' });
    expect(adjustmentShift(row(240 + 5), 'add_30')).toEqual({ refused: 'ROUND_TIMER_TOO_EARLY' });
    expect(adjustmentShift(row(180 + 29), 'add_30')).toEqual({ refused: 'ROUND_TIMER_TOO_EARLY' });
  });

  test('+30 gives the same round or rest thirty more seconds from 30 seconds in', () => {
    expect(at(30)).toMatchObject({ phase: 'work', round: 1, seconds_left: 150 });
    expect(after(row(30), 'add_30')).toMatchObject({ phase: 'work', round: 1, seconds_left: 180 });
    expect(after(row(240 + 100), 'add_30')).toMatchObject({ phase: 'work', round: 2, seconds_left: 110 });
    expect(after(row(180 + 45), 'add_30')).toMatchObject({ phase: 'rest', round: 1, seconds_left: 45 });
  });

  test('+30 is refused before the start, after an end and once every round is done', () => {
    expect(adjustmentShift(row(0, { state: 'ready', started_at: null }), 'add_30')).toEqual({ refused: 'ROUND_TIMER_READY' });
    expect(adjustmentShift(row(100, { state: 'ended' }), 'add_30')).toEqual({ refused: 'ROUND_TIMER_ENDED' });
    expect(adjustmentShift(row(700), 'add_30')).toEqual({ refused: 'ROUND_TIMER_DONE' });
  });

  test('REPEAT runs the round being worked again, from its start', () => {
    expect(after(row(240 + 100), 'repeat')).toMatchObject({ phase: 'work', round: 2, seconds_left: 180 });
    expect(after(row(3), 'repeat')).toMatchObject({ phase: 'work', round: 1, seconds_left: 180 });
  });

  test('REPEAT during a rest runs the round just finished again', () => {
    expect(after(row(180 + 20), 'repeat')).toMatchObject({ phase: 'work', round: 1, seconds_left: 180 });
    expect(after(row(420 + 59), 'repeat')).toMatchObject({ phase: 'work', round: 2, seconds_left: 180 });
  });

  test('REPEAT after the last round runs the last round again, however long ago it ended', () => {
    expect(after(row(660), 'repeat')).toMatchObject({ phase: 'work', round: 3, seconds_left: 180 });
    expect(after(row(5000), 'repeat')).toMatchObject({ phase: 'work', round: 3, seconds_left: 180 });
  });

  test('both work on paused rounds, against the paused instant', () => {
    const paused = row(900, { state: 'paused', paused_at: new Date(Date.parse(START) + 100 * 1000).toISOString() });
    expect(after(paused, 'repeat')).toMatchObject({ phase: 'work', round: 1, seconds_left: 180, is_paused: true });
    expect(after(paused, 'add_30')).toMatchObject({ phase: 'work', round: 1, seconds_left: 110, is_paused: true });
  });

  test('REPEAT is refused before the start and after an end', () => {
    expect(adjustmentShift(row(0, { state: 'ready', started_at: null }), 'repeat')).toEqual({ refused: 'ROUND_TIMER_READY' });
    expect(adjustmentShift(row(100, { state: 'ended' }), 'repeat')).toEqual({ refused: 'ROUND_TIMER_ENDED' });
  });
});
