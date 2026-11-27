import { classPlanStart, classesUnderWay, defaultClassChoice, instantMs, toIsoInstant, type TieableClassView } from './sessionClassChoice';

// D4 (OD-2026-10-21-002): which class a new session opens on. Never a guess between classes,
// never the oldest one (the B2 wrong-class failure).

const NOW = Date.parse('2026-10-21T22:00:00Z'); // 6:00 PM Eastern

function at(minutesFromNow: number): string {
  return new Date(NOW + minutesFromNow * 60_000).toISOString();
}

function klass(id: string, startMin: number, endMin: number, held = false): TieableClassView {
  return { class_id: id, title: id, start_at: at(startMin), end_at: at(endMin), held_by_other_session: held };
}

describe('defaultClassChoice', () => {
  test('exactly one class under way: that class', () => {
    expect(defaultClassChoice([klass('now', -10, 50), klass('later', 120, 180)], NOW)).toBe('now');
  });

  test('a class starting within 30 minutes is under way; one starting later is not', () => {
    expect(defaultClassChoice([klass('soon', 30, 90)], NOW)).toBe('soon');
    expect(defaultClassChoice([klass('later', 31, 90)], NOW)).toBeUndefined();
  });

  test('a class that has ended is not under way', () => {
    expect(defaultClassChoice([klass('done', -90, 0)], NOW)).toBeUndefined();
  });

  test('two classes under way: the coach chooses', () => {
    expect(defaultClassChoice([klass('a', -10, 50), klass('b', 0, 60)], NOW)).toBeUndefined();
  });

  test('never the oldest class of the day by default', () => {
    expect(defaultClassChoice([klass('morning', -600, -540), klass('evening', 120, 180)], NOW)).toBeUndefined();
  });

  test('no class today, or only classes another live session runs: no class (open gym)', () => {
    expect(defaultClassChoice([], NOW)).toBeNull();
    expect(defaultClassChoice([klass('held', -10, 50, true)], NOW)).toBeNull();
  });

  test('a held class never counts as the one under way', () => {
    expect(classesUnderWay([klass('held', -10, 50, true), klass('free', -5, 55)], NOW).map((item) => item.class_id)).toEqual(['free']);
    expect(defaultClassChoice([klass('held', -10, 50, true), klass('free', -5, 55)], NOW)).toBe('free');
  });
});

describe('instantMs', () => {
  test('reads the Postgres text the server sends, and ISO strings, as the same instant', () => {
    expect(instantMs('2026-10-21 22:00:00+00')).toBe(NOW);
    expect(instantMs('2026-10-21 18:00:00.000-04')).toBe(NOW);
    expect(instantMs('2026-10-21T22:00:00.000Z')).toBe(NOW);
  });

  test('rewrites Postgres text to strict ISO, which Safari reads; leaves ISO alone', () => {
    expect(toIsoInstant('2026-10-21 22:00:00+00')).toBe('2026-10-21T22:00:00+00:00');
    expect(toIsoInstant('2026-10-21 18:00:00.123456-04')).toBe('2026-10-21T18:00:00.123456-04:00');
    expect(toIsoInstant('2026-10-21T22:00:00.000Z')).toBe('2026-10-21T22:00:00.000Z');
    expect(toIsoInstant('2026-10-21T22:00:00+05:30')).toBe('2026-10-21T22:00:00+05:30');
  });
});

// OW27-29 A ("Class keeps the plan; Start runs it"); App Overwatch 7215533652 on #2189, Q2 and Q3.
describe('classPlanStart', () => {
  const plan = (retired: boolean, hasBlocks: boolean) => ({ plan: { script_id: 'scr-2', name: 'Footwork night', retired, has_blocks: hasBlocks } });

  test('no class, a class with no plan, or a list without plans: nothing sent, no line', () => {
    expect(classPlanStart(undefined)).toEqual({ scriptId: null, line: null });
    expect(classPlanStart({ plan: null })).toEqual({ scriptId: null, line: null });
    expect(classPlanStart(klass('no-plan', -10, 50))).toEqual({ scriptId: null, line: null });
  });

  test('a plan with blocks, not retired: Start sends its id, and the screen names it', () => {
    expect(classPlanStart(plan(false, true))).toEqual({ scriptId: 'scr-2', line: 'This class runs the plan: Footwork night.' });
  });

  test('retired (Q2): starts without it, and says so', () => {
    expect(classPlanStart(plan(true, true))).toEqual({
      scriptId: null,
      line: "This class's plan, Footwork night, is retired, so this session starts without it.",
    });
  });

  test('no blocks (Q3): starts without it, and says so', () => {
    expect(classPlanStart(plan(false, false))).toEqual({
      scriptId: null,
      line: "This class's plan, Footwork night, has no blocks yet, so this session starts without it.",
    });
  });

  test('retired and with no blocks: the retired words', () => {
    expect(classPlanStart(plan(true, false))).toEqual({
      scriptId: null,
      line: "This class's plan, Footwork night, is retired, so this session starts without it.",
    });
  });
});
