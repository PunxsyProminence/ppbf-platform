import { buildPilotOpsReadinessReport } from './pilotOpsReadiness';

describe('buildPilotOpsReadinessReport', () => {
  it('reports every flag disabled on a bare environment', () => {
    const report = buildPilotOpsReadinessReport({});

    expect(report.shadowWorker.enabled).toBe(false);
    expect(report.videoScan.enabled).toBe(false);
    expect(report.videoScan.gates).toEqual([]);
    expect(report.intakePromotion.enabled).toBe(false);
    expect(report.durableRateLimit.enabled).toBe(false);
  });

  it('reports the shadow worker flag exactly', () => {
    expect(buildPilotOpsReadinessReport({ PPBF_SHADOW_WORKER_ENABLED: 'true' }).shadowWorker.enabled).toBe(true);
    expect(buildPilotOpsReadinessReport({ PPBF_SHADOW_WORKER_ENABLED: 'yes' }).shadowWorker.enabled).toBe(false);
  });

  it('reports which video scan gates are configured', () => {
    const malwareOnly = buildPilotOpsReadinessReport({ PPBF_VIDEO_MALWARE_SCAN: 'defender_index_tags' });
    expect(malwareOnly.videoScan.enabled).toBe(true);
    expect(malwareOnly.videoScan.gates).toEqual(['malware']);

    const both = buildPilotOpsReadinessReport({
      PPBF_VIDEO_MALWARE_SCAN: 'defender_index_tags',
      PPBF_VIDEO_CONTENT_SCAN: 'vision',
    });
    expect(both.videoScan.gates).toEqual(['malware', 'content']);
  });

  it('reports intake promotion exactly on the string "true"', () => {
    expect(buildPilotOpsReadinessReport({ PPBF_INTAKE_PROMOTION_ENABLED: 'true' }).intakePromotion.enabled).toBe(true);
    expect(buildPilotOpsReadinessReport({ PPBF_INTAKE_PROMOTION_ENABLED: 'TRUE' }).intakePromotion.enabled).toBe(false);
  });

  it('requires both the durable rate limit flag AND a Postgres connection string', () => {
    expect(
      buildPilotOpsReadinessReport({ PPBF_DURABLE_RATE_LIMIT: 'true' }).durableRateLimit.enabled,
    ).toBe(false);
    expect(
      buildPilotOpsReadinessReport({
        AZURE_POSTGRES_CONNECTION_STRING: 'postgres://example',
      }).durableRateLimit.enabled,
    ).toBe(false);
    expect(
      buildPilotOpsReadinessReport({
        PPBF_DURABLE_RATE_LIMIT: 'true',
        AZURE_POSTGRES_CONNECTION_STRING: 'postgres://example',
      }).durableRateLimit.enabled,
    ).toBe(true);
  });

  it('never echoes the connection string value back', () => {
    const report = buildPilotOpsReadinessReport({
      AZURE_POSTGRES_CONNECTION_STRING: 'postgres://user:supersecret@host/db',
      PPBF_DURABLE_RATE_LIMIT: 'true',
    });
    expect(JSON.stringify(report)).not.toContain('supersecret');
  });

  it('reports Azure chat config only when all three variables are present', () => {
    expect(buildPilotOpsReadinessReport({}).azureChatConfigured.enabled).toBe(false);
    expect(
      buildPilotOpsReadinessReport({
        AZURE_AI_ENDPOINT: 'https://example.openai.azure.com',
        AZURE_AI_KEY: 'secret',
      }).azureChatConfigured.enabled,
    ).toBe(false);
    expect(
      buildPilotOpsReadinessReport({
        AZURE_AI_ENDPOINT: 'https://example.openai.azure.com',
        AZURE_AI_KEY: 'secret',
        AZURE_AI_DEPLOYMENT_NAME: 'gpt-5-mini',
      }).azureChatConfigured.enabled,
    ).toBe(true);
  });

  it('reports semantic Library search only when the embedding deployment and Azure AI credentials are all present', () => {
    expect(buildPilotOpsReadinessReport({}).semanticLibrarySearch.enabled).toBe(false);
    expect(
      buildPilotOpsReadinessReport({
        AZURE_AI_EMBEDDING_DEPLOYMENT_NAME: 'text-embedding-3-small',
      }).semanticLibrarySearch.enabled,
    ).toBe(false);
    expect(
      buildPilotOpsReadinessReport({
        AZURE_AI_EMBEDDING_DEPLOYMENT_NAME: 'text-embedding-3-small',
        AZURE_AI_ENDPOINT: 'https://example.openai.azure.com',
        AZURE_AI_KEY: 'secret',
      }).semanticLibrarySearch.enabled,
    ).toBe(true);
  });

  it('reports document ingest as unconfigured by default, not silently mock-enabled', () => {
    const report = buildPilotOpsReadinessReport({});
    expect(report.ingest.enabled).toBe(false);
    expect(report.ingest.mockMode).toBe(false);
  });

  it('reports mock mode as its own field, distinct from real pipeline configuration', () => {
    const report = buildPilotOpsReadinessReport({ PPBF_INGEST_MOCK_MODE: 'true' });
    expect(report.ingest.mockMode).toBe(true);
    expect(report.ingest.enabled).toBe(true);
    expect(report.ingest.reason).toContain('mock');
  });

  it('reports document ingest configured once every pipeline credential is present', () => {
    const report = buildPilotOpsReadinessReport({
      DATAVERSE_ORG_URL: 'https://example.crm.dynamics.com',
      DATAVERSE_TENANT_ID: 't',
      DATAVERSE_CLIENT_ID: 'c',
      DATAVERSE_CLIENT_SECRET: 's',
      GRAPH_TENANT_ID: 't',
      GRAPH_CLIENT_ID: 'c',
      GRAPH_CLIENT_SECRET: 's',
      SHAREPOINT_SITE_ID: 'site',
      SHAREPOINT_DRIVE_ID: 'drive',
      GOOGLE_SERVICE_ACCOUNT_JSON: '{}',
    });
    expect(report.ingest.enabled).toBe(true);
    expect(report.ingest.mockMode).toBe(false);
  });

  it('reports the postgres connection flag independent of durable rate limiting', () => {
    expect(buildPilotOpsReadinessReport({}).postgresConnectionConfigured.enabled).toBe(false);
    expect(
      buildPilotOpsReadinessReport({
        AZURE_POSTGRES_CONNECTION_STRING: 'postgres://example',
      }).postgresConnectionConfigured.enabled,
    ).toBe(true);
  });

  it('reports the documented floors as read-only numbers, not configurable via env', () => {
    const report = buildPilotOpsReadinessReport({
      BOARD_MINIMUM_COHORT_SIZE: '999',
      SEMANTIC_SCORE_FLOOR: '0.99',
    });
    expect(report.floors).toEqual({
      boardMinimumCohortSize: 5,
      semanticScoreFloor: 0.15,
      quickRoundComplexityThreshold: 0.4,
      heavyBagComplexityThreshold: 0.6,
    });
  });
});
