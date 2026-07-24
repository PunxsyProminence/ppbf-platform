function fakeClient() {
  return { query: jest.fn() };
}

let currentClient: ReturnType<typeof fakeClient>;

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(currentClient)),
}));

jest.mock('./security', () => ({
  hashPin: jest.fn(async () => 'hashed-new-pin'),
  verifyPin: jest.fn(),
  createOpaqueToken: jest.fn(),
  hashToken: jest.fn(),
}));

import { resetAccountPin } from './auth';

afterEach(() => {
  jest.clearAllMocks();
});

describe('resetAccountPin', () => {
  test('changes the PIN and revokes sessions in the same transaction on success', async () => {
    currentClient = fakeClient();
    currentClient.query.mockResolvedValueOnce({ rows: [{ account_id: 'acct-1' }] }); // update ... returning
    currentClient.query.mockResolvedValueOnce({ rows: [] }); // revoke sessions

    await resetAccountPin('acct-1', '123456', 'org-1');

    expect(currentClient.query).toHaveBeenCalledTimes(2);
    const [updateSql, updateParams] = currentClient.query.mock.calls[0];
    expect(updateSql).toContain('update pilot.accounts');
    expect(updateSql).toContain('returning account_id');
    expect(updateParams).toEqual(['hashed-new-pin', 'acct-1', 'org-1']);

    const [revokeSql, revokeParams] = currentClient.query.mock.calls[1];
    expect(revokeSql).toContain('update pilot.session_tokens');
    expect(revokeSql).toContain('revoked_at = now()');
    expect(revokeParams).toEqual(['acct-1']);
  });

  test('never revokes sessions when the account is not found or not owned by this organization', async () => {
    currentClient = fakeClient();
    currentClient.query.mockResolvedValueOnce({ rows: [] }); // update ... returning finds nothing

    await expect(resetAccountPin('acct-1', '123456', 'org-other')).rejects.toThrow(
      'Account not found or cannot be reset',
    );

    // Only the update was attempted; the revoke step was never reached, so
    // a rolled-back transaction never revokes sessions it shouldn't have.
    expect(currentClient.query).toHaveBeenCalledTimes(1);
  });

  test('does not report success when the revoke step fails after the PIN update', async () => {
    currentClient = fakeClient();
    currentClient.query.mockResolvedValueOnce({ rows: [{ account_id: 'acct-1' }] }); // update succeeds
    currentClient.query.mockRejectedValueOnce(new Error('connection lost')); // revoke fails

    await expect(resetAccountPin('acct-1', '123456', 'org-1')).rejects.toThrow('connection lost');
  });
});
