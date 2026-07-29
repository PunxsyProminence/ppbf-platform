import { SHADOW_PHI_ROLES } from './shadowRoleSets';
import type { PilotRole } from './contracts';
import { canUseShadowSessionType, getShadowChatCapabilities } from './shadowChatCapabilities';

describe('SHADOW chat capabilities', () => {
  it('keeps athlete sessions scoped to low-authority modes', () => {
    const capabilities = getShadowChatCapabilities('athlete');
    expect(capabilities.mode).toBe('scoped');
    expect(capabilities.allowedSessionTypes).toEqual(['quick_round']);
    expect(capabilities.canUseManualTier).toBe(false);
    expect(capabilities.canViewEvidence).toBe(false);
    expect(capabilities.canReviewChatSafetyTelemetry).toBe(false);
    expect(capabilities.canExportConversationHistory).toBe(true);
    expect(capabilities.canExportOwnData).toBe(false);
    expect(capabilities.canRequestDeletion).toBe(true);
    expect(capabilities.deletionFulfillment).toBe('manual_review_required');
  });

  it('allows coaches to select analysis modes without granting safety review', () => {
    const capabilities = getShadowChatCapabilities('coach');
    expect(capabilities.allowedSessionTypes).toContain('heavy_bag');
    expect(capabilities.allowedSessionTypes).not.toContain('film_study');
    expect(capabilities.allowedSessionTypes).not.toContain('scout_report');
    expect(capabilities.canUseManualTier).toBe(true);
    expect(capabilities.canReviewChatSafetyTelemetry).toBe(false);
  });

  it('limits safety review to organization administrators', () => {
    expect(getShadowChatCapabilities('organization_admin').canReviewChatSafetyTelemetry).toBe(true);
    expect(getShadowChatCapabilities('admin').canReviewChatSafetyTelemetry).toBe(true);
    expect(getShadowChatCapabilities('platform_owner').canReviewChatSafetyTelemetry).toBe(true);
  });

  // Omega is broader in breadth but strictly narrower in depth than an
  // organization admin (see shadowRoleSets.ts). Collapsing it back into
  // 'master' would erase the depth restriction, so these assert the split.
  it('gives platform_owner its own omega mode, not organization-admin master', () => {
    const omega = getShadowChatCapabilities('platform_owner');
    expect(omega.mode).toBe('omega');
    expect(getShadowChatCapabilities('organization_admin').mode).toBe('master');
    expect(getShadowChatCapabilities('admin').mode).toBe('master');
    expect(getShadowChatCapabilities('coach').mode).toBe('scoped');
  });

  it('grants omega cross-organization read and denies it protected health information', () => {
    const omega = getShadowChatCapabilities('platform_owner');
    expect(omega.crossOrganizationRead).toBe(true);
    expect(omega.canAccessProtectedHealthInformation).toBe(false);
  });

  it('keeps protected health information with in-organization roles only', () => {
    expect(getShadowChatCapabilities('organization_admin').canAccessProtectedHealthInformation).toBe(true);
    expect(getShadowChatCapabilities('admin').canAccessProtectedHealthInformation).toBe(true);
    expect(getShadowChatCapabilities('organization_admin').crossOrganizationRead).toBe(false);
    expect(getShadowChatCapabilities('coach').crossOrganizationRead).toBe(false);
    expect(getShadowChatCapabilities('athlete').crossOrganizationRead).toBe(false);
  });

  it('retains the tier affordances omega genuinely shares with organization admins', () => {
    const omega = getShadowChatCapabilities('platform_owner');
    expect(omega.allowedSessionTypes).toContain('heavy_bag');
    expect(omega.canUseManualTier).toBe(true);
    expect(omega.canManageSessions).toBe(true);
  });

  it('does not advertise evidence until verified retrieval is wired into chat', () => {
    expect(getShadowChatCapabilities('organization_admin').canViewEvidence).toBe(false);
    expect(getShadowChatCapabilities('coach').canViewEvidence).toBe(false);
    expect(getShadowChatCapabilities('athlete').canViewEvidence).toBe(false);
  });

  it('rejects unknown and disallowed session types', () => {
    expect(canUseShadowSessionType('athlete', 'heavy_bag')).toBe(false);
    expect(canUseShadowSessionType('coach', 'heavy_bag')).toBe(true);
    expect(canUseShadowSessionType('coach', 'invented_mode')).toBe(false);
  });
});

// This field is derived from SHADOW_PHI_ROLES rather than recomputed, so it
// cannot drift from the list the medical-status route actually enforces on.
// An earlier hardcoded version restated it as "organization admins only" and
// silently misreported coaches, who are in that role set and can reach
// clinical state.
describe('protected-health-information flag tracks SHADOW_PHI_ROLES exactly', () => {
  test.each<[PilotRole, boolean]>([
    ['coach', true],
    ['organization_admin', true],
    ['admin', true],
    ['platform_owner', false],
    ['athlete', false],
    ['parent', false],
    ['board', false],
    ['volunteer', false],
    ['staff', false],
  ])('%s -> %p', (role, expected) => {
    expect(getShadowChatCapabilities(role).canAccessProtectedHealthInformation).toBe(expected);
  });

  test('every role in SHADOW_PHI_ROLES reports true', () => {
    for (const role of SHADOW_PHI_ROLES) {
      expect(getShadowChatCapabilities(role).canAccessProtectedHealthInformation).toBe(true);
    }
  });
});

// Omega's two hard boundaries, asserted together because they are the reason
// the tier exists in the form it does: maximum operational breadth, stopping
// at clinical state and youth-protection content.
describe('Omega gets operational breadth but not clinical or youth-protection depth', () => {
  const omega = () => getShadowChatCapabilities('platform_owner');

  test('reaches cross-organization operational signal', () => {
    expect(omega().crossOrganizationRead).toBe(true);
    expect(omega().canReviewChatSafetyTelemetry).toBe(true);
  });

  test('is denied clinical state, which is enforced at the medical-status route', () => {
    expect(omega().canAccessProtectedHealthInformation).toBe(false);
    expect(SHADOW_PHI_ROLES).not.toContain('platform_owner');
  });

  // Chat-safety telemetry is filter/refusal counts about the assistant, not
  // incident reports about people. If a youth-protection surface is ever added
  // it needs its own capability denied to platform_owner -- reusing this one
  // would hand Omega SafeSport content that shadowRoleSets.ts forbids.
  test('chat-safety telemetry is not a youth-protection capability', () => {
    const capabilities = omega() as unknown as Record<string, unknown>;
    expect('canReviewSafetyEvents' in capabilities).toBe(false);
    expect('canReviewYouthProtectionContent' in capabilities).toBe(false);
    expect('canReviewIncidentReports' in capabilities).toBe(false);
  });
});
