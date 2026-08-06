import {
  assertActorCanAccessAthlete,
  assertAthleteBelongsToOrganization,
  assertAthleteUpdateAllowed,
  assertCoachAssignedToAthlete,
  DEFAULT_COVERAGE_TTL_HOURS,
  grantCoachCoverage,
  isOrganizationAdminRole,
  requireRole,
  revokeCoachCoverage,
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
  });

  test('throws Forbidden when coach is not assigned to athlete', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    mockQueryOne.mockResolvedValueOnce(null);
    await expect(assertCoachAssignedToAthlete('coach-1', 'ath-other', 'org-1')).rejects.toThrow('Forbidden');
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
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });
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
      mockQueryOne.mockResolvedValueOnce(null);
      mockQueryOne.mockResolvedValueOnce(null);
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
