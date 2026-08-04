import { createHash } from 'node:crypto';

/**
 * THE WALL DISPLAY — the board the gym's TV points at.
 *
 * Everything in this file is PURE: it takes rows and a clock and returns the
 * board. The reads live in wallDisplayDb.ts. The split is not tidiness -- the
 * consent gate below decides whether a child's name goes up on a screen in a
 * public room, and that decision has to be unit-testable without a database.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCREEN MUST NEVER CARRY
 *
 * No readiness score, no medical clearance state, no injury or pain report, no
 * coach observation, no attendance status other than "present", no discipline.
 * The platform holds all of that (pilot.readiness, pilot.medical_intake,
 * pilot.coach_observations, pilot.scheduler_attendance.note), and none of it is
 * read here. wallDisplay.privacy.test.ts asserts that by scanning this module
 * and wallDisplayDb.ts for the forbidden table and column names, because the
 * failure mode is somebody adding a "useful" field in six months, not somebody
 * doing it today.
 *
 * Absence is not a hint either: an athlete who is not on the floor list is
 * simply not on it. There is no "absent" or "excused" row, because on a wall
 * those read as a public record of who did not turn up.
 * ---------------------------------------------------------------------------
 */

/**
 * The Fibonacci ladder from TrainingCard.tsx. Duplicated rather than imported
 * because that module is a 'use client' React component and a server read has
 * no business pulling React in. wallDisplay.test.ts imports both and asserts
 * they are identical, so the duplicate cannot drift silently.
 */
export const WALL_MILESTONES = [5, 13, 34, 89, 233] as const;

/** How much of a name may go on the wall. Ordered least to most revealing. */
export type WallNameVisibility = 'initials' | 'first_name' | 'full_name';

const VISIBILITY_RANK: Record<WallNameVisibility, number> = {
  initials: 0,
  first_name: 1,
  full_name: 2,
};

/**
 * THE CONSENT GATE.
 *
 * Read this before changing anything below it.
 *
 * The platform's existing consent capture does NOT cover "displayed on a screen
 * in the gym". What exists is:
 *
 *   - pilot.waivers          a generic signed-document record with a freeform
 *                            `waiver_type`, a `consent_version`, a `status` and
 *                            a `signed_by_role`. Every writer in the codebase
 *                            defaults waiver_type to 'general' (see
 *                            app/api/pilot/intake/domain-upsert/route.ts), so
 *                            no row in the wild names a display release.
 *   - public_interest_submissions.consent_to_contact
 *                            an adult prospect agreeing to be CONTACTED after
 *                            filling in the public web form. Not an athlete,
 *                            and not about display.
 *   - publications check_type 'consent'
 *                            a review checkbox on published research.
 *
 * None of that is a release to put a child's name in front of a room. So this
 * gate is built to be satisfied only by a waiver row that says so in as many
 * words -- the two `waiver_type` strings below -- and to fall to initials in
 * every other case, including every case it cannot read. Until an intake screen
 * writes one of these types, the honest outcome is that everyone shows as
 * initials, and that is the correct default rather than a gap.
 */
export const WALL_DISPLAY_CONSENT_TYPES: Readonly<
  Record<string, Exclude<WallNameVisibility, 'initials'>>
> = {
  wall_display_first_name: 'first_name',
  wall_display_full_name: 'full_name',
};

/**
 * A waiver `status` is freeform text, so this is an allow-list and not a
 * deny-list: an unrecognised status is a refusal. 'pending' is deliberately
 * absent -- a release that has been started is not a release that was given.
 */
const AFFIRMATIVE_WAIVER_STATUS = new Set([
  'signed',
  'active',
  'accepted',
  'approved',
  'complete',
  'completed',
  'current',
]);

/**
 * Who may give this release for a minor. A child cannot consent to their own
 * publication, and neither can the gym: 'admin', 'coach' and 'staff' are
 * deliberately absent, so an administrator cannot promote a kid's name onto the
 * wall by signing a form on their behalf.
 */
const GUARDIAN_SIGNER_ROLES = new Set([
  'guardian',
  'legal_guardian',
  'parent',
  'mother',
  'father',
  'grandparent',
  'foster_parent',
]);

/**
 * A release for a child goes stale. There is no expiry column on pilot.waivers,
 * so age is measured from signed_at: a family that agreed to this three years
 * ago has not agreed to it today. One year matches the registration cycle a gym
 * already runs.
 */
export const DISPLAY_CONSENT_MAX_AGE_DAYS = 365;

export const ADULT_AGE_YEARS = 18;

/**
 * The operator-level switch, on top of the per-athlete gate.
 *
 *   off       no names at all. The floor list reports a headcount only.
 *   initials  everyone is initials, whatever their waivers say. The default.
 *   consent   the per-athlete gate below decides, and can reach a real name.
 *
 * Default is 'initials' rather than 'consent' on purpose: turning real names on
 * is then two deliberate acts by two different people -- an operator setting
 * PPBF_WALL_DISPLAY_NAMES=consent, and a guardian signing a release naming this
 * screen. Neither alone is enough, and neither happens by forgetting something.
 */
export type WallNameMode = 'off' | 'initials' | 'consent';

export function resolveWallNameMode(raw: string | undefined | null): WallNameMode {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'off' || value === 'consent') {
    return value;
  }
  // Anything unrecognised -- a typo, an empty string, 'true' -- lands on the
  // conservative middle rung rather than on the most revealing one.
  return 'initials';
}

export interface WallWaiverRow {
  readonly athlete_id: string;
  readonly waiver_type: string;
  readonly status: string;
  readonly signed_by_role: string;
  readonly signed_at: string | null;
}

export interface WallAthleteRow {
  readonly athlete_id: string;
  readonly full_name: string;
  readonly dob: string | null;
}

export type WallConsentReason =
  | 'mode_off'
  | 'mode_initials'
  | 'no_display_consent'
  | 'consent_withdrawn'
  | 'consent_expired'
  | 'consent_undated'
  | 'signer_not_guardian'
  | 'granted';

export interface WallConsentDecision {
  readonly visibility: WallNameVisibility;
  readonly reason: WallConsentReason;
}

/** Age in whole years, or null when the date of birth is missing or unreadable. */
export function ageInYears(dob: string | null | undefined, now: Date): number | null {
  if (typeof dob !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  let age = now.getUTCFullYear() - year;
  const monthNow = now.getUTCMonth() + 1;
  const dayNow = now.getUTCDate();
  if (monthNow < month || (monthNow === month && dayNow < day)) {
    age -= 1;
  }
  return age;
}

/**
 * Unknown age is treated as a minor. A gym whose records are incomplete must
 * not have that read as "adult, publish freely".
 */
export function isMinor(dob: string | null | undefined, now: Date): boolean {
  const age = ageInYears(dob, now);
  return age === null || age < ADULT_AGE_YEARS;
}

/**
 * Resolve how much of one athlete's name may go up.
 *
 * The rule is "the latest statement wins, and silence is a refusal":
 *
 *   1. Take every waiver row whose waiver_type names this screen. Nothing else
 *      counts -- a signed medical waiver or a 'general' release is not
 *      permission to publish a name.
 *   2. Take the most recent of them by signed_at. That row, and only that row,
 *      decides -- so a withdrawal supersedes an earlier grant, and a fresh
 *      grant supersedes an earlier withdrawal, without either being permanent.
 *      A tie on signed_at resolves to the more restrictive row.
 *   3. That row must be affirmative, dated, in the past, and inside the
 *      staleness window.
 *   4. For a minor -- or for anyone whose date of birth is missing -- it must
 *      also have been signed by a guardian.
 *
 * Every failure lands on 'initials'. There is no path from a read error, a
 * missing row or an unparseable date to a real name.
 */
export function resolveDisplayVisibility(input: {
  readonly athlete: WallAthleteRow;
  readonly waivers: readonly WallWaiverRow[];
  readonly now: Date;
  readonly mode: WallNameMode;
}): WallConsentDecision {
  const { athlete, waivers, now, mode } = input;

  if (mode === 'off') return { visibility: 'initials', reason: 'mode_off' };
  if (mode === 'initials') return { visibility: 'initials', reason: 'mode_initials' };

  const relevant = waivers.filter(
    (row) =>
      row.athlete_id === athlete.athlete_id &&
      Object.prototype.hasOwnProperty.call(
        WALL_DISPLAY_CONSENT_TYPES,
        normalize(row.waiver_type),
      ),
  );

  if (relevant.length === 0) {
    return { visibility: 'initials', reason: 'no_display_consent' };
  }

  const latest = pickLatestStatement(relevant);

  const signedAtMs = latest.signed_at ? Date.parse(latest.signed_at) : Number.NaN;
  if (Number.isNaN(signedAtMs)) {
    return { visibility: 'initials', reason: 'consent_undated' };
  }

  if (!AFFIRMATIVE_WAIVER_STATUS.has(normalize(latest.status))) {
    return { visibility: 'initials', reason: 'consent_withdrawn' };
  }

  // A future-dated signature is not a signature yet, and is the shape a clock
  // skew or a bad import takes.
  const ageMs = now.getTime() - signedAtMs;
  if (ageMs < 0 || ageMs > DISPLAY_CONSENT_MAX_AGE_DAYS * 86_400_000) {
    return { visibility: 'initials', reason: 'consent_expired' };
  }

  if (isMinor(athlete.dob, now) && !GUARDIAN_SIGNER_ROLES.has(normalize(latest.signed_by_role))) {
    return { visibility: 'initials', reason: 'signer_not_guardian' };
  }

  const granted = WALL_DISPLAY_CONSENT_TYPES[normalize(latest.waiver_type)];
  return { visibility: granted, reason: 'granted' };
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * The newest statement, with ties broken toward the least revealing row so two
 * rows written in the same second can never resolve upward by accident.
 */
function pickLatestStatement(rows: readonly WallWaiverRow[]): WallWaiverRow {
  return rows.reduce((best, row) => {
    const bestAt = best.signed_at ? Date.parse(best.signed_at) : Number.NaN;
    const rowAt = row.signed_at ? Date.parse(row.signed_at) : Number.NaN;

    // An undated row is unusable, so a dated one always beats it; two undated
    // rows keep the first, which is unusable either way.
    if (Number.isNaN(rowAt)) return best;
    if (Number.isNaN(bestAt)) return row;

    if (rowAt > bestAt) return row;
    if (rowAt < bestAt) return best;

    const bestScope = WALL_DISPLAY_CONSENT_TYPES[normalize(best.waiver_type)] ?? 'initials';
    const rowScope = WALL_DISPLAY_CONSENT_TYPES[normalize(row.waiver_type)] ?? 'initials';
    return VISIBILITY_RANK[rowScope] < VISIBILITY_RANK[bestScope] ? row : best;
  });
}

/**
 * Render a name at the permitted level. Initials carry no separator dots beyond
 * the periods, so "Marcus Ruiz" reads "M.R." across a room and tells a stranger
 * nothing.
 */
export function renderWallName(fullName: string, visibility: WallNameVisibility): string {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    // A blank name is a data problem, not a person to identify. Say nothing.
    return '—';
  }

  if (visibility === 'full_name') return parts.join(' ');
  if (visibility === 'first_name') return parts[0];

  return `${parts
    .map((part) => part[0]?.toUpperCase())
    .filter(Boolean)
    .join('.')}.`;
}

/**
 * A stable, non-identifying key for React and for de-duplication. The raw
 * athlete_id never leaves the server: this endpoint is reachable without a
 * session, and an id list is a roster even when the names beside it are
 * initials.
 */
export function wallKey(organizationId: string, athleteId: string): string {
  return createHash('sha256').update(`${organizationId}:${athleteId}`).digest('hex').slice(0, 12);
}

/* ------------------------------------------------------------------ clock -- */

/**
 * The gym's day, not the server's. A container running in UTC rolls over at
 * 8pm Eastern, which on a screen in Punxsutawney means the evening class
 * disappears off "today" while it is still running.
 */
export function gymDayBounds(now: Date, timeZone: string): { startUtc: Date; endUtc: Date; ymd: string } {
  const ymd = formatYmdInZone(now, timeZone);
  const startUtc = zonedMidnightUtc(ymd, timeZone);
  const endUtc = new Date(startUtc.getTime() + 86_400_000);
  return { startUtc, endUtc, ymd };
}

function zoneParts(instant: Date, timeZone: string): number[] {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const found: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') found[part.type] = part.value;
  }
  // Intl renders midnight as hour 24 in the h23-with-hour12:false combination
  // on some engines; normalising it here keeps the arithmetic below honest.
  const hour = Number(found.hour) % 24;
  return [Number(found.year), Number(found.month), Number(found.day), hour, Number(found.minute), Number(found.second)];
}

/** Move an ISO calendar day by whole days. Calendar arithmetic, no zone. */
export function shiftYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const moved = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return `${String(moved.getUTCFullYear()).padStart(4, '0')}-${String(moved.getUTCMonth() + 1).padStart(2, '0')}-${String(moved.getUTCDate()).padStart(2, '0')}`;
}

export function formatYmdInZone(instant: Date, timeZone: string): string {
  const [y, m, d] = zoneParts(instant, timeZone);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * The UTC instant of local midnight on a given calendar day. Solved twice
 * because the offset that applies at the answer is the offset that must be
 * used to find it -- one pass lands an hour out on the two days a year the
 * clocks move.
 */
function zonedMidnightUtc(ymd: string, timeZone: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const naiveUtc = Date.UTC(y, m - 1, d, 0, 0, 0);

  let guess = new Date(naiveUtc);
  for (let i = 0; i < 2; i += 1) {
    const [gy, gm, gd, gh, gmin, gs] = zoneParts(guess, timeZone);
    const seenAsUtc = Date.UTC(gy, gm - 1, gd, gh, gmin, gs);
    const offset = seenAsUtc - guess.getTime();
    guess = new Date(naiveUtc - offset);
  }
  return guess;
}

/* ------------------------------------------------------------ the board --- */

export type WallSessionState = 'upcoming' | 'now' | 'done' | 'cancelled';

export interface WallClassRow {
  readonly class_id: string;
  readonly title: string;
  readonly start_at: string;
  readonly end_at: string;
  readonly location: string;
  readonly status: string;
}

export interface WallAttendanceRow {
  readonly athlete_id: string;
  readonly class_id: string;
  readonly checked_in_at: string;
}

/** One athlete's Nth completed session, as ranked by the read. */
export interface WallCrossingRow {
  readonly athlete_id: string;
  readonly session_number: number;
  readonly crossed_on: string;
}

export interface WallNoticeRow {
  readonly message: string;
  readonly author_name: string;
  readonly author_role: string;
  readonly created_at: string;
  readonly kind: string;
}

export interface WallSession {
  readonly key: string;
  readonly title: string;
  readonly start_at: string;
  readonly end_at: string;
  readonly location: string;
  readonly state: WallSessionState;
  readonly on_floor: number;
}

export interface WallPerson {
  readonly key: string;
  readonly name: string;
  readonly visibility: WallNameVisibility;
}

export interface WallMilestone {
  readonly key: string;
  readonly name: string;
  readonly visibility: WallNameVisibility;
  readonly milestone: number;
  readonly crossed_on: string;
}

export interface WallNotice {
  readonly message: string;
  readonly author: string;
  readonly posted_at: string;
}

export interface WallBoard {
  readonly generated_at: string;
  readonly gym_day: string;
  readonly time_zone: string;
  readonly name_mode: WallNameMode;
  readonly sessions: readonly WallSession[];
  readonly on_floor: readonly WallPerson[];
  readonly on_floor_total: number;
  readonly marquee: readonly WallMilestone[];
  readonly notice: WallNotice | null;
}

/** How far back a crossing still counts as news worth putting up. */
export const MARQUEE_WINDOW_DAYS = 14;
/** Hard caps, so a busy night cannot push the layout off a 16:9 screen. */
export const MARQUEE_MAX = 8;
export const ON_FLOOR_MAX = 18;

export interface WallBoardSources {
  readonly organizationId: string;
  readonly now: Date;
  readonly timeZone: string;
  readonly mode: WallNameMode;
  readonly classes: readonly WallClassRow[];
  readonly attendance: readonly WallAttendanceRow[];
  readonly athletes: readonly WallAthleteRow[];
  readonly waivers: readonly WallWaiverRow[];
  readonly crossings: readonly WallCrossingRow[];
  readonly notices: readonly WallNoticeRow[];
}

export function buildWallBoard(sources: WallBoardSources): WallBoard {
  const { organizationId, now, timeZone, mode } = sources;
  const { ymd } = gymDayBounds(now, timeZone);

  const athletesById = new Map(sources.athletes.map((a) => [a.athlete_id, a]));

  // One consent decision per athlete, reused by the floor list and the
  // marquee, so those two panels can never disagree about the same child.
  const nameFor = (athleteId: string): { key: string; name: string; visibility: WallNameVisibility } => {
    const key = wallKey(organizationId, athleteId);
    const athlete = athletesById.get(athleteId);
    if (!athlete) {
      // A check-in whose athlete row did not come back. Show the presence, not
      // a guess at who it is.
      return { key, name: '—', visibility: 'initials' };
    }
    const { visibility } = resolveDisplayVisibility({ athlete, waivers: sources.waivers, now, mode });
    return { key, name: renderWallName(athlete.full_name, visibility), visibility };
  };

  const perClass = new Map<string, number>();
  const seenOnFloor = new Set<string>();
  for (const row of sources.attendance) {
    perClass.set(row.class_id, (perClass.get(row.class_id) ?? 0) + 1);
    seenOnFloor.add(row.athlete_id);
  }

  const sessions = [...sources.classes]
    .sort((a, b) => a.start_at.localeCompare(b.start_at))
    .map<WallSession>((row) => ({
      key: row.class_id,
      title: row.title,
      start_at: row.start_at,
      end_at: row.end_at,
      location: row.location,
      state: sessionState(row, now),
      on_floor: perClass.get(row.class_id) ?? 0,
    }));

  // Newest check-in first: the person who just walked in is the one worth
  // seeing appear.
  const orderedFloor: string[] = [];
  for (const row of [...sources.attendance].sort((a, b) => b.checked_in_at.localeCompare(a.checked_in_at))) {
    if (!orderedFloor.includes(row.athlete_id)) orderedFloor.push(row.athlete_id);
  }

  const onFloor: WallPerson[] =
    mode === 'off'
      ? []
      : orderedFloor.slice(0, ON_FLOOR_MAX).map((athleteId) => {
          const { key, name, visibility } = nameFor(athleteId);
          return { key, name, visibility };
        });

  const marquee = selectMarquee(sources.crossings, now, timeZone).map<WallMilestone>((row) => {
    const { key, name, visibility } = nameFor(row.athlete_id);
    return {
      key: `${key}-${row.session_number}`,
      name,
      visibility,
      milestone: row.session_number,
      crossed_on: row.crossed_on,
    };
  });

  return {
    generated_at: now.toISOString(),
    gym_day: ymd,
    time_zone: timeZone,
    name_mode: mode,
    sessions,
    on_floor: onFloor,
    on_floor_total: seenOnFloor.size,
    marquee,
    notice: pickNotice(sources.notices),
  };
}

function sessionState(row: WallClassRow, now: Date): WallSessionState {
  if (normalize(row.status) === 'cancelled') return 'cancelled';
  const start = Date.parse(row.start_at);
  const end = Date.parse(row.end_at);
  if (Number.isNaN(start) || Number.isNaN(end)) return 'upcoming';
  if (now.getTime() < start) return 'upcoming';
  if (now.getTime() >= end) return 'done';
  return 'now';
}

/**
 * Which crossings are news. A row only counts if its rank is an actual rung of
 * the ladder -- the read is a coarse filter and this is the authority -- and if
 * it happened inside the window. Newest and largest first, so a 233 outranks a
 * 5 crossed the same day.
 */
export function selectMarquee(
  crossings: readonly WallCrossingRow[],
  now: Date,
  timeZone: string,
): WallCrossingRow[] {
  const rungs = new Set<number>(WALL_MILESTONES);
  // A crossing is dated by CALENDAR DAY (pilot.sessions.date), not by an
  // instant, so the window is compared day-to-day. Both ends are ISO
  // YYYY-MM-DD, where lexical order is chronological order.
  const today = gymDayBounds(now, timeZone).ymd;
  const earliest = shiftYmd(today, -(MARQUEE_WINDOW_DAYS - 1));

  return crossings
    .filter((row) => {
      if (!rungs.has(row.session_number)) return false;
      const day = (row.crossed_on ?? '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
      // A future-dated session is a data problem, not news.
      return day >= earliest && day <= today;
    })
    .sort(
      (a, b) =>
        b.crossed_on.localeCompare(a.crossed_on) ||
        b.session_number - a.session_number ||
        a.athlete_id.localeCompare(b.athlete_id),
    )
    .slice(0, MARQUEE_MAX);
}

/**
 * The gym's own voice. A 'notice' is the standing operational line and wins; a
 * 'motivation' is what goes up when there is no notice. Both are already
 * written for the gym_notices placement, which is the same copy the signed-out
 * login page shows the public -- so nothing reaches this screen that was not
 * already meant for people who are not signed in.
 */
export function pickNotice(rows: readonly WallNoticeRow[]): WallNotice | null {
  const byRecency = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const chosen =
    byRecency.find((row) => normalize(row.kind) === 'notice') ??
    byRecency.find((row) => normalize(row.kind) === 'motivation') ??
    byRecency[0];

  if (!chosen || !chosen.message.trim()) return null;

  return {
    message: chosen.message.trim(),
    author: [chosen.author_name, chosen.author_role].filter((part) => part && part.trim()).join(' · '),
    posted_at: chosen.created_at,
  };
}
