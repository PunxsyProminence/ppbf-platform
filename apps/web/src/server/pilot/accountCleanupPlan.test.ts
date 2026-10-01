// Contract tests for the account cleanup planner.
//
// The planner decides which production accounts get soft-deleted. The handoff
// it implements (docs/PLATFORM_EVIDENCE_BASELINE_HANDOFF.md, open question 7)
// says "Do not delete accounts without confirming each one", so most of what is
// asserted here is that an account is NOT retired: the platform owner, the
// keep list, the owner's own login, a parent whose deletion cascades to
// athletes, the last admin of a gym, and a case-collision pair.
//
// The fixture table mirrors the shape of the real one -- the same four keep-list
// identities, the same three unresolved identities, a Danielle@/danielle@ pair,
// and inactive gate-run residue.
//
// The module under test is real ESM (.mjs) consumed by a node script, and the
// default jest runner has no ESM loader (`npm test` does not pass
// --experimental-vm-modules). As in postgresWriteTarget.test.ts, every case is
// evaluated in one real `node` child process, which also means these tests
// exercise the module through the same loader the script uses rather than a
// transpiled copy.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// A file:// URL, not a bare path -- Node refuses a Windows absolute path as an
// ESM specifier. See the same note in postgresWriteTarget.test.ts.
const MODULE_URL = pathToFileURL(
  path.resolve(__dirname, '../../../scripts/lib/account-cleanup-plan.mjs'),
).href;

interface AccountRow {
  account_id: string;
  login_email: string | null;
  role: string;
  organization_id: string;
  is_platform_owner: boolean;
  active_flag: boolean;
  deleted_at: string | null;
}

function account(overrides: Partial<AccountRow> & { account_id: string }): AccountRow {
  return {
    login_email: null,
    role: 'coach',
    organization_id: 'ppbf-gym-1',
    is_platform_owner: false,
    active_flag: true,
    deleted_at: null,
    ...overrides,
  };
}

const ROWS: AccountRow[] = [
  // --- the four the owner wants to survive ---
  account({
    account_id: 'acct-admin',
    login_email: 'Admin@punxsyprominence.org',
    role: 'platform_owner',
    organization_id: 'ppbf-platform',
    is_platform_owner: true,
  }),
  account({
    account_id: 'acct-ppbf',
    login_email: 'ppbf@punxsyprominence.org',
    role: 'organization_admin',
  }),
  account({ account_id: 'acct-coach', login_email: 'coach@punxsyprominence.org', role: 'coach' }),

  // --- the Danielle@ / danielle@ pair: one organization_admin of gym 2, one a
  //     lowercase coach row. Both normalise to a keep-list address. ---
  account({
    account_id: 'acct-danielle-upper',
    login_email: 'Danielle@punxsyprominence.org',
    role: 'organization_admin',
    organization_id: 'gym-2',
  }),
  account({
    account_id: 'acct-danielle-lower',
    login_email: 'danielle@punxsyprominence.org',
    role: 'coach',
    organization_id: 'gym-2',
  }),

  // --- active, unresolved in the handoff ---
  account({
    account_id: 'acct-neeko',
    login_email: 'neeko@punxsyprominence.org',
    role: 'organization_admin',
    organization_id: 'audit-test-gym3',
  }),
  account({ account_id: 'acct-jason', login_email: 'jason.c.neale@outlook.com', role: 'admin' }),
  account({ account_id: 'admin-local-probe', login_email: null, role: 'admin' }),

  // --- a parent, whose soft deletion cascades to linked athletes ---
  account({ account_id: 'acct-parent', login_email: 'guardian@example.org', role: 'parent' }),

  // --- an active athlete, on nobody's list ---
  account({ account_id: 'acct-athlete', login_email: null, role: 'athlete' }),

  // --- gate-run residue: inactive, various roles and organizations ---
  account({ account_id: 'residue-1', role: 'coach', organization_id: 'gate_org_a_1', active_flag: false }),
  account({ account_id: 'residue-2', role: 'athlete', organization_id: 'gate_org_a_1', active_flag: false }),
  account({
    account_id: 'residue-3',
    login_email: 'probe@example.org',
    role: 'organization_admin',
    organization_id: 'org-alpha',
    active_flag: false,
  }),

  // --- already soft-deleted; the retention job owns it now ---
  account({
    account_id: 'residue-deleted',
    role: 'coach',
    organization_id: 'org-bravo',
    active_flag: false,
    deleted_at: '2026-07-30T00:00:00Z',
  }),
];

// The staging gate's own accounts (.github/workflows/deploy-staging.yml), in a
// table of their own so they do not disturb the cases above. Each one is placed
// to reach a different rule, because the owner's ruling (OD-2026-09-30-004 d4,
// option A) is that no rule may retire one -- not only the inactive-residue
// rule that retired gate_shadow_athlete after every gate run.
const GATE_ORG = 'gate_org_default';
const GATE_ROWS: AccountRow[] = [
  // Rule 10: the real post-gate state, left inactive by --deactivate-athlete.
  account({ account_id: 'gate_shadow_athlete', role: 'athlete', organization_id: GATE_ORG, active_flag: false }),
  // Rule 9: active, on no list.
  account({ account_id: 'gate_probe_coach', role: 'coach', organization_id: GATE_ORG }),
  // Rule 2: a platform owner by flag.
  account({
    account_id: 'gate_probe_platform_owner',
    role: 'platform_owner',
    organization_id: GATE_ORG,
    is_platform_owner: true,
  }),
  // Rule 4: a parent.
  account({ account_id: 'gate_shadow_guardian', role: 'parent', organization_id: GATE_ORG }),
  // Rule 5: the only active admin of its own organization.
  account({ account_id: 'gate_probe_org_admin', role: 'organization_admin', organization_id: 'gate_org_solo' }),
  // Rule 6: a login-email case collision.
  account({ account_id: 'gate_probe_guardian_a', login_email: 'Gate.Probe@example.org', active_flag: false }),
  account({ account_id: 'gate_probe_guardian_b', login_email: 'gate.probe@example.org', active_flag: false }),
  // Differently cased id, inactive.
  account({ account_id: 'GATE_Shadow_Upper', role: 'athlete', organization_id: GATE_ORG, active_flag: false }),
  // Rule 1 still comes first: an already-deleted fixture is reported as such.
  account({
    account_id: 'gate_deleted_fixture',
    role: 'athlete',
    organization_id: GATE_ORG,
    active_flag: false,
    deleted_at: '2026-09-01T00:00:00Z',
  }),
  // Look-alikes that are NOT gate fixtures: inactive, so still residue.
  account({ account_id: 'gategym_x', role: 'coach', organization_id: GATE_ORG, active_flag: false }),
  account({ account_id: 'x_gate_y', role: 'coach', organization_id: GATE_ORG, active_flag: false }),
  account({ account_id: 'gate-hyphen', role: 'coach', organization_id: GATE_ORG, active_flag: false }),
];

const GATE_CASES: Record<string, { alsoRetire?: string[]; allowOrphanOrganizationIds?: string[] }> = {
  plain: {},
  confirm_shadow_athlete: { alsoRetire: ['gate_shadow_athlete'] },
  confirm_solo_admin_with_orphan_allowance: {
    alsoRetire: ['gate_probe_org_admin'],
    allowOrphanOrganizationIds: ['gate_org_solo'],
  },
  confirm_collision_row_by_account_id: { alsoRetire: ['gate_probe_guardian_b'] },
};

type Plan = {
  decisions: Array<{
    account_id: string;
    disposition: string;
    reason: string;
    named: boolean;
    collision: boolean;
  }>;
  unmatchedNames: string[];
  refusedNames: Array<{ account_id: string; reason: string }>;
  blockedNames: Array<{ account_id: string; reason: string }>;
  collisions: Array<{ account_id: string }>;
  gateFixtures?: Array<{ account_id: string }>;
  alreadySoftDeleted?: Array<{ account_id: string }>;
};

// Each case is a set of options the operator could supply.
const CASES: Record<string, { alsoRetire?: string[]; allowOrphanOrganizationIds?: string[] }> = {
  plain: {},
  confirm_jason: { alsoRetire: ['jason.c.neale@outlook.com'] },
  confirm_probe: { alsoRetire: ['admin-local-probe'] },
  confirm_neeko_without_orphan_allowance: { alsoRetire: ['neeko@punxsyprominence.org'] },
  confirm_neeko_with_orphan_allowance: {
    alsoRetire: ['neeko@punxsyprominence.org'],
    allowOrphanOrganizationIds: ['audit-test-gym3'],
  },
  confirm_neeko_with_wrong_orphan_allowance: {
    alsoRetire: ['neeko@punxsyprominence.org'],
    allowOrphanOrganizationIds: ['gym-2'],
  },
  confirm_parent: { alsoRetire: ['guardian@example.org'] },
  confirm_platform_owner: { alsoRetire: ['Admin@punxsyprominence.org'] },
  confirm_danielle_row_by_account_id: { alsoRetire: ['acct-danielle-lower'] },
  confirm_typo: { alsoRetire: ['neko@punxsyprominence.org'] },
  confirm_mixed_case_identity: { alsoRetire: ['JASON.C.NEALE@OUTLOOK.COM'] },
};

let plans: Record<string, Plan>;
let gatePlans: Record<string, Plan>;
let masked: Record<string, string | null>;
let reasonCounts: Record<string, Record<string, number>>;

beforeAll(() => {
  const script = `
    import { planAccountCleanup, maskEmailForRole, countRetiredReasons } from ${JSON.stringify(MODULE_URL)};
    const rows = ${JSON.stringify(ROWS)};
    const cases = ${JSON.stringify(CASES)};
    const plans = {};
    for (const [name, options] of Object.entries(cases)) {
      plans[name] = planAccountCleanup(rows, options);
    }
    const gateRows = ${JSON.stringify(GATE_ROWS)};
    const gateCases = ${JSON.stringify(GATE_CASES)};
    const gatePlans = {};
    for (const [name, options] of Object.entries(gateCases)) {
      gatePlans[name] = planAccountCleanup(gateRows, options);
    }
    const masked = {
      athlete: maskEmailForRole('jonah.ruiz@example.org', 'athlete'),
      parent: maskEmailForRole('guardian@example.org', 'parent'),
      coach: maskEmailForRole('coach@punxsyprominence.org', 'coach'),
      null_email: maskEmailForRole(null, 'athlete'),
      malformed: maskEmailForRole('not-an-email', 'athlete'),
    };
    // confirm_jason retires three INACTIVE_RESIDUE rows and one
    // NAMED_FOR_RETIREMENT row; each case below is what the retire statement
    // could hand back for that plan.
    const planned = plans.confirm_jason.retire;
    const reasonCounts = {
      all_retired: countRetiredReasons(planned, planned.map((entry) => entry.account_id)),
      one_residue_row_refused: countRetiredReasons(planned, ['residue-1', 'residue-3', 'acct-jason']),
      named_row_refused: countRetiredReasons(planned, ['residue-1', 'residue-2', 'residue-3']),
      none_retired: countRetiredReasons(planned, []),
    };
    process.stdout.write(JSON.stringify({ plans, gatePlans, masked, reasonCounts }));
  `;

  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  const parsed = JSON.parse(stdout);
  plans = parsed.plans;
  gatePlans = parsed.gatePlans;
  masked = parsed.masked;
  reasonCounts = parsed.reasonCounts;
});

function gateDecisionFor(caseName: string, accountId: string) {
  const decision = gatePlans[caseName].decisions.find((entry) => entry.account_id === accountId);
  if (!decision) throw new Error(`no decision for ${accountId} in gate case ${caseName}`);
  return decision;
}

const GATE_FIXTURE_IDS = [
  'GATE_Shadow_Upper',
  'gate_probe_coach',
  'gate_probe_guardian_a',
  'gate_probe_guardian_b',
  'gate_probe_org_admin',
  'gate_probe_platform_owner',
  'gate_shadow_athlete',
  'gate_shadow_guardian',
];

function decisionFor(caseName: string, accountId: string) {
  const decision = plans[caseName].decisions.find((entry) => entry.account_id === accountId);
  if (!decision) throw new Error(`no decision for ${accountId} in case ${caseName}`);
  return decision;
}

function retiredIds(caseName: string): string[] {
  return plans[caseName].decisions
    .filter((entry) => entry.disposition === 'retire')
    .map((entry) => entry.account_id)
    .sort();
}

describe('a plain run', () => {
  test('THE POINT: retires only the inactive residue', () => {
    // Nothing active, nothing on a list, nothing needing a person. This is the
    // whole automatic scope of the cleanup.
    expect(retiredIds('plain')).toEqual(['residue-1', 'residue-2', 'residue-3']);
  });

  test('keeps the platform owner on ownership, not on the list', () => {
    // The rule that fires here is PLATFORM_OWNER, ahead of the keep list, so a
    // badly edited list still cannot take the last way in.
    expect(decisionFor('plain', 'acct-admin')).toMatchObject({
      disposition: 'keep',
      reason: 'PLATFORM_OWNER',
    });
  });

  test('keeps the gym admins the owner named', () => {
    expect(decisionFor('plain', 'acct-ppbf')).toMatchObject({ disposition: 'keep', reason: 'KEEP_LIST' });
    expect(decisionFor('plain', 'acct-coach')).toMatchObject({ disposition: 'keep', reason: 'KEEP_LIST' });
  });

  test("holds the owner's own login, which is not on the keep list", () => {
    // neeko@ is an active organization_admin of audit-test-gym3 and the only
    // one, so the last-admin guard is what catches it -- retiring it would lock
    // the owner out of that gym.
    expect(decisionFor('plain', 'acct-neeko')).toMatchObject({
      disposition: 'hold',
      reason: 'LAST_ACTIVE_ADMIN_OF_ORGANIZATION',
    });
  });

  test('holds the other two active unresolved identities', () => {
    expect(decisionFor('plain', 'acct-jason')).toMatchObject({
      disposition: 'hold',
      reason: 'HOLD_LIST_NEEDS_CONFIRMATION',
    });
    expect(decisionFor('plain', 'admin-local-probe')).toMatchObject({
      disposition: 'hold',
      reason: 'HOLD_LIST_NEEDS_CONFIRMATION',
    });
  });

  test('holds a parent, because soft-deleting one cascades to their athletes', () => {
    // pilot.cascade_parent_deletion sets athletes.deleted_at for every athlete
    // linked through guardian_links. A cleanup aimed at test residue must not
    // reach minors' records.
    expect(decisionFor('plain', 'acct-parent')).toMatchObject({
      disposition: 'hold',
      reason: 'PARENT_ROLE_CASCADES_TO_ATHLETES',
    });
  });

  test('holds an active account nobody has ruled on', () => {
    expect(decisionFor('plain', 'acct-athlete')).toMatchObject({
      disposition: 'hold',
      reason: 'ACTIVE_NOT_ON_KEEP_LIST',
    });
  });

  test('leaves an already soft-deleted row alone', () => {
    // Re-stamping deleted_at would restart its retention clock, deferring the
    // hard delete that pilot-cleanup-deleted-data.mjs is waiting to do.
    expect(decisionFor('plain', 'residue-deleted')).toMatchObject({
      disposition: 'skip',
      reason: 'ALREADY_SOFT_DELETED',
    });
  });

  test('retires an inactive organization_admin without the last-admin guard firing', () => {
    // The guard counts only accounts that can sign in. An inactive admin of a
    // dead gate organization is residue, not cover.
    expect(decisionFor('plain', 'residue-3')).toMatchObject({
      disposition: 'retire',
      reason: 'INACTIVE_RESIDUE',
    });
  });
});

describe('the Danielle@ / danielle@ pair', () => {
  test('keeps both rows and touches neither', () => {
    // Both normalise to a keep-list address, so the safe outcome is that
    // nothing happens to either. Which one is the real account is a rename or a
    // merge, and not this script's decision.
    expect(decisionFor('plain', 'acct-danielle-upper').disposition).toBe('keep');
    expect(decisionFor('plain', 'acct-danielle-lower').disposition).toBe('keep');
  });

  test('still reports the collision, which the disposition alone would hide', () => {
    expect(plans.plain.collisions.map((entry) => entry.account_id).sort()).toEqual([
      'acct-danielle-lower',
      'acct-danielle-upper',
    ]);
  });

  test('refuses to retire one of the pair by account id', () => {
    // An account id is the only way to name one of two rows sharing an address,
    // and naming a keep-listed row is a contradiction rather than a precedence
    // question -- so it refuses instead of picking a winner.
    expect(plans.confirm_danielle_row_by_account_id.refusedNames).toEqual([
      { account_id: 'acct-danielle-lower', reason: 'KEEP_LIST' },
    ]);
    expect(retiredIds('confirm_danielle_row_by_account_id')).toEqual([
      'residue-1',
      'residue-2',
      'residue-3',
    ]);
  });
});

describe('confirming a held account', () => {
  test('retires it once named by login email', () => {
    expect(retiredIds('confirm_jason')).toContain('acct-jason');
    expect(decisionFor('confirm_jason', 'acct-jason').reason).toBe('NAMED_FOR_RETIREMENT');
  });

  test('retires it once named by account id, for a row with no login email', () => {
    expect(retiredIds('confirm_probe')).toContain('admin-local-probe');
  });

  test('matches a named identity case-insensitively, as the unique index does', () => {
    expect(retiredIds('confirm_mixed_case_identity')).toContain('acct-jason');
  });

  test('confirming one account does not disturb the others', () => {
    expect(decisionFor('confirm_jason', 'admin-local-probe').disposition).toBe('hold');
    expect(decisionFor('confirm_jason', 'acct-neeko').disposition).toBe('hold');
  });

  test('reports a name that matched no row instead of quietly doing nothing', () => {
    // A typo that matched nothing would otherwise read as "confirmed and
    // cleaned up" while leaving the account in place.
    expect(plans.confirm_typo.unmatchedNames).toEqual(['neko@punxsyprominence.org']);
  });
});

describe('guards a name alone does not lift', () => {
  test('a named last admin stays held without an orphan allowance', () => {
    expect(decisionFor('confirm_neeko_without_orphan_allowance', 'acct-neeko')).toMatchObject({
      disposition: 'hold',
      reason: 'LAST_ACTIVE_ADMIN_OF_ORGANIZATION',
    });
    expect(plans.confirm_neeko_without_orphan_allowance.blockedNames).toEqual([
      { account_id: 'acct-neeko', reason: 'LAST_ACTIVE_ADMIN_OF_ORGANIZATION' },
    ]);
  });

  test('an allowance for a different organization does not lift it', () => {
    expect(decisionFor('confirm_neeko_with_wrong_orphan_allowance', 'acct-neeko').disposition).toBe('hold');
  });

  test('both the name and the matching organization retire it', () => {
    // Two separate statements of intent, because this one leaves a gym with
    // nobody who can administer it.
    expect(decisionFor('confirm_neeko_with_orphan_allowance', 'acct-neeko')).toMatchObject({
      disposition: 'retire',
      reason: 'NAMED_FOR_RETIREMENT',
    });
  });

  test('a named parent stays held, with no override at all', () => {
    expect(decisionFor('confirm_parent', 'acct-parent')).toMatchObject({
      disposition: 'hold',
      reason: 'PARENT_ROLE_CASCADES_TO_ATHLETES',
    });
    expect(plans.confirm_parent.blockedNames).toEqual([
      { account_id: 'acct-parent', reason: 'PARENT_ROLE_CASCADES_TO_ATHLETES' },
    ]);
  });

  test('a named platform owner is refused, not retired', () => {
    expect(decisionFor('confirm_platform_owner', 'acct-admin').disposition).toBe('keep');
    expect(plans.confirm_platform_owner.refusedNames).toEqual([
      { account_id: 'acct-admin', reason: 'PLATFORM_OWNER' },
    ]);
  });
});

describe('staging-gate fixtures (account_id starts with gate_)', () => {
  test('THE POINT: the inactive gate_shadow_athlete a gate run leaves behind is skipped, not retired', () => {
    // Retiring it sets deleted_at, and the next gate run cannot sign in as it.
    expect(gateDecisionFor('plain', 'gate_shadow_athlete')).toMatchObject({
      disposition: 'skip',
      reason: 'GATE_FIXTURE',
    });
  });

  test.each(Object.keys(GATE_CASES))('no gate fixture is retired in case %s', (caseName) => {
    const retiredGateIds = gatePlans[caseName].decisions
      .filter((entry) => entry.disposition === 'retire' && entry.account_id.toLowerCase().startsWith('gate_'));
    expect(retiredGateIds).toEqual([]);
  });

  test.each(GATE_FIXTURE_IDS)('%s is skipped whichever rule it would otherwise reach', (accountId) => {
    expect(gateDecisionFor('plain', accountId)).toMatchObject({ disposition: 'skip', reason: 'GATE_FIXTURE' });
  });

  test('the plan lists the skipped fixtures on their own, apart from already soft-deleted rows', () => {
    expect(gatePlans.plain.gateFixtures?.map((entry) => entry.account_id).sort()).toEqual(GATE_FIXTURE_IDS);
    expect(gatePlans.plain.alreadySoftDeleted?.map((entry) => entry.account_id)).toEqual(['gate_deleted_fixture']);
  });

  test('an already soft-deleted fixture is still reported as already soft-deleted', () => {
    expect(gateDecisionFor('plain', 'gate_deleted_fixture')).toMatchObject({
      disposition: 'skip',
      reason: 'ALREADY_SOFT_DELETED',
    });
  });

  test('naming a gate fixture is refused, not honoured and not silently ignored', () => {
    expect(gateDecisionFor('confirm_shadow_athlete', 'gate_shadow_athlete').disposition).toBe('skip');
    expect(gatePlans.confirm_shadow_athlete.refusedNames).toEqual([
      { account_id: 'gate_shadow_athlete', reason: 'GATE_FIXTURE' },
    ]);
  });

  test('a name plus an orphan allowance does not retire a gate admin either', () => {
    expect(gateDecisionFor('confirm_solo_admin_with_orphan_allowance', 'gate_probe_org_admin').disposition)
      .toBe('skip');
    expect(gatePlans.confirm_solo_admin_with_orphan_allowance.refusedNames).toEqual([
      { account_id: 'gate_probe_org_admin', reason: 'GATE_FIXTURE' },
    ]);
  });

  test('look-alike ids that do not start with gate_ are still ordinary residue', () => {
    for (const accountId of ['gategym_x', 'x_gate_y', 'gate-hyphen']) {
      expect(gateDecisionFor('plain', accountId)).toMatchObject({
        disposition: 'retire',
        reason: 'INACTIVE_RESIDUE',
      });
    }
  });
});

describe('countRetiredReasons, the reason counts in the audit row', () => {
  const total = (counts: Record<string, number>) => Object.values(counts).reduce((sum, n) => sum + n, 0);

  test('counts every planned row when the statement retired them all', () => {
    expect(reasonCounts.all_retired).toEqual({ INACTIVE_RESIDUE: 3, NAMED_FOR_RETIREMENT: 1 });
  });

  test('THE POINT: a planned row the statement refused is not counted', () => {
    // Four rows planned, three returned. Counting from the plan would record
    // reasons adding up to 4 beside a retired_count of 3.
    expect(reasonCounts.one_residue_row_refused).toEqual({ INACTIVE_RESIDUE: 2, NAMED_FOR_RETIREMENT: 1 });
    expect(total(reasonCounts.one_residue_row_refused)).toBe(3);
  });

  test('a reason with no retired row is left out rather than recorded as zero', () => {
    expect(reasonCounts.named_row_refused).toEqual({ INACTIVE_RESIDUE: 3 });
  });

  test('nothing retired counts nothing', () => {
    expect(reasonCounts.none_retired).toEqual({});
  });
});

describe('maskEmailForRole', () => {
  test('masks an athlete address, which is a minor', () => {
    expect(masked.athlete).toBe('j***@example.org');
  });

  test('masks a parent address', () => {
    expect(masked.parent).toBe('g***@example.org');
  });

  test('prints a staff address in full, because it is what gets confirmed', () => {
    expect(masked.coach).toBe('coach@punxsyprominence.org');
  });

  test('handles a null email and a malformed one without leaking either', () => {
    expect(masked.null_email).toBeNull();
    expect(masked.malformed).toBe('***');
  });
});
