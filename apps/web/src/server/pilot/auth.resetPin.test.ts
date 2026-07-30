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

import { activateAccountPin, resetAccountPin } from './auth';

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

  // The admin UI promises "they will have to choose a new one when they sign in",
  // and its "back to the starting PIN" button resets to the published
  // DEFAULT_FIRST_LOGIN_PIN. Without must_change_pin the promise was false and
  // the reset handed out full access on a PIN anybody can read.
  test('forces a PIN change, because a reset PIN is always known to someone else', async () => {
    currentClient = fakeClient();
    currentClient.query.mockResolvedValueOnce({ rows: [{ account_id: 'acct-1' }] });
    currentClient.query.mockResolvedValueOnce({ rows: [] });

    await resetAccountPin('acct-1', '123456', 'org-1');

    const [updateSql] = currentClient.query.mock.calls[0];
    expect(updateSql).toContain('must_change_pin = true');
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

  test('rejects reset for non-athlete accounts', async () => {
    currentClient = fakeClient();
    currentClient.query.mockResolvedValueOnce({ rows: [] });

    await expect(resetAccountPin('coach-1', '123456', 'org-1')).rejects.toThrow(
      'Account not found or cannot be reset',
    );

    expect(currentClient.query).toHaveBeenCalledTimes(1);
  });

  test('does not report success when the revoke step fails after the PIN update', async () => {
    currentClient = fakeClient();
    currentClient.query.mockResolvedValueOnce({ rows: [{ account_id: 'acct-1' }] }); // update succeeds
    currentClient.query.mockRejectedValueOnce(new Error('connection lost')); // revoke fails

    await expect(resetAccountPin('acct-1', '123456', 'org-1')).rejects.toThrow('connection lost');
  });

  test('rejects policy-invalid PIN values before attempting any write', async () => {
    currentClient = fakeClient();

    await expect(resetAccountPin('acct-1', '12ab', 'org-1')).rejects.toThrow('PIN must contain only digits');
    expect(currentClient.query).not.toHaveBeenCalled();
  });
});

describe('activateAccountPin', () => {
  test('activates athlete account PIN, enables membership, and revokes existing sessions in one transaction', async () => {
    currentClient = fakeClient();
    currentClient.query.mockResolvedValueOnce({ rows: [{ account_id: 'ath-acct-1' }] });
    currentClient.query.mockResolvedValueOnce({ rows: [] });
    currentClient.query.mockResolvedValueOnce({ rows: [] });

    await activateAccountPin('ath-acct-1', '123456', 'org-1');

    expect(currentClient.query).toHaveBeenCalledTimes(3);
    const [updateSql, updateParams] = currentClient.query.mock.calls[0];
    expect(updateSql).toContain('update pilot.accounts');
    expect(updateSql).toContain('active_flag = true');
    expect(updateParams).toEqual(['hashed-new-pin', 'ath-acct-1', 'org-1']);

    const [membershipSql, membershipParams] = currentClient.query.mock.calls[1];
    expect(membershipSql).toContain('insert into pilot.organization_memberships');
    expect(membershipSql).toContain('active_flag = true');
    expect(membershipParams).toEqual(['ath-acct-1', 'org-1']);

    const [revokeSql, revokeParams] = currentClient.query.mock.calls[2];
    expect(revokeSql).toContain('update pilot.session_tokens');
    expect(revokeParams).toEqual(['ath-acct-1']);
  });

  test('rejects activation when account is outside organization scope', async () => {
    currentClient = fakeClient();
    currentClient.query.mockResolvedValueOnce({ rows: [] });

    await expect(activateAccountPin('ath-acct-1', '123456', 'org-2')).rejects.toThrow(
      'Account not found or cannot be activated',
    );
    expect(currentClient.query).toHaveBeenCalledTimes(1);
  });
});
