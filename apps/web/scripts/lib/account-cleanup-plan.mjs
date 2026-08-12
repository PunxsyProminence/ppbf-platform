// Decides, for every row in pilot.accounts, whether it is kept, held for the
// owner's confirmation, or retired.
//
// WHY THIS IS A SEPARATE, PURE MODULE
//
// The handoff that produced this work
// (docs/PLATFORM_EVIDENCE_BASELINE_HANDOFF.md, open question 7) ends with
// "Do not delete accounts without confirming each one." The confirming is the
// hard part, not the deleting: the production account table holds the platform
// owner, two gym admins, the owner's own active login, an outlook identity, a
// local probe account, a Danielle@/danielle@ case-collision pair, and 28
// inactive rows left behind by the July gate runs. A single SQL predicate
// cannot tell those apart, and a predicate that got it wrong would take the
// owner's own way back in with it.
//
// So the decision lives here, as a pure function over rows with no database and
// no clock, and accountCleanupPlan.test.ts asserts each rule against fixtures
// that mirror the real table. The runner
// (scripts/pilot-cleanup-accounts.mjs) does the connecting, the printing and
// the writing, and holds no policy of its own.
//
// NOTHING HERE HARD-DELETES. "Retire" means soft delete: deleted_at set,
// active_flag cleared, sessions revoked. That is deliberate on two counts --
// most of the ~30 tables referencing pilot.accounts(account_id) do so WITHOUT
// `on delete cascade`, so a hard delete would either fail on a foreign key or
// null out audit history; and pilot-cleanup-deleted-data.mjs already owns hard
// deletion, after a retention window, with its own guards.

/**
 * The four identities the owner wants to survive the cleanup.
 *
 * `coach@` is on the list as "possibly" in the handoff. It is kept here rather
 * than retired, because keeping an account the owner turns out not to want
 * costs one more line in a later run, and retiring one they did want costs a
 * restore.
 */
export const KEEP_LOGIN_EMAILS = Object.freeze([
  'admin@punxsyprominence.org',
  'ppbf@punxsyprominence.org',
  'danielle@punxsyprominence.org',
  'coach@punxsyprominence.org',
]);

/**
 * Identities that are active, are not on the keep list, and that the owner has
 * not ruled on. They are never retired by a plain run -- naming one in
 * `alsoRetire` is what "confirming each one" looks like at the command line.
 */
export const HOLD_IDENTITIES = Object.freeze([
  // The owner's own active organization_admin of audit-test-gym3.
  'neeko@punxsyprominence.org',
  'jason.c.neale@outlook.com',
  'admin-local-probe',
]);

/** Roles that can administer an organization, for the last-admin guard. */
const ADMIN_ROLES = Object.freeze(['platform_owner', 'organization_admin', 'admin']);

export const DISPOSITIONS = Object.freeze(['keep', 'hold', 'retire', 'skip']);

function normalize(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * An account matches a named identity by login email (case-insensitively, which
 * is how pilot_accounts_login_email_uq indexes it) or by account_id.
 *
 * Both, because the Danielle@/danielle@ pair cannot be told apart by email --
 * naming that one has to go through the account_id.
 */
function matchesIdentity(row, identities) {
  const email = normalize(row.login_email);
  const accountId = normalize(row.account_id);
  return identities.some((identity) => {
    const wanted = normalize(identity);
    return wanted !== '' && (wanted === email || wanted === accountId);
  });
}

function isSoftDeleted(row) {
  return row.deleted_at !== null && row.deleted_at !== undefined;
}

/**
 * Login emails shared by more than one row once case is folded.
 *
 * The unique index makes this impossible to create today, which is exactly why
 * the existing pair matters: it predates the index, so it is data no constraint
 * will resolve and no automated rule should guess at.
 */
function findCaseCollisions(rows) {
  const byEmail = new Map();
  for (const row of rows) {
    const email = normalize(row.login_email);
    if (email === '') continue;
    if (!byEmail.has(email)) byEmail.set(email, []);
    byEmail.get(email).push(row);
  }

  const collisions = new Set();
  for (const [, group] of byEmail) {
    if (group.length < 2) continue;
    for (const row of group) collisions.add(row.account_id);
  }
  return collisions;
}

/**
 * Account ids that are the last remaining administrator of their organization.
 *
 * Retiring one leaves a gym with no one who can administer it, which is a
 * different and larger act than clearing test residue. Soft-deleted and
 * inactive rows do not count as cover, because neither can sign in.
 */
function findLastAdmins(rows) {
  const adminCountByOrg = new Map();
  for (const row of rows) {
    if (isSoftDeleted(row)) continue;
    if (row.active_flag !== true) continue;
    if (!ADMIN_ROLES.includes(row.role)) continue;
    const org = row.organization_id ?? '';
    adminCountByOrg.set(org, (adminCountByOrg.get(org) ?? 0) + 1);
  }

  const lastAdmins = new Set();
  for (const row of rows) {
    if (isSoftDeleted(row)) continue;
    if (row.active_flag !== true) continue;
    if (!ADMIN_ROLES.includes(row.role)) continue;
    const org = row.organization_id ?? '';
    if (adminCountByOrg.get(org) === 1) lastAdmins.add(row.account_id);
  }
  return lastAdmins;
}

/**
 * Classifies every account row.
 *
 * @param rows Account rows: account_id, login_email, role, organization_id,
 *   is_platform_owner, active_flag, deleted_at. Extra fields are carried
 *   through to the report untouched.
 * @param options.alsoRetire Login emails or account ids the owner has
 *   confirmed. Moves an account off the hold list.
 * @param options.allowOrphanOrganizationIds Organizations the owner accepts
 *   leaving without an administrator. Required on top of `alsoRetire` to
 *   retire a last admin.
 * @returns Per-account decisions plus the refusals the runner must honour.
 */
export function planAccountCleanup(rows, options = {}) {
  const alsoRetire = Array.isArray(options.alsoRetire) ? options.alsoRetire : [];
  const allowOrphan = (Array.isArray(options.allowOrphanOrganizationIds)
    ? options.allowOrphanOrganizationIds
    : []).map(normalize);

  const collisions = findCaseCollisions(rows);
  const lastAdmins = findLastAdmins(rows);

  const decisions = rows.map((row) => {
    const named = matchesIdentity(row, alsoRetire);
    const collision = collisions.has(row.account_id);
    const decide = (disposition, reason) => ({ ...row, disposition, reason, named, collision });

    // Order is load-bearing: every rule that can refuse a retirement is
    // evaluated before the rule that grants one.

    // 1. Already soft-deleted. Hard deletion belongs to the retention job.
    if (isSoftDeleted(row)) return decide('skip', 'ALREADY_SOFT_DELETED');

    // 2. Platform ownership, independent of the keep list. If the list is ever
    //    edited badly, this is what stops the run taking the last way in.
    if (row.is_platform_owner === true) return decide('keep', 'PLATFORM_OWNER');

    // 3. The owner's keep list.
    //
    //    A collision pair whose shared address is on the keep list -- which is
    //    the live Danielle@/danielle@ case -- lands here, so BOTH rows are kept
    //    and neither is touched. That is the safe outcome, and it is not the
    //    same as the collision being resolved: `collision` stays set on both
    //    rows and the runner reports them, because deciding which row is the
    //    real account is a rename or a merge, not a retirement.
    if (matchesIdentity(row, KEEP_LOGIN_EMAILS)) return decide('keep', 'KEEP_LIST');

    // 4. Parents. Setting accounts.deleted_at on a parent fires
    //    pilot.cascade_parent_deletion, which soft-deletes every athlete linked
    //    through guardian_links -- minors' records, from a cleanup aimed at test
    //    residue. Not overridable here; pilot-cleanup-deleted-data.mjs is the
    //    path that may remove a parent.
    if (row.role === 'parent') return decide('hold', 'PARENT_ROLE_CASCADES_TO_ATHLETES');

    // 5. Last administrator of an organization.
    if (lastAdmins.has(row.account_id)) {
      const orgAllowed = allowOrphan.includes(normalize(row.organization_id));
      if (!(named && orgAllowed)) return decide('hold', 'LAST_ACTIVE_ADMIN_OF_ORGANIZATION');
      return decide('retire', 'NAMED_FOR_RETIREMENT');
    }

    // 6. Case-collision pairs, which an email cannot disambiguate.
    if (collision) {
      const namedByAccountId = matchesIdentity(row, alsoRetire.filter(
        (identity) => normalize(identity) === normalize(row.account_id),
      ));
      if (!namedByAccountId) return decide('hold', 'LOGIN_EMAIL_CASE_COLLISION');
      return decide('retire', 'NAMED_FOR_RETIREMENT');
    }

    // 7. Confirmed by the owner.
    if (named) return decide('retire', 'NAMED_FOR_RETIREMENT');

    // 8. Named in the handoff as unresolved.
    if (matchesIdentity(row, HOLD_IDENTITIES)) return decide('hold', 'HOLD_LIST_NEEDS_CONFIRMATION');

    // 9. Still active and not accounted for above. Active means someone may be
    //    using it, so it waits for a decision rather than assuming one.
    if (row.active_flag === true) return decide('hold', 'ACTIVE_NOT_ON_KEEP_LIST');

    // 10. Inactive, not a parent, not on any list: the gate-run residue this
    //     cleanup exists for.
    return decide('retire', 'INACTIVE_RESIDUE');
  });

  // Every named identity must resolve to exactly one row. A typo that silently
  // matched nothing would read as "confirmed and cleaned up" in the output
  // while leaving the account in place.
  const unmatchedNames = alsoRetire.filter((identity) => normalize(identity) !== '' && !rows.some(
    (row) => matchesIdentity(row, [identity]),
  ));

  // A named identity that lands on keep is a contradiction, not a precedence
  // question. Refuse rather than pick a winner.
  const refusedNames = decisions
    .filter((decision) => decision.named && decision.disposition === 'keep')
    .map((decision) => ({ account_id: decision.account_id, reason: decision.reason }));

  const blockedNames = decisions
    .filter((decision) => decision.named && decision.disposition === 'hold')
    .map((decision) => ({ account_id: decision.account_id, reason: decision.reason }));

  return {
    decisions,
    keep: decisions.filter((decision) => decision.disposition === 'keep'),
    hold: decisions.filter((decision) => decision.disposition === 'hold'),
    retire: decisions.filter((decision) => decision.disposition === 'retire'),
    skip: decisions.filter((decision) => decision.disposition === 'skip'),
    collisions: decisions.filter((decision) => decision.collision),
    unmatchedNames,
    refusedNames,
    blockedNames,
  };
}

/**
 * Masks the local part of a minor's or guardian's login email.
 *
 * The report exists to be read, and the accounts being confirmed are staff, so
 * their addresses print in full. Athlete and parent rows are in the same table
 * and would otherwise print a child's address into a terminal log for no
 * benefit -- nothing about confirming residue needs to read them.
 */
export function maskEmailForRole(loginEmail, role) {
  if (typeof loginEmail !== 'string' || loginEmail === '') return null;
  if (role !== 'athlete' && role !== 'parent') return loginEmail;

  const at = loginEmail.indexOf('@');
  if (at <= 0) return '***';
  const local = loginEmail.slice(0, at);
  const domain = loginEmail.slice(at);
  return `${local.slice(0, 1)}***${domain}`;
}
