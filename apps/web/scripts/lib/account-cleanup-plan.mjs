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

/**
 * Account ids the staging gate provisions for itself (gate_shadow_athlete,
 * gate_probe_coach, ...; .github/workflows/deploy-staging.yml).
 *
 * The gate leaves gate_shadow_athlete inactive after every run
 * (--deactivate-athlete), which is exactly what rule 10 below retires -- and the
 * gate cannot sign in as a fixture whose deleted_at is set. The owner's ruling
 * (OD-2026-09-30-004 d4, option A) is that the cleanup skips these ids under
 * every rule, not only rule 10.
 */
export const GATE_FIXTURE_ID_PREFIX = 'gate_';

/**
 * Reads every account with what the planner needs to rule on it.
 *
 * `athlete_record_live` is the one thing here that is not a column of
 * pilot.accounts: whether a live pilot.athletes row (same organization, same
 * athlete_id, deleted_at null) stands behind the login. The planner cannot
 * work that out from the account row, so the read hands it over as a boolean
 * -- false both when the account has no athlete_id and when the athlete row is
 * missing or marked deleted.
 */
export const ACCOUNTS_READ_SQL = `select a.account_id,
              a.login_email,
              a.role,
              a.organization_id,
              a.is_platform_owner,
              a.athlete_id,
              a.active_flag,
              a.deleted_at,
              o.status as organization_status,
              (t.athlete_id is not null and t.deleted_at is null) as athlete_record_live
         from pilot.accounts a
         left join pilot.organizations o on o.organization_id = a.organization_id
         left join pilot.athletes t
                on t.organization_id = a.organization_id
               and t.athlete_id = a.athlete_id
        order by a.organization_id, a.role, a.login_email nulls last, a.account_id`;

/**
 * Retires the planned accounts ($1 = account ids).
 *
 * Every clause after the first restates a guarantee the planner already
 * makes. They are here because this is the statement that writes, and a WHERE
 * clause is cheaper than trusting that no future edit to the planner ever lets
 * one of these through:
 *   - `role <> 'parent'`: this statement can fire
 *     pilot.cascade_parent_deletion across minors' records.
 *   - `deleted_at is null`: re-stamping would restart a retention clock.
 *   - not a gate fixture (`\_` is a literal underscore).
 *   - no live athlete record behind the login: a deleted login keeps its hold
 *     on (organization_id, athlete_id), so the child could not be given
 *     another one.
 */
export const RETIRE_ACCOUNTS_SQL = `update pilot.accounts
          set deleted_at = now(),
              active_flag = false,
              updated_at = now()
        where account_id = any($1::text[])
          and role <> 'parent'
          and deleted_at is null
          and account_id not ilike 'gate\\_%'
          and not exists (
            select 1
              from pilot.athletes t
             where t.organization_id = pilot.accounts.organization_id
               and t.athlete_id = pilot.accounts.athlete_id
               and t.deleted_at is null
          )
        returning account_id`;

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

/** Case-folded, so a differently cased gate id is still skipped rather than retired. */
export function isGateFixture(row) {
  return normalize(row.account_id).startsWith(GATE_FIXTURE_ID_PREFIX);
}

function hasAthleteLink(row) {
  return row.athlete_id !== null && row.athlete_id !== undefined && row.athlete_id !== '';
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
 * @param rows Account rows, as ACCOUNTS_READ_SQL returns them: account_id,
 *   login_email, role, organization_id, is_platform_owner, athlete_id,
 *   athlete_record_live, active_flag, deleted_at. Extra fields are carried
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

    // 1a. Staging-gate fixtures. Ahead of every rule that can grant a
    //     retirement, including a name in `alsoRetire` -- naming one is refused
    //     below rather than honoured.
    if (isGateFixture(row)) return decide('skip', 'GATE_FIXTURE');

    // 1b. A login with a live athlete record behind it, whatever its role and
    //     whether or not it is active. The case this exists for is a child who
    //     was added to the roster and never redeemed an activation code: the
    //     login is inactive, on no list, and rule 10 would retire it -- after
    //     which the athlete record is still held by a deleted login and intake
    //     cannot issue the child another. Not overridable by name; an admin
    //     who wants such a login off deactivates it in the app.
    if (row.athlete_record_live === true) return decide('skip', 'LIVE_ATHLETE_RECORD');

    // 1c. The caller did not say, as a boolean, whether a live athlete record
    //     stands behind this login (ACCOUNTS_READ_SQL always does): the row is
    //     linked to an athlete and carries no answer, or carries one that is
    //     neither true nor false. Not knowing is not the same as "not live",
    //     so this waits rather than falling through to a rule that could
    //     retire it. A row with no link and no answer has nothing to ask about.
    if (row.athlete_record_live !== false) {
      const unanswered = row.athlete_record_live === undefined || row.athlete_record_live === null;
      if (hasAthleteLink(row) || !unanswered) return decide('hold', 'ATHLETE_RECORD_STATE_UNKNOWN');
    }

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
  // question. Refuse rather than pick a winner. A named gate fixture is the
  // same contradiction: the operator asked for a retirement the plan will not
  // make, and a skip would otherwise pass silently. So is a named login with
  // a live athlete record behind it.
  const refusedNames = decisions
    .filter((decision) => decision.named && (
      decision.disposition === 'keep'
      || decision.reason === 'GATE_FIXTURE'
      || decision.reason === 'LIVE_ATHLETE_RECORD'
    ))
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
    alreadySoftDeleted: decisions.filter((decision) => decision.reason === 'ALREADY_SOFT_DELETED'),
    gateFixtures: decisions.filter((decision) => decision.reason === 'GATE_FIXTURE'),
    liveAthleteLogins: decisions.filter((decision) => decision.reason === 'LIVE_ATHLETE_RECORD'),
    collisions: decisions.filter((decision) => decision.collision),
    unmatchedNames,
    refusedNames,
    blockedNames,
  };
}

/**
 * Reason counts for the audit row, over the accounts the retire statement
 * actually retired -- not over the plan.
 *
 * The runner's UPDATE carries its own guards (not a parent, not already
 * deleted, not a gate fixture), so it can return fewer rows than the plan
 * listed. Counting reasons from the plan would then leave a durable audit
 * record whose reasons add up to more than its retired_count.
 *
 * @param retireDecisions The plan's `retire` list.
 * @param retiredIds Account ids the UPDATE returned.
 */
export function countRetiredReasons(retireDecisions, retiredIds) {
  const retired = new Set(retiredIds);
  const totals = {};
  for (const decision of retireDecisions) {
    if (!retired.has(decision.account_id)) continue;
    totals[decision.reason] = (totals[decision.reason] ?? 0) + 1;
  }
  return totals;
}

/**
 * Masks the local part of a minor's or guardian's login email.
 *
 * The report exists to be read, and the accounts being confirmed are staff, so
 * their addresses print in full. Athlete and parent rows are in the same table
 * and would otherwise print a child's address into a terminal log for no
 * benefit -- nothing about confirming residue needs to read them.
 *
 * `athleteLinked` masks on the athlete link as well as the role: a login with
 * an athlete record behind it can carry another role (volunteer, staff), and
 * the role alone would print that address in full.
 */
export function maskEmailForRole(loginEmail, role, athleteLinked = false) {
  if (typeof loginEmail !== 'string' || loginEmail === '') return null;
  if (role !== 'athlete' && role !== 'parent' && athleteLinked !== true) return loginEmail;

  const at = loginEmail.indexOf('@');
  if (at <= 0) return '***';
  const local = loginEmail.slice(0, at);
  const domain = loginEmail.slice(at);
  return `${local.slice(0, 1)}***${domain}`;
}
