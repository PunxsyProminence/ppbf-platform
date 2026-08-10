import { query } from './db';

// pilot.source_citation_checks, pilot.v_source_citation_status and
// pilot.v_sources_needing_citation_check are owned by
// infra/azure/pilot_slice_postgres_source_citation_checks_migration.sql, applied
// through the apply-migrations workflow. Nothing here issues DDL.
//
// THIS MODULE NEVER WRITES. Every row in source_citation_checks is written by
// apps/web/scripts/verify-research-citations.mjs, the only thing that talks to
// the NCBI/Crossref resolvers. This module exists to let the app read the
// results a human reviewer needs -- it has no insert/update path, on purpose,
// so there is exactly one writer to reason about.
//
// A RESOLVED IDENTIFIER IS NOT REVIEWER APPROVAL. review_signal flags rows a
// human should look at; it never sets shadow_library_sources.verification_state,
// and no caller of this module may treat it as though it did. See
// shadowLibrary.ts's reviewShadowLibrarySource for the only real approval path.

export type SourceCitationIdentifierKind = 'pmid' | 'doi' | 'isbn' | 'url' | 'none';
export type SourceCitationResolver = 'ncbi_eutils' | 'crossref' | 'openalex' | 'http_head' | 'manual' | 'not_attempted';
export type SourceCitationOutcome =
  | 'resolved_title_match'
  | 'resolved_title_mismatch'
  | 'resolved_title_unknown'
  | 'unresolved'
  | 'no_identifier'
  | 'resolver_unavailable';
export type SourceCitationMatchMethod = 'title_overlap' | 'author_year' | 'multi_source_best' | 'manual' | 'none';
export type SourceCitationReviewSignal =
  | 'needs_adjudication'
  | 'recheck_pending'
  | 'not_machine_checkable'
  | 'ok';
export type SourceCitationCheckState = 'never_checked' | 'stale_source_edited' | 'retry_resolver' | 'current';

export interface SourceCitationCheckRow {
  organization_id: string;
  check_id: string;
  source_id: string;
  identifier_kind: SourceCitationIdentifierKind;
  identifier_value: string;
  resolver: SourceCitationResolver;
  outcome: SourceCitationOutcome;
  retrieved_title: string | null;
  retrieved_year: string | null;
  retrieved_container: string | null;
  match_method: SourceCitationMatchMethod | null;
  match_score: number | null;
  checked_at: string;
  checker_version: string;
  detail: string;
}

export interface SourceCitationStatusRow {
  organization_id: string;
  source_id: string;
  claimed_title: string;
  source_type: string;
  authority_tier: number;
  approval_state: string;
  verification_state: string;
  identifier_kind: SourceCitationIdentifierKind;
  identifier_value: string;
  resolver: SourceCitationResolver;
  outcome: SourceCitationOutcome;
  retrieved_title: string | null;
  match_method: SourceCitationMatchMethod | null;
  match_score: number | null;
  checked_at: string;
  checker_version: string;
  review_signal: SourceCitationReviewSignal;
}

export interface SourceNeedingCitationCheckRow {
  organization_id: string;
  source_id: string;
  title: string;
  source_type: string;
  url: string | null;
  metadata: Record<string, unknown>;
  approval_state: string;
  updated_at: string;
  last_checked_at: string | null;
  check_state: SourceCitationCheckState;
}

/** Raw check history for one source, most recent first. */
export async function listSourceCitationChecks(
  organizationId: string,
  sourceId: string,
): Promise<SourceCitationCheckRow[]> {
  return query<SourceCitationCheckRow>(
    `select organization_id, check_id, source_id, identifier_kind, identifier_value, resolver,
            outcome, retrieved_title, retrieved_year, retrieved_container, match_method,
            match_score, checked_at, checker_version, detail
     from pilot.source_citation_checks
     where organization_id = $1 and source_id = $2
     order by checked_at desc`,
    [organizationId, sourceId],
  );
}

/**
 * Latest citation status per source. This is the reviewer-facing read: it
 * carries review_signal so a human can see which rows need adjudication
 * without re-deriving it from raw outcomes.
 */
export async function getSourceCitationStatus(
  organizationId: string,
  filter: { reviewSignal?: SourceCitationReviewSignal } = {},
): Promise<SourceCitationStatusRow[]> {
  return query<SourceCitationStatusRow>(
    `select organization_id, source_id, claimed_title, source_type, authority_tier, approval_state,
            verification_state, identifier_kind, identifier_value, resolver, outcome, retrieved_title,
            match_method, match_score, checked_at, checker_version, review_signal
     from pilot.v_source_citation_status
     where organization_id = $1
       and ($2::text is null or review_signal = $2)
     order by checked_at desc`,
    [organizationId, filter.reviewSignal ?? null],
  );
}

/** The work queue verify-research-citations.mjs consumes. */
export async function getSourcesNeedingCitationCheck(
  organizationId: string,
  limit = 500,
): Promise<SourceNeedingCitationCheckRow[]> {
  return query<SourceNeedingCitationCheckRow>(
    `select organization_id, source_id, title, source_type, url, metadata, approval_state, updated_at,
            last_checked_at, check_state
     from pilot.v_sources_needing_citation_check
     where organization_id = $1
       and check_state <> 'current'
     order by updated_at desc
     limit $2`,
    [organizationId, limit],
  );
}
