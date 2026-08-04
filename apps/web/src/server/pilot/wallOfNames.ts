import {
  formatYmdInZone,
  renderWallName,
  resolveDisplayVisibility,
  wallKey,
  type WallAthleteRow,
  type WallNameMode,
  type WallNameVisibility,
  type WallWaiverRow,
} from './wallDisplay';

/**
 * THE WALL OF NAMES — everyone who has come through this gym, still up after
 * they have gone.
 *
 * Everything in this file is PURE: rows and a clock in, a board out. The reads
 * live in wallOfNamesDb.ts. Same split, and for the same reason, as
 * wallDisplay / wallDisplayDb: the gate that decides how much of a child's name
 * goes onto a surface the whole gym can see has to be unit-testable without a
 * database.
 *
 * ---------------------------------------------------------------------------
 * WHAT "CAME THROUGH" MEANS, HONESTLY
 * ---------------------------------------------------------------------------
 *
 * The schema has no join date and no leaving date. There is no membership
 * table, no enrolment record, no `left_at`. What actually exists is:
 *
 *   pilot.athletes.created_at   when the gym first entered this person into the
 *                               platform. Not the day they first walked in --
 *                               nothing records that -- but the closest thing
 *                               the database holds, and it is a real event with
 *                               a real timestamp rather than a derived guess.
 *   pilot.athletes.active_flag  whether they are on the roster right now.
 *   pilot.sessions              a training log, thin and recent.
 *
 * So "came through" is defined as HAS A ROW IN pilot.athletes, and the year a
 * person is filed under is the year of that row.
 *
 * The tempting alternative -- "logged at least one completed session" -- was
 * rejected deliberately. The session log only goes back as far as the software
 * does, so that definition would quietly erase everybody who trained here
 * before the platform existed and everybody whose coach logs on paper. A wall
 * built on it would be a record of the software, not of the gym, which is the
 * exact opposite of what a wall of names is for. The board says which
 * definition it used, in words, on the surface itself, so nobody has to guess
 * whether an absence means "never came" or "we did not have this yet".
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SURFACE MUST NEVER CARRY
 * ---------------------------------------------------------------------------
 *
 * No health, clearance, injury, readiness, medical, observation or disciplinary
 * fact -- the same list wallDisplay.ts refuses, refused again here and pinned
 * by wallOfNamesPrivacy.test.ts, because the failure mode is an addition in six
 * months rather than a decision today.
 *
 * AND NO PER-PERSON NUMBERS. Not a session count, not a years-here count, not a
 * milestone tally. achievementPaths.ts rule 2 -- nothing ranks one athlete
 * against another -- is a rule about the whole platform, and a shared board
 * showing "233" beside one child and "3" beside another is the single most
 * effective way to break it. The wall carries a name and a year. Totals for the
 * WHOLE wall are fine and are the point: they describe the lineage, not a
 * person's place in it.
 *
 * There is also no "left" and no "quit". A person who has gone is marked
 * `came_through`, which is the whole idea: the wall is where you stay.
 */

/** Where a person stands. Two values, neither of which is a judgement. */
export type WallOfNamesStanding = 'training' | 'came_through';

export interface WallOfNamesAthleteRow {
  readonly athlete_id: string;
  readonly full_name: string;
  readonly dob: string | null;
  readonly active_flag: boolean;
  /** pilot.athletes.created_at as text. The year of this is the year they are filed under. */
  readonly first_recorded_at: string | null;
}

export interface WallOfNamesEntry {
  /** Hashed, like the wall display's. An id list is a roster whatever the names beside it say. */
  readonly key: string;
  readonly name: string;
  readonly visibility: WallNameVisibility;
  readonly standing: WallOfNamesStanding;
}

export interface WallOfNamesYear {
  /** Null when the record carries no readable date. Rendered as such, never guessed. */
  readonly year: number | null;
  readonly entries: readonly WallOfNamesEntry[];
}

export interface WallOfNamesBoard {
  readonly generated_at: string;
  readonly time_zone: string;
  readonly name_mode: WallNameMode;
  /** Everyone with a record, whatever the mode did to their name. */
  readonly total_people: number;
  readonly total_training: number;
  readonly first_year: number | null;
  readonly last_year: number | null;
  readonly years: readonly WallOfNamesYear[];
  /** True when the read hit its cap, so the surface can say the list is partial. */
  readonly truncated: boolean;
}

/** How many rows the board will lay out. The read caps too; this is the backstop. */
export const WALL_OF_NAMES_MAX = 2000;

export interface WallOfNamesSources {
  readonly organizationId: string;
  readonly now: Date;
  readonly timeZone: string;
  readonly mode: WallNameMode;
  readonly athletes: readonly WallOfNamesAthleteRow[];
  readonly waivers: readonly WallWaiverRow[];
  /** True when the read returned its limit and there may be more. */
  readonly truncated?: boolean;
}

/**
 * The calendar year a timestamp falls in, in the GYM's zone.
 *
 * A record written at 8pm Eastern on 31 December is a UTC timestamp in the
 * following year. Filing that person under the wrong year on a wall about
 * lineage is a small error that is visible forever, so the same zone-aware
 * clock the wall display uses decides it here.
 */
export function yearInZone(timestamp: string | null | undefined, timeZone: string): number | null {
  if (typeof timestamp !== 'string') return null;
  const parsed = Date.parse(timestamp.trim());
  if (Number.isNaN(parsed)) return null;
  const year = Number(formatYmdInZone(new Date(parsed), timeZone).slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

export function buildWallOfNames(sources: WallOfNamesSources): WallOfNamesBoard {
  const { organizationId, now, timeZone, mode } = sources;

  const capped = sources.athletes.slice(0, WALL_OF_NAMES_MAX);

  // One consent decision per person, taken once. The same function the gym's
  // television uses -- imported, never re-implemented, so the two surfaces
  // cannot drift into disagreeing about the same child.
  const resolved = capped.map((athlete) => {
    const gate: WallAthleteRow = {
      athlete_id: athlete.athlete_id,
      full_name: athlete.full_name,
      dob: athlete.dob,
    };
    const { visibility } = resolveDisplayVisibility({
      athlete: gate,
      waivers: sources.waivers,
      now,
      mode,
    });

    return {
      key: wallKey(organizationId, athlete.athlete_id),
      // Sorted on the real name so the order is stable and alphabetical in the
      // room, then rendered at whatever the gate permits. Ordering by the
      // RENDERED string would shuffle the whole board the day one family signs
      // a release, and would leak nothing useful either way.
      sortName: (athlete.full_name ?? '').trim().toLowerCase(),
      name: renderWallName(athlete.full_name, visibility),
      visibility,
      standing: (athlete.active_flag ? 'training' : 'came_through') as WallOfNamesStanding,
      year: yearInZone(athlete.first_recorded_at, timeZone),
    };
  });

  const byYear = new Map<number | null, typeof resolved>();
  for (const person of resolved) {
    const bucket = byYear.get(person.year);
    if (bucket) bucket.push(person);
    else byYear.set(person.year, [person]);
  }

  // Oldest first. You read down the wall and arrive at your own year, which is
  // the whole feeling this surface exists to produce. The undated bucket goes
  // last because it is not a year and cannot be placed among them.
  const years: WallOfNamesYear[] = [...byYear.entries()]
    .sort((a, b) => {
      if (a[0] === null) return 1;
      if (b[0] === null) return -1;
      return a[0] - b[0];
    })
    .map(([year, people]) => ({
      year,
      entries: people
        .slice()
        .sort((a, b) => a.sortName.localeCompare(b.sortName) || a.key.localeCompare(b.key))
        .map<WallOfNamesEntry>((person) => ({
          key: person.key,
          name: person.name,
          visibility: person.visibility,
          standing: person.standing,
        })),
    }));

  const datedYears = years.map((group) => group.year).filter((year): year is number => year !== null);

  return {
    generated_at: now.toISOString(),
    time_zone: timeZone,
    name_mode: mode,
    total_people: resolved.length,
    total_training: resolved.filter((person) => person.standing === 'training').length,
    first_year: datedYears.length ? Math.min(...datedYears) : null,
    last_year: datedYears.length ? Math.max(...datedYears) : null,
    // Mode 'off' is "no names at all", exactly as it is on the television: the
    // wall becomes a count of people and a span of years, which is still a
    // truthful record of a lineage and identifies nobody.
    years: mode === 'off' ? [] : years,
    truncated: sources.truncated === true || sources.athletes.length > WALL_OF_NAMES_MAX,
  };
}
