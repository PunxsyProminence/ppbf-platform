import {
  hasSecureDestination,
  isDestinationAllowedForClassification,
  isRestrictedFromGeneralShadowLibrary,
  isVisibleToOrdinaryCoach,
  targetsGeneralShadowLibrary,
} from './privacyClassification';

describe('privacy classification', () => {
  it('has no secure destination for admin_restricted content', () => {
    expect(hasSecureDestination('admin_restricted')).toBe(false);
    expect(isDestinationAllowedForClassification('admin_restricted', 'pilot.shadow_library_chunks')).toBe(false);
    expect(isDestinationAllowedForClassification('admin_restricted', 'pilot.sessions')).toBe(false);
  });

  it('has no secure destination for unpromoted support_reference content', () => {
    expect(hasSecureDestination('support_reference')).toBe(false);
  });

  it('allows athlete_private content only into existing scoped athlete tables', () => {
    expect(isDestinationAllowedForClassification('athlete_private', 'pilot.sessions')).toBe(true);
    expect(isDestinationAllowedForClassification('athlete_private', 'pilot.shadow_formula_observations')).toBe(true);
    expect(isDestinationAllowedForClassification('athlete_private', 'pilot.shadow_library_chunks')).toBe(false);
  });

  it('allows organization_doctrine into the general SHADOW library only', () => {
    expect(isDestinationAllowedForClassification('organization_doctrine', 'pilot.shadow_library_documents')).toBe(true);
    expect(isDestinationAllowedForClassification('organization_doctrine', 'pilot.sessions')).toBe(false);
  });

  it('flags admin_restricted and support_reference as barred from the general SHADOW library', () => {
    expect(isRestrictedFromGeneralShadowLibrary('admin_restricted')).toBe(true);
    expect(isRestrictedFromGeneralShadowLibrary('support_reference')).toBe(true);
    expect(isRestrictedFromGeneralShadowLibrary('athlete_private')).toBe(false);
    expect(isRestrictedFromGeneralShadowLibrary('organization_doctrine')).toBe(false);
  });

  it('identifies the general SHADOW library tables', () => {
    expect(targetsGeneralShadowLibrary('pilot.shadow_library_chunks')).toBe(true);
    expect(targetsGeneralShadowLibrary('pilot.sessions')).toBe(false);
  });

  it('keeps admin_restricted content out of ordinary coach visibility', () => {
    expect(isVisibleToOrdinaryCoach('admin_restricted')).toBe(false);
    expect(isVisibleToOrdinaryCoach('support_reference')).toBe(false);
    expect(isVisibleToOrdinaryCoach('athlete_private')).toBe(true);
    expect(isVisibleToOrdinaryCoach('organization_doctrine')).toBe(true);
  });
});
