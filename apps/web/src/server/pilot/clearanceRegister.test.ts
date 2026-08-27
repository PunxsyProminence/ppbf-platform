import {
  computeClearanceExpiry,
  deriveCredentialBand,
  getPersonClearanceForOrganization,
  listPersonClearancesForVerification,
  listStaffCredentialStatus,
  supersededClearanceState,
  STAFF_CREDENTIAL_ROLES,
  type PersonClearanceRow,
} from './clearanceRegister';
import { ClearanceStateConflictError } from './clearanceRegister';
import { query, queryOne } from './db';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

describe('deriveCredentialBand', () => {
  const today = new Date('2026-08-16T12:00:00Z');

  it('reads revoked, not_required, submitted and not_started off the stored status directly', () => {
    expect(deriveCredentialBand('revoked', null, today)).toBe('revoked');
    expect(deriveCredentialBand('not_required', null, today)).toBe('not_required');
    expect(deriveCredentialBand('submitted', null, today)).toBe('submitted');
    expect(deriveCredentialBand('not_started', null, today)).toBe('missing');
  });

  it('treats current with no expiry as simply current', () => {
    expect(deriveCredentialBand('current', null, today)).toBe('current');
  });

  it('treats current with a far-future expiry as current', () => {
    expect(deriveCredentialBand('current', '2027-06-01', today)).toBe('current');
  });

  it('flags current within the 30-day window as expiring_soon', () => {
    expect(deriveCredentialBand('current', '2026-09-01', today)).toBe('expiring_soon');
    // Exactly on the boundary (30 days out) still counts.
    expect(deriveCredentialBand('current', '2026-09-15', today)).toBe('expiring_soon');
  });

  it('treats current with a past expiry as expired -- the read-time sweep, no cron involved', () => {
    expect(deriveCredentialBand('current', '2026-01-01', today)).toBe('expired');
  });

  it('treats the stored expired status as expired even with no expiry date recorded', () => {
    expect(deriveCredentialBand('expired', null, today)).toBe('expired');
  });
});

describe('computeClearanceExpiry', () => {
  it('adds the validity in calendar months', () => {
    expect(computeClearanceExpiry('2026-01-15', 12)).toBe('2027-01-15');
    expect(computeClearanceExpiry('2026-08-16', 24)).toBe('2028-08-16');
  });

  it('returns null when the clearance type has no validity_months (does not expire)', () => {
    expect(computeClearanceExpiry('2026-01-15', null)).toBeNull();
  });

  it('returns null for an unparseable issued_on', () => {
    expect(computeClearanceExpiry('not-a-date', 12)).toBeNull();
  });
});

describe('listPersonClearancesForVerification', () => {
  it('scopes to the organization and orders submissions first', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await listPersonClearancesForVerification('org-1');

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('from pilot.person_clearances pc'),
      ['org-1'],
    );
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('where pc.organization_id = $1');
    expect(sql).toContain("order by pc.status = 'submitted' desc");
    expect(sql).not.toContain('activity_clearance_requirements');
  });
});

describe('getPersonClearanceForOrganization', () => {
  it('scopes the lookup to organization, person and clearance type together', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    const result = await getPersonClearanceForOrganization('org-1', 'acct-9', 'ct-safesport');

    expect(result).toBeNull();
    expect(mockQueryOne).toHaveBeenCalledWith(
      expect.stringContaining('where organization_id = $1 and person_account_id = $2 and clearance_type_id = $3'),
      ['org-1', 'acct-9', 'ct-safesport'],
    );
  });
});

describe('listStaffCredentialStatus', () => {
  it('defaults to the staff-credential role set and excludes document_ref from the query entirely', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await listStaffCredentialStatus('org-1');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['org-1', [...STAFF_CREDENTIAL_ROLES]]);
    expect(sql).not.toMatch(/document_ref/);
    expect(sql).not.toMatch(/verification_note/);
    expect(sql).not.toMatch(/verified_by_account_id/);
    expect(sql).toContain('cross join pilot.clearance_types ct');
  });

  it('accepts a narrower role list from the caller', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await listStaffCredentialStatus('org-1', ['coach']);

    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['org-1', ['coach']]);
  });
});

/**
 * recordPersonClearance upserts, so every write destroys the answer that was
 * there. This is the one shape in which that destroyed answer is preserved, and
 * three call sites use it -- admin verify, admin reject, coach self-upload --
 * so the key set is pinned here rather than three times over.
 */
describe('supersededClearanceState', () => {
  const ROW: PersonClearanceRow = {
    organization_id: 'org-1',
    clearance_id: 'clr-1',
    person_account_id: 'acct-9',
    clearance_type_id: 'ct-act34',
    status: 'current',
    issued_on: '2026-01-10',
    expires_on: '2031-01-10',
    document_ref: 'org-1/acct-9/ct-act34/cert.pdf',
    verified_by_account_id: 'admin-7',
    verified_at: '2026-01-12T09:00:00Z',
    verification_note: 'card checked in person',
    created_at: '2026-01-10T00:00:00Z',
    updated_at: '2026-01-12T09:00:00Z',
  };

  // Exactly these five, by name. "Was this adult cleared, from when, until
  // when, and who said so" is the question a safeguarding review asks of a
  // clearance that has since been overwritten; dropping one of them makes that
  // question half-answerable, which reads as answered.
  it('carries the five fields the overwrite destroys', () => {
    expect(supersededClearanceState(ROW)).toEqual({
      status: 'current',
      issued_on: '2026-01-10',
      expires_on: '2031-01-10',
      verified_by_account_id: 'admin-7',
      verified_at: '2026-01-12T09:00:00Z',
    });
  });

  // document_ref is the blob path and verification_note can carry a reviewer's
  // free text about a named adult. Neither is part of "was this person
  // cleared", and this event is written to a table an organization admin can
  // read, so neither goes in.
  it('carries neither the document path nor the verification note', () => {
    const state = supersededClearanceState(ROW) ?? {};
    expect(state).not.toHaveProperty('document_ref');
    expect(state).not.toHaveProperty('verification_note');
    expect(Object.keys(state)).toHaveLength(5);
  });

  // null, not a block of nulls: nothing was superseded, and an object of nulls
  // asserts that a record existed and was empty.
  it.each([[null], [undefined]])('returns null when there was no prior row (%p)', (previous) => {
    expect(supersededClearanceState(previous)).toBeNull();
  });

  it('preserves a never-verified prior row rather than flattening it to null', () => {
    const submitted: PersonClearanceRow = {
      ...ROW,
      status: 'submitted',
      issued_on: null,
      expires_on: null,
      verified_by_account_id: null,
      verified_at: null,
    };
    // A prior row that was never verified is still a prior row: "there was a
    // submission on file and it was replaced" is a different fact from "there
    // was nothing here".
    expect(supersededClearanceState(submitted)).not.toBeNull();
    expect(supersededClearanceState(submitted)).toMatchObject({ status: 'submitted' });
  });
});

/**
 * A clearance decision must not be a blind overwrite.
 *
 * recordPersonClearance's ON CONFLICT DO UPDATE had no state guard, and both
 * decision routes read the current row, decided, and then wrote
 * unconditionally. Two admins on stale pages both write and the later commit
 * silently wins.
 *
 * The compounding half is the audit trail. Both routes serialize
 * supersededClearanceState(existing) from the STALE read, so both audit events
 * claim they superseded the same prior state and nothing records that the
 * second overwrote the first's decision. The one mechanism designed to preserve
 * overwritten clearance history produces a false statement exactly when it
 * matters -- a post-incident "was this coach cleared, and until when" is
 * answered wrongly rather than not at all.
 *
 * These are SQL-shape and parameter assertions. The behaviour against a real
 * database is covered by clearanceRegister.pg.test.ts, run under its own
 * migration runner.
 */
// Reads the module source rather than mocking the driver: what is being pinned
// here is the SQL that ships, and a mocked query() would let the guard be
// deleted while these stayed green.
function readClearanceRegisterSource(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  return fs.readFileSync(path.join(__dirname, 'clearanceRegister.ts'), 'utf8');
}

describe('clearance decisions are compare-and-swap, not last-write-wins', () => {
  test('the upsert carries a state guard, so a moved row declines the write', () => {
    const sql = readClearanceRegisterSource();
    const upsert = sql.slice(sql.indexOf('on conflict (organization_id, person_account_id'));
    // The guard must be ON the conflict update, not merely present in the file.
    expect(upsert.slice(0, upsert.indexOf('returning'))).toMatch(
      /where \$11::text is null or pilot\.person_clearances\.status = \$11::text/,
    );
  });

  test('omitting expectedStatus still writes, so a first-ever record is unaffected', () => {
    // `$11 is null or ...` is the half that keeps this backward compatible.
    // Without the null branch, every caller that has no prior state to protect
    // would silently stop writing.
    const sql = readClearanceRegisterSource();
    expect(sql).toContain('$11::text is null');
  });

  test('a declined swap is reported as a conflict, not as a database failure', () => {
    const source = readClearanceRegisterSource();
    // The distinction is load-bearing: an admin told "the server broke" retries,
    // and the retry reads the NEW state and succeeds in overwriting a decision
    // they never saw. A 409 tells them to reload instead.
    expect(source).toContain('ClearanceStateConflictError');
    expect(source).toMatch(/if \(input\.expectedStatus != null\)/);
  });

  test('the conflict error carries 409 and a machine code, so it is not redacted', () => {
    // errors.ts: a plain Error means "redact me" and becomes an opaque 500.
    expect(new ClearanceStateConflictError('x').status).toBe(409);
    expect(new ClearanceStateConflictError('x').code).toBe('CLEARANCE_STATE_CONFLICT');
  });
});
