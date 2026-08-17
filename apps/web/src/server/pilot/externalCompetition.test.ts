// Unit coverage for the CAS-guarded lifecycle transition on external
// competition entries. Mocking convention mirrors compliance.test.ts's
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

import { withdrawCompetitionEntry } from './externalCompetition';

beforeEach(() => {
  currentClient = fakeClient();
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('withdrawCompetitionEntry', () => {
  test('CAS out of entered only, org-scoped, touching status alone', async () => {
    currentClient.query.mockResolvedValue({ rows: [{ entry_id: 'e1' }] });

    const applied = await withdrawCompetitionEntry({ organizationId: 'org-1', entryId: 'e1' });

    expect(applied).toBe(true);
    expect(currentClient.query).toHaveBeenCalledTimes(1);
    const [sql, params] = currentClient.query.mock.calls[0];
    expect(sql).toContain('update pilot.external_competition_entries');
    expect(sql).toContain("set status = 'withdrawn'");
    expect(sql).toContain("where organization_id = $1 and entry_id = $2 and status = 'entered'");
    expect(params).toEqual(['org-1', 'e1']);
    // Result and lesson_note are the separate, already-shipped feature --
    // withdrawal must never touch them.
    const setClause = sql.slice(sql.toLowerCase().indexOf('set '), sql.toLowerCase().indexOf('where'));
    expect(setClause).not.toContain('result');
    expect(setClause).not.toContain('lesson_note');
  });

  test('a stale state, foreign org, or missing entry_id reports false and writes nothing further', async () => {
    // Already-withdrawn, a cross-org id, a typo'd id, and a second
    // concurrent click all arrive as the same zero-row CAS miss.
    currentClient.query.mockResolvedValue({ rows: [] });

    const applied = await withdrawCompetitionEntry({ organizationId: 'org-1', entryId: 'e-gone' });

    expect(applied).toBe(false);
    expect(currentClient.query).toHaveBeenCalledTimes(1);
  });
});
