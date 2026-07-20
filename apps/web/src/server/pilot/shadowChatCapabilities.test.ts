import { canUseShadowSessionType, getShadowChatCapabilities } from './shadowChatCapabilities';

describe('SHADOW chat capabilities', () => {
  it('limits athletes, parents, staff, and volunteers to non-privileged sessions', () => {
    for (const role of ['athlete', 'parent', 'staff', 'volunteer'] as const) {
      expect(getShadowChatCapabilities(role).canUseManualTier).toBe(false);
      expect(canUseShadowSessionType(role, 'heavy_bag')).toBe(false);
      expect(canUseShadowSessionType(role, 'quick_round')).toBe(true);
    }
  });

  it('allows coaches and administrators to use advanced sessions', () => {
    for (const role of ['coach', 'admin', 'organization_admin', 'platform_owner'] as const) {
      expect(getShadowChatCapabilities(role).canUseManualTier).toBe(true);
      expect(canUseShadowSessionType(role, 'heavy_bag')).toBe(true);
    }
  });

  it('restricts safety review to administrative roles', () => {
    expect(getShadowChatCapabilities('coach').canReviewSafetyEvents).toBe(false);
    expect(getShadowChatCapabilities('admin').canReviewSafetyEvents).toBe(true);
  });
});
