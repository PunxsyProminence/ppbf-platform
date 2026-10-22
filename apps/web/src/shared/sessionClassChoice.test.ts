import { classesUnderWay, defaultClassChoice, instantMs, type TieableClassView } from './sessionClassChoice';

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
});
