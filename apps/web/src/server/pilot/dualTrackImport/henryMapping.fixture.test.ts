import { planDualTrackImport } from './dryRunImporter';
import {
  EXAMPLE_ATHLETE_ID,
  EXAMPLE_ORGANIZATION_ID,
  exampleDualTrackProgram,
  exampleImportRequest,
  exampleRestrictedRecordRejectedByDesign,
  exampleSourceManifest,
} from './henryMapping.fixture';
import { validateDualTrackProgram } from './schema';
import { validateSourceManifest } from './sourceManifest';

describe('sanitized example fixture', () => {
  it('describes a valid dual-track program', () => {
    expect(validateDualTrackProgram(exampleDualTrackProgram).valid).toBe(true);
  });

  it('produces an unblocked plan for the example import request', () => {
    const report = planDualTrackImport(exampleImportRequest);
    expect(report.organizationId).toBe(EXAMPLE_ORGANIZATION_ID);
    expect(report.athleteId).toBe(EXAMPLE_ATHLETE_ID);
    expect(report.blocked).toBe(false);
    expect(report.planned).toHaveLength(exampleImportRequest.records.length);
  });

  it('rejects the example admin_restricted record rather than planning it', () => {
    const report = planDualTrackImport({
      organizationId: EXAMPLE_ORGANIZATION_ID,
      athleteId: EXAMPLE_ATHLETE_ID,
      dryRun: true,
      records: [exampleRestrictedRecordRejectedByDesign],
    });
    expect(report.planned).toHaveLength(0);
    expect(report.rejected[0]?.reason).toBe('ADMIN_RESTRICTED_HAS_NO_SECURE_DESTINATION');
  });

  it('describes a valid source manifest', () => {
    expect(validateSourceManifest(exampleSourceManifest).valid).toBe(true);
  });
});
