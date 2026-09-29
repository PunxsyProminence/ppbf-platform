/**
 * The role a seed loader records as created_by_role: the seed account's own,
 * read from pilot.accounts at run time.
 *
 * The drill-library and workout-template seed CSVs used to carry the role
 * themselves -- `platform_owner` on every row -- and their loaders wrote it as
 * given. Gym content is seeded as an organization_admin of the gym
 * (ppbf@punxsyprominence.org; OD-2026-09-28-005, OD-2026-09-28-007), so every
 * new row would have claimed a role its creator never held. The account row is
 * the one source for what role the account has; a seed file cannot know which
 * account will run it. import-shadow-research.mjs already reads it this way.
 *
 * Refuses rather than guessing. A missing account usually means a casing
 * mistake -- account_id is case-sensitive, and a third casing is a third
 * account -- and writing rows under an id nothing resolves to is the failure
 * worth stopping for.
 */
export async function resolveSeedAccountRole(client, seedAccountId) {
  const result = await client.query(
    'select role from pilot.accounts where account_id = $1',
    [seedAccountId],
  );
  const account = result.rows[0];
  if (!account) {
    throw new Error(
      `SEED_ACCOUNT_NOT_FOUND: no pilot.accounts row has account_id '${seedAccountId}'. `
      + 'account_id is case-sensitive; read the exact value from the target database '
      + '(check-database seed-identity).',
    );
  }

  const role = String(account.role ?? '').trim();
  if (!role) {
    throw new Error(
      `SEED_ACCOUNT_HAS_NO_ROLE: pilot.accounts row '${seedAccountId}' has no role, `
      + 'so there is nothing true to record as created_by_role.',
    );
  }
  return role;
}
