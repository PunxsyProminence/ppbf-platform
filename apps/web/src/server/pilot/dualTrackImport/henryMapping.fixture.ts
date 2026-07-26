// Sanitized example fixture for the dual-track import package.
//
// Every identifier and value below is synthetic. This file intentionally
// contains none of the real athlete's name, measurements, dates, or source
// identifiers -- it exists only to demonstrate the shape of a request this
// package can process, and to give the tests/docs something concrete to
// exercise. `EXAMPLE_ATHLETE_ID` is a placeholder for "the athlete's real,
// already-existing pilot.athletes.athlete_id" -- this package never
// resolves an athlete by name, so a real invocation would substitute the
// real existing internal ID here, never a name lookup.

import type { DualTrackAthleteProgram } from './schema';
import { CORE_CONDITIONING_DOMAINS, REQUIRED_MANDATORY_GATE_CATEGORIES } from './schema';
import type { ImportRequest } from './dryRunImporter';
import type { SourceManifest } from './sourceManifest';

export const EXAMPLE_ORGANIZATION_ID = 'org-example-0001';
export const EXAMPLE_ATHLETE_ID = 'athlete-example-0001';

export const exampleDualTrackProgram: DualTrackAthleteProgram = {
  organizationId: EXAMPLE_ORGANIZATION_ID,
  athleteId: EXAMPLE_ATHLETE_ID,
  primaryTrack: {
    trackRole: 'primary',
    trackKey: 'air_force_special_warfare_prep',
    displayName: 'Air Force Special Warfare / Combat Control preparation (example)',
    description: 'Placeholder description -- occupational-readiness track governing overall workload.',
  },
  secondaryTrack: {
    trackRole: 'secondary',
    trackKey: 'adaptive_boxing_development',
    displayName: 'Adaptive boxing development (example)',
    description: 'Placeholder description -- supports footwork, composure, conditioning, perception, motivation.',
    supportsDomains: ['footwork', 'composure', 'perception', 'motivation', 'conditioning_support'],
    neverReplacesDomains: [...CORE_CONDITIONING_DOMAINS],
  },
  mandatoryGates: [...REQUIRED_MANDATORY_GATE_CATEGORIES],
  workloadAuthorityTrackRole: 'primary',
  hasRestrictedAdministrativeLane: true,
  status: 'draft',
};

// A minimal example import request. Values are placeholders, not real
// measurements -- see "Known historical measurements" in the task
// instructions, none of which are reproduced here or anywhere else in this
// package.
export const exampleImportRequest: ImportRequest = {
  organizationId: EXAMPLE_ORGANIZATION_ID,
  athleteId: EXAMPLE_ATHLETE_ID,
  dryRun: true,
  records: [
    {
      recordKind: 'measured_result',
      classification: 'athlete_private',
      destinationTable: 'pilot.readiness',
      fieldName: 'example_conditioning_metric',
      sensitive: false,
      observedAt: '2026-05-01T00:00:00.000Z',
      value: 0,
    },
    {
      recordKind: 'target',
      classification: 'athlete_private',
      destinationTable: 'pilot.goals',
      fieldName: 'example_conditioning_target',
      sensitive: false,
      targetDate: '2026-12-01',
      value: 0,
    },
    {
      // Recorded as a pending-verification note, not a write to
      // pilot.athletes.full_name -- the canonical display name is never
      // silently changed by this package.
      recordKind: 'name_verification',
      classification: 'athlete_private',
      destinationTable: 'pilot.coach_observations',
      fieldName: 'display_name_spelling_variant',
      sensitive: false,
      canonicalDisplayName: '[unchanged app record -- not modified by this package]',
      alternateSpellingObserved: '[example alternate spelling observed in an official-source document]',
      status: 'pending_verification',
    },
  ],
};

// This example is deliberately shown as REJECTED by the importer: it
// demonstrates that an admin_restricted record (e.g. recruiter/financial
// content) is refused outright, not routed anywhere.
export const exampleRestrictedRecordRejectedByDesign: ImportRequest['records'][number] = {
  recordKind: 'measured_result',
  classification: 'admin_restricted',
  destinationTable: 'pilot.documents',
  fieldName: 'example_restricted_field',
  sensitive: true,
  observedAt: '2026-05-01T00:00:00.000Z',
  value: '[never populated with real content -- rejected before any value is used]',
};

export const exampleSourceManifest: SourceManifest = {
  organizationId: EXAMPLE_ORGANIZATION_ID,
  athleteId: EXAMPLE_ATHLETE_ID,
  generatedAt: '2026-07-24T00:00:00.000Z',
  sources: [
    {
      sourceKey: 'src-example-doctrine-001',
      system: 'google',
      title: 'Example general boxing doctrine source',
      athleteSpecific: false,
      classification: 'organization_doctrine',
      contentSha256: null,
      versionOrModifiedAt: null,
      discoveryQuery: 'example doctrine query',
      provenanceNote: 'Placeholder -- general system doctrine, no athlete-specific content.',
    },
    {
      sourceKey: 'src-example-support-001',
      system: 'microsoft',
      title: 'Example working training packet (source candidate)',
      athleteSpecific: true,
      classification: 'support_reference',
      contentSha256: null,
      versionOrModifiedAt: null,
      discoveryQuery: 'example athlete-specific query',
      provenanceNote: 'Placeholder -- not yet approved as doctrine; not evidence-grade.',
    },
  ],
  duplicateGroups: [],
};
