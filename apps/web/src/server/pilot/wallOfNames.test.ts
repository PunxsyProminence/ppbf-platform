import { WALL_DISPLAY_CONSENT_TYPES } from './wallDisplay';
import type { WallWaiverRow } from './wallDisplay';
import {
  buildWallOfNames,
  yearInZone,
  type WallOfNamesAthleteRow,
} from './wallOfNames';

/**
 * The Wall of Names, tested where it is dangerous: the names.
 *
 * The consent gate itself belongs to wallDisplay.ts and is tested there. What
 * is tested here is that this surface actually goes through it, that nothing
 * about the grouping can promote a name past it, and that the board carries no
 * per-person number for anybody to rank children by.
 */

const NOW = new Date('2026-08-03T15:00:00.000Z');
const ZONE = 'America/New_York';

function athlete(overrides: Partial<WallOfNamesAthleteRow> = {}): WallOfNamesAthleteRow {
  return {
    athlete_id: 'ath-1',
    full_name: 'Marcus Ruiz',
    dob: '2012-04-02',
    active_flag: true,
    first_recorded_at: '2024-03-11T14:00:00.000Z',
    ...overrides,
  };
}

function displayWaiver(overrides: Partial<WallWaiverRow> = {}): WallWaiverRow {
  return {
    athlete_id: 'ath-1',
    waiver_type: 'wall_display_full_name',
    status: 'signed',
    signed_by_role: 'guardian',
    signed_at: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
}

function build(input: {
  athletes: WallOfNamesAthleteRow[];
  waivers?: WallWaiverRow[];
  mode?: 'off' | 'initials' | 'consent';
}) {
  return buildWallOfNames({
    organizationId: 'org-ppbf',
    now: NOW,
    timeZone: ZONE,
    mode: input.mode ?? 'initials',
    athletes: input.athletes,
    waivers: input.waivers ?? [],
  });
}

describe('the wall of names is names, and nothing else', () => {
  it('shows initials in the default mode, whatever the athlete signed', () => {
    // The two facts that make this the honest day-one outcome: the operator
    // switch defaults to 'initials', and no writer in the codebase produces a
    // wall_display_* waiver row at all.
    const board = build({
      athletes: [athlete()],
      waivers: [displayWaiver()],
    });

    expect(board.name_mode).toBe('initials');
    expect(board.years[0].entries[0]).toMatchObject({ name: 'M.R.', visibility: 'initials' });
  });

  it('reaches a real name only when the operator switch and a guardian release agree', () => {
    const board = build({
      athletes: [athlete()],
      waivers: [displayWaiver()],
      mode: 'consent',
    });

    expect(board.years[0].entries[0]).toMatchObject({ name: 'Marcus Ruiz', visibility: 'full_name' });
  });

  it('keeps a minor at initials when the release was signed by the gym rather than a guardian', () => {
    const board = build({
      athletes: [athlete()],
      waivers: [displayWaiver({ signed_by_role: 'admin' })],
      mode: 'consent',
    });

    expect(board.years[0].entries[0].name).toBe('M.R.');
  });

  it('keeps everyone at initials when there is no release at all', () => {
    const board = build({ athletes: [athlete()], mode: 'consent' });
    expect(board.years[0].entries[0].name).toBe('M.R.');
  });

  it('publishes no name at all when the operator switches names off', () => {
    const board = build({
      athletes: [
        athlete({ athlete_id: 'ath-1', full_name: 'Marcus Ruiz' }),
        athlete({ athlete_id: 'ath-2', full_name: 'Sofia Alvarez' }),
      ],
      mode: 'off',
    });

    expect(board.years).toEqual([]);
    // Not one letter of anybody's name, not even an initial.
    expect(JSON.stringify(board)).not.toMatch(/Marcus|Ruiz|Sofia|Alvarez|M\.R\.|S\.A\./);

    // The lineage survives as whole-wall aggregates, which name nobody: two
    // people, both training, in a year. That is still a truthful record of a
    // gym's history and it identifies no one, so 'off' does not blank it.
    expect(board.total_people).toBe(2);
    expect(board.total_training).toBe(2);
    expect(board.first_year).toBe(2024);
    expect(board.last_year).toBe(2024);
  });

  it('never puts a per-person number on the board', () => {
    // The rule this pins is achievementPaths.ts's: nothing ranks one athlete
    // against another. A session count beside a child's name on a shared board
    // is the most effective way to break it, so the entry shape must not have
    // anywhere to put one.
    const board = build({ athletes: [athlete()] });
    const entry = board.years[0].entries[0] as unknown as Record<string, unknown>;

    expect(Object.keys(entry).sort()).toEqual(['key', 'name', 'standing', 'visibility']);
    for (const value of Object.values(entry)) {
      expect(typeof value).not.toBe('number');
    }
  });

  it('never returns a raw athlete id', () => {
    // An id list is a roster whatever the names beside it say. The key is the
    // same hash the gym's television uses.
    const board = build({ athletes: [athlete()] });
    expect(JSON.stringify(board)).not.toContain('ath-1');
    expect(board.years[0].entries[0].key).toHaveLength(12);
  });

  it('names the consent vocabulary it shares with the television', () => {
    // A regression guard on the import rather than a copy: if wallDisplay.ts's
    // types ever change, this surface changes with it instead of drifting.
    expect(Object.keys(WALL_DISPLAY_CONSENT_TYPES)).toContain('wall_display_full_name');
  });
});

describe('who is on the wall, and where they sit', () => {
  it('keeps people who have gone, and marks them without judging them', () => {
    const board = build({
      athletes: [
        athlete({ athlete_id: 'ath-1', full_name: 'Aaron Diaz', active_flag: false }),
        athlete({ athlete_id: 'ath-2', full_name: 'Bea Kowalski', active_flag: true }),
      ],
    });

    const standings = board.years.flatMap((year) => year.entries.map((entry) => entry.standing));
    expect(standings.sort()).toEqual(['came_through', 'training']);
    expect(board.total_people).toBe(2);
    expect(board.total_training).toBe(1);

    // No 'left', no 'quit', no 'inactive'. The wall is where you stay.
    expect(JSON.stringify(board)).not.toMatch(/left|quit|inactive|dropped/i);
  });

  it('groups by the year the gym wrote them down, oldest first', () => {
    const board = build({
      athletes: [
        athlete({ athlete_id: 'a', full_name: 'Newer Person', first_recorded_at: '2025-02-01T12:00:00.000Z' }),
        athlete({ athlete_id: 'b', full_name: 'Older Person', first_recorded_at: '2019-11-04T12:00:00.000Z' }),
        athlete({ athlete_id: 'c', full_name: 'Middle Person', first_recorded_at: '2022-06-06T12:00:00.000Z' }),
      ],
    });

    expect(board.years.map((year) => year.year)).toEqual([2019, 2022, 2025]);
    expect(board.first_year).toBe(2019);
    expect(board.last_year).toBe(2025);
  });

  it('sorts within a year by the real name, so the order cannot move when a family signs a release', () => {
    const rows = [
      athlete({ athlete_id: 'z', full_name: 'Zoe Abbott' }),
      athlete({ athlete_id: 'a', full_name: 'Aaron Zeller' }),
    ];

    const initials = build({ athletes: rows });
    const named = build({
      athletes: rows,
      mode: 'consent',
      waivers: [
        displayWaiver({ athlete_id: 'z' }),
        displayWaiver({ athlete_id: 'a' }),
      ],
    });

    // "Aaron Zeller" precedes "Zoe Abbott" by real name; by rendered initials
    // "A.Z." also precedes "Z.A.", but only because the sort key is the real
    // name in both cases. The two orders must match.
    expect(initials.years[0].entries.map((e) => e.key)).toEqual(named.years[0].entries.map((e) => e.key));
    expect(named.years[0].entries.map((e) => e.name)).toEqual(['Aaron Zeller', 'Zoe Abbott']);
  });

  it('files an unreadable date under its own heading rather than guessing a year', () => {
    const board = build({
      athletes: [
        athlete({ athlete_id: 'dated', first_recorded_at: '2021-01-05T12:00:00.000Z' }),
        athlete({ athlete_id: 'undated', full_name: 'No Date', first_recorded_at: null }),
        athlete({ athlete_id: 'garbage', full_name: 'Bad Date', first_recorded_at: 'not a date' }),
      ],
    });

    expect(board.years.map((year) => year.year)).toEqual([2021, null]);
    expect(board.years[1].entries).toHaveLength(2);
    // An undated bucket must not drag the span of years anywhere.
    expect(board.first_year).toBe(2021);
    expect(board.last_year).toBe(2021);
  });

  it('files a late-December record in the gym’s year, not the server’s', () => {
    // 2024-01-01T02:00Z is 2023-12-31 at 9pm in Punxsutawney. A person entered
    // on the last night of the year belongs to that year on a wall about
    // lineage, and getting it wrong is visible forever.
    expect(yearInZone('2024-01-01T02:00:00.000Z', ZONE)).toBe(2023);
    expect(yearInZone('2024-01-01T02:00:00.000Z', 'UTC')).toBe(2024);
    expect(yearInZone(null, ZONE)).toBeNull();
    expect(yearInZone('nonsense', ZONE)).toBeNull();
  });

  it('is a finished object on the day nobody is on it', () => {
    const board = build({ athletes: [] });

    expect(board.total_people).toBe(0);
    expect(board.total_training).toBe(0);
    expect(board.years).toEqual([]);
    expect(board.first_year).toBeNull();
    expect(board.last_year).toBeNull();
    expect(board.truncated).toBe(false);
  });

  it('says so when the wall is longer than it will lay out', () => {
    const many = Array.from({ length: 2001 }, (_, index) =>
      athlete({ athlete_id: `ath-${index}`, full_name: `Person ${index}` }));

    const board = build({ athletes: many });
    expect(board.truncated).toBe(true);
    expect(board.total_people).toBe(2000);
  });
});
