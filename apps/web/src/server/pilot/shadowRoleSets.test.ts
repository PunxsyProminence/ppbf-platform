import { requireRole, type ActorIdentity } from './access';
import {
  DECISION_LOOP_ROLES,
  MANUAL_OVERRIDE_ROLES,
  ORGANIZATION_MEMBER_ROLES,
  SHADOW_LIBRARY_CURATOR_ROLES,
  SHADOW_PHI_ROLES,
  SHADOW_PROJECTION_READ_ROLES,
} from './shadowRoleSets';

function actor(role: ActorIdentity['role']): ActorIdentity {
  return {
    accountId: 'acct-1',
    role,
    organizationId: 'org-1',
    athleteId: null,
  };
}

describe('SHADOW role sets', () => {
  describe('platform_owner (Omega) breadth', () => {
    // The platform owner was omitted from these lists, which made every
    // /admin/shadow request it issued return 403 while the UI still admitted it
    // to the page. These assertions are the regression guard for that.
    it('may read organization-scoped projections and telemetry', () => {
      expect(() => requireRole(actor('platform_owner'), [...SHADOW_PROJECTION_READ_ROLES])).not.toThrow();
    });

    it('is not a member role', () => {
      expect(ORGANIZATION_MEMBER_ROLES).not.toContain('platform_owner');
      expect(() => requireRole(actor('platform_owner'), [...ORGANIZATION_MEMBER_ROLES])).toThrow('Forbidden');
    });

    it('may curate an organization library, which holds doctrine rather than PHI', () => {
      // The depth restriction is enforced per-document instead: a document
      // carrying a subject_id is athlete-scoped, and the documents route runs
      // assertActorCanAccessAthlete, which refuses platform_owner outright.
      expect(SHADOW_LIBRARY_CURATOR_ROLES).toContain('platform_owner');
      expect(() => requireRole(actor('platform_owner'), [...SHADOW_LIBRARY_CURATOR_ROLES])).not.toThrow();
    });

    it('may force a SHADOW tier', () => {
      expect(MANUAL_OVERRIDE_ROLES).toContain('platform_owner');
    });
  });

  describe('platform_owner (Omega) depth restriction', () => {
    // Omega is broader in breadth but STRICTLY NARROWER IN DEPTH than an
    // organization admin. These are the assertions that keep it that way. If a
    // future change adds platform_owner to either set, it must be a deliberate
    // privacy decision -- these tests are meant to fail loudly first.
    it('must never reach protected health information', () => {
      expect(SHADOW_PHI_ROLES).not.toContain('platform_owner');
      expect(() => requireRole(actor('platform_owner'), [...SHADOW_PHI_ROLES])).toThrow('Forbidden');
    });

    it('keeps the library write path aligned with the review path that approves it', () => {
      // Curating evidence and approving it are the same authority. If these
      // ever diverge, either a curator can write what no reviewer can approve,
      // or a reviewer can approve what no curator could have written.
      expect([...SHADOW_LIBRARY_CURATOR_ROLES].sort()).toEqual(
        ['admin', 'organization_admin', 'platform_owner'],
      );
    });

    it('must not author decisions inside an organization', () => {
      expect(DECISION_LOOP_ROLES).not.toContain('platform_owner');
      expect(() => requireRole(actor('platform_owner'), [...DECISION_LOOP_ROLES])).toThrow('Forbidden');
    });

    it('grants an organization admin the PHI access that Omega lacks', () => {
      // The inversion stated plainly: on this route the org admin is the wider
      // role and the platform owner is the narrower one.
      expect(() => requireRole(actor('organization_admin'), [...SHADOW_PHI_ROLES])).not.toThrow();
      expect(() => requireRole(actor('platform_owner'), [...SHADOW_PHI_ROLES])).toThrow('Forbidden');
    });
  });

  describe('board role', () => {
    // Board is restricted to organization-level aggregates and has no SHADOW
    // chat or record access. It must not appear in any SHADOW role set.
    it.each([
      ['ORGANIZATION_MEMBER_ROLES', ORGANIZATION_MEMBER_ROLES],
      ['SHADOW_PROJECTION_READ_ROLES', SHADOW_PROJECTION_READ_ROLES],
      ['SHADOW_PHI_ROLES', SHADOW_PHI_ROLES],
      ['DECISION_LOOP_ROLES', DECISION_LOOP_ROLES],
      ['MANUAL_OVERRIDE_ROLES', MANUAL_OVERRIDE_ROLES],
      ['SHADOW_LIBRARY_CURATOR_ROLES', SHADOW_LIBRARY_CURATOR_ROLES],
    ])('is absent from %s', (_name, roles) => {
      expect(roles).not.toContain('board');
    });
  });

  describe('legacy admin alias', () => {
    // 'admin' is a legacy alias for 'organization_admin'. Any set naming one
    // must name the other, or authorization silently depends on which row shape
    // an account happens to have.
    it.each([
      ['ORGANIZATION_MEMBER_ROLES', ORGANIZATION_MEMBER_ROLES],
      ['SHADOW_PROJECTION_READ_ROLES', SHADOW_PROJECTION_READ_ROLES],
      ['SHADOW_PHI_ROLES', SHADOW_PHI_ROLES],
      ['DECISION_LOOP_ROLES', DECISION_LOOP_ROLES],
      ['MANUAL_OVERRIDE_ROLES', MANUAL_OVERRIDE_ROLES],
      ['SHADOW_LIBRARY_CURATOR_ROLES', SHADOW_LIBRARY_CURATOR_ROLES],
    ])('names both admin spellings in %s', (_name, roles) => {
      expect(roles.includes('admin')).toBe(roles.includes('organization_admin'));
    });
  });
});
