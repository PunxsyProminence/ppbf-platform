import {
  deriveCredentialBand,
  getPersonClearanceForOrganization,
  listPersonClearancesForVerification,
  listStaffCredentialStatus,
  STAFF_CREDENTIAL_ROLES,
} from './clearanceRegister';
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
