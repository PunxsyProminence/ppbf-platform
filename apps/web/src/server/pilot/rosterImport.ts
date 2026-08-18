import { insertAthleteIfAbsent } from './entities';
import { insertClubMemberIfAbsent, type ClubMembershipType } from './clubMembers';
import { query } from './db';

/**
 * Loading a gym's roster from a spreadsheet.
 *
 * Everything before this could onboard one athlete at a time, which is fine for
 * a demo and not fine for a coach holding a list of forty children on the first
 * night. This is the last structural gap between the platform and a gym full of
 * kids.
 *
 * IT ROUND-TRIPS WITH THE EXPORT. The headers it accepts are the headers
 * app/api/pilot/admin/export/roster/csv.ts emits, so a gym can export its
 * roster, correct it in a spreadsheet, and load it back. That includes undoing
 * the export's one alteration: a cell beginning `=`, `+`, `-` or `@` is written
 * with a leading apostrophe so a spreadsheet cannot execute it as a formula, and
 * reading it back has to strip that apostrophe or every such value would gain
 * one on each round trip.
 *
 * IT NEVER OVERWRITES. Every athlete is created through insertAthleteIfAbsent,
 * whose insert carries `on conflict do nothing` -- so an athlete_id already in
 * the gym is REPORTED as a collision and left exactly as it is. An import that
 * silently replaced a child's name, date of birth and coach assignment because
 * a spreadsheet reused an id would be the worst outcome available here, and it
 * is the one a naive upsert produces.
 *
 * IT CREATES NO CREDENTIALS. An imported athlete has a record and no way to
 * sign in. The PIN is issued afterwards through the PIN console, deliberately:
 * a bulk import that also minted forty credentials would be forty children able
 * to sign in before anyone had spoken to them.
 *
 * IT ALSO ACCEPTS NON-ATHLETE MEMBERS. A real dues-paying roster is not
 * athletes only -- the gym owner and other adults appear on it as
 * "Non-Athlete" (or one of the fitness-only categories) with a home address
 * and no training record. A row's `member_type` column decides the path: an
 * "Athlete" row (or a blank member_type, for backward compatibility with a
 * roster that has no such column) goes through the athlete-creation path
 * exactly as before; any other recognised member type creates a
 * pilot.club_members row ONLY -- no pilot.athletes row, no dob/weight
 * class/gym status/coach requirement, because none of those apply to a
 * person who is not training. Every row, athlete or not, gets a
 * pilot.club_members row whenever the file supplies membership/address data
 * for it, so an "Athlete" row's address and membership type live on that
 * shared table rather than being bolted onto pilot.athletes, which stays
 * training-specific. See pilot_slice_postgres_club_members_migration.sql for
 * the full reasoning.
 */

/** A row as the operator's spreadsheet gives it, before validation. */
export interface RosterImportRow {
  athlete_id: string;
  full_name: string;
  date_of_birth: string;
  weight_class: string;
  gym_status: string;
  emergency_contact_note: string;
  coach_account_id: string;
  /**
   * The roster's own "Mbr Type" column, raw (e.g. "Non-Athlete"), before
   * normalisation. Blank means "Athlete", for compatibility with a roster
   * that predates this column entirely.
   */
  member_type: string;
  address_line1: string;
  city: string;
  state: string;
  postal_code: string;
}

export type RosterRowOutcome = 'create' | 'skip_exists' | 'reject';

export interface RosterRowPlan {
  /** 1-based line number in the operator's file, header excluded. */
  line: number;
  athlete_id: string;
  full_name: string;
  outcome: RosterRowOutcome;
  /** Why, in words a person at the gym can act on. Empty when creating. */
  reason: string;
}

export interface RosterImportPlan {
  rows: RosterRowPlan[];
  counts: { create: number; skip_exists: number; reject: number };
}

/**
 * Header spellings this accepts, mapped to the field they fill.
 *
 * The export's own headers come first because round-tripping is the point. The
 * short forms are here because the first roster a gym types by hand will not
 * say "Emergency contact (roster field)", and refusing it over a header would
 * be refusing the only file they have.
 *
 * Compared case-insensitively with surrounding whitespace removed.
 */
const HEADER_ALIASES: Readonly<Record<string, keyof RosterImportRow>> = {
  'athlete id': 'athlete_id',
  athlete_id: 'athlete_id',
  id: 'athlete_id',
  'full name': 'full_name',
  full_name: 'full_name',
  name: 'full_name',
  'date of birth': 'date_of_birth',
  date_of_birth: 'date_of_birth',
  dob: 'date_of_birth',
  'weight class': 'weight_class',
  weight_class: 'weight_class',
  'gym status': 'gym_status',
  gym_status: 'gym_status',
  status: 'gym_status',
  'emergency contact (roster field)': 'emergency_contact_note',
  'emergency contact': 'emergency_contact_note',
  emergency_contact: 'emergency_contact_note',
  'coach account id': 'coach_account_id',
  coach_account_id: 'coach_account_id',
  coach: 'coach_account_id',
  // The real membership export's own id column names the roster entry, not
  // specifically an athlete -- it fills the same field 'id' already does,
  // because both an athlete row and a non-athlete member row are identified
  // by one id space in this file.
  'member id': 'athlete_id',
  member_id: 'athlete_id',
  'mbr type': 'member_type',
  'member type': 'member_type',
  member_type: 'member_type',
  'membership type': 'member_type',
  address: 'address_line1',
  'address line 1': 'address_line1',
  address_line1: 'address_line1',
  city: 'city',
  state: 'state',
  zip: 'postal_code',
  'zip code': 'postal_code',
  'postal code': 'postal_code',
  postal_code: 'postal_code',
};

/**
 * Raw "Mbr Type" spellings from the real export, mapped to the vocabulary
 * pilot.club_members.membership_type stores. Compared case-insensitively
 * with surrounding whitespace removed, matching HEADER_ALIASES' convention.
 */
const MEMBER_TYPE_ALIASES: Readonly<Record<string, ClubMembershipType>> = {
  athlete: 'athlete',
  'non-athlete': 'non_athlete',
  'non athlete': 'non_athlete',
  'junior fitness non-contact': 'junior_fitness_non_contact',
  'junior fitness non contact': 'junior_fitness_non_contact',
  'adult fitness non-contact': 'adult_fitness_non_contact',
  'adult fitness non contact': 'adult_fitness_non_contact',
};

const MEMBER_TYPE_LABEL = 'Athlete, Non-Athlete, Junior Fitness Non-Contact or Adult Fitness Non-Contact';

/**
 * Resolves a row's raw member_type to the stored vocabulary. Blank resolves
 * to 'athlete' -- a roster with no Mbr Type column at all is an all-athlete
 * roster, exactly what this importer already accepted before this column
 * existed. `null` means the value was present but not recognised.
 */
function resolveMemberType(raw: string): ClubMembershipType | null {
  if (!raw) return 'athlete';
  return MEMBER_TYPE_ALIASES[raw.trim().toLowerCase()] ?? null;
}

/**
 * pilot.athletes.gym_status is plain text with no database constraint, so this
 * list is the only thing holding the vocabulary together. It matches the roster
 * form on /admin/athletes exactly; a spreadsheet inventing a fourth spelling
 * would fragment every screen that groups by it.
 */
const GYM_STATUSES = new Set(['active', 'training', 'inactive']);

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * RFC 4180 by hand, because a roster is exactly the file that breaks a naive
 * split: a name with a comma, a note with a quoted phrase inside it, an address
 * spanning two lines. Handles CRLF and LF, doubled quotes inside quoted fields,
 * and a leading UTF-8 BOM.
 */
export function parseCsv(text: string): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let index = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (index < source.length) {
    const char = source[index];

    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      endField();
      index += 1;
      continue;
    }
    if (char === '\r') {
      // Swallow CRLF as one terminator; a lone CR also ends the row.
      endRow();
      index += source[index + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (char === '\n') {
      endRow();
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  // A file not ending in a newline still has a final row.
  if (field !== '' || row.length > 0) {
    endRow();
  }

  return rows.filter((entry) => entry.some((cell) => cell.trim() !== ''));
}

/**
 * Undoes the export's formula guard.
 *
 * escapeCsvField prefixes an apostrophe to any value starting with a character
 * a spreadsheet would evaluate. Without this, an export/import round trip adds
 * one apostrophe per cycle to those values.
 */
function stripFormulaGuard(value: string): string {
  if (value.startsWith("'") && ['=', '+', '-', '@', '\t', '\r'].includes(value.charAt(1))) {
    return value.slice(1);
  }
  return value;
}

export interface ParsedRoster {
  rows: RosterImportRow[];
  /** Header problems, which stop the whole file rather than one row. */
  fatal: string;
}

export function parseRosterCsv(text: string): ParsedRoster {
  const table = parseCsv(text);
  // The "Unsupported" prefix is load-bearing, not phrasing: jsonError maps a
  // message by its prefix, and anything unrecognised becomes a masked 500. A
  // person who pasted the wrong file would be told the server broke rather
  // than what is wrong with their spreadsheet.
  if (table.length === 0) {
    return { rows: [], fatal: 'Unsupported file: it has no rows in it.' };
  }

  const header = table[0].map((cell) => HEADER_ALIASES[cell.trim().toLowerCase()] ?? '');
  if (!header.includes('athlete_id') || !header.includes('full_name')) {
    return {
      rows: [],
      fatal:
        'Unsupported file: it needs at least an athlete id column and a full name column. '
        + 'A roster exported from this platform already has them.',
    };
  }

  const rows = table.slice(1).map((cells) => {
    const row: RosterImportRow = {
      athlete_id: '',
      full_name: '',
      date_of_birth: '',
      weight_class: '',
      gym_status: '',
      emergency_contact_note: '',
      coach_account_id: '',
      member_type: '',
      address_line1: '',
      city: '',
      state: '',
      postal_code: '',
    };
    header.forEach((field, column) => {
      if (field) {
        row[field] = stripFormulaGuard((cells[column] ?? '').trim());
      }
    });
    return row;
  });

  return { rows, fatal: '' };
}

/** Why this row cannot be created, or empty if it can. */
function rejectionReason(row: RosterImportRow, seen: Set<string>): string {
  if (!row.athlete_id) {
    return 'No athlete id.';
  }
  if (!row.full_name) {
    return 'No name.';
  }
  if (seen.has(row.athlete_id)) {
    return 'This athlete id appears more than once in the file.';
  }
  const memberType = resolveMemberType(row.member_type);
  if (memberType === null) {
    return `Membership type must be ${MEMBER_TYPE_LABEL}, not "${row.member_type}".`;
  }
  // Everything below is athlete-specific: a "not training" member type (e.g.
  // Non-Athlete) has no dob, weight class, gym status or coach requirement,
  // because none of those apply to a person who isn't an athlete here.
  if (memberType !== 'athlete') {
    return '';
  }
  // pilot.athletes.dob is `date not null`, so a missing one is not an
  // omission the import can absorb -- it is a row Postgres will refuse. It is
  // rejected HERE, in planning, so the operator sees it in the preview and
  // fixes the spreadsheet, rather than discovering it as a failed row after
  // pressing the button.
  if (!row.date_of_birth) {
    return 'No date of birth. The roster requires one for every athlete.';
  }
  // And it must be a calendar day. A spreadsheet's "3/14/12" would either be
  // refused by Postgres mid-import or, worse, read as a different day than the
  // one a parent wrote down.
  if (!CALENDAR_DAY.test(row.date_of_birth)) {
    return `Date of birth must look like 2012-03-14, not "${row.date_of_birth}".`;
  }
  if (row.gym_status && !GYM_STATUSES.has(row.gym_status)) {
    return `Gym status must be active, training or inactive, not "${row.gym_status}".`;
  }
  return '';
}

/**
 * What an import would do, decided before anything is written.
 *
 * The dry run and the real run share this function, so the preview a person
 * approves is produced by the same code that then acts -- rather than by a
 * second implementation that can disagree with it.
 */
export async function planRosterImport(
  organizationId: string,
  rows: readonly RosterImportRow[],
): Promise<RosterImportPlan> {
  const ids = rows.map((row) => row.athlete_id).filter((id) => id !== '');
  // Checked against BOTH tables an id can land in: an athlete-type row that
  // collides with an existing pilot.athletes row, or any row (athlete-type
  // or not) that collides with an existing pilot.club_members row. Either
  // collision must be reported and left alone, never silently overwritten.
  const existingAthleteRows = ids.length
    ? await query<{ athlete_id: string }>(
      'select athlete_id from pilot.athletes where organization_id = $1 and athlete_id = any($2::text[])',
      [organizationId, ids],
    )
    : [];
  const existingMemberRows = ids.length
    ? await query<{ member_id: string }>(
      'select member_id from pilot.club_members where organization_id = $1 and member_id = any($2::text[])',
      [organizationId, ids],
    )
    : [];
  const existing = new Set([
    ...existingAthleteRows.map((row) => row.athlete_id),
    ...existingMemberRows.map((row) => row.member_id),
  ]);

  const seen = new Set<string>();
  const planned: RosterRowPlan[] = rows.map((row, index) => {
    const reason = rejectionReason(row, seen);
    if (row.athlete_id) {
      seen.add(row.athlete_id);
    }

    if (reason) {
      return { line: index + 1, athlete_id: row.athlete_id, full_name: row.full_name, outcome: 'reject', reason };
    }
    if (existing.has(row.athlete_id)) {
      return {
        line: index + 1,
        athlete_id: row.athlete_id,
        full_name: row.full_name,
        outcome: 'skip_exists',
        reason: 'Already on the roster. Left exactly as it is.',
      };
    }
    return { line: index + 1, athlete_id: row.athlete_id, full_name: row.full_name, outcome: 'create', reason: '' };
  });

  return {
    rows: planned,
    counts: {
      create: planned.filter((row) => row.outcome === 'create').length,
      skip_exists: planned.filter((row) => row.outcome === 'skip_exists').length,
      reject: planned.filter((row) => row.outcome === 'reject').length,
    },
  };
}

interface CreatableRow {
  planned: RosterRowPlan;
  row: RosterImportRow;
}

/** True when a row carries anything for pilot.club_members to store. A file
 * with no member_type/address columns at all (every legacy roster) leaves
 * every row false, so no club_members row is ever written for it -- this
 * extension changes nothing for a file that predates it. */
function hasClubMemberData(row: RosterImportRow): boolean {
  return Boolean(
    row.member_type.trim()
    || row.address_line1.trim()
    || row.city.trim()
    || row.state.trim()
    || row.postal_code.trim(),
  );
}

/**
 * Attempts every eligible `create` row in ONE multi-row insert instead of one
 * round trip per row -- the common case, a roster where every row is a plain
 * athlete with no club_members data, is every bit as create-only and
 * collision-safe as the row-by-row version (same ON CONFLICT DO NOTHING, same
 * "returning tells you what actually landed" logic), just in a single
 * statement. It only knows how to write pilot.athletes, so a row needing a
 * pilot.club_members write (a non-athlete member type, or an athlete row that
 * also carries club-member data) is never handed to this function -- see the
 * batchEligible split in applyRosterImport.
 *
 * A single multi-row INSERT is all-or-nothing for anything ON CONFLICT does
 * NOT absorb (a bad foreign key, a type Postgres refuses) -- one such row
 * would abort every row in the batch, which is exactly the "row seven kills
 * the other thirty-nine" outcome applyRosterImport's caller must never see.
 * That failure mode is why this throws rather than trying to report a
 * partial result: the caller (applyRosterImport) catches it and re-runs the
 * same rows through createAthletesSequentially, which is the original
 * row-by-row code, unchanged, kept specifically as this fallback.
 */
async function createAthletesBatch(
  organizationId: string,
  toCreate: readonly CreatableRow[],
  now: string,
): Promise<RosterRowPlan[]> {
  const values: unknown[] = [organizationId, now];
  const tuples = toCreate.map(({ row }, index) => {
    const base = 3 + index * 7;
    values.push(
      row.athlete_id,
      row.full_name,
      row.date_of_birth,
      row.weight_class,
      row.gym_status || 'training',
      row.emergency_contact_note,
      row.coach_account_id,
    );
    // emergency_contact and emergency_contact_note both take the same
    // bound value ($${base + 5} twice) -- matching insertAthleteIfAbsent's
    // own single-row insert, which fills both columns from one field.
    return `($1, $${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 5}, true, $${base + 6}, $2, $2)`;
  });

  const inserted = await query<{ athlete_id: string }>(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, emergency_contact_note, active_flag, coach_id, created_at, updated_at)
     values ${tuples.join(', ')}
     on conflict (organization_id, athlete_id) do nothing
     returning athlete_id`,
    values,
  );
  const createdIds = new Set(inserted.map((row) => row.athlete_id));

  return toCreate.map(({ planned, row }) =>
    createdIds.has(row.athlete_id)
      ? { ...planned, outcome: 'create', reason: '' }
      : {
        ...planned,
        outcome: 'skip_exists',
        reason: 'Already on the roster by the time this ran. Left exactly as it is.',
      },
  );
}

/**
 * The original row-by-row import, extended to also create club_members rows.
 * One insert per row, so one bad row is reported and skipped while the rest
 * of the file still lands. Used directly for any row that needs
 * pilot.club_members handling (a non-athlete member type, or an athlete row
 * that also carries club-member data) -- the batch path above only knows how
 * to insert into pilot.athletes -- and as the recovery path when
 * createAthletesBatch's single statement fails for the pure-athlete rows it
 * was given.
 *
 * The insert can still lose a race it passed in planning, which is why the
 * return value of insertAthleteIfAbsent / insertClubMemberIfAbsent is honoured
 * rather than assumed: a row planned as `create` that finds the id taken is
 * reported as a collision, not as a creation that did not happen.
 *
 * `createdByAccountId` is the operator running the import (pilot.club_members
 * requires an actor, matching every other admin-authored record in this
 * schema); the route supplies it from the authenticated principal.
 */
async function createAthletesSequentially(
  organizationId: string,
  toCreate: readonly CreatableRow[],
  now: string,
  createdByAccountId: string,
): Promise<RosterRowPlan[]> {
  const applied: RosterRowPlan[] = [];

  for (const { planned, row } of toCreate) {
    // resolveMemberType cannot return null here: a row that reached `create`
    // already passed rejectionReason, which rejects an unrecognised value.
    const memberType = resolveMemberType(row.member_type) ?? 'athlete';

    try {
      if (memberType === 'athlete') {
        const created = await insertAthleteIfAbsent(organizationId, {
          athlete_id: row.athlete_id,
          full_name: row.full_name,
          // Guaranteed present and a calendar day by rejectionReason above;
          // the column is `date not null`.
          dob: row.date_of_birth,
          weight_class: row.weight_class,
          // 'training' rather than 'active': an imported athlete is on the
          // roster, not yet cleared to compete, and the gym should say so
          // deliberately rather than inherit it from a blank cell.
          gym_status: row.gym_status || 'training',
          emergency_contact: row.emergency_contact_note,
          active_flag: true,
          coach_id: row.coach_account_id,
          created_at: now,
          updated_at: now,
        });

        if (!created) {
          applied.push({
            ...planned,
            outcome: 'skip_exists',
            reason: 'Already on the roster by the time this ran. Left exactly as it is.',
          });
          continue;
        }

        // The athlete row is the one that matters for the reported outcome;
        // the club_members row is supplementary and only written when the
        // file actually supplied membership/address data for this person.
        // full_name stays null here on purpose -- it lives on pilot.athletes,
        // never duplicated (pilot_club_members_name_check enforces this).
        if (hasClubMemberData(row)) {
          await insertClubMemberIfAbsent(organizationId, {
            member_id: row.athlete_id,
            athlete_id: row.athlete_id,
            full_name: null,
            membership_type: 'athlete',
            address_line1: row.address_line1,
            city: row.city,
            state: row.state,
            postal_code: row.postal_code,
            created_by_account_id: createdByAccountId,
          });
        }

        applied.push({ ...planned, outcome: 'create', reason: '' });
      } else {
        // A non-athlete member type never touches pilot.athletes: no dob, no
        // weight class, no gym status, no coach -- none of those describe a
        // person who is not training here.
        const created = await insertClubMemberIfAbsent(organizationId, {
          member_id: row.athlete_id,
          athlete_id: null,
          full_name: row.full_name,
          membership_type: memberType,
          address_line1: row.address_line1,
          city: row.city,
          state: row.state,
          postal_code: row.postal_code,
          created_by_account_id: createdByAccountId,
        });

        applied.push(
          created
            ? { ...planned, outcome: 'create', reason: '' }
            : {
              ...planned,
              outcome: 'skip_exists',
              reason: 'Already on the roster by the time this ran. Left exactly as it is.',
            },
        );
      }
    } catch (error) {
      // One row's failure must not discard the rest of the file, and must not
      // be reported as a success.
      applied.push({
        ...planned,
        outcome: 'reject',
        reason: error instanceof Error ? error.message : 'Could not be created.',
      });
    }
  }

  return applied;
}

/**
 * Creates the athletes and/or club members the plan says to create.
 *
 * Every batch-eligible `create` row -- a plain athlete row with no
 * club_members data -- is attempted as one batched insert
 * (createAthletesBatch) when there is more than one, collapsing what used to
 * be up to MAX_ROWS round trips into one for the common case, a roster with
 * no bad rows and no club members. Anything the batch path cannot express (a
 * non-athlete member type, or an athlete row that also carries club-member
 * data) always goes through createAthletesSequentially instead, which is
 * also the automatic fallback if the batch statement itself fails. Either
 * way, row-by-row isolation is preserved exactly: a spreadsheet with one bad
 * row in it still gets every other row created and that one row reported,
 * never the whole file discarded.
 *
 * The insert can still lose a race it passed in planning, which is why the
 * return value is honoured rather than assumed: a row planned as `create`
 * that finds the id taken is reported as a collision, not as a creation
 * that did not happen. Re-running the same file is always safe because
 * creation is create-only.
 *
 * `createdByAccountId` is the operator running the import (pilot.club_members
 * requires an actor, matching every other admin-authored record in this
 * schema); the route supplies it from the authenticated principal.
 */
export async function applyRosterImport(
  organizationId: string,
  rows: readonly RosterImportRow[],
  plan: RosterImportPlan,
  createdByAccountId: string,
): Promise<RosterImportPlan> {
  const byLine = new Map(plan.rows.map((row) => [row.line, row]));
  const now = new Date().toISOString();

  const passthrough: RosterRowPlan[] = [];
  const toCreate: CreatableRow[] = [];

  rows.forEach((row, index) => {
    const planned = byLine.get(index + 1);
    if (!planned) return;
    if (planned.outcome !== 'create') {
      passthrough.push(planned);
      return;
    }
    toCreate.push({ planned, row });
  });

  // Only a plain athlete row with no club_members data at all can go through
  // the batched insert -- it only knows how to write pilot.athletes. A
  // non-athlete member type, or an athlete row that also carries
  // club-member data, needs the per-row path so the club_members write
  // actually happens.
  const batchEligibleSet = new Set(
    toCreate.filter(
      ({ row }) => (resolveMemberType(row.member_type) ?? 'athlete') === 'athlete' && !hasClubMemberData(row),
    ),
  );
  const batchEligible = toCreate.filter((entry) => batchEligibleSet.has(entry));
  const sequentialOnly = toCreate.filter((entry) => !batchEligibleSet.has(entry));

  let batchedRows: RosterRowPlan[] = [];
  if (batchEligible.length === 1) {
    batchedRows = await createAthletesSequentially(organizationId, batchEligible, now, createdByAccountId);
  } else if (batchEligible.length > 1) {
    try {
      batchedRows = await createAthletesBatch(organizationId, batchEligible, now);
    } catch {
      batchedRows = await createAthletesSequentially(organizationId, batchEligible, now, createdByAccountId);
    }
  }

  const sequentialRows = sequentialOnly.length > 0
    ? await createAthletesSequentially(organizationId, sequentialOnly, now, createdByAccountId)
    : [];

  // rows/passthrough/toCreate are all built from one forward pass over
  // `rows`, so every subset already carries the original line numbers --
  // sort the merge back into file order rather than re-deriving it.
  const applied = [...passthrough, ...batchedRows, ...sequentialRows].sort((a, b) => a.line - b.line);

  return {
    rows: applied,
    counts: {
      create: applied.filter((row) => row.outcome === 'create').length,
      skip_exists: applied.filter((row) => row.outcome === 'skip_exists').length,
      reject: applied.filter((row) => row.outcome === 'reject').length,
    },
  };
}
