import { query } from './db';
import { SERVABLE_GYM_WIDE_LIBRARY_DOCUMENT_SQL, SERVABLE_LIBRARY_SOURCE_SQL } from './libraryServability';
import { libraryRetrievalOrganizationIds, PLATFORM_LIBRARY_ORGANIZATION_ID } from './platformLibraryScope';

// WHAT A DRILL'S GROUNDING CLAIM IDS POINT AT (audit 2026-10-17 item 11).
//
// A drill stores grounding_claim_ids ("A2-063", "A3-032"). Each names one
// claim of the research program, loaded into the SHADOW Library as a chunk
// whose metadata carries that claim_id (referenceSets.ts, referenceSetsDb.ts).
// This module turns the ids into what a coach can read: the claim, who was
// studied, its limitations and the source -- or a plain statement that the id
// resolves to nothing. An id is never shown as if it were verification.
//
// THREE ANSWERS PER ID, never a fourth:
//   found        a chunk SHADOW itself would serve: libraryServability.ts's
//                two predicates, the bar searchShadowLibrary sets (source
//                active, approved, verified and not suppressed; document
//                indexed, approved and verified), written once there.
//   not_cleared  the claim is in the Library but not cleared for use --
//                awaiting review, rejected, archived, suppressed, not yet
//                indexed. Its text is not returned: what SHADOW will not
//                serve, a drill screen does not serve either.
//   not_found    no chunk carries the id.
//
// ATHLETE-SCOPED MATERIAL IS NEVER A CANDIDATE. A chunk or document with a
// subject_id, or one the retention purge held (metadata.subject_purged_at), is
// excluded in SQL, so it reads as not_found rather than revealing it exists.
// Grounding claims are research claims; none is about one athlete.
//
// WHICH INSTRUCTION A CLAIM SUPPORTS is recorded at drill level only: the
// library stores no mapping from a claim to one step. What the research program
// wrote about the claim's meaning for PPBF is the chunk's own "PPBF
// implication:" line, returned as ppbfImplication. Nothing here invents a
// finer mapping.
//
// Read-only. Scoped to the reader's organization plus the shared __platform__
// baseline, the same pair every retrieval query uses.

export interface GroundingEvidenceRecord {
  claim: string;
  effect: string | null;
  ppbfImplication: string | null;
  evidenceClass: string | null;
  evidenceTier: string | null;
  confidence: string | null;
  population: string | null;
  competitiveLevel: string | null;
  sex: string | null;
  ageRange: string | null;
  studyDesign: string | null;
  sampleSize: string | null;
  limitations: string | null;
  transferStatus: string | null;
  boxingSpecificity: string | null;
  doiOrPmid: string | null;
  sourceTitle: string | null;
  sourcePublisher: string | null;
  sourceType: string | null;
  publicationDate: string | null;
  sourceUrl: string | null;
  authorityTier: number | null;
}

export type GroundingEvidence =
  | { claimId: string; status: 'found'; record: GroundingEvidenceRecord }
  | { claimId: string; status: 'not_cleared' }
  | { claimId: string; status: 'not_found' };

interface ChunkRow {
  claim_id: string;
  cleared: boolean;
  text_content: string | null;
  metadata: Record<string, unknown> | null;
  source_title: string | null;
  source_publisher: string | null;
  source_type: string | null;
  publication_date: string | null;
  source_url: string | null;
  authority_tier: number | null;
}

function metadataText(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key];
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function labelledLine(lines: string[], label: string): string | null {
  const line = lines.find((candidate) => candidate.toLowerCase().startsWith(`${label.toLowerCase()}:`));
  const text = line?.slice(label.length + 1).trim();
  return text ? text : null;
}

/**
 * The research package writes each claim chunk as labelled lines: the claim
 * first, behind its evidence class in brackets, then "Effect/estimate:",
 * "PPBF implication:" and the rest. A chunk written any other way keeps its
 * whole text as the claim.
 */
export function parseClaimChunkText(text: string | null): Pick<GroundingEvidenceRecord, 'claim' | 'effect' | 'ppbfImplication'> {
  const lines = (text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const effect = labelledLine(lines, 'Effect/estimate');
  const ppbfImplication = labelledLine(lines, 'PPBF implication');
  if (!effect && !ppbfImplication) {
    return { claim: lines.join(' '), effect: null, ppbfImplication: null };
  }
  return { claim: (lines[0] ?? '').replace(/^\[[^\]]*\]\s*/, ''), effect, ppbfImplication };
}

/** Only an https link is rendered as one; anything else stays text. */
function safeUrl(url: string | null): string | null {
  const text = url?.trim();
  return text && /^https:\/\//i.test(text) ? text : null;
}

function recordFrom(row: ChunkRow): GroundingEvidenceRecord {
  const metadata = row.metadata;
  return {
    ...parseClaimChunkText(row.text_content),
    evidenceClass: metadataText(metadata, 'evidence_class'),
    evidenceTier: metadataText(metadata, 'evidence_tier'),
    confidence: metadataText(metadata, 'confidence'),
    population: metadataText(metadata, 'population'),
    competitiveLevel: metadataText(metadata, 'competitive_level'),
    sex: metadataText(metadata, 'sex'),
    ageRange: metadataText(metadata, 'age_range'),
    studyDesign: metadataText(metadata, 'study_design'),
    sampleSize: metadataText(metadata, 'sample_size'),
    limitations: metadataText(metadata, 'limitations'),
    transferStatus: metadataText(metadata, 'transfer_status'),
    boxingSpecificity: metadataText(metadata, 'boxing_specificity'),
    doiOrPmid: metadataText(metadata, 'doi_or_pmid'),
    sourceTitle: row.source_title,
    sourcePublisher: row.source_publisher,
    sourceType: row.source_type,
    publicationDate: row.publication_date,
    sourceUrl: safeUrl(row.source_url),
    authorityTier: row.authority_tier === null ? null : Number(row.authority_tier),
  };
}

/**
 * One answer per distinct id, in the drill's own order. An id cited twice is
 * answered once.
 */
export async function resolveDrillGroundingEvidence(
  organizationId: string,
  claimIds: readonly string[],
): Promise<GroundingEvidence[]> {
  const ids = [...new Set(claimIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return [];

  // Cleared rows first, then the platform baseline -- the research program's
  // own copy of the claim -- over a gym shelf carrying the same id, then the
  // most authoritative, so the first row per id is the one to show.
  const rows = await query<ChunkRow>(
    `select c.metadata->>'claim_id' as claim_id,
            (${SERVABLE_LIBRARY_SOURCE_SQL}
              and ${SERVABLE_GYM_WIDE_LIBRARY_DOCUMENT_SQL}) as cleared,
            c.text_content, c.metadata,
            s.title as source_title, s.publisher as source_publisher, s.source_type,
            s.publication_date::text as publication_date, s.url as source_url, s.authority_tier
       from pilot.shadow_library_chunks c
       join pilot.shadow_library_documents d on d.document_id = c.document_id and d.organization_id = c.organization_id
       join pilot.shadow_library_sources s on s.source_id = c.source_id and s.organization_id = c.organization_id
      where c.organization_id = any($1::text[])
        and c.metadata->>'claim_id' = any($2::text[])
        and c.subject_id is null
        and d.subject_id is null
        and not (d.metadata ? 'subject_purged_at')
        and not (c.metadata ? 'subject_purged_at')
      order by claim_id, cleared desc, (c.organization_id = $3) desc, s.authority_tier asc, c.chunk_id asc`,
    [libraryRetrievalOrganizationIds(organizationId), ids, PLATFORM_LIBRARY_ORGANIZATION_ID],
  );

  const firstById = new Map<string, ChunkRow>();
  for (const row of rows) {
    if (!firstById.has(row.claim_id)) firstById.set(row.claim_id, row);
  }

  return ids.map((claimId): GroundingEvidence => {
    const row = firstById.get(claimId);
    if (!row) return { claimId, status: 'not_found' };
    if (!row.cleared) return { claimId, status: 'not_cleared' };
    return { claimId, status: 'found', record: recordFrom(row) };
  });
}
