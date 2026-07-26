import {
  planDualTrackImport,
  summarizePlan,
  type EvidenceRecord,
  type ImportRequest,
  type MeasuredResultRecord,
  type NameVerificationRecord,
  type TargetRecord,
} from './dryRunImporter';

function baseRequest(overrides: Partial<ImportRequest> = {}): ImportRequest {
  return {
    organizationId: 'org-example',
    athleteId: 'athlete-example-0001',
    dryRun: true,
    records: [],
    ...overrides,
  };
}

describe('dry-run importer: identity and deduplication', () => {
  it('refuses a request with no athleteId (name-only matching)', () => {
    expect(() => planDualTrackImport(baseRequest({ athleteId: '' }))).toThrow(
      /IDENTITY_RESOLUTION_REQUIRES_EXISTING_ATHLETE_ID/,
    );
  });

  it('refuses a request with only whitespace as athleteId', () => {
    expect(() => planDualTrackImport(baseRequest({ athleteId: '   ' }))).toThrow(
      /IDENTITY_RESOLUTION_REQUIRES_EXISTING_ATHLETE_ID/,
    );
  });

  it('exposes no record kind or operation that creates a new athlete', () => {
    // Structural guarantee: PlannedOperation.destinationTable values this
    // module can ever emit never include pilot.athletes (creation table).
    const record: NameVerificationRecord = {
      recordKind: 'name_verification',
      classification: 'athlete_private',
      destinationTable: 'pilot.athletes',
      fieldName: 'full_name',
      sensitive: false,
      canonicalDisplayName: 'Example Canonical Name',
      alternateSpellingObserved: 'Example Alternate Spelling',
      status: 'pending_verification',
    };
    const report = planDualTrackImport(baseRequest({ records: [record] }));
    // pilot.athletes is not a permitted destination for any classification,
    // so this is rejected rather than planned -- confirming the importer
    // cannot be made to plan an athlete-creation write.
    expect(report.planned).toHaveLength(0);
    expect(report.rejected[0]?.reason).toBe('CLASSIFICATION_DESTINATION_MISMATCH');
  });
});

describe('dry-run importer: organization/athlete scope enforcement', () => {
  it('refuses a request with no organizationId', () => {
    expect(() => planDualTrackImport(baseRequest({ organizationId: '' }))).toThrow(/MISSING_ORGANIZATION_ID/);
  });
});

describe('dry-run importer: dry-run behavior', () => {
  it('defaults every produced report to dryRun: true', () => {
    const report = planDualTrackImport(baseRequest());
    expect(report.dryRun).toBe(true);
  });

  it('refuses to run when dryRun is explicitly set to false', () => {
    expect(() => planDualTrackImport(baseRequest({ dryRun: false }))).toThrow(/WET_RUN_NOT_IMPLEMENTED/);
  });
});

describe('dry-run importer: privacy classification enforcement', () => {
  it('rejects admin_restricted records unconditionally, regardless of destination', () => {
    const record: MeasuredResultRecord = {
      recordKind: 'measured_result',
      classification: 'admin_restricted',
      destinationTable: 'pilot.sessions',
      fieldName: 'example_restricted_field',
      sensitive: true,
      observedAt: '2026-05-01T00:00:00.000Z',
      value: 'example-value',
    };
    const report = planDualTrackImport(baseRequest({ records: [record] }));
    expect(report.planned).toHaveLength(0);
    expect(report.rejected[0]?.reason).toBe('ADMIN_RESTRICTED_HAS_NO_SECURE_DESTINATION');
    expect(report.blocked).toBe(true);
  });

  it('never echoes a redacted/sensitive value in the plan preview', () => {
    const record: MeasuredResultRecord = {
      recordKind: 'measured_result',
      classification: 'athlete_private',
      destinationTable: 'pilot.readiness',
      fieldName: 'example_sensitive_metric',
      sensitive: true,
      observedAt: '2026-05-01T00:00:00.000Z',
      value: 'THIS-VALUE-MUST-NEVER-APPEAR-IN-OUTPUT',
    };
    const report = planDualTrackImport(baseRequest({ records: [record] }));
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('THIS-VALUE-MUST-NEVER-APPEAR-IN-OUTPUT');
    expect(report.planned[0]?.valuePreview).toBe('[redacted]');
  });
});

describe('dry-run importer: stale/undated measurements', () => {
  it('rejects a measured_result with no observation date', () => {
    const record: MeasuredResultRecord = {
      recordKind: 'measured_result',
      classification: 'athlete_private',
      destinationTable: 'pilot.readiness',
      fieldName: 'example_metric',
      sensitive: false,
      observedAt: null,
      value: 42,
    };
    const report = planDualTrackImport(baseRequest({ records: [record] }));
    expect(report.planned).toHaveLength(0);
    expect(report.rejected[0]?.reason).toBe('MISSING_OBSERVATION_DATE_CANNOT_BE_CURRENT');
  });

  it('accepts a measured_result that carries an observation date', () => {
    const record: MeasuredResultRecord = {
      recordKind: 'measured_result',
      classification: 'athlete_private',
      destinationTable: 'pilot.readiness',
      fieldName: 'example_metric',
      sensitive: false,
      observedAt: '2026-05-01T00:00:00.000Z',
      value: 42,
    };
    const report = planDualTrackImport(baseRequest({ records: [record] }));
    expect(report.planned).toHaveLength(1);
    expect(report.blocked).toBe(false);
  });
});

describe('dry-run importer: target vs. result separation', () => {
  it('rejects a target record aimed at a result-bearing table', () => {
    const record: TargetRecord = {
      recordKind: 'target',
      classification: 'athlete_private',
      destinationTable: 'pilot.shadow_formula_observations',
      fieldName: 'example_target_metric',
      sensitive: false,
      targetDate: '2026-12-01',
      value: 100,
    };
    const report = planDualTrackImport(baseRequest({ records: [record] }));
    expect(report.planned).toHaveLength(0);
    expect(report.rejected[0]?.reason).toBe('TARGET_CANNOT_BE_RESULT');
  });

  it('accepts a target record aimed at pilot.goals', () => {
    const record: TargetRecord = {
      recordKind: 'target',
      classification: 'athlete_private',
      destinationTable: 'pilot.goals',
      fieldName: 'example_target_metric',
      sensitive: false,
      targetDate: '2026-12-01',
      value: 100,
    };
    const report = planDualTrackImport(baseRequest({ records: [record] }));
    expect(report.planned).toHaveLength(1);
    expect(report.planned[0]?.operation).toBe('insert');
  });
});

describe('dry-run importer: restricted evidence rejection', () => {
  it('rejects support_reference evidence bound for the general SHADOW library', () => {
    const record: EvidenceRecord = {
      recordKind: 'evidence',
      classification: 'support_reference',
      destinationTable: 'pilot.shadow_library_documents',
      fieldName: 'example_document',
      sensitive: false,
      sourceKey: 'src-example-001',
    };
    // support_reference has no allowed destination at all, so this is
    // rejected before the general-library-specific check even runs.
    const report = planDualTrackImport(baseRequest({ records: [record] }));
    expect(report.planned).toHaveLength(0);
    expect(report.rejected[0]?.reason).toBe('CLASSIFICATION_DESTINATION_MISMATCH');
  });

  it('accepts organization_doctrine evidence bound for the general SHADOW library', () => {
    const record: EvidenceRecord = {
      recordKind: 'evidence',
      classification: 'organization_doctrine',
      destinationTable: 'pilot.shadow_library_documents',
      fieldName: 'example_document',
      sensitive: false,
      sourceKey: 'src-example-002',
    };
    const report = planDualTrackImport(baseRequest({ records: [record] }));
    expect(report.planned).toHaveLength(1);
    expect(report.blocked).toBe(false);
  });
});

describe('summarizePlan', () => {
  it('reports counts only, never raw record content', () => {
    const record: MeasuredResultRecord = {
      recordKind: 'measured_result',
      classification: 'athlete_private',
      destinationTable: 'pilot.readiness',
      fieldName: 'example_metric',
      sensitive: false,
      observedAt: '2026-05-01T00:00:00.000Z',
      value: 'sensitive-looking-value',
    };
    const report = planDualTrackImport(baseRequest({ records: [record] }));
    const summary = summarizePlan(report);
    expect(summary).toEqual({ plannedCount: 1, rejectedCount: 0, blocked: false });
    expect(JSON.stringify(summary)).not.toContain('sensitive-looking-value');
  });
});
