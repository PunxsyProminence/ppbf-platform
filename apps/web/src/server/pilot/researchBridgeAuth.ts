import type { NextRequest } from 'next/server';

type JoseModule = typeof import('jose');
type JWTPayload = import('jose').JWTPayload;
type RemoteJWKSet = ReturnType<JoseModule['createRemoteJWKSet']>;

export class ResearchBridgeAccessError extends Error {
  constructor(public readonly status: 401 | 403 | 404 | 503, message: string) {
    super(message);
    this.name = 'ResearchBridgeAccessError';
  }
}

type ResearchBridgeEnvironment = Record<string, string | undefined> & {
  RESEARCH_BRIDGE_EXPORT_ENABLED?: string;
  RESEARCH_BRIDGE_EXPORT_ENVIRONMENT?: string;
  RESEARCH_BRIDGE_EXPORT_ALLOWED_HOST?: string;
  RESEARCH_BRIDGE_EXPORT_AUDIENCE?: string;
  RESEARCH_BRIDGE_EXPORT_ALLOWED_CLIENT_IDS?: string;
  RESEARCH_BRIDGE_ORGANIZATION_ID?: string;
  AZURE_TENANT_ID?: string;
};

const jwksByTenant = new Map<string, RemoteJWKSet>();

export function isResearchBridgeExportActive(
  environment: ResearchBridgeEnvironment,
  requestHost: string,
): boolean {
  const allowedHost = environment.RESEARCH_BRIDGE_EXPORT_ALLOWED_HOST?.trim().toLowerCase();
  return environment.RESEARCH_BRIDGE_EXPORT_ENABLED === 'true'
    && environment.RESEARCH_BRIDGE_EXPORT_ENVIRONMENT === 'staging'
    && Boolean(allowedHost)
    && requestHost.trim().toLowerCase() === allowedHost;
}

export function extractBearerToken(authorization: string | null): string | null {
  if (!authorization) {
    return null;
  }
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

export function hasRequiredClaims(payload: JWTPayload, allowedClientIds: ReadonlySet<string>): boolean {
  const roles = Array.isArray(payload.roles) ? payload.roles : [];
  const callingClientId = typeof payload.azp === 'string'
    ? payload.azp
    : typeof payload.appid === 'string'
      ? payload.appid
      : '';
  return roles.includes('Research.Export') && allowedClientIds.has(callingClientId);
}

export async function requireResearchBridgeAccess(
  request: NextRequest,
  environment: ResearchBridgeEnvironment = process.env,
): Promise<{ organizationId: string }> {
  if (!isResearchBridgeExportActive(environment, new URL(request.url).host)) {
    throw new ResearchBridgeAccessError(404, 'Research bridge export is unavailable');
  }

  const tenantId = environment.AZURE_TENANT_ID?.trim();
  const audience = environment.RESEARCH_BRIDGE_EXPORT_AUDIENCE?.trim();
  const allowedClientIds = new Set(
    (environment.RESEARCH_BRIDGE_EXPORT_ALLOWED_CLIENT_IDS ?? '')
      .split(',')
      .map((clientId) => clientId.trim())
      .filter(Boolean),
  );
  const organizationId = environment.RESEARCH_BRIDGE_ORGANIZATION_ID?.trim();
  if (!tenantId || !audience || allowedClientIds.size === 0 || !organizationId) {
    throw new ResearchBridgeAccessError(503, 'Research bridge export is not configured');
  }

  const token = extractBearerToken(request.headers.get('authorization'));
  if (!token) {
    throw new ResearchBridgeAccessError(401, 'Authentication required');
  }

  try {
    const { createRemoteJWKSet, jwtVerify } = await import('jose');
    const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
    const jwks = jwksByTenant.get(tenantId)
      ?? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`));
    jwksByTenant.set(tenantId, jwks);
    const { payload } = await jwtVerify(token, jwks, {
      audience,
      issuer,
      algorithms: ['RS256'],
    });
    if (payload.tid !== tenantId || !hasRequiredClaims(payload, allowedClientIds)) {
      throw new ResearchBridgeAccessError(403, 'Forbidden');
    }
  } catch (error) {
    if (error instanceof ResearchBridgeAccessError) {
      throw error;
    }
    throw new ResearchBridgeAccessError(401, 'Authentication failed');
  }

  return { organizationId };
}
