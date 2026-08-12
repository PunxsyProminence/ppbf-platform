#!/usr/bin/env node

/**
 * Moves an already-imported research corpus off a gym's shelf and onto the
 * platform baseline, leaving that gym its own policy material.
 *
 * WHY THIS EXISTS
 *
 * Both staging and production already hold the full corpus under
 * `ppbf-default-org` -- imported before the platform/gym split existed. The
 * baseline import cannot place the same rows in the reserved organization,
 * because `shadow_library_sources.source_id` is the primary key: a corpus row
 * exists in exactly one organization, ever. The refusal is real and correct
 * (`CROSS_TENANT_ID_COLLISION`), and no flag on the importer fixes it.
 *
 * Two ways out were put to the owner; the owner chose re-scoping (2026-08-12).
 * It is the better choice for a reason worth recording: deleting the gym's copy
 * and re-importing would have taken `source_citation_checks` and
 * `source_retraction_checks` with it -- both hold `on delete cascade` foreign
 * keys to `source_id`, so 1,214 sources' worth of resolver history and
 * retraction surveillance would have gone silently. Re-scoping keeps every
 * check, every id, and every approval already granted.
 *
 * WHERE THE ROWS GO IS NOT DECIDED HERE
 *
 * The seed files are the authority. This script calls the importer's own
 * `loadSeedPackage` for both scopes and re-scopes the database to match, so the
 * end state is exactly what running the two imports would have produced -- and
 * `SCOPE_EXPECTED_COUNTS` verifies that before the transaction commits. Nothing
 * about the split is restated here, because a second copy of that rule is a
 * second thing to get wrong.
 *
 *   TARGET GUARD    Refuses unless PPBF_EXPECTED_POSTGRES_HOSTNAME and
 *                   PPBF_EXPECTED_POSTGRES_DATABASE match the connection string.
 *
 *   READ-ONLY BY    A plain run opens `begin read only` and reports the plan.
 *   DEFAULT         PPBF_RESCOPE_APPLY=true is the only route to a writable
 *                   transaction.
 *
 *   CITED ROWS      Refuses outright if any shadow_evidence_item cites a row this
 *                   would move. Those carry composite foreign keys on
 *                   (source_id, library_organization_id), so moving a cited row
 *                   either breaks the constraint or silently re-points somebody's
 *                   answer at evidence in another tenant. Expected to be zero --
 *                   nothing is approved, so nothing can have been cited -- but
 *                   "expected" is not "checked".
 *
 *   VERIFY BEFORE   Counts the end state per organization inside the same
 *   COMMIT          transaction and rolls back unless it matches the corpus.
 *
 * Usage:
 *   PPBF_RESCOPE_FROM_ORG=ppbf-default-org npm run pilot:rescope-library-baseline
 *   PPBF_RESCOPE_FROM_ORG=ppbf-default-org PPBF_RESCOPE_APPLY=true npm run pilot:rescope-library-baseline
 */

import { Pool } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';
import { SCOPE_EXPECTED_COUNTS, loadSeedPackage } from './import-shadow-research.mjs';

const PLATFORM_ORGANIZATION_ID = '__platform__';

const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING;
if (!connectionString) {
  console.error(JSON.stringify({ event: 'library.rescope.failed', reason: 'MISSING_CONNECTION_STRING' }));
  process.exit(1);
}

try {
  assertDeclaredWriteTargetFromEnv(connectionString);
} catch (error) {
  console.error(JSON.stringify({
    event: 'library.rescope.refused',
    reason: error instanceof Error ? error.message : 'UNKNOWN_TARGET_ERROR',
  }));
  process.exit(1);
}

const fromOrg = process.env.PPBF_RESCOPE_FROM_ORG?.trim();
if (!fromOrg) {
  console.error(JSON.stringify({ event: 'library.rescope.failed', reason: 'MISSING_PPBF_RESCOPE_FROM_ORG' }));
  process.exit(1);
}
if (fromOrg === PLATFORM_ORGANIZATION_ID) {
  console.error(JSON.stringify({ event: 'library.rescope.refused', reason: 'FROM_ORG_IS_THE_BASELINE' }));
  process.exit(1);
}

const apply = process.env.PPBF_RESCOPE_APPLY === 'true';
const maxRows = Number.parseInt(process.env.PPBF_RESCOPE_MAX ?? '3000', 10);
if (!Number.isFinite(maxRows) || maxRows < 0) {
  console.error(JSON.stringify({ event: 'library.rescope.failed', reason: 'INVALID_MAX' }));
  process.exit(1);
}

const pool = new Pool({ connectionString });

function refuse(reason, extra = {}) {
  console.error(JSON.stringify({ event: 'library.rescope.refused', reason, ...extra }));
  process.exitCode = 1;
}

async function main() {
  const client = await pool.connect();

  try {
    // The seed files decide the split. Loaded with the organization each scope is
    // destined for, so the rows this script INSERTS (the gym's document copies)
    // carry the right organization without restating the rule.
    const baseline = await loadSeedPackage({
      organizationId: PLATFORM_ORGANIZATION_ID,
      accountId: 'rescope',
      scope: 'platform_baseline',
    });
    const policy = await loadSeedPackage({
      organizationId: fromOrg,
      accountId: 'rescope',
      scope: 'ppbf_policy',
    });

    const baselineSourceIds = baseline.sources.map((r) => r.source_id);
    const baselineDocumentIds = baseline.documents.map((r) => r.document_id);
    const baselineChunkIds = baseline.chunks.map((r) => r.chunk_id);
    const baselineCapabilityIds = baseline.capabilityMap.map((r) => r.capability_map_id);
    const policyChunks = policy.chunks;
    // The copies the gym needs: the programme source and the 6 track documents
    // its policy chunks sit in. Identified by carrying provenance rather than by
    // matching a prefix here -- applySeedScope is what decides they are copies.
    const copiedDocuments = policy.documents.filter((r) => r.metadata?.copied_from_document_id);
    const copiedSources = policy.sources.filter((r) => r.metadata?.copied_from_source_id);

    await client.query(apply ? 'begin' : 'begin read only');

    for (const organizationId of [PLATFORM_ORGANIZATION_ID, fromOrg]) {
      const exists = await client.query(
        'select 1 from pilot.organizations where organization_id = $1', [organizationId],
      );
      if (exists.rowCount !== 1) {
        await client.query('rollback');
        refuse('ORGANIZATION_NOT_FOUND', { organization_id: organizationId });
        return;
      }
    }

    // Where the rows actually are now. Reported rather than assumed: a run
    // against a database where somebody already moved half of them should say so
    // instead of reporting a clean plan.
    const present = await client.query(
      `select
         (select count(*)::int from pilot.shadow_library_sources
           where organization_id = $1 and source_id = any($3::text[])) as sources_in_gym,
         (select count(*)::int from pilot.shadow_library_sources
           where organization_id = $2 and source_id = any($3::text[])) as sources_already_platform,
         (select count(*)::int from pilot.shadow_library_documents
           where organization_id = $1 and document_id = any($4::text[])) as documents_in_gym,
         (select count(*)::int from pilot.shadow_library_chunks
           where organization_id = $1 and chunk_id = any($5::text[])) as chunks_in_gym,
         (select count(*)::int from pilot.shadow_library_capability_map
           where organization_id = $1 and capability_map_id = any($6::text[])) as capabilities_in_gym,
         (select count(*)::int from pilot.shadow_research_requirements
           where organization_id = $1) as requirements_in_gym,
         (select count(*)::int from pilot.source_citation_checks
           where organization_id = $1 and source_id = any($3::text[])) as citation_checks,
         (select count(*)::int from pilot.source_retraction_checks
           where organization_id = $1 and source_id = any($3::text[])) as retraction_checks,
         (select count(*)::int from pilot.shadow_evidence_items
           where library_organization_id = $1
             and (source_id = any($3::text[]) or document_id = any($4::text[]) or chunk_id = any($5::text[]))
          ) as cited_by_evidence_items`,
      [fromOrg, PLATFORM_ORGANIZATION_ID, baselineSourceIds, baselineDocumentIds,
        baselineChunkIds, baselineCapabilityIds],
    );
    const counts = present.rows[0];
    const movingTotal = counts.sources_in_gym + counts.documents_in_gym + counts.chunks_in_gym
      + counts.capabilities_in_gym;

    console.log(JSON.stringify({
      event: 'library.rescope.plan',
      apply,
      from_organization: fromOrg,
      to_organization: PLATFORM_ORGANIZATION_ID,
      found: counts,
      expected_by_corpus: {
        sources: SCOPE_EXPECTED_COUNTS.platform_baseline.sources,
        documents: SCOPE_EXPECTED_COUNTS.platform_baseline.documents,
        chunks: SCOPE_EXPECTED_COUNTS.platform_baseline.chunks,
        capabilities: SCOPE_EXPECTED_COUNTS.platform_baseline.capabilityMap,
      },
      gym_keeps: {
        policy_sources: policy.sources.length - copiedSources.length,
        policy_chunks: policyChunks.length,
        document_copies_to_create: copiedDocuments.length,
        source_copies_to_create: copiedSources.length,
      },
      moving_total: movingTotal,
    }, null, 2));

    // A cited row is the one case that must not be moved quietly.
    if (counts.cited_by_evidence_items > 0) {
      await client.query('rollback');
      refuse('ROWS_ARE_CITED_BY_EVIDENCE_ITEMS', { count: counts.cited_by_evidence_items });
      return;
    }

    if (movingTotal > maxRows) {
      await client.query('rollback');
      refuse('BLAST_RADIUS_EXCEEDED', { moving: movingTotal, max: maxRows });
      return;
    }

    if (!apply) {
      await client.query('rollback');
      console.log(JSON.stringify({
        event: 'library.rescope.dry-run',
        moving: movingTotal,
        note: 'set PPBF_RESCOPE_APPLY=true to re-scope',
      }));
      return;
    }

    // 1. Move everything the baseline owns, FIRST -- see the ordering note below. Scoped by explicit id list, never by
    //    prefix or by "everything in this organization" -- the gym keeps rows in
    //    all of these tables.
    const movedSources = await client.query(
      `update pilot.shadow_library_sources set organization_id = $2, updated_at = now()
        where organization_id = $1 and source_id = any($3::text[]) returning source_id`,
      [fromOrg, PLATFORM_ORGANIZATION_ID, baselineSourceIds],
    );
    const movedDocuments = await client.query(
      `update pilot.shadow_library_documents set organization_id = $2, updated_at = now()
        where organization_id = $1 and document_id = any($3::text[]) returning document_id`,
      [fromOrg, PLATFORM_ORGANIZATION_ID, baselineDocumentIds],
    );
    const movedChunks = await client.query(
      `update pilot.shadow_library_chunks set organization_id = $2, updated_at = now()
        where organization_id = $1 and chunk_id = any($3::text[]) returning chunk_id`,
      [fromOrg, PLATFORM_ORGANIZATION_ID, baselineChunkIds],
    );
    const movedCapabilities = await client.query(
      `update pilot.shadow_library_capability_map set organization_id = $2, updated_at = now()
        where organization_id = $1 and capability_map_id = any($3::text[]) returning capability_map_id`,
      [fromOrg, PLATFORM_ORGANIZATION_ID, baselineCapabilityIds],
    );

    // The check tables carry their own organization_id but reference source_id
    // alone, so the database would not object to leaving them behind -- they would
    // simply become a gym's rows about another tenant's sources. They follow.
    const movedCitationChecks = await client.query(
      `update pilot.source_citation_checks set organization_id = $2
        where organization_id = $1 and source_id = any($3::text[]) returning check_id`,
      [fromOrg, PLATFORM_ORGANIZATION_ID, baselineSourceIds],
    );
    const movedRetractionChecks = await client.query(
      `update pilot.source_retraction_checks set organization_id = $2
        where organization_id = $1 and source_id = any($3::text[]) returning retraction_check_id`,
      [fromOrg, PLATFORM_ORGANIZATION_ID, baselineSourceIds],
    );

    // Requirements are keyed by their natural key, not by a library id.
    const movedRequirements = await client.query(
      // No updated_at on this table -- it carries created_at and resolved_at only.
      `update pilot.shadow_research_requirements r set organization_id = $2
        where r.organization_id = $1
          and exists (
            select 1 from jsonb_to_recordset($3::jsonb)
              as x(source_event_name text, source_entity_type text, source_entity_id text)
             where x.source_event_name = r.source_event_name
               and x.source_entity_type = r.source_entity_type
               and x.source_entity_id = r.source_entity_id
          )
        returning research_requirement_id`,
      [fromOrg, PLATFORM_ORGANIZATION_ID, JSON.stringify(baseline.requirements.map((r) => ({
        source_event_name: r.source_event_name,
        source_entity_type: r.source_entity_type,
        source_entity_id: r.source_entity_id,
      })))],
    );

    // 2. NOW the gym's own copies, and only now.
    //
    //    Order is load-bearing and was wrong first time: documents carry
    //    `unique (organization_id, content_sha256)`, and a copy is the same file
    //    as its original. Creating the copies while the originals were still in
    //    the gym violated that constraint outright
    //    (shadow_library_documents_organization_id_content_sha256_key), which a
    //    local rehearsal caught and a staging run would have discovered the hard
    //    way. Once the originals are in the reserved organization the pair is
    //    legitimate: same content, two tenants, which is exactly what a copy is.
    for (const source of copiedSources) {
      await client.query(
        `insert into pilot.shadow_library_sources
           (source_id, organization_id, title, publisher, source_type, authority_tier, url,
            publication_date, status, approval_state, verification_state, metadata,
            created_by_account_id, created_by_role)
         select $1, $2, title, publisher, source_type, authority_tier, url, publication_date,
                status, 'pending_review', 'unverified', metadata, created_by_account_id, created_by_role
           from pilot.shadow_library_sources
          where source_id = $3
         on conflict (source_id) do nothing`,
        [source.source_id, fromOrg, source.metadata.copied_from_source_id],
      );
    }

    for (const document of copiedDocuments) {
      await client.query(
        `insert into pilot.shadow_library_documents
           (document_id, source_id, organization_id, subject_id, document_name, blob_path,
            content_sha256, ingest_state, approval_state, verification_state, metadata,
            created_by_account_id, created_by_role)
         select $1, $2, $3, subject_id, document_name, blob_path, content_sha256,
                'pending', 'pending_review', 'unverified', $4::jsonb,
                created_by_account_id, created_by_role
           from pilot.shadow_library_documents
          where document_id = $5
         on conflict (document_id) do nothing`,
        [document.document_id, document.source_id, fromOrg,
          JSON.stringify(document.metadata), document.metadata.copied_from_document_id],
      );
    }

    // 3. Repoint the gym's policy chunks at its copies. They were left behind by
    //    step 1 (their ids are not in the baseline set) and are pointing at
    //    documents that have just moved, so this is what puts them back inside
    //    their own tenant. No intermediate state is observable: one transaction.
    let repointed = 0;
    for (const chunk of policyChunks) {
      const result = await client.query(
        `update pilot.shadow_library_chunks
            set document_id = $1, updated_at = now()
          where chunk_id = $2 and organization_id = $3
          returning chunk_id`,
        [chunk.document_id, chunk.chunk_id, fromOrg],
      );
      repointed += result.rowCount;
    }

    // 4. Verify the end state against the corpus before committing. This is the
    //    assertion that makes the whole operation safe to run unattended: if the
    //    database does not now look exactly like two clean imports, nothing
    //    happened.
    const after = await client.query(
      `select
         (select count(*)::int from pilot.shadow_library_sources where organization_id = $1) as platform_sources,
         (select count(*)::int from pilot.shadow_library_documents where organization_id = $1) as platform_documents,
         (select count(*)::int from pilot.shadow_library_chunks where organization_id = $1) as platform_chunks,
         (select count(*)::int from pilot.shadow_library_capability_map where organization_id = $1) as platform_capabilities,
         (select count(*)::int from pilot.shadow_library_chunks c
            join pilot.shadow_library_documents d
              on d.document_id = c.document_id and d.organization_id = c.organization_id
           where c.organization_id = $2) as gym_chunks_with_local_document`,
      [PLATFORM_ORGANIZATION_ID, fromOrg],
    );
    const end = after.rows[0];
    const expected = SCOPE_EXPECTED_COUNTS.platform_baseline;

    const mismatches = [];
    if (end.platform_sources !== expected.sources) mismatches.push(`sources=${end.platform_sources}!=${expected.sources}`);
    if (end.platform_documents !== expected.documents) mismatches.push(`documents=${end.platform_documents}!=${expected.documents}`);
    if (end.platform_chunks !== expected.chunks) mismatches.push(`chunks=${end.platform_chunks}!=${expected.chunks}`);
    if (end.platform_capabilities !== expected.capabilityMap) mismatches.push(`capabilities=${end.platform_capabilities}!=${expected.capabilityMap}`);
    if (repointed !== policyChunks.length) mismatches.push(`repointed=${repointed}!=${policyChunks.length}`);

    if (mismatches.length > 0) {
      await client.query('rollback');
      refuse('END_STATE_DOES_NOT_MATCH_CORPUS', { mismatches });
      return;
    }

    await client.query(
      `insert into pilot.audit_events
         (event_type, organization_id, entity_type, entity_id, details)
       values ('update', null, 'shadow_library_rescope', $1, $2)`,
      [
        PLATFORM_ORGANIZATION_ID,
        JSON.stringify({
          from_organization: fromOrg,
          sources_moved: movedSources.rowCount,
          documents_moved: movedDocuments.rowCount,
          chunks_moved: movedChunks.rowCount,
          capabilities_moved: movedCapabilities.rowCount,
          requirements_moved: movedRequirements.rowCount,
          citation_checks_moved: movedCitationChecks.rowCount,
          retraction_checks_moved: movedRetractionChecks.rowCount,
          policy_chunks_repointed: repointed,
          document_copies_created: copiedDocuments.length,
          reason: 'corpus imported before the platform/gym split existed',
        }),
      ],
    );

    await client.query('commit');

    console.log(JSON.stringify({
      event: 'library.rescope.completed',
      from_organization: fromOrg,
      sources_moved: movedSources.rowCount,
      documents_moved: movedDocuments.rowCount,
      chunks_moved: movedChunks.rowCount,
      capabilities_moved: movedCapabilities.rowCount,
      requirements_moved: movedRequirements.rowCount,
      citation_checks_moved: movedCitationChecks.rowCount,
      retraction_checks_moved: movedRetractionChecks.rowCount,
      policy_chunks_repointed: repointed,
      gym_chunks_with_local_document: end.gym_chunks_with_local_document,
    }));
  } catch (error) {
    await client.query('rollback').catch(() => {});
    console.error(JSON.stringify({
      event: 'library.rescope.failed',
      reason: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
      code: error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined,
      constraint: error && typeof error === 'object' && 'constraint' in error ? String(error.constraint) : undefined,
    }));
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

await main();
