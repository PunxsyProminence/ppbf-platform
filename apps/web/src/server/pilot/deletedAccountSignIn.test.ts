// The one rule behind "sign-in refuses any account marked deleted"
// (OD-2026-09-29-003 Q9). The paths that read it are tested where they live
// (auth.loginTiming, auth.microsoftLogin, auth.sessionExpiry, magicLink) and
// against real Postgres in signInRefusesDeletedAccount.pg.test.ts.

import { accountDeletedSql, isDeletedAccount, type AccountDeletionFlag } from './deletedAccountSignIn';

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
