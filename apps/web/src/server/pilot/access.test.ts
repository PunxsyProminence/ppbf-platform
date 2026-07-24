import {
  assertActorCanAccessAthlete,
  assertAthleteBelongsToOrganization,
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
  });

  test('throws Forbidden when coach is not assigned to athlete', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    await expect(assertCoachAssignedToAthlete('coach-1', 'ath-other', 'org-1')).rejects.toThrow('Forbidden');
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
      const actor: ActorIdentity = { accountId: 'coach-1', role: 'coach', organizationId: 'org-1', athleteId: null };
      await expect(assertActorCanAccessAthlete(actor, 'ath-other')).rejects.toThrow('Forbidden');
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
