#!/usr/bin/env node

/**
 * Approves an organization's SHADOW library evidence in one reviewed pass.
 *
 * WHY A SCRIPT, WHEN A REVIEW ROUTE EXISTS
 *
 * Retrieval requires `approval_state = 'approved'` AND
 * `verification_state = 'verified'` on both the source and its document --
 * shadowLibrary.ts, shadowEvidence.ts and rabbitHoles.ts all restate it. The
 * corpus imports as pending_review/unverified by design, so SHADOW answers
 * nothing until something clears it.
 *
 * PATCH /api/pilot/shadow/evidence/review clears rows one at a time, and it
 * stays the right surface for a gym reviewing its own material. It cannot do
 * this job:
 *
 *   * It scopes every write to `principal.organizationId`, and no account may
 *     belong to the reserved platform organization -- the platform library scope
 *     migration asserts that org has no members and no memberships. So the
 *     platform baseline is unreachable through the API by construction, not by
 *     omission.
 *   * Until the change that accompanies this script, its id validator accepted
 *     only `source_`-prefixed ids while the corpus is keyed `src_`, so every
 *     imported source answered 404 there regardless of organization.
 *   * The baseline is 1,208 rows. One attestation covering a reviewed corpus is
 *     the decision the owner made; 1,208 identical clicks is not a reviewed
 *     corpus, it is the same decision with worse evidence that it was made.
 *
 * WHAT APPROVING MEANS HERE
 *
 * shadow_library_sources_review_pair_check makes the review state all-or-nothing:
 * either approval_state='approved', verification_state='verified' and all four of
 * approved_by/approved_at/verified_by/verified_at are set, or the row is pending
 * with all four null. There is no "approved, verification to follow". The
 * platform owner's account id therefore lands on every row this touches, as both
 * approver and verifier -- one named person attesting to the whole baseline. The
 * schema was built that way on purpose; this script makes the attestation
 * explicit in its output and in the audit row rather than quietly satisfying a
 * constraint.
 *
 *   TARGET GUARD    Refuses unless PPBF_EXPECTED_POSTGRES_HOSTNAME and
 *                   PPBF_EXPECTED_POSTGRES_DATABASE match the connection string,
 *                   the same contract the migration runners use.
 *
 *   READ-ONLY BY    A plain run opens `begin read only` and reports what it
 *   DEFAULT         would approve. PPBF_LIBRARY_APPROVAL_APPLY=true is the only
 *                   route to a writable transaction.
 *
 *   NAMED APPROVER  Resolves the single active platform owner and refuses if
 *                   there is none, or more than one and none was named. An
 *                   attestation needs a person, and "whichever row came back
 *                   first" is not one.
 *
 *   PENDING ONLY    Touches `approval_state = 'pending_review'` and nothing
 *                   else. A 'rejected' row is somebody's decision, and a bulk
 *                   pass must not silently reverse it.
 *
 *   WHOLE-ORG       The filter is organization_id + pending, and nothing narrower.
 *   SCOPE           Against the reserved platform organization that is exactly
 *                   right: nothing lives there but the baseline. Against a real
 *                   gym it means anything else pending in that gym is approved
 *                   too. Production's run on ppbf-default-org approved 22 sources
 *                   and 7 documents where the re-scope had left 21 and 6 -- one
 *                   source and one document, with 29 chunks, that a coach had
 *                   uploaded through the app and that no one had reviewed. They
 *                   now carry the platform owner as approver and verifier.
 *                   Nothing here filters them out, because "approve this gym's
 *                   library" is a defensible thing to mean and guessing which
 *                   rows the operator did not mean is not. What the plan can do
 *                   is say so: non_corpus_pending lists every pending row that
 *                   did not come from the seed files, so the operator sees them
 *                   before the apply rather than deriving them from two log lines
 *                   afterwards.
 *
 *   INDEXED FIRST   shadow_library_documents_review_pair_check additionally
 *                   requires ingest_state='indexed' and index_completed_at set
 *                   before a document may be approved -- a document cannot be
 *                   approved before it has been indexed. The corpus imports as
 *                   'pending' because the importer refuses to claim work it has
 *                   not done. This script completes that transition under the
 *                   same condition completeShadowLibraryDocumentIndexing
 *                   enforces (the document must have a non-empty chunk in its
 *                   own organization) and never for a document that has none.
 *
 *   BLAST RADIUS    Refuses above PPBF_LIBRARY_APPROVAL_MAX (default 1500). The
 *                   platform baseline is 1,194 sources and 14 documents; a run
 *                   wanting materially more is pointed at something else.
 *
 *   ONE TRANSACTION Sources, documents and the audit row commit together.
 *
 * Usage:
 *   npm run pilot:approve-library-baseline
 *       Reports what would be approved in __platform__. Writes nothing.
 *
 *   PPBF_LIBRARY_APPROVAL_APPLY=true npm run pilot:approve-library-baseline
 *       Approves it, stamping the platform owner.
 *
 *   PPBF_LIBRARY_APPROVAL_ORG=ppbf-gym-1
 *       Approve a different organization's shelf (a gym's own policy material,
 *       for instance). Defaults to the reserved platform organization.
 *
 *   PPBF_LIBRARY_APPROVAL_ACCOUNT=<account_id>
 *       Required only when more than one active platform owner exists.
 */

import { Pool } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Kept in lockstep with PLATFORM_LIBRARY_ORGANIZATION_ID in
// src/server/pilot/platformLibraryScope.ts, the same way the migration runner is.
const PLATFORM_ORGANIZATION_ID = '__platform__';

const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING;
if (!connectionString) {
  console.error(JSON.stringify({ event: 'library.approval.failed', reason: 'MISSING_CONNECTION_STRING' }));
  process.exit(1);
}

try {
  assertDeclaredWriteTargetFromEnv(connectionString);
} catch (error) {
  console.error(JSON.stringify({
    event: 'library.approval.refused',
    reason: error instanceof Error ? error.message : 'UNKNOWN_TARGET_ERROR',
  }));
  process.exit(1);
}

const apply = process.env.PPBF_LIBRARY_APPROVAL_APPLY === 'true';
const organizationId = process.env.PPBF_LIBRARY_APPROVAL_ORG?.trim() || PLATFORM_ORGANIZATION_ID;
const namedApprover = process.env.PPBF_LIBRARY_APPROVAL_ACCOUNT?.trim() || null;

const maxRows = Number.parseInt(process.env.PPBF_LIBRARY_APPROVAL_MAX ?? '1500', 10);
if (!Number.isFinite(maxRows) || maxRows < 0) {
  console.error(JSON.stringify({ event: 'library.approval.failed', reason: 'INVALID_MAX' }));
  process.exit(1);
}

const pool = new Pool({ connectionString });

/**
 * Finds the one person who can attest to this baseline.
 *
 * Platform ownership rather than a role name: `admin` and `organization_admin`
 * are per-gym, and approving the platform baseline is a platform-wide act. An
 * inactive or soft-deleted owner is not eligible -- an attestation by an account
 * that cannot sign in is not an attestation.
 */
async function resolveApprover(client) {
  const owners = await client.query(
    `select account_id, login_email, role
       from pilot.accounts
      where is_platform_owner = true
        and active_flag = true
        and deleted_at is null
      order by account_id`,
  );

  if (owners.rows.length === 0) return { error: 'NO_ACTIVE_PLATFORM_OWNER' };

  if (namedApprover) {
    const match = owners.rows.find((row) => row.account_id === namedApprover);
    if (!match) return { error: 'NAMED_APPROVER_IS_NOT_PLATFORM_OWNER' };
    return { approver: match };
  }

  if (owners.rows.length > 1) {
    return { error: 'AMBIGUOUS_PLATFORM_OWNER', candidates: owners.rows.map((row) => row.account_id) };
  }

  return { approver: owners.rows[0] };
}

function refuse(reason, extra = {}) {
  console.error(JSON.stringify({ event: 'library.approval.refused', reason, ...extra }));
  process.exitCode = 1;
}

async function main() {
  const client = await pool.connect();

  try {
    await client.query(apply ? 'begin' : 'begin read only');

    const organization = await client.query(
      'select organization_id, status from pilot.organizations where organization_id = $1',
      [organizationId],
    );
    if (organization.rowCount !== 1) {
      await client.query('rollback');
      refuse('ORGANIZATION_NOT_FOUND', { organization_id: organizationId });
      return;
    }

    const resolved = await resolveApprover(client);
    if (resolved.error) {
      await client.query('rollback');
      refuse(resolved.error, { candidates: resolved.candidates });
      return;
    }
    const { approver } = resolved;

    // Counted in the same transaction that will do the approving, so what is
    // reported is what changes. Split by state because the difference matters:
    // `rejected` is a decision this script leaves alone, and an operator reading
    // "1194 pending, 3 rejected" learns something that a single total hides.
    const before = await client.query(
      `select
         (select count(*)::int from pilot.shadow_library_sources
           where organization_id = $1 and approval_state = 'pending_review') as sources_pending,
         (select count(*)::int from pilot.shadow_library_sources
           where organization_id = $1 and approval_state = 'approved') as sources_approved,
         (select count(*)::int from pilot.shadow_library_sources
           where organization_id = $1 and approval_state = 'rejected') as sources_rejected,
         (select count(*)::int from pilot.shadow_library_documents
           where organization_id = $1 and approval_state = 'pending_review') as documents_pending,
         (select count(*)::int from pilot.shadow_library_documents
           where organization_id = $1 and approval_state = 'approved') as documents_approved,
         (select count(*)::int from pilot.shadow_library_documents
           where organization_id = $1 and approval_state = 'rejected') as documents_rejected,
         (select count(*)::int from pilot.shadow_library_chunks
           where organization_id = $1) as chunks,
         -- Documents that cannot be approved at all, because nothing indexable
         -- was imported for them. Counted separately so the plan distinguishes
         -- "not yet indexed" (this run fixes that) from "has no content"
         -- (this run must leave it alone).
         (select count(*)::int from pilot.shadow_library_documents d
           where d.organization_id = $1
             and d.approval_state = 'pending_review'
             and not exists (
               select 1 from pilot.shadow_library_chunks c
                where c.document_id = d.document_id
                  and c.organization_id = d.organization_id
                  and length(trim(c.text_content)) > 0
             )) as documents_without_content`,
      [organizationId],
    );
    const counts = before.rows[0];
    const approvableDocuments = counts.documents_pending - counts.documents_without_content;
    const total = counts.sources_pending + approvableDocuments;

    // Pending rows this run will approve that did NOT come from the seed files.
    // The corpus is keyed `src_<hash>`; anything created through the API is
    // `source_<uuid>`. See WHOLE-ORG SCOPE above: these are approved either way,
    // and the point of listing them is that the operator reads the plan first.
    // Capped, because the list exists to be read -- if a gym has hundreds of
    // pending uploads, the count is the signal and the sample is the illustration.
    const nonCorpusPending = await client.query(
      `select source_id, title, source_type
         from pilot.shadow_library_sources
        where organization_id = $1
          and approval_state = 'pending_review'
          and source_id not like 'src\\_%'
        order by source_id
        limit 25`,
      [organizationId],
    );
    const nonCorpusPendingTotal = await client.query(
      `select count(*)::int as total
         from pilot.shadow_library_sources
        where organization_id = $1
          and approval_state = 'pending_review'
          and source_id not like 'src\\_%'`,
      [organizationId],
    );

    console.log(JSON.stringify({
      event: 'library.approval.plan',
      apply,
      organization_id: organizationId,
      organization_status: organization.rows[0].status,
      approver: { account_id: approver.account_id, login_email: approver.login_email, role: approver.role },
      counts,
      would_index: approvableDocuments,
      would_approve: total,
      non_corpus_pending_count: nonCorpusPendingTotal.rows[0].total,
      non_corpus_pending: nonCorpusPending.rows,
      // Said plainly, because the constraint means there is no weaker version of
      // this: one account is recorded as having both approved and verified every
      // row below.
      attestation: `${approver.account_id} is recorded as approver AND verifier for ${total} row(s)`,
    }, null, 2));

    if (total > maxRows) {
      await client.query('rollback');
      refuse('BLAST_RADIUS_EXCEEDED', { would_approve: total, max: maxRows });
      return;
    }

    if (!apply) {
      await client.query('rollback');
      console.log(JSON.stringify({
        event: 'library.approval.dry-run',
        would_approve: total,
        note: 'set PPBF_LIBRARY_APPROVAL_APPLY=true to approve',
      }));
      return;
    }

    if (total === 0) {
      await client.query('rollback');
      console.log(JSON.stringify({
        event: 'library.approval.completed', sources_approved: 0, documents_approved: 0,
      }));
      return;
    }

    // All six columns in one statement per table, because
    // shadow_library_*_review_pair_check permits no intermediate state -- an
    // update that set approval_state without the stamps would be rejected by the
    // database, which is the behaviour we want and the reason not to fight it.
    const sources = await client.query(
      `update pilot.shadow_library_sources
          set approval_state = 'approved',
              verification_state = 'verified',
              approved_by_account_id = $2,
              approved_at = now(),
              verified_by_account_id = $2,
              verified_at = now(),
              updated_at = now()
        where organization_id = $1
          and approval_state = 'pending_review'
        returning source_id`,
      [organizationId, approver.account_id],
    );

    // Indexing before approval, in this order, because the check constraint
    // requires the indexed state to already hold on the row being approved.
    // The `exists` clause is completeShadowLibraryDocumentIndexing's condition,
    // restated: a document with no non-empty chunk of its own is not indexed,
    // and this must not say otherwise.
    const indexed = await client.query(
      `update pilot.shadow_library_documents d
          set ingest_state = 'indexed',
              index_completed_at = now(),
              updated_at = now()
        where d.organization_id = $1
          and d.approval_state = 'pending_review'
          -- "not fully indexed", not "not indexed". A document can sit at
          -- ingest_state='indexed' with index_completed_at NULL: the review-pair
          -- constraint permits it (its pending branch constrains only the
          -- approval columns), and staging's 14 corpus documents were in exactly
          -- that state. The first version tested ingest_state <> 'indexed'
          -- alone, so those rows matched neither this statement nor the approval
          -- below, which requires index_completed_at -- they fell through both
          -- and the run reported success having approved 1,194 sources and no
          -- documents at all. Retrieval needs both, so the baseline stayed dark.
          and (d.ingest_state <> 'indexed' or d.index_completed_at is null)
          and exists (
            select 1 from pilot.shadow_library_chunks c
             where c.document_id = d.document_id
               and c.organization_id = d.organization_id
               and length(trim(c.text_content)) > 0
          )
        returning d.document_id`,
      [organizationId],
    );

    const documents = await client.query(
      `update pilot.shadow_library_documents
          set approval_state = 'approved',
              verification_state = 'verified',
              approved_by_account_id = $2,
              approved_at = now(),
              verified_by_account_id = $2,
              verified_at = now(),
              updated_at = now()
        where organization_id = $1
          and approval_state = 'pending_review'
          and ingest_state = 'indexed'
          and index_completed_at is not null
        returning document_id`,
      [organizationId, approver.account_id],
    );

    // event_type 'update' rather than a new vocabulary entry: the audit
    // vocabulary is a CHECK constraint kept in lockstep with
    // src/server/pilot/auditEventTypes.ts by auditEventVocabulary.test.ts, and
    // widening it is its own migration. entity_type carries the specificity, and
    // details carry what an auditor actually needs -- who attested, on what
    // basis, and how many rows.
    // The plan said what it would do; refuse to commit if it did not do it.
    //
    // Without this the run above committed with documents_indexed=0 against
    // would_index=14 and called itself a success, which is the worst possible
    // outcome: a half-approved library reads as a finished one, and the next
    // person to look sees a green run. A mismatch here means the predicates and
    // the counting query disagree about the same rows, which is a bug in this
    // script, not a state the operator should be asked to interpret.
    const documentShortfall = approvableDocuments - documents.rowCount;
    const sourceShortfall = counts.sources_pending - sources.rowCount;
    if (documentShortfall !== 0 || sourceShortfall !== 0) {
      await client.query('rollback');
      refuse('APPLY_DID_NOT_MATCH_PLAN', {
        sources_planned: counts.sources_pending,
        sources_approved: sources.rowCount,
        documents_planned: approvableDocuments,
        documents_indexed: indexed.rowCount,
        documents_approved: documents.rowCount,
      });
      return;
    }

    await client.query(
      `insert into pilot.audit_events
         (event_type, actor_account_id, actor_role, organization_id, entity_type, entity_id, details)
       values ('update', $1, $2, $3, 'shadow_library_approval', $4, $5)`,
      [
        approver.account_id,
        approver.role,
        organizationId,
        organizationId,
        JSON.stringify({
          sources_approved: sources.rows.length,
          documents_indexed: indexed.rows.length,
          documents_approved: documents.rows.length,
          documents_left_unapproved_without_content: counts.documents_without_content,
          approver_account_id: approver.account_id,
          verifier_account_id: approver.account_id,
          verification_basis: 'platform_owner_bulk_attestation',
          approval_scope: organizationId === PLATFORM_ORGANIZATION_ID ? 'platform_baseline' : 'organization',
          rejected_left_untouched: counts.sources_rejected + counts.documents_rejected,
        }),
      ],
    );

    await client.query('commit');

    console.log(JSON.stringify({
      event: 'library.approval.completed',
      organization_id: organizationId,
      approver_account_id: approver.account_id,
      sources_approved: sources.rows.length,
      documents_indexed: indexed.rows.length,
      documents_approved: documents.rows.length,
      documents_without_content: counts.documents_without_content,
    }));
  } catch (error) {
    await client.query('rollback').catch(() => {});
    // The constraint name, not just the SQLSTATE. A bare 23514 says only "some
    // check failed" -- it was the documents review pair, and finding that meant
    // reproducing the statement by hand. Constraint and table names are schema
    // identifiers, not row data, so printing them leaks nothing.
    console.error(JSON.stringify({
      event: 'library.approval.failed',
      reason: error instanceof Error ? error.name : 'UnknownError',
      code: error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined,
      constraint: error && typeof error === 'object' && 'constraint' in error ? String(error.constraint) : undefined,
      table: error && typeof error === 'object' && 'table' in error ? String(error.table) : undefined,
    }));
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

await main();
