// Unit coverage for the CAS-guarded lifecycle transition on wrestling
// league roster entries. Mocking convention mirrors compliance.test.ts's
// coverage of transitionComplianceViolation -- the model this transition was
// built from.

function fakeClient() {
  return { query: jest.fn().mockResolvedValue({ rows: [] }) };
}

let currentClient: ReturnType<typeof fakeClient>;

jest.mock('./db', () => ({
  ...jest.requireActual('./db'),
  query: jest.fn(async () => []),
  queryOne: jest.fn(async () => null),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(currentClient)),
}));

import { withdrawLeagueRosterEntry } from './wrestlingLeague';

beforeEach(() => {
  currentClient = fakeClient();
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('withdrawLeagueRosterEntry', () => {
  test('CAS out of active only, org-scoped, touching status alone', async () => {
    currentClient.query.mockResolvedValue({ rows: [{ entry_id: 'entry-1' }] });

    const applied = await withdrawLeagueRosterEntry({ organizationId: 'org-1', entryId: 'entry-1' });

    expect(applied).toBe(true);
    expect(currentClient.query).toHaveBeenCalledTimes(1);
    const [sql, params] = currentClient.query.mock.calls[0];
    expect(sql).toContain('update pilot.wrestling_league_roster_entries');
    expect(sql).toContain("set status = 'inactive'");
    expect(sql).toContain("where organization_id = $1 and entry_id = $2 and status = 'active'");
    expect(params).toEqual(['org-1', 'entry-1']);
  });

  test('a stale state, foreign org, or missing entry_id reports false and writes nothing further', async () => {
    // Already-inactive, a cross-org id, a typo'd id, and a second
    // concurrent click all arrive as the same zero-row CAS miss.
    currentClient.query.mockResolvedValue({ rows: [] });

    const applied = await withdrawLeagueRosterEntry({ organizationId: 'org-1', entryId: 'entry-gone' });

    expect(applied).toBe(false);
    expect(currentClient.query).toHaveBeenCalledTimes(1);
  });
});
