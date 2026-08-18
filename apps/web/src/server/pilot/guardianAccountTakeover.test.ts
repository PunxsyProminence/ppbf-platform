/**
 * A GUARDIAN ROW IS A DOOR TO EVERY CHILD BEHIND IT.
 *
 * The intake routes take `parent_id` straight from the request body and check
 * only that it is non-empty. The athlete side of those routes is gated; the
 * parent side is not. That was survivable until you notice what a guardian row
 * carries: `guardian_links` to every child of that family, which
 * guardianAthleteIds() resolves into a parent portal's reach.
 *
 * So the old unconditional `account_id = excluded.account_id` meant an actor
 * with standing on ONE athlete could post another family's parent_id plus an
 * account they control, and inherit that guardian's links to children they have
 * no standing on -- while the real guardian, silently repointed, lost their own.
 *
 * These tests pin the three behaviours that keep sibling enrolment working
 * while closing that door. They assert on the SQL because the guard lives in the
 * ON CONFLICT clause: it has to be one atomic statement, since a read-then-write
 * would let two concurrent callers straddle the check.
 */

const queryMock = jest.fn();
jest.mock('./db', () => ({ query: (...args: unknown[]) => queryMock(...args) }));

import { GuardianAccountReassignmentError, upsertGuardian } from './intake';

const GUARDIAN = {
  organizationId: 'org-1',
  parentId: 'parent-1',
  fullName: 'A Guardian',
};

beforeEach(() => {
  queryMock.mockReset();
});

describe('upsertGuardian account takeover guard', () => {
  test('refuses to move a guardian already bound to another account', async () => {
    // No row comes back: the ON CONFLICT WHERE rejected the update.
    queryMock.mockResolvedValue([]);

    await expect(
      upsertGuardian({ ...GUARDIAN, accountId: 'attacker-account' }),
    ).rejects.toBeInstanceOf(GuardianAccountReassignmentError);
  });

  test('the refusal names the action rather than leaking whose record it is', async () => {
    queryMock.mockResolvedValue([]);

    const error = await upsertGuardian({ ...GUARDIAN, accountId: 'attacker-account' })
      .catch((e: unknown) => e as Error);

    // It must not disclose the real guardian's name, email or account.
    expect(error.message).toMatch(/staff-credentialing/i);
    expect(error.message).not.toMatch(/attacker-account/);
  });

  test('creating a guardian and re-linking one still succeed', async () => {
    queryMock.mockResolvedValue([{ parent_id: 'parent-1' }]);

    await expect(upsertGuardian({ ...GUARDIAN })).resolves.toBeUndefined();
    await expect(
      upsertGuardian({ ...GUARDIAN, accountId: 'same-account' }),
    ).resolves.toBeUndefined();
  });

  test('the guard is one atomic statement, not a read followed by a write', async () => {
    queryMock.mockResolvedValue([{ parent_id: 'parent-1' }]);
    await upsertGuardian({ ...GUARDIAN, accountId: 'acct-1' });

    // Two calls would mean a check-then-act race between concurrent writers.
    expect(queryMock).toHaveBeenCalledTimes(1);

    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toMatch(/on conflict/i);
    // Refuses the reassignment...
    expect(sql).toMatch(/where[\s\S]*account_id is null[\s\S]*account_id = excluded\.account_id/i);
    // ...and never nulls an existing link by omitting accountId.
    expect(sql).toMatch(/coalesce\(pilot\.parents\.account_id, excluded\.account_id\)/i);
    expect(sql).not.toMatch(/account_id = excluded\.account_id,/);
    expect(sql).toMatch(/returning parent_id/i);
  });
});
