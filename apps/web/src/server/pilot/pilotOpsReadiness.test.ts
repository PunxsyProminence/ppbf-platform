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
});
