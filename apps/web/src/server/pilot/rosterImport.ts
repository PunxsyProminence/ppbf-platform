import { insertAthleteIfAbsent } from './entities';
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
};

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
  const existingRows = ids.length
    ? await query<{ athlete_id: string }>(
      'select athlete_id from pilot.athletes where organization_id = $1 and athlete_id = any($2::text[])',
      [organizationId, ids],
    )
    : [];
  const existing = new Set(existingRows.map((row) => row.athlete_id));

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

/**
 * Creates the athletes the plan says to create.
 *
 * Row by row rather than one transaction, deliberately. A roster of forty typed
 * by hand will have a bad row in it, and failing the whole file for row seven
 * means the operator fixes one cell and re-runs all forty -- every time. Each
 * row stands alone, the outcome of every row is reported, and re-running the
 * same file is safe because creation is create-only.
 *
 * The insert can still lose a race it passed in planning, which is why the
 * return value of insertAthleteIfAbsent is honoured rather than assumed: a row
 * planned as `create` that finds the id taken is reported as a collision, not
 * as a creation that did not happen.
 */
export async function applyRosterImport(
  organizationId: string,
  rows: readonly RosterImportRow[],
  plan: RosterImportPlan,
): Promise<RosterImportPlan> {
  const byLine = new Map(plan.rows.map((row) => [row.line, row]));
  const now = new Date().toISOString();
  const applied: RosterRowPlan[] = [];

  for (const [index, row] of rows.entries()) {
    const planned = byLine.get(index + 1);
    if (!planned || planned.outcome !== 'create') {
      if (planned) {
        applied.push(planned);
      }
      continue;
    }

    try {
      const created = await insertAthleteIfAbsent(organizationId, {
        athlete_id: row.athlete_id,
        full_name: row.full_name,
        // Guaranteed present and a calendar day by rejectionReason above; the
        // column is `date not null`.
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

      applied.push(
        created
          ? { ...planned, outcome: 'create', reason: '' }
          : {
            ...planned,
            outcome: 'skip_exists',
            reason: 'Already on the roster by the time this ran. Left exactly as it is.',
          },
      );
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

  return {
    rows: applied,
    counts: {
      create: applied.filter((row) => row.outcome === 'create').length,
      skip_exists: applied.filter((row) => row.outcome === 'skip_exists').length,
      reject: applied.filter((row) => row.outcome === 'reject').length,
    },
  };
}
