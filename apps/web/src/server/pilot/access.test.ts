import {
  accessibleAthleteIds,
  assertActorCanAccessAthlete,
  assertAthleteBelongsToOrganization,
  assertAthleteUpdateAllowed,
  assertCoachAssignedToAthlete,
  athleteIdsForCoach,
  DEFAULT_COVERAGE_TTL_HOURS,
  grantCoachCoverage,
  isOrganizationAdminRole,
  listActiveCoachCoverage,
  requireRole,
  revokeCoachCoverage,
} from './access';
import { query, queryOne } from './db';
import type { ActorIdentity } from './access';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

// ─── isOrganizationAdminRole ──────────────────────────────────────────────────

describe('isOrganizationAdminRole', () => {
  test('returns true for organization_admin', () => {
    expect(isOrganizationAdminRole('organization_admin')).toBe(true);
  });

  test('returns true for legacy admin', () => {
    expect(isOrganizationAdminRole('admin')).toBe(true);
  });

  test('returns false for coach', () => {
    expect(isOrganizationAdminRole('coach')).toBe(false);
  });

  test('returns false for athlete', () => {
    expect(isOrganizationAdminRole('athlete')).toBe(false);
  });

  test('returns false for the aggregate-only board role', () => {
    expect(isOrganizationAdminRole('board')).toBe(false);
  });
});

// ─── requireRole ─────────────────────────────────────────────────────────────

describe('requireRole', () => {
  const actor = (role: string): ActorIdentity => ({
    accountId: 'acct-1',
    role: role as ActorIdentity['role'],
    organizationId: 'org-1',
    athleteId: null,
  });

  test('allows when role matches', () => {
    expect(() => requireRole(actor('coach'), ['coach', 'organization_admin'])).not.toThrow();
  });

  test('throws Forbidden when role not in allowed list', () => {
    expect(() => requireRole(actor('volunteer'), ['coach', 'organization_admin'])).toThrow('Forbidden');
  });

  test('allows organization_admin when admin is specified (legacy compat)', () => {
    expect(() => requireRole(actor('organization_admin'), ['admin'])).not.toThrow();
  });

  test('allows admin when organization_admin is specified (legacy compat)', () => {
    expect(() => requireRole(actor('admin'), ['organization_admin'])).not.toThrow();
  });

  test('does not treat board as admin or coach authority', () => {
    expect(() => requireRole(actor('board'), ['admin', 'organization_admin', 'coach'])).toThrow('Forbidden');
  });
});

// ─── assertCoachAssignedToAthlete ─────────────────────────────────────────────

describe('assertCoachAssignedToAthlete', () => {
  test('resolves when coach is assigned to athlete', async () => {
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    await expect(assertCoachAssignedToAthlete('coach-1', 'ath-1', 'org-1')).resolves.toBeUndefined();
    expect(mockQueryOne).toHaveBeenCalledWith(
      expect.stringContaining('pilot.athletes'),
      ['ath-1', 'coach-1', 'org-1'],
    );
    // The assigned coach never costs a coverage lookup.
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
  });

  test('throws Forbidden when coach is not assigned to athlete', async () => {
    // Setup only (the coverage rule: add setup, never weaken the assertion):
    // the coach is not assigned AND holds no coverage grant.
    mockQueryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(assertCoachAssignedToAthlete('coach-1', 'ath-other', 'org-1')).rejects.toThrow('Forbidden');
  });

  // T-002: a coach covering for the athlete's coach of record.
  describe('coverage grants (T-002)', () => {
    test('resolves for a coach holding an active coverage grant', async () => {
      mockQueryOne
        .mockResolvedValueOnce(null) // not the coach_id of record
        .mockResolvedValueOnce({ coverage_id: 'cov-1' }); // active grant
      await expect(assertCoachAssignedToAthlete('coach-sub', 'ath-1', 'org-1')).resolves.toBeUndefined();
      expect(mockQueryOne).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('pilot.coach_coverage'),
        ['org-1', 'ath-1', 'coach-sub'],
      );
    });

    // The window predicates live in the SQL itself, so an expired (or
    // revoked -- expires_at forced to now() -- or not-yet-started) grant is
    // indistinguishable from no grant: the query returns nothing and the
    // same Forbidden is thrown. The real-Postgres proof that the predicates
    // enforce expiry against real rows is in coachCoverage.pg.test.ts.
    test('throws Forbidden when the only grant is expired: the lookup window excludes it', async () => {
      mockQueryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      await expect(assertCoachAssignedToAthlete('coach-sub', 'ath-1', 'org-1')).rejects.toThrow(
        'Forbidden: coach not assigned to athlete',
      );
      const [coverageSql] = mockQueryOne.mock.calls[1];
      expect(String(coverageSql)).toContain('starts_at <= now()');
      expect(String(coverageSql)).toContain('expires_at > now()');
    });

    test('a coverage grant does not shadow the exact-match path: assigned coach still short-circuits', async () => {
      mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
      await expect(assertCoachAssignedToAthlete('coach-1', 'ath-1', 'org-1')).resolves.toBeUndefined();
      expect(mockQueryOne).toHaveBeenCalledTimes(1);
    });

    // Migrations are operator-applied, so this code legitimately runs
    // against databases the coverage migration has not reached. A missing
    // relation must mean what the pre-T-002 code meant -- Forbidden -- not
    // turn every non-assigned-coach 403 into an opaque 500.
    test('a missing coach_coverage table (42P01) refuses with Forbidden, not a relation error', async () => {
      const missingTable = Object.assign(new Error('relation "pilot.coach_coverage" does not exist'), { code: '42P01' });
      mockQueryOne.mockResolvedValueOnce(null).mockRejectedValueOnce(missingTable);

      await expect(assertCoachAssignedToAthlete('coach-sub', 'ath-1', 'org-1')).rejects.toThrow(
        'Forbidden: coach not assigned to athlete',
      );
    });

    test('any other database error from the coverage lookup still propagates', async () => {
      const dbDown = Object.assign(new Error('connection refused'), { code: '08006' });
      mockQueryOne.mockResolvedValueOnce(null).mockRejectedValueOnce(dbDown);

      await expect(assertCoachAssignedToAthlete('coach-sub', 'ath-1', 'org-1')).rejects.toThrow('connection refused');
    });
  });
});

// ─── grantCoachCoverage ───────────────────────────────────────────────────────
//
// The TTL bound is the security property here, not an input-validation nicety.
// A per-athlete coverage table was chosen over a roster-wide flag specifically
// because coverage is time-bounded exposure to one minor's record; a ttl_hours
// that reaches `now() + ($n || ' hours')::interval` unchecked makes "temporary"
// mean "until someone notices", which is the property the design was picked for.

describe('grantCoachCoverage', () => {
  const baseParams = {
    organizationId: 'org-1',
    athleteId: 'ath-1',
    coveringCoachId: 'coach-sub',
    grantedByAccountId: 'admin-1',
  };

  test('defaults to DEFAULT_COVERAGE_TTL_HOURS when ttlHours is omitted', async () => {
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' }); // athlete in org
    mockQueryOne.mockResolvedValueOnce({ account_id: 'coach-sub' }); // grantee is an active coach
    mockQueryOne.mockResolvedValueOnce(null); // no overlapping live grant
    mockQueryOne.mockResolvedValueOnce({ coverage_id: 'cov-1', expires_at: '2026-08-07T00:00:00Z' });

    await expect(grantCoachCoverage(baseParams)).resolves.toEqual({
      coverageId: 'cov-1',
      expiresAt: '2026-08-07T00:00:00Z',
    });

    expect(mockQueryOne).toHaveBeenLastCalledWith(
      expect.stringContaining('insert into pilot.coach_coverage'),
      expect.arrayContaining([DEFAULT_COVERAGE_TTL_HOURS]),
    );
  });

  test('rejects a ttlHours beyond the maximum instead of granting a century of access', async () => {
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });

    await expect(grantCoachCoverage({ ...baseParams, ttlHours: 876_000 })).rejects.toThrow(
      'Missing ttl_hours: must be a positive integer of at most 336',
    );

    // The insert must never be reached -- rejecting after writing would be no
    // protection at all.
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
  });

  test('rejects a non-integer ttlHours', async () => {
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    await expect(grantCoachCoverage({ ...baseParams, ttlHours: 1.5 })).rejects.toThrow('Missing ttl_hours');
  });

  test('rejects a zero or negative ttlHours', async () => {
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    await expect(grantCoachCoverage({ ...baseParams, ttlHours: 0 })).rejects.toThrow('Missing ttl_hours');

    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    await expect(grantCoachCoverage({ ...baseParams, ttlHours: -4 })).rejects.toThrow('Missing ttl_hours');
  });

  test('accepts a ttlHours exactly at the maximum', async () => {
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockQueryOne.mockResolvedValueOnce({ account_id: 'coach-sub' });
    mockQueryOne.mockResolvedValueOnce(null);
    mockQueryOne.mockResolvedValueOnce({ coverage_id: 'cov-2', expires_at: '2026-08-20T00:00:00Z' });

    await expect(grantCoachCoverage({ ...baseParams, ttlHours: 336 })).resolves.toMatchObject({
      coverageId: 'cov-2',
    });
  });

  test('refuses to grant coverage for an athlete outside the organization', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    await expect(grantCoachCoverage(baseParams)).rejects.toThrow('Forbidden: athlete does not belong to organization');
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
  });

  // The table this writes to exists to admit its holder through
  // assertCoachAssignedToAthlete, so the grantee check is not input
  // validation: a typo'd account id is coach-level access to a minor's
  // record handed to whatever account the typo names.
  test('refuses to grant coverage to an account that is not an active coach', async () => {
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockQueryOne.mockResolvedValueOnce(null); // not a coach / not active / not in this org

    await expect(grantCoachCoverage(baseParams)).rejects.toThrow(
      'Missing covering_coach_id: must be an active coach account in this organization',
    );

    expect(mockQueryOne).toHaveBeenCalledTimes(2);
    expect(mockQueryOne).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("role = 'coach'"),
      ['coach-sub', 'org-1'],
    );
  });

  // Stacked overlapping grants make revocation lie: revoke "the" grant and a
  // hidden second one keeps the door open. Grant-time refusal keeps at most
  // one live grant per (athlete, coach), naming the live one so the admin
  // can revoke it first if a re-issue is really intended.
  test('refuses an overlapping grant while one is still live, naming the live grant', async () => {
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    mockQueryOne.mockResolvedValueOnce({ account_id: 'coach-sub' });
    mockQueryOne.mockResolvedValueOnce({ coverage_id: 'cov-live' });

    await expect(grantCoachCoverage(baseParams)).rejects.toThrow(
      'Coverage already exists: grant cov-live for this coach and athlete is still active',
    );

    // The insert is never reached.
    expect(mockQueryOne).toHaveBeenCalledTimes(3);
  });
});

// ─── revokeCoachCoverage ──────────────────────────────────────────────────────

describe('revokeCoachCoverage', () => {
  test('reports revoked when an active grant was ended', async () => {
    mockQueryOne.mockResolvedValueOnce({ coverage_id: 'cov-1' });

    await expect(revokeCoachCoverage({ organizationId: 'org-1', coverageId: 'cov-1' })).resolves.toEqual({
      revoked: true,
    });
  });

  test('scopes the revoke by organization so one gym cannot end another gym grant', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    await expect(revokeCoachCoverage({ organizationId: 'org-2', coverageId: 'cov-1' })).resolves.toEqual({
      revoked: false,
    });

    expect(mockQueryOne).toHaveBeenCalledWith(
      expect.stringContaining('organization_id = $1'),
      ['org-2', 'cov-1'],
    );
  });

  test('is idempotent -- revoking an already-expired grant is not an error', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    await expect(revokeCoachCoverage({ organizationId: 'org-1', coverageId: 'cov-gone' })).resolves.toEqual({
      revoked: false,
    });
  });
});

describe('listActiveCoachCoverage', () => {
  test('reads only the calling organization, ordered by soonest to expire', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await listActiveCoachCoverage('org-1');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('where cc.organization_id = $1');
    expect(sql).toContain('and cc.expires_at > now()');
    expect(sql).toContain('order by cc.expires_at asc');
    expect(params).toEqual(['org-1']);
  });

  test('returns the joined athlete name and coach/granter emails', async () => {
    mockQuery.mockResolvedValueOnce([
      {
        coverage_id: 'cov-1',
        athlete_id: 'ath-1',
        athlete_full_name: 'A Name',
        covering_coach_id: 'coach-sub',
        covering_coach_email: 'sub@example.org',
        granted_by_account_id: 'admin-1',
        granted_by_email: 'admin@example.org',
        starts_at: '2026-08-01T00:00:00.000Z',
        expires_at: '2026-08-02T00:00:00.000Z',
      },
    ]);

    const rows = await listActiveCoachCoverage('org-1');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      coverage_id: 'cov-1',
      athlete_full_name: 'A Name',
      covering_coach_email: 'sub@example.org',
      granted_by_email: 'admin@example.org',
    });
  });
});

// ─── assertAthleteBelongsToOrganization ──────────────────────────────────────

describe('assertAthleteBelongsToOrganization', () => {
  test('resolves when athlete belongs to organization', async () => {
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    await expect(assertAthleteBelongsToOrganization('org-1', 'ath-1')).resolves.toBeUndefined();
    expect(mockQueryOne).toHaveBeenCalledWith(
      expect.stringContaining('pilot.athletes'),
      ['ath-1', 'org-1'],
    );
  });

  test('throws Forbidden when athlete belongs to a different organization', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    await expect(assertAthleteBelongsToOrganization('org-1', 'ath-other-org')).rejects.toThrow('Forbidden');
  });
});

// ─── assertActorCanAccessAthlete ─────────────────────────────────────────────

describe('assertActorCanAccessAthlete', () => {
  test('throws Forbidden for platform_owner', async () => {
    const actor: ActorIdentity = { accountId: 'a', role: 'platform_owner', organizationId: 'org-1', athleteId: null };
    await expect(assertActorCanAccessAthlete(actor, 'ath-1')).rejects.toThrow('Forbidden');
  });

  test('denies board before any athlete lookup is attempted', async () => {
    const actor: ActorIdentity = { accountId: 'board-1', role: 'board', organizationId: 'org-1', athleteId: null };
    await expect(assertActorCanAccessAthlete(actor, 'ath-1')).rejects.toThrow(
      'restricted to organization-level aggregates',
    );
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('allows organization_admin when athlete belongs to their organization', async () => {
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    const actor: ActorIdentity = { accountId: 'a', role: 'organization_admin', organizationId: 'org-1', athleteId: null };
    await expect(assertActorCanAccessAthlete(actor, 'ath-1')).resolves.toBeUndefined();
    expect(mockQueryOne).toHaveBeenCalledWith(
      expect.stringContaining('pilot.athletes'),
      ['ath-1', 'org-1'],
    );
  });

  test('throws Forbidden when organization_admin targets an athlete from another organization', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    const actor: ActorIdentity = { accountId: 'a', role: 'organization_admin', organizationId: 'org-1', athleteId: null };
    await expect(assertActorCanAccessAthlete(actor, 'ath-other-org')).rejects.toThrow('Forbidden');
  });

  test('allows legacy admin role when athlete belongs to their organization', async () => {
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
    const actor: ActorIdentity = { accountId: 'a', role: 'admin', organizationId: 'org-1', athleteId: null };
    await expect(assertActorCanAccessAthlete(actor, 'ath-1')).resolves.toBeUndefined();
  });

  test('throws Forbidden when legacy admin targets an athlete from another organization', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    const actor: ActorIdentity = { accountId: 'a', role: 'admin', organizationId: 'org-1', athleteId: null };
    await expect(assertActorCanAccessAthlete(actor, 'ath-other-org')).rejects.toThrow('Forbidden');
  });

  describe('coach role', () => {
    test('allows access when coach is assigned to athlete', async () => {
      mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
      const actor: ActorIdentity = { accountId: 'coach-1', role: 'coach', organizationId: 'org-1', athleteId: null };
      await expect(assertActorCanAccessAthlete(actor, 'ath-1')).resolves.toBeUndefined();
    });

    test('throws Forbidden when coach is not assigned to athlete', async () => {
      // Setup only: no assignment and no coverage grant (coverage added the
      // second lookup). The assertion is unchanged.
      mockQueryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      const actor: ActorIdentity = { accountId: 'coach-1', role: 'coach', organizationId: 'org-1', athleteId: null };
      await expect(assertActorCanAccessAthlete(actor, 'ath-other')).rejects.toThrow('Forbidden');
    });

    test('allows access when coach has an active covering grant', async () => {
      mockQueryOne.mockResolvedValueOnce(null);
      mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
      const actor: ActorIdentity = { accountId: 'coach-covering', role: 'coach', organizationId: 'org-1', athleteId: null };
      await expect(assertActorCanAccessAthlete(actor, 'ath-1')).resolves.toBeUndefined();
    });

    test('throws Forbidden when coach covering grant is expired or absent', async () => {
      mockQueryOne.mockResolvedValueOnce(null);
      mockQueryOne.mockResolvedValueOnce(null);
      const actor: ActorIdentity = { accountId: 'coach-expired', role: 'coach', organizationId: 'org-1', athleteId: null };
      await expect(assertActorCanAccessAthlete(actor, 'ath-1')).rejects.toThrow('Forbidden: coach not assigned to athlete');
    });
  });

  describe('athlete role', () => {
    test('allows athlete to access own record', async () => {
      const actor: ActorIdentity = { accountId: 'acct-1', role: 'athlete', organizationId: 'org-1', athleteId: 'ath-1' };
      await expect(assertActorCanAccessAthlete(actor, 'ath-1')).resolves.toBeUndefined();
      expect(mockQueryOne).not.toHaveBeenCalled();
    });

    test('throws Forbidden when athlete tries to access another athlete record', async () => {
      const actor: ActorIdentity = { accountId: 'acct-1', role: 'athlete', organizationId: 'org-1', athleteId: 'ath-1' };
      await expect(assertActorCanAccessAthlete(actor, 'ath-2')).rejects.toThrow('Forbidden');
    });

    test('throws Forbidden when athlete has no athleteId set', async () => {
      const actor: ActorIdentity = { accountId: 'acct-1', role: 'athlete', organizationId: 'org-1', athleteId: null };
      await expect(assertActorCanAccessAthlete(actor, 'ath-1')).rejects.toThrow('Forbidden');
    });
  });

  describe('parent role', () => {
    test('allows parent linked to athlete', async () => {
      mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
      const actor: ActorIdentity = { accountId: 'parent-acct-1', role: 'parent', organizationId: 'org-1', athleteId: null };
      await expect(assertActorCanAccessAthlete(actor, 'ath-1')).resolves.toBeUndefined();
      expect(mockQueryOne).toHaveBeenCalledWith(
        expect.stringContaining('guardian_links'),
        ['org-1', 'ath-1', 'parent-acct-1'],
      );
    });

    test('throws Forbidden when parent is not linked to athlete', async () => {
      mockQueryOne.mockResolvedValueOnce(null);
      const actor: ActorIdentity = { accountId: 'parent-acct-1', role: 'parent', organizationId: 'org-1', athleteId: null };
      await expect(assertActorCanAccessAthlete(actor, 'ath-other')).rejects.toThrow('Forbidden');
    });
  });

  describe('volunteer and staff roles', () => {
    test('throws Forbidden for volunteer', async () => {
      const actor: ActorIdentity = { accountId: 'v1', role: 'volunteer', organizationId: 'org-1', athleteId: null };
      await expect(assertActorCanAccessAthlete(actor, 'ath-1')).rejects.toThrow('Forbidden');
    });

    test('throws Forbidden for staff', async () => {
      const actor: ActorIdentity = { accountId: 's1', role: 'staff', organizationId: 'org-1', athleteId: null };
      await expect(assertActorCanAccessAthlete(actor, 'ath-1')).rejects.toThrow('Forbidden');
    });
  });
});

// ─── accessibleAthleteIds ─────────────────────────────────────────────────────
//
// The batched counterpart to assertActorCanAccessAthlete: same authorization
// rule per role, but evaluated for a whole candidate list in a bounded
// number of queries instead of one round trip per id. Each test's rule
// mirrors the matching assertActorCanAccessAthlete test above -- this is a
// different query shape for the identical predicate, not a different rule.

describe('accessibleAthleteIds', () => {
  test('returns an empty set without querying when given no ids', async () => {
    const actor: ActorIdentity = { accountId: 'a', role: 'organization_admin', organizationId: 'org-1', athleteId: null };
    await expect(accessibleAthleteIds(actor, [])).resolves.toEqual(new Set());
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('dedupes repeated ids before querying', async () => {
    mockQuery.mockResolvedValueOnce([{ athlete_id: 'ath-1' }]);
    const actor: ActorIdentity = { accountId: 'a', role: 'organization_admin', organizationId: 'org-1', athleteId: null };
    await accessibleAthleteIds(actor, ['ath-1', 'ath-1', 'ath-1']);
    const [, params] = mockQuery.mock.calls[0];
    expect(params[1]).toEqual(['ath-1']);
  });

  test('denies platform_owner without querying, same as assertActorCanAccessAthlete', async () => {
    const actor: ActorIdentity = { accountId: 'a', role: 'platform_owner', organizationId: 'org-1', athleteId: null };
    await expect(accessibleAthleteIds(actor, ['ath-1'])).resolves.toEqual(new Set());
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('denies board without querying, same as assertActorCanAccessAthlete', async () => {
    const actor: ActorIdentity = { accountId: 'b', role: 'board', organizationId: 'org-1', athleteId: null };
    await expect(accessibleAthleteIds(actor, ['ath-1'])).resolves.toEqual(new Set());
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('org admin: returns only the ids that belong to their organization', async () => {
    mockQuery.mockResolvedValueOnce([{ athlete_id: 'ath-1' }]);
    const actor: ActorIdentity = { accountId: 'a', role: 'organization_admin', organizationId: 'org-1', athleteId: null };
    const result = await accessibleAthleteIds(actor, ['ath-1', 'ath-other-org']);
    expect(result).toEqual(new Set(['ath-1']));
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('pilot.athletes');
    expect(params).toEqual(['org-1', ['ath-1', 'ath-other-org']]);
  });

  test('legacy admin role behaves like organization_admin', async () => {
    mockQuery.mockResolvedValueOnce([{ athlete_id: 'ath-1' }]);
    const actor: ActorIdentity = { accountId: 'a', role: 'admin', organizationId: 'org-1', athleteId: null };
    await expect(accessibleAthleteIds(actor, ['ath-1'])).resolves.toEqual(new Set(['ath-1']));
  });

  describe('coach role', () => {
    test('returns directly assigned athletes without a coverage query', async () => {
      mockQuery.mockResolvedValueOnce([{ athlete_id: 'ath-1' }, { athlete_id: 'ath-2' }]);
      const actor: ActorIdentity = { accountId: 'coach-1', role: 'coach', organizationId: 'org-1', athleteId: null };
      const result = await accessibleAthleteIds(actor, ['ath-1', 'ath-2']);
      expect(result).toEqual(new Set(['ath-1', 'ath-2']));
      // Every candidate matched the direct-assignment query -- nothing left
      // to check coverage for.
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    test('falls back to a coverage query only for ids that missed direct assignment', async () => {
      mockQuery
        .mockResolvedValueOnce([{ athlete_id: 'ath-1' }]) // assigned: ath-1 only
        .mockResolvedValueOnce([{ athlete_id: 'ath-2' }]); // covered: ath-2
      const actor: ActorIdentity = { accountId: 'coach-1', role: 'coach', organizationId: 'org-1', athleteId: null };
      const result = await accessibleAthleteIds(actor, ['ath-1', 'ath-2', 'ath-3']);

      expect(result).toEqual(new Set(['ath-1', 'ath-2']));
      const [coverageSql, coverageParams] = mockQuery.mock.calls[1];
      expect(coverageSql).toContain('pilot.coach_coverage');
      expect(coverageParams).toEqual(['org-1', 'coach-1', ['ath-2', 'ath-3']]);
    });

    test('a missing coach_coverage table (42P01) is treated as no coverage, matching assertCoachAssignedToAthlete', async () => {
      const missingTable = Object.assign(new Error('relation "pilot.coach_coverage" does not exist'), { code: '42P01' });
      mockQuery.mockResolvedValueOnce([]).mockRejectedValueOnce(missingTable);
      const actor: ActorIdentity = { accountId: 'coach-1', role: 'coach', organizationId: 'org-1', athleteId: null };
      await expect(accessibleAthleteIds(actor, ['ath-1'])).resolves.toEqual(new Set());
    });

    test('any other database error from the coverage lookup still propagates', async () => {
      const dbDown = Object.assign(new Error('connection refused'), { code: '08006' });
      mockQuery.mockResolvedValueOnce([]).mockRejectedValueOnce(dbDown);
      const actor: ActorIdentity = { accountId: 'coach-1', role: 'coach', organizationId: 'org-1', athleteId: null };
      await expect(accessibleAthleteIds(actor, ['ath-1'])).rejects.toThrow('connection refused');
    });
  });

  describe('athlete role', () => {
    test('returns only their own id, without querying', async () => {
      const actor: ActorIdentity = { accountId: 'acct-1', role: 'athlete', organizationId: 'org-1', athleteId: 'ath-1' };
      await expect(accessibleAthleteIds(actor, ['ath-1', 'ath-2'])).resolves.toEqual(new Set(['ath-1']));
      expect(mockQuery).not.toHaveBeenCalled();
    });

    test('returns an empty set when athleteId is unset', async () => {
      const actor: ActorIdentity = { accountId: 'acct-1', role: 'athlete', organizationId: 'org-1', athleteId: null };
      await expect(accessibleAthleteIds(actor, ['ath-1'])).resolves.toEqual(new Set());
    });
  });

  describe('parent role', () => {
    test('returns the subset of candidates the parent is linked to', async () => {
      mockQuery.mockResolvedValueOnce([{ athlete_id: 'ath-1' }, { athlete_id: 'ath-2' }]);
      const actor: ActorIdentity = { accountId: 'parent-acct-1', role: 'parent', organizationId: 'org-1', athleteId: null };
      const result = await accessibleAthleteIds(actor, ['ath-1', 'ath-3']);
      expect(result).toEqual(new Set(['ath-1']));
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('guardian_links');
      expect(params).toEqual(['org-1', 'parent-acct-1']);
    });
  });

  describe('volunteer and staff roles', () => {
    test('returns an empty set for volunteer, without querying', async () => {
      const actor: ActorIdentity = { accountId: 'v1', role: 'volunteer', organizationId: 'org-1', athleteId: null };
      await expect(accessibleAthleteIds(actor, ['ath-1'])).resolves.toEqual(new Set());
      expect(mockQuery).not.toHaveBeenCalled();
    });

    test('returns an empty set for staff, without querying', async () => {
      const actor: ActorIdentity = { accountId: 's1', role: 'staff', organizationId: 'org-1', athleteId: null };
      await expect(accessibleAthleteIds(actor, ['ath-1'])).resolves.toEqual(new Set());
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });
});

// ─── athleteIdsForCoach ──────────────────────────────────────────────────────
//
// OPERATIONS V1 acceptance points 11 and 40. This is the "everything mine"
// counterpart to accessibleAthleteIds, and it is the access boundary for
// FIVE coach-facing aggregates: the Morning Read digest, the readiness
// board, performance analytics, progression suggestions, and escalations.
// Every one of those route tests mocks this function, so until now the
// scope itself -- the union, its coverage window, and its behavior when the
// coverage table is absent -- was asserted by nothing at all. A mocked
// boundary is a boundary nobody has watched hold.

describe('athleteIdsForCoach', () => {
  test('is the union of assignment of record and coverage that is live RIGHT NOW', async () => {
    mockQuery.mockResolvedValueOnce([{ athlete_id: 'ath-1' }, { athlete_id: 'ath-2' }]);

    await expect(athleteIdsForCoach('org-1', 'coach-1')).resolves.toEqual(['ath-1', 'ath-2']);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('pilot.athletes');
    expect(sql).toContain('pilot.coach_coverage');
    // The two halves of the window. Without BOTH, a grant that has not
    // started yet, or one that lapsed months ago, still returns the athlete
    // -- and coverage stops being bounded exposure at all.
    expect(sql).toContain('starts_at <= now()');
    expect(sql).toContain('expires_at > now()');
    // Both halves are scoped by organization and by this coach, and nothing
    // else is passed: there is no third parameter a caller could widen.
    expect(params).toEqual(['org-1', 'coach-1']);
  });

  test('a missing coach_coverage table (42P01) falls back to assigned athletes only, never a 500', async () => {
    const missingTable = Object.assign(new Error('relation "pilot.coach_coverage" does not exist'), { code: '42P01' });
    mockQuery
      .mockRejectedValueOnce(missingTable)
      .mockResolvedValueOnce([{ athlete_id: 'ath-1' }]);

    await expect(athleteIdsForCoach('org-1', 'coach-1')).resolves.toEqual(['ath-1']);

    // The fallback is the pre-coverage scope, not a wider one: it must still
    // ask for this coach's own athletes, and must not mention coverage.
    const [fallbackSql, fallbackParams] = mockQuery.mock.calls[1];
    expect(fallbackSql).toContain('coach_id = $2');
    expect(fallbackSql).not.toContain('coach_coverage');
    expect(fallbackParams).toEqual(['org-1', 'coach-1']);
  });

  test('any other database error still propagates rather than degrading to a partial roster', async () => {
    const dbDown = Object.assign(new Error('connection refused'), { code: '08006' });
    mockQuery.mockRejectedValueOnce(dbDown);

    await expect(athleteIdsForCoach('org-1', 'coach-1')).rejects.toThrow('connection refused');
    // Critically, no second query: a coach surface that answered with a
    // silently-shortened roster during an outage would read as "these are
    // your athletes" while hiding some of them.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

// ─── assertAthleteUpdateAllowed ──────────────────────────────────────────────
//
// This function had no tests, which is how the coach branch below stayed
// missing: `coach_id` is in the update route's CORRECTABLE_FIELDS and is
// written by upsertAthlete's `coach_id = excluded.coach_id`, so nothing
// between the request and the column refused a coach rewriting it.

describe('assertAthleteUpdateAllowed', () => {
  const actor = (role: string): ActorIdentity => ({
    accountId: 'coach-sub',
    role: role as ActorIdentity['role'],
    organizationId: 'org-1',
    athleteId: 'ath-1',
  });

  const record = (overrides: Partial<{ coach_id: string; active_flag: boolean; gym_status: string }> = {}) => ({
    coach_id: 'coach-assigned',
    active_flag: true,
    gym_status: 'active',
    ...overrides,
  });

  describe('coach role', () => {
    test('refuses a coach reassigning the athlete to themselves', () => {
      // The escalation this guards: a coach who reached the record through a
      // temporary grant writes themselves in as the permanent coach, after
      // which the grant's expiry no longer matters.
      expect(() =>
        assertAthleteUpdateAllowed(actor('coach'), record(), record({ coach_id: 'coach-sub' })),
      ).toThrow('Forbidden: coach cannot change coach assignment');
    });

    test('refuses a coach handing the athlete to a different coach', () => {
      expect(() =>
        assertAthleteUpdateAllowed(actor('coach'), record(), record({ coach_id: 'coach-other' })),
      ).toThrow('Forbidden: coach cannot change coach assignment');
    });

    test('still allows a coach to correct fields that are theirs to correct', () => {
      expect(() =>
        assertAthleteUpdateAllowed(actor('coach'), record(), record({ gym_status: 'injured' })),
      ).not.toThrow();
    });
  });

  describe('organization_admin role', () => {
    test('allows an admin to reassign the coach -- this is an administrator decision', () => {
      expect(() =>
        assertAthleteUpdateAllowed(actor('organization_admin'), record(), record({ coach_id: 'coach-new' })),
      ).not.toThrow();
    });

    test('allows the legacy admin role to reassign the coach', () => {
      expect(() =>
        assertAthleteUpdateAllowed(actor('admin'), record(), record({ coach_id: 'coach-new' })),
      ).not.toThrow();
    });
  });

  describe('athlete role -- existing invariants, unchanged', () => {
    test('refuses an athlete changing their coach assignment', () => {
      expect(() =>
        assertAthleteUpdateAllowed(actor('athlete'), record(), record({ coach_id: 'coach-new' })),
      ).toThrow('Forbidden: athlete cannot change coach assignment');
    });

    test('refuses an athlete changing their active flag', () => {
      expect(() =>
        assertAthleteUpdateAllowed(actor('athlete'), record(), record({ active_flag: false })),
      ).toThrow('Forbidden: athlete cannot change status flags');
    });

    test('refuses an athlete changing their gym status', () => {
      expect(() =>
        assertAthleteUpdateAllowed(actor('athlete'), record(), record({ gym_status: 'inactive' })),
      ).toThrow('Forbidden: athlete cannot change gym_status');
    });

    test('allows an athlete to submit an unchanged record', () => {
      expect(() => assertAthleteUpdateAllowed(actor('athlete'), record(), record())).not.toThrow();
    });
  });
});
