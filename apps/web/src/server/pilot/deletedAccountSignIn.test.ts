// The one rule behind "sign-in refuses any account marked deleted"
// (OD-2026-09-29-003 Q9). The paths that read it are tested where they live
// (auth.loginTiming, auth.microsoftLogin, auth.sessionExpiry, magicLink) and
// against real Postgres in signInRefusesDeletedAccount.pg.test.ts.

import {
  accountDeletedSql,
  deletedLoginConflict,
  isDeletedAccount,
  refuseIfLoginDeleted,
  type AccountDeletionFlag,
} from './deletedAccountSignIn';

describe('accountDeletedSql', () => {
  test('reads deleted_at on the row under the given alias', () => {
    expect(accountDeletedSql('a')).toBe('(a.deleted_at is not null)');
    expect(accountDeletedSql('acct')).toBe('(acct.deleted_at is not null)');
  });

  test.each(['a; drop table pilot.accounts', 'a.b', '', 'A'])(
    'refuses %p, which is not a plain alias',
    (alias) => {
      expect(() => accountDeletedSql(alias)).toThrow('is not a plain SQL alias');
    },
  );
});

describe('isDeletedAccount fails closed', () => {
  test('only an explicit false admits', () => {
    expect(isDeletedAccount({ account_deleted: false })).toBe(false);
    expect(isDeletedAccount({ account_deleted: true })).toBe(true);
  });

  // A query that forgot to select the flag, or a driver that returned null,
  // must refuse rather than admit.
  test.each([
    ['missing', {}],
    ['null', { account_deleted: null }],
    ['a string', { account_deleted: 'false' }],
  ])('a flag that is %s counts as deleted', (_label, row) => {
    expect(isDeletedAccount(row as unknown as AccountDeletionFlag)).toBe(true);
  });
});

// OD-2026-09-30-004 e2: an admin action on a deleted login is refused. The
// writes that carry the rule are tested against real Postgres in
// deletedLoginAdminActions.pg.test.ts; this is the one message and the lookup
// that names the reason.
describe('deletedLoginConflict', () => {
  test('is a 409 with a code, naming the login the caller gave', () => {
    const refusal = deletedLoginConflict('acct-1');

    expect(refusal).toMatchObject({ status: 409, code: 'DELETED_LOGIN' });
    expect(refusal.message).toBe(
      'Conflict: the login "acct-1" was deleted. A deleted login cannot sign in and nothing here changes it; '
      + 'a deletion is not undone from the app. A returning person needs a new login: a new account_id, or for a '
      + 'staff or guardian login a different email address, because the deleted login keeps its own.',
    );
  });
});

describe('refuseIfLoginDeleted', () => {
  function clientAnswering(rows: unknown[]) {
    return { query: jest.fn(async () => ({ rows })) };
  }

  test('throws the refusal when the lookup finds a deleted login', async () => {
    const client = clientAnswering([{ found: 1 }]);

    await expect(refuseIfLoginDeleted(client, 'acct-1', 'org-1')).rejects.toMatchObject({ code: 'DELETED_LOGIN' });
  });

  test('returns when it finds none, so the caller raises the error it always raised', async () => {
    await expect(refuseIfLoginDeleted(clientAnswering([]), 'acct-1', 'org-1')).resolves.toBeUndefined();
  });

  // The scoping is what keeps one gym's admin from learning that an account
  // in another gym exists and was deleted.
  test('scopes the lookup to the organization it is given, and only a platform route passes null', async () => {
    const client = clientAnswering([]);

    await refuseIfLoginDeleted(client, 'acct-1', 'org-1');
    await refuseIfLoginDeleted(client, 'acct-1', null);

    const [sql, params] = client.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('($2::text is null or a.organization_id = $2)');
    expect(sql).toContain('and (a.deleted_at is not null)');
    expect(params).toEqual(['acct-1', 'org-1']);
    expect((client.query.mock.calls[1] as unknown as [string, unknown[]])[1]).toEqual(['acct-1', null]);
  });
});
