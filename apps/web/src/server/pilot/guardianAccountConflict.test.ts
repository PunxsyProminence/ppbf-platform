// Intake could silently move a guardian record to a different login.
//
// upsertGuardian's on-conflict clause was `account_id = coalesce(excluded.
// account_id, pilot.parents.account_id)`: an omitted account_id kept the link,
// but a SUPPLIED one replaced it. Naming an existing parent_id with another
// login therefore re-pointed the record -- the real parent lost every child
// linked to it and the new login gained them, with no error anywhere.
//
// The SQL itself is proved against a real database in guardianUpsert.pg.test.ts.
// These pin the code around it: the statement carries the guard and asks for
// the written row back, an empty result is refused as a 409 naming the
// conflict, and the pre-write check review-action runs refuses the same case
// before anything is written.

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { query, queryOne } from './db';
import { PilotError } from './errors';
import { jsonError } from './http';
import { assertGuardianAccountUnchanged, upsertGuardian } from './intake';

const mockQuery = jest.mocked(query);
const mockQueryOne = jest.mocked(queryOne);

afterEach(() => {
  jest.clearAllMocks();
});

const GUARDIAN = {
  organizationId: 'org-1',
  parentId: 'parent-1',
  accountId: 'acct-new-login',
  fullName: 'Guardian One',
};

describe('upsertGuardian never re-points a guardian record to another login', () => {
  test('the write only updates when the account link is empty, omitted, or unchanged, and returns what it wrote', async () => {
    mockQuery.mockResolvedValueOnce([{ parent_id: 'parent-1' }]);

    await upsertGuardian(GUARDIAN);

    const [sql, params] = mockQuery.mock.calls[0];
    const normalized = String(sql).replace(/\s+/g, ' ');
    expect(normalized).toContain(
      'where pilot.parents.account_id is null or excluded.account_id is null or pilot.parents.account_id = excluded.account_id',
    );
    expect(normalized).toContain('returning parent_id');
    expect(params).toEqual(['org-1', 'parent-1', 'acct-new-login', 'Guardian One', null, null]);
  });

  test('when the guard leaves nothing written, the write is refused as a 409 naming the conflict', async () => {
    mockQuery.mockResolvedValueOnce([]);

    const refusal = await upsertGuardian(GUARDIAN).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(PilotError);
    expect((refusal as PilotError).status).toBe(409);
    expect((refusal as PilotError).code).toBe('GUARDIAN_ACCOUNT_CONFLICT');
    expect((refusal as Error).message).toMatch(/^Conflict: guardian record "parent-1" is already linked to another login account, not "acct-new-login"\./);

    // And the route boundary discloses it rather than masking it as a 500.
    const response = jsonError(refusal);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('already linked to another login account');
  });

  test('a write that returns its row is accepted', async () => {
    mockQuery.mockResolvedValueOnce([{ parent_id: 'parent-1' }]);

    await expect(upsertGuardian({ ...GUARDIAN, accountId: undefined })).resolves.toBeUndefined();
  });
});

describe('assertGuardianAccountUnchanged refuses before any write', () => {
  test('an existing record linked to a different login is refused', async () => {
    mockQueryOne.mockResolvedValueOnce({ account_id: 'acct-real-parent' });

    await expect(assertGuardianAccountUnchanged(GUARDIAN)).rejects.toMatchObject({
      status: 409,
      code: 'GUARDIAN_ACCOUNT_CONFLICT',
    });

    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(String(sql)).toContain('from pilot.parents where organization_id = $1 and parent_id = $2');
    expect(params).toEqual(['org-1', 'parent-1']);
  });

  test('the same login restated is allowed', async () => {
    mockQueryOne.mockResolvedValueOnce({ account_id: 'acct-new-login' });

    await expect(assertGuardianAccountUnchanged(GUARDIAN)).resolves.toBeUndefined();
  });

  test('a record with no login yet may be given one', async () => {
    mockQueryOne.mockResolvedValueOnce({ account_id: null });

    await expect(assertGuardianAccountUnchanged(GUARDIAN)).resolves.toBeUndefined();
  });

  test('a new guardian record is allowed', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    await expect(assertGuardianAccountUnchanged(GUARDIAN)).resolves.toBeUndefined();
  });

  test('no account_id supplied means nothing to move, and nothing is read', async () => {
    await expect(assertGuardianAccountUnchanged({ ...GUARDIAN, accountId: undefined })).resolves.toBeUndefined();
    expect(mockQueryOne).not.toHaveBeenCalled();
  });
});
