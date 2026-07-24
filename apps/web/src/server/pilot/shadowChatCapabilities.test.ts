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
