import {
  assertActorCanAccessAthlete,
  assertAthleteBelongsToOrganization,
  assertAthleteUpdateAllowed,
  assertCoachAssignedToAthlete,
  isOrganizationAdminRole,
  requireRole,
} from './access';
import { queryOne } from './db';
import type { ActorIdentity } from './access';

jest.mock('./db', () => ({
  queryOne: jest.fn(),
}));

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
    // Setup only (T-002's rule: add setup, never weaken the assertion): the
    // coach is not assigned AND holds no coverage grant.
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
        ['ath-1', 'coach-sub', 'org-1'],
      );
    });

    // The window predicates live in the SQL itself, so an expired (or
    // revoked, or not-yet-started) grant is indistinguishable from no grant:
    // the query returns nothing and the same Forbidden is thrown. The
    // real-Postgres proof that the predicates enforce expiry against real
    // rows is in coachCoverage.pg.test.ts.
    test('throws Forbidden when the only grant is expired: the lookup window excludes it', async () => {
      mockQueryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      await expect(assertCoachAssignedToAthlete('coach-sub', 'ath-1', 'org-1')).rejects.toThrow(
        'Forbidden: coach not assigned to athlete',
      );
      const [coverageSql] = mockQueryOne.mock.calls[1];
      expect(String(coverageSql)).toContain('revoked_at is null');
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

// ─── assertAthleteUpdateAllowed: the coverage-to-permanent escalation guard ──

describe('assertAthleteUpdateAllowed coach branch (T-002)', () => {
  const fields = (coachId: string) => ({ coach_id: coachId, active_flag: true, gym_status: 'active' });

  // Without this guard, a covering coach could rewrite coach_id to
  // themselves through athletes/update: the exact-match branch would then
  // pass forever, and revoking or expiring the grant would change nothing --
  // a temporary grant silently converted into permanent access to a minor's
  // records.
  test('a coach who is not the coach of record cannot change coach_id', () => {
    const actor: ActorIdentity = { accountId: 'coach-sub', role: 'coach', organizationId: 'org-1', athleteId: null };
    expect(() => assertAthleteUpdateAllowed(actor, fields('coach-record'), fields('coach-sub'))).toThrow(
      'Forbidden: covering coach cannot change coach assignment',
    );
  });

  test('a covering coach may still correct non-assignment fields', () => {
    const actor: ActorIdentity = { accountId: 'coach-sub', role: 'coach', organizationId: 'org-1', athleteId: null };
    const before = { coach_id: 'coach-record', active_flag: true, gym_status: 'active' };
    const after = { coach_id: 'coach-record', active_flag: true, gym_status: 'active' };
    expect(() => assertAthleteUpdateAllowed(actor, before, after)).not.toThrow();
  });

  test('the coach of record may hand off their own athlete', () => {
    const actor: ActorIdentity = { accountId: 'coach-record', role: 'coach', organizationId: 'org-1', athleteId: null };
    expect(() => assertAthleteUpdateAllowed(actor, fields('coach-record'), fields('coach-next'))).not.toThrow();
  });

  test('admin reassignment is untouched by the coach guard', () => {
    const actor: ActorIdentity = { accountId: 'acct-admin', role: 'organization_admin', organizationId: 'org-1', athleteId: null };
    expect(() => assertAthleteUpdateAllowed(actor, fields('coach-record'), fields('coach-next'))).not.toThrow();
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
      // Setup only: no assignment and no coverage grant (T-002 added the
      // second lookup). The assertion is unchanged.
      mockQueryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      const actor: ActorIdentity = { accountId: 'coach-1', role: 'coach', organizationId: 'org-1', athleteId: null };
      await expect(assertActorCanAccessAthlete(actor, 'ath-other')).rejects.toThrow('Forbidden');
    });

    test('allows access when coach holds an active coverage grant for the athlete (T-002)', async () => {
      mockQueryOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ coverage_id: 'cov-1' });
      const actor: ActorIdentity = { accountId: 'coach-sub', role: 'coach', organizationId: 'org-1', athleteId: null };
      await expect(assertActorCanAccessAthlete(actor, 'ath-1')).resolves.toBeUndefined();
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
