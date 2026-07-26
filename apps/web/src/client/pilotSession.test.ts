import { getPilotSessionAuthProvider, getPilotSessionRedirectPath } from './pilotSession';

describe('pilotSession helpers', () => {
  test('accepts either auth provider field name', () => {
    expect(getPilotSessionAuthProvider({ auth_provider: 'microsoft' })).toBe('microsoft');
    expect(getPilotSessionAuthProvider({ authProvider: 'ppbf_local' })).toBe('ppbf_local');
  });

  test('routes session payloads through the login redirect contract', () => {
    expect(getPilotSessionRedirectPath({ role: 'platform_owner' })).toBe('/admin/organizations');
    expect(getPilotSessionRedirectPath({ role: 'coach', has_master_shadow_access: true })).toBe('/admin');
    expect(getPilotSessionRedirectPath({ role: 'athlete' })).toBe('/athlete/dashboard');
  });
});