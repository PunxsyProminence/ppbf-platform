import type { PilotRole } from './contracts';
import { query, queryOne } from './db';
import { requireEvidenceReviewer } from './shadowLibrary';

// pilot.source_retraction_checks, pilot.v_source_retraction_status and
// pilot.v_sources_needing_retraction_check -- along with the retrieval_suppressed
// family of columns on pilot.shadow_library_sources -- are owned by
// infra/azure/pilot_slice_postgres_retraction_surveillance_migration.sql, applied
// through the apply-migrations workflow. Nothing here issues DDL.
//
// THE CHECK ROW AND ITS DISPOSITION ARE WRITTEN BY DIFFERENT ACTORS.
// apps/web/scripts/check-source-retractions.mjs is the only thing that inserts a
// row into source_retraction_checks -- it talks to PubMed/Crossref and raises a
// finding. recordRetractionDisposition and suppressSource below are the only
// paths that record what a human did about it. Neither the script nor this
// module may skip that separation: a machine can flag a retraction, but only a
// named reviewer disposes of one (pilot_src_retraction_disposition) or removes a
// source from retrieval (pilot_library_sources_suppression_reason).
//
// SUPPRESSION IS NEVER A DELETE. The row, its documents and its chunks are
// preserved -- suppressing only removes it from searchShadowLibrary's retrieval
// path (see the `not coalesce(s.retrieval_suppressed, false)` predicate there).
// That is what makes it reversible and keeps the audit trail intact.

const MIN_SUPPRESSION_REASON_LENGTH = 10;
const MIN_DISPOSITION_NOTE_LENGTH = 15;

export type SourceRetractionIdentifierKind = 'pmid' | 'doi' | 'none';
export type SourceRetractionResolver = 'ncbi_eutils' | 'crossref' | 'manual' | 'not_attempted';
export type SourceRetractionStatus =
  | 'clear'
  | 'retracted'
  | 'expression_of_concern'
  | 'corrected'
  | 'withdrawn'
  | 'not_checkable'
  | 'resolver_unavailable';
export type SourceRetractionDisposition =
  | 'suppress_source'
  | 'keep_with_caveat'
  | 'claim_unaffected'
  | 'superseded_by_newer'
  | 'under_review';
export type SourceRetractionActionSignal =
  | 'urgent_unhandled'
  | 'needs_review'
  | 'informational'
  | 'recheck_pending'
  | 'not_surveillable'
  | 'handled';
export type SourceRetractionCheckState = 'never_checked' | 'retry_resolver' | 'stale_recheck_due' | 'current';

export interface SourceRetractionCheckRow {
  organization_id: string;
  retraction_check_id: string;
  source_id: string;
  identifier_kind: SourceRetractionIdentifierKind;
  identifier_value: string;
  resolver: SourceRetractionResolver;
  status: SourceRetractionStatus;
  notice_type: string | null;
  notice_doi: string | null;
  notice_date: string | null;
  notice_source: string | null;
  evidence_snippet: string;
  checked_at: string;
  checker_version: string;
  acknowledged_by_account_id: string | null;
  acknowledged_at: string | null;
  disposition: SourceRetractionDisposition | null;
  disposition_note: string | null;
}

export interface SourceRetractionStatusRow {
  organization_id: string;
  source_id: string;
  title: string;
  approval_state: string;
  verification_state: string;
  status: SourceRetractionStatus;
  notice_type: string | null;
  notice_doi: string | null;
  notice_date: string | null;
  notice_source: string | null;
  checked_at: string;
  disposition: SourceRetractionDisposition | null;
  acknowledged_at: string | null;
  dependent_chunks: number;
  action_signal: SourceRetractionActionSignal;
}

export interface SourceNeedingRetractionCheckRow {
  organization_id: string;
  source_id: string;
  title: string;
  source_type: string;
  url: string | null;
  metadata: Record<string, unknown>;
  approval_state: string;
  last_checked_at: string | null;
  last_status: SourceRetractionStatus | null;
  check_state: SourceRetractionCheckState;
}

export async function listSourceRetractionChecks(
  organizationId: string,
  sourceId: string,
): Promise<SourceRetractionCheckRow[]> {
  return query<SourceRetractionCheckRow>(
    `select organization_id, retraction_check_id, source_id, identifier_kind, identifier_value,
            resolver, status, notice_type, notice_doi, notice_date, notice_source, evidence_snippet,
            checked_at, checker_version, acknowledged_by_account_id, acknowledged_at, disposition,
            disposition_note
     from pilot.source_retraction_checks
     where organization_id = $1 and source_id = $2
     order by checked_at desc`,
    [organizationId, sourceId],
  );
}

/** Latest retraction status per source, with the dependent-chunk count that says how much rides on it. */
export async function getSourceRetractionStatus(
  organizationId: string,
  filter: { actionSignal?: SourceRetractionActionSignal } = {},
): Promise<SourceRetractionStatusRow[]> {
  return query<SourceRetractionStatusRow>(
    `select organization_id, source_id, title, approval_state, verification_state, status, notice_type,
            notice_doi, notice_date, notice_source, checked_at, disposition, acknowledged_at,
            dependent_chunks, action_signal
     from pilot.v_source_retraction_status
     where organization_id = $1
       and ($2::text is null or action_signal = $2)
     order by
       case action_signal
         when 'urgent_unhandled' then 0
         when 'needs_review' then 1
         when 'recheck_pending' then 2
         when 'informational' then 3
         else 4
       end,
       checked_at desc`,
    [organizationId, filter.actionSignal ?? null],
  );
}

/** The 90-day surveillance queue check-source-retractions.mjs consumes. */
export async function getSourcesNeedingRetractionCheck(
  organizationId: string,
  limit = 500,
): Promise<SourceNeedingRetractionCheckRow[]> {
  return query<SourceNeedingRetractionCheckRow>(
    `select organization_id, source_id, title, source_type, url, metadata, approval_state,
            last_checked_at, last_status, check_state
     from pilot.v_sources_needing_retraction_check
     where organization_id = $1
       and check_state <> 'current'
     order by last_checked_at asc nulls first
     limit $2`,
    [organizationId, limit],
  );
}

export interface RecordRetractionDispositionInput {
  organizationId: string;
  retractionCheckId: string;
  disposition: SourceRetractionDisposition;
  dispositionNote: string;
  acknowledgedByAccountId: string;
  actorRole: PilotRole;
}

/**
 * Records a human's disposition of a retraction/correction finding. Refuses
 * up front, ahead of pilot_src_retraction_disposition, when the note is
 * under 15 characters -- "a disposition carries a name and a reason."
 * Disposing of a finding does NOT by itself suppress the source from
 * retrieval; that is a separate, explicit act via suppressSource below.
 */
export async function recordRetractionDisposition(
  input: RecordRetractionDispositionInput,
): Promise<SourceRetractionCheckRow> {
  requireEvidenceReviewer(input.actorRole);
  if (input.dispositionNote.trim().length < MIN_DISPOSITION_NOTE_LENGTH) {
    throw new Error(
      `RETRACTION_DISPOSITION_NOTE_TOO_SHORT: must be at least ${MIN_DISPOSITION_NOTE_LENGTH} characters`,
    );
  }

  const row = await queryOne<SourceRetractionCheckRow>(
    `update pilot.source_retraction_checks
       set disposition = $3,
           disposition_note = $4,
           acknowledged_by_account_id = $5,
           acknowledged_at = now()
     where organization_id = $1 and retraction_check_id = $2
     returning organization_id, retraction_check_id, source_id, identifier_kind, identifier_value,
               resolver, status, notice_type, notice_doi, notice_date, notice_source, evidence_snippet,
               checked_at, checker_version, acknowledged_by_account_id, acknowledged_at, disposition,
               disposition_note`,
    [
      input.organizationId,
      input.retractionCheckId,
      input.disposition,
      input.dispositionNote.trim(),
      input.acknowledgedByAccountId,
    ],
  );
  if (!row) {
    throw new Error('RETRACTION_CHECK_NOT_FOUND');
  }
  return row;
}

export interface SuppressSourceInput {
  organizationId: string;
  sourceId: string;
  reason: string;
  suppressedByAccountId: string;
  actorRole: PilotRole;
}

/**
 * Removes a source from retrieval. Refuses up front, ahead of
 * pilot_library_sources_suppression_reason, when the reason is under 10
 * characters. The row, its documents and its chunks are never touched --
 * this only flips retrieval_suppressed, which searchShadowLibrary excludes on.
 */
export async function suppressSource(input: SuppressSourceInput): Promise<void> {
  requireEvidenceReviewer(input.actorRole);
  if (input.reason.trim().length < MIN_SUPPRESSION_REASON_LENGTH) {
    throw new Error(
      `SOURCE_SUPPRESSION_REASON_TOO_SHORT: must be at least ${MIN_SUPPRESSION_REASON_LENGTH} characters`,
    );
  }

  const result = await queryOne<{ source_id: string }>(
    `update pilot.shadow_library_sources
       set retrieval_suppressed = true,
           suppression_reason = $3,
           suppressed_at = now(),
           suppressed_by_account_id = $4
     where organization_id = $1 and source_id = $2
     returning source_id`,
    [input.organizationId, input.sourceId, input.reason.trim(), input.suppressedByAccountId],
  );
  if (!result) {
    throw new Error('SOURCE_NOT_FOUND');
  }
}

export interface UnsuppressSourceInput {
  organizationId: string;
  sourceId: string;
  actorRole: PilotRole;
}

/** Reverses suppressSource. The prior reason/who/when are left in place as history. */
export async function unsuppressSource(input: UnsuppressSourceInput): Promise<void> {
  requireEvidenceReviewer(input.actorRole);

  const result = await queryOne<{ source_id: string }>(
    `update pilot.shadow_library_sources
       set retrieval_suppressed = false
     where organization_id = $1 and source_id = $2
     returning source_id`,
    [input.organizationId, input.sourceId],
  );
  if (!result) {
    throw new Error('SOURCE_NOT_FOUND');
  }
}
