#!/usr/bin/env node

/**
 * Moves one organization's policy shelf -- its library sources of one source
 * type (only `internal_policy` is allowed) and every row that belongs to them --
 * to another, named organization.
 *
 * WHY THIS EXISTS
 *
 * OD-2026-09-28-007 counted 22 `internal_policy` sources (7 documents, 49
 * chunks) under `ppbf-default-org`, which is not the gym; the dry run is the
 * current count and shows each row's review state.
 * A user sees their own organization plus `__platform__`, so the gym does not
 * see its own policy material. Jason said yes to moving them to
 * `punxsy_prominence` (OD-2026-09-28-011 item 6) and approves the production
 * run in GitHub. pilot-rescope-library-baseline.mjs cannot do it: it only moves
 * a corpus onto the platform baseline.
 *
 * WHAT MOVES, AND WHAT REFUSES
 *
 * The selection is the database's rows, not a seed scope: every source of the
 * chosen type in the from-organization WHATEVER its approval state (the plan
 * reports review state; it does not filter on it, because a pending programme
 * copy can hold the documents an approved policy's chunks sit in), every
 * document whose source is one of
 * them, every chunk whose source or document is one of those, and the
 * citation-check and retraction-check rows about those sources. Those two
 * check tables carry their own organization_id but reference source_id alone,
 * so the database would not stop them being left behind as a gym's rows about
 * another tenant's sources. They follow, as they did in the rescope.
 *
 * SHADOW evidence items that cite a moving row are DETACHED, in the same
 * transaction and before the move: their shadow_message_citations rows, then
 * the items themselves, are deleted. They cannot be re-pointed: they cite
 * (id, library_organization_id) by composite foreign key with no ON UPDATE
 * action, and a CHECK lets an item cite only its asking organization or
 * __platform__ (OD-2026-10-08-009 D22 asked for a re-point; with no asker a
 * member of the gym, overwatch ruled to detach). The chat answers keep their
 * text and lose their citation list; bundles and claims are not touched. The
 * audit_events row records every detached id, the ids it cited and its
 * excerpt hash -- no account id and no text. The dry run prints evidence counts only.
 * The detached set is part of the plan fingerprint, and DETACH_RADIUS_EXCEEDED
 * refuses past DEFAULT_MAX_DETACH_ROWS.
 *
 * Other rows that point AT the moving rows from somewhere else are not moved,
 * and any of them refuses the apply:
 *   - shadow_research_submissions hang off a research requirement that stays
 *     in the old organization;
 *   - rabbit_holes.library_document_id has no foreign key and resolves only in
 *     the lesson's own organization or __platform__, so a lesson outside the
 *     target would silently lose its citation.
 * Unique keys that include organization_id (sources url, documents
 * content_sha256, both check tables' primary keys) are checked against the
 * target first; a clash refuses rather than failing half way.
 *
 * Capability rules (shadow_library_capability_map) reference no source. The
 * dry run lists the from-organization's rules that ask for this source type,
 * and nothing moves them -- that is Jason's call, not this script's.
 *
 *   INPUT GUARD     from/to/type/confirm-phrase checked before any connection.
 *   TARGET GUARD    PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE must match the
 *                   connection string (scripts/lib/postgres-write-target.mjs).
 *   READ-ONLY BY    A plain run opens `begin read only`, prints the plan and
 *   DEFAULT         rolls back. Apply needs PPBF_POLICY_MOVE_APPLY=true AND
 *                   PPBF_POLICY_MOVE_CONFIRM set to the phrase.
 *   REVIEWED PLAN   Apply also needs PPBF_POLICY_MOVE_EXPECT_FINGERPRINT set to
 *   ONLY            the plan_fingerprint a dry run printed. Apply re-plans, and
 *                   refuses before its first update unless the fingerprint of
 *                   the rows it found is that one -- so a row added (or gone)
 *                   since the reviewed dry run stops the move.
 *   ONE TRANSACTION Apply plans and moves inside one transaction with the
 *                   planned rows locked; each update is scoped to the planned
 *                   ids and must touch exactly as many rows as the plan.
 *   VERIFY BEFORE   Re-counts both organizations and checks every moved chunk
 *   COMMIT          joins a document and source in the target, and rolls back
 *                   on any mismatch.
 *
 * It never reads a local env file: the connection string must come from the
 * environment, which in practice means the move-policy-shelf workflow.
 *
 * Usage (from the workflow):
 *   PPBF_POLICY_MOVE_TO_ORG=punxsy_prominence npm run pilot:move-policy-shelf
 *   PPBF_POLICY_MOVE_TO_ORG=punxsy_prominence PPBF_POLICY_MOVE_APPLY=true \
 *     PPBF_POLICY_MOVE_CONFIRM='MOVE POLICY SHELF' \
 *     PPBF_POLICY_MOVE_EXPECT_FINGERPRINT='sha256:<from the dry run>' \
 *     npm run pilot:move-policy-shelf
 */

import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

export const PLATFORM_ORGANIZATION_ID = '__platform__';
export const CONFIRM_PHRASE = 'MOVE POLICY SHELF';
export const ALLOWED_SOURCE_TYPES = Object.freeze(['internal_policy']);
export const DEFAULT_FROM_ORGANIZATION_ID = 'ppbf-default-org';
export const DEFAULT_SOURCE_TYPE = 'internal_policy';
// Production's shelf is ~22 + 7 + 49 plus its check rows. The cap is far above
// that and far below the 1,194-source baseline, so a selection that somehow
// grabbed a corpus refuses instead of moving it.
export const DEFAULT_MAX_ROWS = 500;
// Evidence items plus message citations detached by one run. Staging held
// about 1,136 and production 2 (dry runs, 2026-10-16); separate from the move
// cap, which counts only rows that move.
export const DEFAULT_MAX_DETACH_ROWS = 2000;
export const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

const EVENT_PREFIX = 'library.policy_move';

function defaultLog(event, payload) {
  const line = JSON.stringify({ event: `${EVENT_PREFIX}.${event}`, ...payload }, null, event === 'plan' ? 2 : 0);
  if (event === 'refused' || event === 'failed') console.error(line);
  else console.log(line);
}

/**
 * Pure input checks. Returns null when the options are usable, otherwise
 * `{ reason, ...detail }`. Runs before any database statement.
 */
export function validateMoveOptions(options) {
  const {
    fromOrganizationId, toOrganizationId, sourceType, apply, confirm, maxRows, expectFingerprint, maxDetachRows,
  } = options ?? {};
  // Only a real boolean decides the mode. A truthy string would otherwise skip
  // the phrase check below and still open a writing transaction.
  if (apply !== undefined && typeof apply !== 'boolean') return { reason: 'INVALID_APPLY' };
  if (!toOrganizationId) return { reason: 'MISSING_TO_ORG' };
  if (!fromOrganizationId) return { reason: 'MISSING_FROM_ORG' };
  if (fromOrganizationId === PLATFORM_ORGANIZATION_ID || toOrganizationId === PLATFORM_ORGANIZATION_ID) {
    return { reason: 'PLATFORM_ORGANIZATION_REFUSED' };
  }
  if (fromOrganizationId === toOrganizationId) return { reason: 'FROM_EQUALS_TO' };
  if (!ALLOWED_SOURCE_TYPES.includes(sourceType)) {
    return { reason: 'UNSUPPORTED_SOURCE_TYPE', source_type: sourceType ?? null };
  }
  if (!Number.isInteger(maxRows) || maxRows < 1) return { reason: 'INVALID_MAX' };
  if (maxDetachRows !== undefined && (!Number.isInteger(maxDetachRows) || maxDetachRows < 1)) {
    return { reason: 'INVALID_MAX_DETACH' };
  }
  if (apply === true && confirm !== CONFIRM_PHRASE) return { reason: 'APPLY_WITHOUT_CONFIRM_PHRASE' };
  if (apply === true && !expectFingerprint) return { reason: 'APPLY_WITHOUT_EXPECTED_FINGERPRINT' };
  if (apply === true && !FINGERPRINT_PATTERN.test(String(expectFingerprint))) {
    return { reason: 'INVALID_EXPECTED_FINGERPRINT' };
  }
  return null;
}

/** Reads the PPBF_POLICY_MOVE_* environment into options, then validates them. */
export function parseMoveOptions(env = process.env) {
  const maxRaw = (env.PPBF_POLICY_MOVE_MAX ?? '').trim();
  const options = {
    fromOrganizationId: (env.PPBF_POLICY_MOVE_FROM_ORG ?? '').trim() || DEFAULT_FROM_ORGANIZATION_ID,
    toOrganizationId: (env.PPBF_POLICY_MOVE_TO_ORG ?? '').trim(),
    sourceType: (env.PPBF_POLICY_MOVE_SOURCE_TYPE ?? '').trim() || DEFAULT_SOURCE_TYPE,
    // Exactly 'true'. Anything else, including 'TRUE' or '1', is a dry run.
    apply: env.PPBF_POLICY_MOVE_APPLY === 'true',
    confirm: env.PPBF_POLICY_MOVE_CONFIRM ?? '',
    // The plan_fingerprint of the dry run that was reviewed. Required for apply.
    expectFingerprint: (env.PPBF_POLICY_MOVE_EXPECT_FINGERPRINT ?? '').trim(),
    maxRows: maxRaw === '' ? DEFAULT_MAX_ROWS : Number(maxRaw),
  };
  const refusal = validateMoveOptions(options);
  return refusal ? { ok: false, refusal } : { ok: true, options };
}

/** sha256 over the exact ids the plan would move or detach, so two runs can be compared. */
export function planFingerprint(plan) {
  const material = JSON.stringify({
    from: plan.from,
    to: plan.to,
    source_type: plan.sourceType,
    sources: [...plan.ids.sources].sort(),
    documents: [...plan.ids.documents].sort(),
    chunks: [...plan.ids.chunks].sort(),
    citation_checks: [...plan.ids.citationChecks].sort(),
    retraction_checks: [...plan.ids.retractionChecks].sort(),
    detach_evidence_items: [...plan.ids.evidenceItems].sort(),
    detach_message_citations: [...plan.ids.messageCitations].sort(),
  });
  return `sha256:${crypto.createHash('sha256').update(material).digest('hex')}`;
}

const COUNT_KEYS = ['sources', 'documents', 'chunks', 'citation_checks', 'retraction_checks'];

/** Mirrors the source filters retrieval applies (shadowLibrary.ts). */
function isSourceReady(row) {
  return row.status === 'active'
    && row.approval_state === 'approved'
    && row.verification_state === 'verified'
    && row.retrieval_suppressed !== true;
}

/** Mirrors the document filters retrieval applies (shadowLibrary.ts). */
function isDocumentReady(row) {
  return row.ingest_state === 'indexed'
    && row.index_completed === true
    && row.approval_state === 'approved'
    && row.verification_state === 'verified';
}

async function countOrganizations(client, organizationIds) {
  const result = await client.query(
    `select o.organization_id,
       (select count(*)::int from pilot.shadow_library_sources x where x.organization_id = o.organization_id) as sources,
       (select count(*)::int from pilot.shadow_library_documents x where x.organization_id = o.organization_id) as documents,
       (select count(*)::int from pilot.shadow_library_chunks x where x.organization_id = o.organization_id) as chunks,
       (select count(*)::int from pilot.source_citation_checks x where x.organization_id = o.organization_id) as citation_checks,
       (select count(*)::int from pilot.source_retraction_checks x where x.organization_id = o.organization_id) as retraction_checks
       from pilot.organizations o
      where o.organization_id = any($1::text[])`,
    [organizationIds],
  );
  const byOrg = {};
  for (const row of result.rows) {
    byOrg[row.organization_id] = Object.fromEntries(COUNT_KEYS.map((key) => [key, Number(row[key] ?? 0)]));
  }
  return byOrg;
}

/**
 * Reads everything the move would touch or collide with. `lock` adds
 * FOR UPDATE to the rows that move (apply only -- a read-only transaction
 * cannot take row locks).
 */
async function buildPlan(client, { from, to, sourceType, maxRows, maxDetachRows, lock }) {
  const forUpdate = lock ? ' for update' : '';

  const sources = (await client.query(
    `select source_id, title, source_type, authority_tier, url, approval_state, verification_state,
            status, retrieval_suppressed
       from pilot.shadow_library_sources
      where organization_id = $1 and source_type = $2
      order by source_id${forUpdate}`,
    [from, sourceType],
  )).rows;
  const sourceIds = sources.map((row) => row.source_id);
  const sourceIdSet = new Set(sourceIds);

  // Every organization, on purpose: a document of a moving source that sits in
  // another tenant already is a state to stop on, not to step around.
  const documentsAnyOrg = (await client.query(
    `select document_id, source_id, organization_id, subject_id, content_sha256,
            ingest_state, index_completed_at is not null as index_completed, approval_state, verification_state
       from pilot.shadow_library_documents
      where source_id = any($1::text[])
      order by document_id${forUpdate}`,
    [sourceIds],
  )).rows;
  const documents = documentsAnyOrg.filter((row) => row.organization_id === from);
  const documentIds = documents.map((row) => row.document_id);
  const documentIdSet = new Set(documentIds);

  const chunksAnyOrg = (await client.query(
    `select chunk_id, document_id, source_id, organization_id, subject_id
       from pilot.shadow_library_chunks
      where source_id = any($1::text[]) or document_id = any($2::text[])
      order by chunk_id${forUpdate}`,
    [sourceIds, documentsAnyOrg.map((row) => row.document_id)],
  )).rows;
  const chunks = chunksAnyOrg.filter((row) => row.organization_id === from);
  const chunkIds = chunks.map((row) => row.chunk_id);

  const citationChecksAnyOrg = (await client.query(
    `select organization_id, check_id, source_id
       from pilot.source_citation_checks
      where source_id = any($1::text[])
      order by organization_id, check_id${forUpdate}`,
    [sourceIds],
  )).rows;
  const citationChecks = citationChecksAnyOrg.filter((row) => row.organization_id === from);

  const retractionChecksAnyOrg = (await client.query(
    `select organization_id, retraction_check_id, source_id
       from pilot.source_retraction_checks
      where source_id = any($1::text[])
      order by organization_id, retraction_check_id${forUpdate}`,
    [sourceIds],
  )).rows;
  const retractionChecks = retractionChecksAnyOrg.filter((row) => row.organization_id === from);

  // The evidence items that cite a moving row, and the chat-answer citations of
  // them: both are detached before the move. Locked on apply; with the cited
  // rows already locked, no new item or citation can appear mid-run (an insert
  // takes a key-share lock on the row it references). account_id is never
  // selected.
  const citingItems = (await client.query(
    `select evidence_id::text as evidence_id, bundle_id::text as bundle_id, organization_id,
            source_id, document_id, chunk_id, library_organization_id, ordinal, excerpt_sha256
       from pilot.shadow_evidence_items
      where source_id = any($1::text[]) or document_id = any($2::text[]) or chunk_id = any($3::text[])
      order by evidence_id${forUpdate}`,
    [sourceIds, documentIds, chunkIds],
  )).rows;
  const citingItemIds = citingItems.map((row) => row.evidence_id);
  const messageCitations = (await client.query(
    `select assistant_message_id::text as assistant_message_id, evidence_id::text as evidence_id,
            bundle_id::text as bundle_id, ordinal
       from pilot.shadow_message_citations
      where evidence_id = any($1::uuid[])
      order by assistant_message_id, evidence_id${forUpdate}`,
    [citingItemIds],
  )).rows;
  const citationKey = (row) => `${row.assistant_message_id}:${row.evidence_id}`;

  // Why detach and not re-point: the CHECK
  // pilot_shadow_evidence_items_library_scope_check lets an item cite only its
  // own (asking) organization or __platform__. The plan groups the citing
  // items by asking organization and says whether every asking account is an
  // active member of the target (the counts the detach decision was made on,
  // OD-2026-10-08-009 D22). Counts only: no account id leaves the database.
  // "Active in target" is what sign-in would honour: an active membership of
  // the target AND an account that is active and not deleted (auth.ts,
  // deletedAccountSignIn.ts). A de-identified asker (anon_<uuid>, set by the
  // retention purge) has no account and is counted on its own. Because of the
  // CHECK, every citing item's asking organization is the from-organization,
  // so in practice there is one group. message_citations counts citation
  // rows: one answer citing three items counts three.
  const evidenceByAskingOrganization = (await client.query(
    `with citing as (
       select e.organization_id, e.bundle_id, e.account_id,
              (select count(*)::int from pilot.shadow_message_citations mc
                where mc.evidence_id = e.evidence_id) as message_citations,
              e.account_id ~ '^anon_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' as deidentified,
              exists (
                select 1
                  from pilot.organization_memberships m
                  join pilot.accounts a on a.account_id = m.account_id
                 where m.account_id = e.account_id and m.organization_id = $4 and m.active_flag = true
                   and a.active_flag = true and a.deleted_at is null
              ) as account_in_target
         from pilot.shadow_evidence_items e
        where e.source_id = any($1::text[]) or e.document_id = any($2::text[]) or e.chunk_id = any($3::text[])
     )
     select organization_id as asking_organization_id,
            count(*)::int as items,
            count(distinct bundle_id)::int as bundles,
            coalesce(sum(message_citations), 0)::int as message_citations,
            count(distinct account_id)::int as asking_accounts,
            count(distinct account_id) filter (where deidentified)::int as asking_accounts_deidentified,
            count(distinct account_id) filter (where account_in_target)::int as asking_accounts_active_in_target
       from citing
      group by organization_id
      order by organization_id`,
    [sourceIds, documentIds, chunkIds, to],
  )).rows.map((row) => {
    const askingAccounts = Number(row.asking_accounts ?? 0);
    const inTarget = Number(row.asking_accounts_active_in_target ?? 0);
    return {
      asking_organization_id: row.asking_organization_id,
      items: Number(row.items ?? 0),
      bundles: Number(row.bundles ?? 0),
      message_citations: Number(row.message_citations ?? 0),
      asking_accounts: askingAccounts,
      asking_accounts_deidentified: Number(row.asking_accounts_deidentified ?? 0),
      asking_accounts_active_in_target: inTarget,
      all_asking_accounts_active_in_target: askingAccounts > 0 && inTarget === askingAccounts,
    };
  });
  const detaching = citingItems.length + messageCitations.length;
  const citingEvidence = {
    items: citingItems.length,
    message_citations: messageCitations.length,
    bundles: new Set(citingItems.map((row) => row.bundle_id)).size,
    answers: new Set(messageCitations.map((row) => row.assistant_message_id)).size,
    by_asking_organization: evidenceByAskingOrganization,
  };

  const submissions = (await client.query(
    `select organization_id, submission_id, source_id, document_id
       from pilot.shadow_research_submissions
      where source_id = any($1::text[]) or document_id = any($2::text[])
      order by organization_id, submission_id`,
    [sourceIds, documentIds],
  )).rows;

  const rabbitHoles = (await client.query(
    `select organization_id, rabbit_hole_id::text as rabbit_hole_id, library_document_id, status
       from pilot.rabbit_holes
      where library_document_id = any($1::text[])
      order by organization_id, rabbit_hole_id`,
    [documentIds],
  )).rows;

  // Unique keys that include organization_id: what the target already holds.
  const urls = sources.map((row) => row.url).filter((url) => url !== null && url !== undefined);
  const shas = documents.map((row) => row.content_sha256).filter((sha) => sha !== null && sha !== undefined);
  const collisions = {
    source_urls: (await client.query(
      `select source_id, url from pilot.shadow_library_sources
        where organization_id = $1 and url = any($2::text[])
        order by source_id`,
      [to, urls],
    )).rows,
    document_content_sha256: (await client.query(
      `select document_id, content_sha256 from pilot.shadow_library_documents
        where organization_id = $1 and content_sha256 = any($2::text[])
        order by document_id`,
      [to, shas],
    )).rows,
    citation_check_ids: (await client.query(
      `select check_id from pilot.source_citation_checks
        where organization_id = $1 and check_id = any($2::text[])
        order by check_id`,
      [to, citationChecks.map((row) => row.check_id)],
    )).rows,
    retraction_check_ids: (await client.query(
      `select retraction_check_id from pilot.source_retraction_checks
        where organization_id = $1 and retraction_check_id = any($2::text[])
        order by retraction_check_id`,
      [to, retractionChecks.map((row) => row.retraction_check_id)],
    )).rows,
  };

  const capabilityRules = (await client.query(
    `select f.capability_map_id, f.capability_key, f.coverage_state,
            exists (
              select 1 from pilot.shadow_library_capability_map t
               where t.organization_id = $2 and t.capability_key = f.capability_key
            ) as target_has_key
       from pilot.shadow_library_capability_map f
      where f.organization_id = $1 and $3 = any(f.required_source_types)
      order by f.capability_key`,
    [from, to, sourceType],
  )).rows;

  const counts = {
    sources: sources.length,
    documents: documents.length,
    chunks: chunks.length,
    citation_checks: citationChecks.length,
    retraction_checks: retractionChecks.length,
  };
  const total = COUNT_KEYS.reduce((sum, key) => sum + counts[key], 0);

  const blockers = [];
  if (sources.length === 0) {
    blockers.push({ code: 'NOTHING_TO_MOVE', source_type: sourceType });
  }

  const crossTenant = {
    documents: documentsAnyOrg.filter((row) => row.organization_id !== from)
      .map((row) => ({ document_id: row.document_id, organization_id: row.organization_id })),
    chunks: chunksAnyOrg.filter((row) => row.organization_id !== from)
      .map((row) => ({ chunk_id: row.chunk_id, organization_id: row.organization_id })),
    citation_checks: citationChecksAnyOrg.filter((row) => row.organization_id !== from)
      .map((row) => ({ check_id: row.check_id, organization_id: row.organization_id })),
    retraction_checks: retractionChecksAnyOrg.filter((row) => row.organization_id !== from)
      .map((row) => ({ retraction_check_id: row.retraction_check_id, organization_id: row.organization_id })),
  };
  if (Object.values(crossTenant).some((rows) => rows.length > 0)) {
    blockers.push({ code: 'CROSS_TENANT_ROWS', ...crossTenant });
  }

  // A chunk that moves must land beside its document and its source. A chunk
  // of a moving source inside a document that stays (or the reverse) would be
  // split across two tenants.
  const openChunks = chunks
    .filter((row) => !sourceIdSet.has(row.source_id) || !documentIdSet.has(row.document_id))
    .map((row) => ({ chunk_id: row.chunk_id, source_id: row.source_id, document_id: row.document_id }));
  if (openChunks.length > 0) blockers.push({ code: 'CLOSURE_BROKEN', chunks: openChunks });

  if (detaching > maxDetachRows) {
    blockers.push({ code: 'DETACH_RADIUS_EXCEEDED', detaching, max: maxDetachRows });
  }
  if (submissions.length > 0) blockers.push({ code: 'RESEARCH_SUBMISSIONS_REFERENCE_ROWS', submissions });

  const strandedRabbitHoles = rabbitHoles.filter((row) => row.organization_id !== to);
  if (strandedRabbitHoles.length > 0) {
    blockers.push({ code: 'RABBIT_HOLES_WOULD_LOSE_CITATION', rabbit_holes: strandedRabbitHoles });
  }

  const subjectScoped = [
    ...documents.filter((row) => row.subject_id !== null && row.subject_id !== undefined)
      .map((row) => ({ document_id: row.document_id })),
    ...chunks.filter((row) => row.subject_id !== null && row.subject_id !== undefined)
      .map((row) => ({ chunk_id: row.chunk_id })),
  ];
  if (subjectScoped.length > 0) blockers.push({ code: 'SUBJECT_SCOPED_ROWS', rows: subjectScoped });

  if (Object.values(collisions).some((rows) => rows.length > 0)) {
    blockers.push({ code: 'TARGET_ORG_COLLISION', ...collisions });
  }

  if (total > maxRows) blockers.push({ code: 'BLAST_RADIUS_EXCEEDED', moving: total, max: maxRows });

  const chunksPerDocument = new Map();
  for (const row of chunks) chunksPerDocument.set(row.document_id, (chunksPerDocument.get(row.document_id) ?? 0) + 1);

  // The move changes which organization owns a row, never its review state.
  // Retrieval reads only rows past the review and index filters
  // (src/server/pilot/shadowLibrary.ts), so the plan counts how many would be
  // readable in the target straight after the move.
  const readySourceIds = new Set(sources.filter(isSourceReady).map((row) => row.source_id));
  const readyDocumentIds = new Set(documents.filter(isDocumentReady).map((row) => row.document_id));
  const readyChunks = chunks.filter((row) => (
    readySourceIds.has(row.source_id) && readyDocumentIds.has(row.document_id)
    && (row.subject_id === null || row.subject_id === undefined)
  )).length;
  const sourcesByApprovalState = {};
  for (const row of sources) {
    const key = String(row.approval_state ?? 'unknown');
    sourcesByApprovalState[key] = (sourcesByApprovalState[key] ?? 0) + 1;
  }
  const stateTally = {
    sources: {
      ready: readySourceIds.size,
      not_ready: sources.length - readySourceIds.size,
      by_approval_state: sourcesByApprovalState,
    },
    documents: { ready: readyDocumentIds.size, not_ready: documents.length - readyDocumentIds.size },
    chunks: { ready: readyChunks, not_ready: chunks.length - readyChunks },
  };

  const plan = {
    from,
    to,
    sourceType,
    ids: {
      sources: sourceIds,
      documents: documentIds,
      chunks: chunkIds,
      citationChecks: citationChecks.map((row) => row.check_id),
      retractionChecks: retractionChecks.map((row) => row.retraction_check_id),
      evidenceItems: citingItemIds,
      messageCitations: messageCitations.map(citationKey),
    },
    counts,
    total,
    blockers,
    stateTally,
    citingEvidence,
    // The audit record of what is detached. Ids, cited ids and excerpt hashes
    // only; never printed by a dry run, which reports citingEvidence counts.
    detach: {
      evidence_items: citingItems.map((row) => ({
        evidence_id: row.evidence_id,
        bundle_id: row.bundle_id,
        asking_organization_id: row.organization_id,
        source_id: row.source_id,
        document_id: row.document_id,
        chunk_id: row.chunk_id,
        library_organization_id: row.library_organization_id,
        ordinal: Number(row.ordinal),
        excerpt_sha256: row.excerpt_sha256,
      })),
      message_citations: messageCitations.map((row) => ({
        assistant_message_id: row.assistant_message_id,
        evidence_id: row.evidence_id,
        bundle_id: row.bundle_id,
        ordinal: Number(row.ordinal),
      })),
    },
    report: {
      state_tally: stateTally,
      citing_evidence: citingEvidence,
      state_note: 'The move changes which organization owns these rows, not their review state. '
        + 'ready = passes the review and index filters retrieval applies (embeddings not checked); '
        + 'not_ready rows stay out of retrieval after the move until they are reviewed.',
      sources: sources.map((row) => ({
        source_id: row.source_id,
        title: row.title,
        authority_tier: row.authority_tier,
        status: row.status,
        approval_state: row.approval_state,
        verification_state: row.verification_state,
        retrieval_suppressed: row.retrieval_suppressed === true,
      })),
      documents: documents.map((row) => ({
        document_id: row.document_id,
        source_id: row.source_id,
        chunks: chunksPerDocument.get(row.document_id) ?? 0,
        ingest_state: row.ingest_state,
        index_completed: row.index_completed === true,
        approval_state: row.approval_state,
        verification_state: row.verification_state,
      })),
      chunk_ids: chunkIds,
      citation_check_ids: citationChecks.map((row) => row.check_id),
      retraction_check_ids: retractionChecks.map((row) => row.retraction_check_id),
      rabbit_holes_in_target_citing_documents: rabbitHoles.filter((row) => row.organization_id === to).length,
      capability_rules_not_moved: capabilityRules.map((row) => ({
        capability_map_id: row.capability_map_id,
        capability_key: row.capability_key,
        coverage_state: row.coverage_state,
        target_has_key: row.target_has_key === true,
      })),
    },
  };
  plan.fingerprint = planFingerprint(plan);
  return plan;
}

/**
 * The move. `client` is anything with pg's `query(text, values)` shape; the
 * caller owns connecting and ending it.
 *
 * Returns one of:
 *   { status: 'refused', reason, ... }           nothing written
 *   { status: 'dry-run', plan, blockers, ... }  nothing written
 *   { status: 'applied', plan, moved, detached, after } committed
 * and throws (after rolling back) on an unexpected database error.
 */
export async function movePolicyShelf(client, options, { log = defaultLog } = {}) {
  const refusal = validateMoveOptions(options);
  if (refusal) {
    log('refused', refusal);
    return { status: 'refused', ...refusal };
  }

  const { fromOrganizationId: from, toOrganizationId: to, sourceType, maxRows, expectFingerprint } = options;
  const maxDetachRows = options.maxDetachRows ?? DEFAULT_MAX_DETACH_ROWS;
  // validateMoveOptions already refuses a non-boolean; this keeps the write
  // path from ever branching on mere truthiness.
  const apply = options.apply === true;
  let open = false;

  async function refuseInside(reason, detail = {}) {
    await client.query('rollback');
    open = false;
    log('refused', { reason, ...detail });
    return { status: 'refused', reason, ...detail };
  }

  try {
    await client.query(apply ? 'begin' : 'begin read only');
    open = true;
    if (apply) await client.query("set local lock_timeout = '10s'");

    const organizations = (await client.query(
      `select organization_id, organization_name, status
         from pilot.organizations
        where organization_id = any($1::text[])`,
      [[from, to]],
    )).rows;
    const byId = new Map(organizations.map((row) => [row.organization_id, row]));
    const missing = [from, to].filter((id) => !byId.has(id));
    if (missing.length > 0) return await refuseInside('ORGANIZATION_NOT_FOUND', { missing });

    const before = await countOrganizations(client, [from, to]);
    const plan = await buildPlan(client, { from, to, sourceType, maxRows, maxDetachRows, lock: apply });

    log('plan', {
      mode: apply ? 'apply' : 'dry-run',
      from_organization: { ...byId.get(from) },
      to_organization: { ...byId.get(to) },
      source_type: sourceType,
      plan_fingerprint: plan.fingerprint,
      moving: plan.counts,
      moving_total: plan.total,
      before,
      ...plan.report,
      blockers: plan.blockers,
    });

    if (!apply) {
      await client.query('rollback');
      open = false;
      const result = {
        status: 'dry-run',
        would_apply: plan.blockers.length === 0,
        blockers: plan.blockers.map((b) => b.code),
        plan_fingerprint: plan.fingerprint,
        moving: plan.counts,
        state_tally: plan.stateTally,
        citing_evidence: plan.citingEvidence,
        before,
        plan,
      };
      log('dry-run', {
        would_apply: result.would_apply,
        blockers: result.blockers,
        moving: plan.counts,
        state_tally: plan.stateTally,
        citing_evidence: plan.citingEvidence,
        plan_fingerprint: plan.fingerprint,
        note: result.would_apply
          ? `apply needs mode=apply, the phrase ${CONFIRM_PHRASE}, and expected_fingerprint set to this plan_fingerprint`
          : 'apply would refuse; see blockers',
      });
      return result;
    }

    // The reviewed dry run is the plan Jason approves. Anything added to, or
    // gone from, the shelf since then changes the fingerprint and stops here,
    // before the first update.
    if (plan.fingerprint !== expectFingerprint) {
      return await refuseInside('PLAN_FINGERPRINT_MISMATCH', {
        expected: expectFingerprint, actual: plan.fingerprint,
      });
    }

    if (plan.blockers.length > 0) {
      return await refuseInside('PLAN_BLOCKED', { blockers: plan.blockers });
    }

    // Detach first: the answers' citations of the citing items, then the items.
    // Each delete is scoped to the planned keys and must remove exactly as many
    // rows as the plan; a citation the plan did not see would make the item
    // delete fail on its foreign key, which rolls the whole run back.
    const detached = { message_citations: 0, evidence_items: 0 };
    if (plan.ids.messageCitations.length > 0) {
      const result = await client.query(
        `delete from pilot.shadow_message_citations mc
          using unnest($1::uuid[], $2::uuid[]) as k(assistant_message_id, evidence_id)
          where mc.assistant_message_id = k.assistant_message_id and mc.evidence_id = k.evidence_id
         returning mc.evidence_id`,
        [plan.detach.message_citations.map((row) => row.assistant_message_id),
          plan.detach.message_citations.map((row) => row.evidence_id)],
      );
      detached.message_citations = result.rowCount ?? result.rows?.length ?? 0;
      if (detached.message_citations !== plan.ids.messageCitations.length) {
        return await refuseInside('PLAN_DETACH_COUNT_MISMATCH', {
          table: 'message_citations', planned: plan.ids.messageCitations.length, deleted: detached.message_citations,
        });
      }
    }
    if (plan.ids.evidenceItems.length > 0) {
      const result = await client.query(
        `delete from pilot.shadow_evidence_items
          where evidence_id = any($1::uuid[])
         returning evidence_id`,
        [plan.ids.evidenceItems],
      );
      detached.evidence_items = result.rowCount ?? result.rows?.length ?? 0;
      if (detached.evidence_items !== plan.ids.evidenceItems.length) {
        return await refuseInside('PLAN_DETACH_COUNT_MISMATCH', {
          table: 'evidence_items', planned: plan.ids.evidenceItems.length, deleted: detached.evidence_items,
        });
      }
    }

    // Each update is scoped to the planned ids AND the from-organization, so a
    // row that changed hands since the plan is not touched -- and is caught by
    // the count comparison below.
    const moved = {};
    const updates = [
      ['sources', `update pilot.shadow_library_sources set organization_id = $2, updated_at = now()
         where organization_id = $1 and source_id = any($3::text[]) returning source_id`, plan.ids.sources],
      ['documents', `update pilot.shadow_library_documents set organization_id = $2, updated_at = now()
         where organization_id = $1 and document_id = any($3::text[]) returning document_id`, plan.ids.documents],
      ['chunks', `update pilot.shadow_library_chunks set organization_id = $2, updated_at = now()
         where organization_id = $1 and chunk_id = any($3::text[]) returning chunk_id`, plan.ids.chunks],
      // Neither check table has an updated_at column.
      ['citation_checks', `update pilot.source_citation_checks set organization_id = $2
         where organization_id = $1 and check_id = any($3::text[]) returning check_id`, plan.ids.citationChecks],
      ['retraction_checks', `update pilot.source_retraction_checks set organization_id = $2
         where organization_id = $1 and retraction_check_id = any($3::text[]) returning retraction_check_id`,
      plan.ids.retractionChecks],
    ];
    for (const [key, sql, ids] of updates) {
      const result = await client.query(sql, [from, to, ids]);
      moved[key] = result.rowCount ?? result.rows?.length ?? 0;
      if (moved[key] !== plan.counts[key]) {
        return await refuseInside('PLAN_APPLY_COUNT_MISMATCH', {
          table: key, planned: plan.counts[key], updated: moved[key],
        });
      }
    }

    const verify = (await client.query(
      `select
         (select count(*)::int from pilot.shadow_library_sources
           where organization_id = $1 and source_id = any($3::text[])) as sources_left_in_from,
         (select count(*)::int from pilot.shadow_library_documents
           where organization_id = $1 and document_id = any($4::text[])) as documents_left_in_from,
         (select count(*)::int from pilot.shadow_library_chunks
           where organization_id = $1 and chunk_id = any($5::text[])) as chunks_left_in_from,
         (select count(*)::int from pilot.source_citation_checks
           where organization_id = $1 and source_id = any($3::text[])) as citation_checks_left_in_from,
         (select count(*)::int from pilot.source_retraction_checks
           where organization_id = $1 and source_id = any($3::text[])) as retraction_checks_left_in_from,
         (select count(*)::int from pilot.shadow_library_sources
           where organization_id = $2 and source_id = any($3::text[])) as sources_in_to,
         (select count(*)::int from pilot.shadow_library_documents d
            join pilot.shadow_library_sources s
              on s.source_id = d.source_id and s.organization_id = d.organization_id
           where d.organization_id = $2 and d.document_id = any($4::text[])) as documents_in_to_with_local_source,
         (select count(*)::int from pilot.shadow_library_chunks c
            join pilot.shadow_library_documents d
              on d.document_id = c.document_id and d.organization_id = c.organization_id
            join pilot.shadow_library_sources s
              on s.source_id = c.source_id and s.organization_id = c.organization_id
           where c.organization_id = $2 and c.chunk_id = any($5::text[])) as chunks_in_to_with_local_document_and_source,
         (select count(*)::int from pilot.shadow_evidence_items
           where source_id = any($3::text[]) or document_id = any($4::text[])
              or chunk_id = any($5::text[])) as evidence_items_citing_moved_rows,
         (select count(*)::int from pilot.shadow_message_citations
           where evidence_id = any($6::uuid[])) as message_citations_of_detached_items`,
      [from, to, plan.ids.sources, plan.ids.documents, plan.ids.chunks, plan.ids.evidenceItems],
    )).rows[0] ?? {};
    const after = await countOrganizations(client, [from, to]);

    const mismatches = [];
    const expectEqual = (label, actual, expected) => {
      if (Number(actual) !== expected) mismatches.push(`${label}=${actual}!=${expected}`);
    };
    expectEqual('sources_left_in_from', verify.sources_left_in_from, 0);
    expectEqual('documents_left_in_from', verify.documents_left_in_from, 0);
    expectEqual('chunks_left_in_from', verify.chunks_left_in_from, 0);
    expectEqual('citation_checks_left_in_from', verify.citation_checks_left_in_from, 0);
    expectEqual('retraction_checks_left_in_from', verify.retraction_checks_left_in_from, 0);
    expectEqual('sources_in_to', verify.sources_in_to, plan.counts.sources);
    expectEqual('documents_in_to_with_local_source', verify.documents_in_to_with_local_source, plan.counts.documents);
    expectEqual('chunks_in_to_with_local_document_and_source',
      verify.chunks_in_to_with_local_document_and_source, plan.counts.chunks);
    expectEqual('evidence_items_citing_moved_rows', verify.evidence_items_citing_moved_rows, 0);
    expectEqual('message_citations_of_detached_items', verify.message_citations_of_detached_items, 0);
    for (const key of COUNT_KEYS) {
      expectEqual(`${from}.${key}`, after[from]?.[key], (before[from]?.[key] ?? 0) - plan.counts[key]);
      expectEqual(`${to}.${key}`, after[to]?.[key], (before[to]?.[key] ?? 0) + plan.counts[key]);
    }
    if (mismatches.length > 0) return await refuseInside('END_STATE_MISMATCH', { mismatches });

    await client.query(
      `insert into pilot.audit_events
         (event_type, organization_id, entity_type, entity_id, details)
       values ('update', null, 'shadow_library_policy_move', $1, $2::jsonb)`,
      [to, JSON.stringify({
        from_organization: from,
        to_organization: to,
        source_type: sourceType,
        plan_fingerprint: plan.fingerprint,
        moved,
        detached_counts: detached,
        // Every detached row: ids, cited ids and excerpt hashes. No account
        // id, no text. The only record of them once this commits.
        detached: plan.detach,
        before,
        after,
      })],
    );

    await client.query('commit');
    open = false;

    log('completed', {
      from_organization: from, to_organization: to, plan_fingerprint: plan.fingerprint, moved, detached, before, after,
    });
    return { status: 'applied', plan_fingerprint: plan.fingerprint, moved, detached, before, after, plan };
  } catch (error) {
    if (open) await client.query('rollback').catch(() => {});
    throw error;
  }
}

function defaultCreateClient(connectionString) {
  return new pg.Client({ connectionString });
}

/**
 * Command-line entry. Every refusal that can be decided without the database
 * is decided before a client is even created.
 */
export async function run(env = process.env, { createClient = defaultCreateClient, log = defaultLog } = {}) {
  const parsed = parseMoveOptions(env);
  if (!parsed.ok) {
    log('refused', parsed.refusal);
    return { status: 'refused', ...parsed.refusal };
  }

  const connectionString = env.AZURE_POSTGRES_CONNECTION_STRING;
  if (!connectionString) {
    log('refused', { reason: 'MISSING_CONNECTION_STRING' });
    return { status: 'refused', reason: 'MISSING_CONNECTION_STRING' };
  }
  try {
    assertDeclaredWriteTargetFromEnv(connectionString, env);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'UNKNOWN_TARGET_ERROR';
    log('refused', { reason });
    return { status: 'refused', reason };
  }

  const client = createClient(connectionString);
  await client.connect();
  try {
    return await movePolicyShelf(client, parsed.options, { log });
  } catch (error) {
    const failure = {
      reason: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
      code: error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined,
      constraint: error && typeof error === 'object' && 'constraint' in error ? String(error.constraint) : undefined,
    };
    log('failed', failure);
    return { status: 'failed', ...failure };
  } finally {
    await client.end();
  }
}

/**
 * Exit status: 0 for a dry run with no blockers or a committed apply, 1 for
 * everything else -- including a dry run whose plan has blockers.
 */
export function exitCodeFor(result) {
  if (result.status === 'applied') return 0;
  if (result.status === 'dry-run' && result.would_apply) return 0;
  return 1;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    const result = await run();
    process.exitCode = exitCodeFor(result);
  } catch (error) {
    defaultLog('failed', { reason: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}
