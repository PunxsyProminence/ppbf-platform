import { query } from './db';
import { findDuplicateGuardianGroups, maskEmail } from './duplicateGuardians';

// The privacy posture is the contract: emails leave this module MASKED, the
// query is scoped to one organization, and hidden athletes are a set
// difference (a sibling reachable through a claimed row is not "hidden").
// The underlying query logic has real-Postgres coverage in
// duplicateGuardianCheck.pg.test.ts against the CI script's identical shape.

jest.mock('./db', () => ({ query: jest.fn() }));

const mockQuery = query as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

describe('maskEmail', () => {
  test('keeps one character and the domain, masks the rest', () => {
    expect(maskEmail('guardian@example.org')).toBe('g*******@example.org');
    expect(maskEmail('a@b.co')).toBe('a*@b.co');
  });

  test('a missing or malformed address never throws', () => {
    expect(maskEmail(null)).toBe('(none)');
    expect(maskEmail('not-an-email')).toBe('not-an-email');
  });
});

describe('findDuplicateGuardianGroups', () => {
  test('scopes every CTE to the organization and returns masked emails only', async () => {
    mockQuery.mockResolvedValue([
      {
        email_sample: 'guardian@example.org',
        record_count: 2,
        claimed_count: 1,
        unclaimed_count: 1,
        account_ids: ['acct-1'],
        parent_ids: ['par-a', 'par-b'],
        hidden_athlete_ids: ['ath-2'],
      },
    ]);

    const groups = await findDuplicateGuardianGroups('org-1');

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['org-1']);
    // Both scans are org-filtered -- pilot.parents and pilot.guardian_links.
    expect((sql.match(/organization_id = \$1/g) ?? []).length).toBe(2);
    expect(sql).toContain('having count(distinct parent_id) > 1');
    expect(sql).toContain('except');

    expect(groups).toEqual([{
      email: 'g*******@example.org',
      record_count: 2,
      claimed_count: 1,
      unclaimed_count: 1,
      account_ids: ['acct-1'],
      parent_ids: ['par-a', 'par-b'],
      hidden_athlete_ids: ['ath-2'],
    }]);
    // The raw address appears nowhere in the result.
    expect(JSON.stringify(groups)).not.toContain('guardian@example.org');
  });
});
