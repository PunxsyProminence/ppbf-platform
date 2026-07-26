// Dry-run-only importer/validator for dual-track athlete program data.
//
// This module never opens a database connection and never issues a write.
// It takes a proposed batch of records and an existing (organizationId,
// athleteId) scope and returns a plan describing what *would* be inserted or
// updated, plus a rejected list with machine-readable reasons. Turning this
// into an executor that actually writes is explicitly out of scope for this
// package -- see MAPPING.md for what a future wet-run implementation would
// need (a real extraction/chunking pipeline, a classification-aware
// evidence store, and a fulfillment path for admin_restricted content, none
// of which exist yet).

import { isDestinationAllowedForClassification, type PrivacyClassification } from './privacyClassification';

export type RecordKind = 'target' | 'measured_result' | 'evidence' | 'name_verification';

export interface ImportRecordBase {
  recordKind: RecordKind;
  classification: PrivacyClassification;
  destinationTable: string;
  fieldName: string;
  sensitive: boolean;
}

export interface MeasuredResultRecord extends ImportRecordBase {
  recordKind: 'measured_result';
  observedAt: string | null;
  value: unknown;
}

export interface TargetRecord extends ImportRecordBase {
  recordKind: 'target';
  targetDate: string | null;
  value: unknown;
}

export interface EvidenceRecord extends ImportRecordBase {
  recordKind: 'evidence';
  sourceKey: string;
}

export interface NameVerificationRecord extends ImportRecordBase {
  recordKind: 'name_verification';
  canonicalDisplayName: string;
  alternateSpellingObserved: string;
  status: 'pending_verification';
}

export type ImportRecord = MeasuredResultRecord | TargetRecord | EvidenceRecord | NameVerificationRecord;

export interface ImportRequest {
  organizationId: string;
  athleteId: string;
  dryRun: boolean;
  records: ImportRecord[];
}

export interface PlannedOperation {
  destinationTable: string;
  operation: 'insert' | 'update';
  fieldName: string;
  classification: PrivacyClassification;
  // Redacted for sensitive/admin_restricted fields; see summarizePlan.
  valuePreview: string;
}

export interface RejectedRecord {
  fieldName: string;
  classification: PrivacyClassification;
  destinationTable: string;
  reason: string;
}

export interface ImportPlanReport {
  organizationId: string;
  athleteId: string;
  dryRun: true;
  planned: PlannedOperation[];
  rejected: RejectedRecord[];
  blocked: boolean;
}

function redactedPreview(record: ImportRecordBase, value: unknown): string {
  if (record.sensitive || record.classification === 'admin_restricted') {
    return '[redacted]';
  }
  return typeof value === 'object' ? '[object]' : String(value);
}

function reject(record: ImportRecordBase, reason: string): RejectedRecord {
  return {
    fieldName: record.fieldName,
    classification: record.classification,
    destinationTable: record.destinationTable,
    reason,
  };
}

// Records the shape of a request as it arrives from a caller, before any
// per-record validation. Structurally there is no variant of ImportRecord
// that creates a new athlete/account row -- this function's job is only to
// refuse requests that try to bypass that by omitting scope entirely (which
// is what a name-only lookup would look like at this layer).
function assertRequestScope(request: ImportRequest): void {
  if (!request.organizationId || !request.organizationId.trim()) {
    throw new Error('MISSING_ORGANIZATION_ID: organization scope is required.');
  }
  if (!request.athleteId || !request.athleteId.trim()) {
    throw new Error(
      'IDENTITY_RESOLUTION_REQUIRES_EXISTING_ATHLETE_ID: name-only matching is refused. ' +
        'Supply the athlete\'s existing internal athlete_id; this importer never creates a new athlete record.',
    );
  }
  if (request.dryRun !== true) {
    throw new Error(
      'WET_RUN_NOT_IMPLEMENTED: this package only ever produces a plan. No code path in ' +
        'dualTrackImport executes a database write; see MAPPING.md for what a real import would require.',
    );
  }
}

export function planDualTrackImport(request: ImportRequest): ImportPlanReport {
  assertRequestScope(request);

  const planned: PlannedOperation[] = [];
  const rejected: RejectedRecord[] = [];

  for (const record of request.records) {
    if (record.classification === 'admin_restricted') {
      rejected.push(reject(record, 'ADMIN_RESTRICTED_HAS_NO_SECURE_DESTINATION'));
      continue;
    }

    if (!isDestinationAllowedForClassification(record.classification, record.destinationTable)) {
      rejected.push(reject(record, 'CLASSIFICATION_DESTINATION_MISMATCH'));
      continue;
    }

    if (record.recordKind === 'measured_result') {
      if (!record.observedAt) {
        rejected.push(reject(record, 'MISSING_OBSERVATION_DATE_CANNOT_BE_CURRENT'));
        continue;
      }
      planned.push({
        destinationTable: record.destinationTable,
        operation: 'insert',
        fieldName: record.fieldName,
        classification: record.classification,
        valuePreview: redactedPreview(record, record.value),
      });
      continue;
    }

    if (record.recordKind === 'target') {
      if (record.destinationTable !== 'pilot.goals') {
        rejected.push(reject(record, 'TARGET_CANNOT_BE_RESULT'));
        continue;
      }
      planned.push({
        destinationTable: record.destinationTable,
        operation: 'insert',
        fieldName: record.fieldName,
        classification: record.classification,
        valuePreview: redactedPreview(record, record.value),
      });
      continue;
    }

    if (record.recordKind === 'evidence') {
      const evidenceErrors = evidenceRejections(record);
      if (evidenceErrors.length > 0) {
        rejected.push(...evidenceErrors);
      } else {
        planned.push({
          destinationTable: record.destinationTable,
          operation: 'insert',
          fieldName: record.fieldName,
          classification: record.classification,
          valuePreview: `source:${record.sourceKey}`,
        });
      }
      continue;
    }

    if (record.recordKind === 'name_verification') {
      planned.push({
        destinationTable: record.destinationTable,
        operation: 'update',
        fieldName: record.fieldName,
        classification: record.classification,
        // The canonical display name is never silently changed; this plan
        // entry only ever represents recording the discrepancy as pending.
        valuePreview: 'status:pending_verification',
      });
      continue;
    }
  }

  return {
    organizationId: request.organizationId,
    athleteId: request.athleteId,
    dryRun: true,
    planned,
    rejected,
    blocked: rejected.length > 0,
  };
}

function evidenceRejections(record: EvidenceRecord): RejectedRecord[] {
  const reasons: RejectedRecord[] = [];
  const targetsGeneralLibrary = [
    'pilot.shadow_library_sources',
    'pilot.shadow_library_documents',
    'pilot.shadow_library_chunks',
  ].includes(record.destinationTable);

  if (targetsGeneralLibrary && record.classification !== 'organization_doctrine') {
    reasons.push(reject(record, 'RESTRICTED_CLASSIFICATION_CANNOT_ENTER_GENERAL_LIBRARY'));
  }

  return reasons;
}

export function summarizePlan(report: ImportPlanReport): { plannedCount: number; rejectedCount: number; blocked: boolean } {
  return {
    plannedCount: report.planned.length,
    rejectedCount: report.rejected.length,
    blocked: report.blocked,
  };
}
