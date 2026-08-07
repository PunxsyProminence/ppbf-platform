import {
  allowedResearchBridgeIssuers,
  extractBearerToken,
  hasRequiredClaims,
  isResearchBridgeExportActive,
  resolveResearchBridgeRequestHost,
} from './researchBridgeAuth';

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

  test('uses the external proxy host before the internal request URL', () => {
    expect(resolveResearchBridgeRequestHost(
      'http://localhost:3000/api/pilot/shadow/research-bridge/export',
      'internal-proxy.example.test',
      'app-ppbf-staging.example.test',
    )).toBe('app-ppbf-staging.example.test');
    expect(resolveResearchBridgeRequestHost(
      'http://localhost:3000/api/pilot/shadow/research-bridge/export',
      'app-ppbf-staging.example.test',
      null,
    )).toBe('app-ppbf-staging.example.test');
  });

  test('accepts only the tenant v2 and managed-identity issuers', () => {
    expect(allowedResearchBridgeIssuers('tenant-id')).toEqual([
      'https://login.microsoftonline.com/tenant-id/v2.0',
      'https://sts.windows.net/tenant-id/',
    ]);
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
