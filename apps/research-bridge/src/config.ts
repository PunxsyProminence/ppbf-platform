import { z } from 'zod';

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  STAGING_APP_ORIGIN: z.string().url().refine((value) => new URL(value).protocol === 'https:', 'STAGING_APP_ORIGIN must use HTTPS'),
  MCP_AUDIENCE: z.string().min(1),
  AZURE_SEARCH_ENDPOINT: z.string().url().refine((value) => new URL(value).protocol === 'https:'),
  AZURE_SEARCH_INDEX_NAME: z.string().min(1).max(128).default('ppbf-research-evidence-v1'),
  AZURE_STORAGE_ACCOUNT_URL: z.string().url().refine((value) => new URL(value).protocol === 'https:'),
  AZURE_STORAGE_RESEARCH_CONTAINER: z.string().min(3),
  AZURE_STORAGE_EVIDENCE_CONTAINER: z.string().min(3),
  AZURE_CLIENT_ID: z.string().min(1).optional(),
  APPLICATIONINSIGHTS_CONNECTION_STRING: z.string().min(1).optional(),
  // Index *schema* management is a separate privilege from writing documents:
  // createOrUpdateIndex needs Search Service Contributor, while loading
  // documents needs only Search Index Data Contributor. Defaulting this off
  // keeps the recurring sync on the smaller role, so only the one-time
  // bootstrap job is granted object management.
  RESEARCH_MANAGE_INDEX_SCHEMA: z.enum(['true', 'false']).default('false'),
  MCP_REQUIRE_PLATFORM_AUTH: z.enum(['true', 'false']).default('true'),
  MCP_ALLOWED_HOSTS: z.string().min(1).default('localhost,127.0.0.1,[::1]'),
});

export type BridgeConfig = {
  port: number;
  stagingAppOrigin: string;
  mcpAudience: string;
  searchEndpoint: string;
  searchIndexName: string;
  storageAccountUrl: string;
  researchContainerName: string;
  evidenceContainerName: string;
  manageIndexSchema: boolean;
  managedIdentityClientId?: string;
  applicationInsightsConnectionString?: string;
  requirePlatformAuth: boolean;
  allowedHosts: string[];
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const parsed = configSchema.parse(environment);
  return {
    port: parsed.PORT,
    stagingAppOrigin: parsed.STAGING_APP_ORIGIN.replace(/\/$/, ''),
    mcpAudience: parsed.MCP_AUDIENCE.replace(/\/$/, ''),
    searchEndpoint: parsed.AZURE_SEARCH_ENDPOINT.replace(/\/$/, ''),
    searchIndexName: parsed.AZURE_SEARCH_INDEX_NAME,
    storageAccountUrl: parsed.AZURE_STORAGE_ACCOUNT_URL.replace(/\/$/, ''),
    researchContainerName: parsed.AZURE_STORAGE_RESEARCH_CONTAINER,
    evidenceContainerName: parsed.AZURE_STORAGE_EVIDENCE_CONTAINER,
    manageIndexSchema: parsed.RESEARCH_MANAGE_INDEX_SCHEMA === 'true',
    managedIdentityClientId: parsed.AZURE_CLIENT_ID,
    applicationInsightsConnectionString: parsed.APPLICATIONINSIGHTS_CONNECTION_STRING,
    requirePlatformAuth: parsed.MCP_REQUIRE_PLATFORM_AUTH === 'true',
    allowedHosts: [...new Set(parsed.MCP_ALLOWED_HOSTS.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean))],
  };
}
