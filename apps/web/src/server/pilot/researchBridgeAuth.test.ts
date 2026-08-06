import { extractBearerToken, hasRequiredClaims, isResearchBridgeExportActive } from './researchBridgeAuth';

describe('research bridge export activation', () => {
  const enabled = {
    RESEARCH_BRIDGE_EXPORT_ENABLED: 'true',
    RESEARCH_BRIDGE_EXPORT_ENVIRONMENT: 'staging',
    RESEARCH_BRIDGE_EXPORT_ALLOWED_HOST: 'app-ppbf-staging.example.test',
  };

  test('requires all three staging guards', () => {
    expect(isResearchBridgeExportActive(enabled, 'app-ppbf-staging.example.test')).toBe(true);
    expect(isResearchBridgeExportActive({ ...enabled, RESEARCH_BRIDGE_EXPORT_ENABLED: 'false' }, 'app-ppbf-staging.example.test')).toBe(false);
    expect(isResearchBridgeExportActive({ ...enabled, RESEARCH_BRIDGE_EXPORT_ENVIRONMENT: 'production' }, 'app-ppbf-staging.example.test')).toBe(false);
    expect(isResearchBridgeExportActive(enabled, 'app-ppbf-production.example.test')).toBe(false);
  });

  test('extracts only a single bearer token', () => {
    expect(extractBearerToken('Bearer token-value')).toBe('token-value');
    expect(extractBearerToken('Basic token-value')).toBeNull();
    expect(extractBearerToken('Bearer one two')).toBeNull();
  });

  test('accepts either approved managed identity only with the export role', () => {
    const allowed = new Set(['bridge-client', 'sync-client']);
    expect(hasRequiredClaims({ roles: ['Research.Export'], azp: 'bridge-client' }, allowed)).toBe(true);
    expect(hasRequiredClaims({ roles: ['Research.Export'], appid: 'sync-client' }, allowed)).toBe(true);
    expect(hasRequiredClaims({ roles: ['Research.Export'], azp: 'other-client' }, allowed)).toBe(false);
    expect(hasRequiredClaims({ roles: [], azp: 'bridge-client' }, allowed)).toBe(false);
  });
});
