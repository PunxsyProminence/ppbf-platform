/**
 * The roster export's column contract and its serializer.
 *
 * Kept separate from the route so the set of columns that can leave the
 * platform is one list, in one place, that a test can read. The serializer
 * emits EXACTLY these columns and nothing else: it reads named keys off each
 * row rather than iterating the row's own properties, so a query that later
 * selects an extra field cannot widen the export by accident. That is the
 * property roster.export.test.ts asserts, because the fields that must never
 * appear here -- a PIN, a PIN hash, a session token -- all live one join away
 * in pilot.accounts and pilot.session_tokens.
 */

export interface RosterExportRow {
  athlete_id: string;
  full_name: string;
  date_of_birth: string | null;
  weight_class: string | null;
  gym_status: string | null;
  active: boolean | null;
  coach_account_id: string | null;
  coach_email: string | null;
  emergency_contact_note: string | null;
  emergency_contact_name: string | null;
  emergency_contact_relationship: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_email: string | null;
  guardian_count: number | null;
  guardians: string | null;
  athlete_login_id: string | null;
  athlete_login_active: boolean | null;
  /** present / (present + absent), rounded to 3 places; null when never marked. See attendanceReporting.ts#computeAttendanceRate. */
  attendance_rate: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface RosterExportColumn {
  readonly key: keyof RosterExportRow;
  readonly header: string;
}

export const ROSTER_EXPORT_COLUMNS: readonly RosterExportColumn[] = [
  { key: 'athlete_id', header: 'Athlete ID' },
  { key: 'full_name', header: 'Full name' },
  { key: 'date_of_birth', header: 'Date of birth' },
  { key: 'weight_class', header: 'Weight class' },
  { key: 'gym_status', header: 'Gym status' },
  { key: 'active', header: 'Active' },
  { key: 'coach_account_id', header: 'Coach account ID' },
  { key: 'coach_email', header: 'Coach email' },
  { key: 'emergency_contact_note', header: 'Emergency contact (roster field)' },
  { key: 'emergency_contact_name', header: 'Emergency contact name' },
  { key: 'emergency_contact_relationship', header: 'Emergency contact relationship' },
  { key: 'emergency_contact_phone', header: 'Emergency contact phone' },
  { key: 'emergency_contact_email', header: 'Emergency contact email' },
  { key: 'guardian_count', header: 'Guardians on file' },
  { key: 'guardians', header: 'Guardians' },
  { key: 'athlete_login_id', header: 'Athlete sign-in ID' },
  { key: 'athlete_login_active', header: 'Athlete sign-in active' },
  { key: 'attendance_rate', header: 'Attendance rate' },
  { key: 'created_at', header: 'Record created' },
  { key: 'updated_at', header: 'Record updated' },
];

// Excel reads a UTF-8 file without this as if it were the local code page,
// which turns every accented name in the gym into mojibake. The roster is a
// list of children's names; getting them wrong is not cosmetic. Written as an
// escape rather than a literal because U+FEFF is invisible in a source file.
export const UTF8_BOM = '\uFEFF';

// A spreadsheet evaluates a cell beginning with any of these as a formula, so a
// value typed into the platform could execute when the export is opened. The
// leading apostrophe below makes the cell literal text. It is visible in the
// file, it is the only alteration the export makes to a stored value, and the
// export page says so.
const FORMULA_LEAD_CHARACTERS = ['=', '+', '-', '@', '\t', '\r'];

export function formatRosterCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

// Every field is quoted, always. Conditional quoting means deciding, per value,
// whether a separator or a newline is present -- and a name, a note or an
// address is exactly the kind of value that eventually contains one.
export function escapeCsvField(value: unknown): string {
  const formatted = formatRosterCell(value);
  const guarded = FORMULA_LEAD_CHARACTERS.includes(formatted.charAt(0))
    ? `'${formatted}`
    : formatted;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/**
 * Serializes rows into RFC 4180 CSV using CRLF line endings, which is what
 * every spreadsheet on a coach's laptop expects.
 *
 * A roster with no athletes produces the header row and nothing else. That is
 * a truthful empty export; the caller is responsible for telling the person
 * that it contained no athletes rather than letting an empty file read as a
 * finding.
 */
export function buildRosterCsv(rows: readonly RosterExportRow[]): string {
  const lines = [ROSTER_EXPORT_COLUMNS.map((column) => escapeCsvField(column.header)).join(',')];

  for (const row of rows) {
    lines.push(ROSTER_EXPORT_COLUMNS.map((column) => escapeCsvField(row[column.key])).join(','));
  }

  return `${UTF8_BOM}${lines.join('\r\n')}\r\n`;
}

/**
 * Builds the download filename.
 *
 * Sanitized to ASCII word characters because it is written into a
 * Content-Disposition header, where a quote or a newline in an organization id
 * would be a header injection rather than an odd filename.
 */
export function rosterExportFilename(organizationId: string, now: Date): string {
  const slug = organizationId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    || 'organization';
  const stamp = now.toISOString().slice(0, 10);
  return `ppbf-roster-${slug}-${stamp}.csv`;
}
