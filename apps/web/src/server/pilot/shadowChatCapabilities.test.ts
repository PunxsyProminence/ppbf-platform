import { canUseShadowSessionType, getShadowChatCapabilities } from './shadowChatCapabilities';

describe('SHADOW chat capabilities', () => {
  it('keeps athlete sessions scoped to low-authority modes', () => {
    const capabilities = getShadowChatCapabilities('athlete');
    expect(capabilities.mode).toBe('scoped');
    expect(capabilities.allowedSessionTypes).toEqual(['quick_round']);
    expect(capabilities.canUseManualTier).toBe(false);
    expect(capabilities.canViewEvidence).toBe(false);
    expect(capabilities.canReviewSafetyEvents).toBe(false);
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
    expect(capabilities.canReviewSafetyEvents).toBe(false);
  });

  it('limits safety review to organization administrators', () => {
    expect(getShadowChatCapabilities('organization_admin').canReviewSafetyEvents).toBe(true);
    expect(getShadowChatCapabilities('admin').canReviewSafetyEvents).toBe(true);
    expect(getShadowChatCapabilities('platform_owner').canReviewSafetyEvents).toBe(true);
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
