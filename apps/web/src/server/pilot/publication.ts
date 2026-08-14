import { randomUUID } from 'node:crypto';
import { query, queryOne, withTransaction } from './db';

export type PublicationStatus =
  | 'draft'
  | 'pending_review'
  | 'approved'
  | 'published'
  | 'rejected'
  | 'archived'
  | 'retracted';

export type PublicationComplianceStatus = 'pending' | 'passed' | 'failed' | 'manual_review';

export interface VideoPublication {
  publication_id: string;
  video_session_id: string;
  athlete_id: string;
  // The coach who submitted the publication is the only non-admin who may
  // publish it, so every surface that lists publications has to carry this.
  submitted_by_account_id: string;
  publication_type: 'research_library' | 'public_coaching' | 'private_archive';
  title: string;
  description: string;
  tags: string[];
  compliance_check_status: PublicationComplianceStatus;
  metadata_complete: boolean;
  visibility: 'private' | 'organization' | 'public' | 'research';
  status: PublicationStatus;
  created_at: string;
}

export async function createPublication(params: {
  organizationId: string;
  videoSessionId: string;
  athleteId: string;
  submittedByAccountId: string;
  publicationType: string;
  title: string;
  description: string;
  tags?: string[];
}): Promise<VideoPublication> {
  const publicationId = `pub_${Date.now()}_${randomUUID().split('-')[0]}`;

  const result = await query<VideoPublication>(
    `insert into pilot.video_publications (
      publication_id, organization_id, video_session_id, athlete_id, submitted_by_account_id,
      publication_type, title, description, tags, status, compliance_check_status, metadata_complete
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', 'pending', false)
    returning publication_id, video_session_id, athlete_id, submitted_by_account_id, publication_type,
             title, description, tags, compliance_check_status, metadata_complete, visibility, status,
             created_at`,
    [
      publicationId,
      params.organizationId,
      params.videoSessionId,
      params.athleteId,
      params.submittedByAccountId,
      params.publicationType,
      params.title,
      params.description,
      // tags is text[]; node-pg serializes a JS array into a Postgres array
      // literal. JSON.stringify produced '[...]', which array_in rejects.
      params.tags || [],
    ],
  );

  return result[0];
}

// The coach-visible half of the review workflow: a draft reaches the admin
// console's queue only through this transition, because the console's GET
// lists status='pending_review' and nothing else. The CAS predicate on
// 'draft' matters for the same reason decidePublicationCompliance guards on
// its expected status -- a stale submit (a double-click, or a tab left open
// past an admin's decision) must not yank an already-decided publication
// back into the queue.
//
// publication_id is a caller-supplied value and the table's primary key is
// the id alone, so the organization must be part of the WHERE: without it a
// publication_id belonging to another gym is mutated by whoever guesses it.
// Returns false when no draft row in this organization matched.
export async function submitPublicationForReview(
  organizationId: string,
  publicationId: string,
): Promise<boolean> {
  const result = await query<{ publication_id: string }>(
    `update pilot.video_publications
     set status = 'pending_review',
         updated_at = now()
     where organization_id = $1 and publication_id = $2 and status = 'draft'
     returning publication_id`,
    [organizationId, publicationId],
  );

  return result.length > 0;
}

export interface PublicationGateRecord {
  publication_id: string;
  video_session_id: string;
  athlete_id: string;
  submitted_by_account_id: string;
  title: string;
  description: string;
  tags: string[];
  status: PublicationStatus;
  compliance_check_status: PublicationComplianceStatus;
}

// Read before publishing so the caller can name the exact reason a publish was
// refused. The row -- not the request body -- is the authority for who
// submitted the publication, which video session it covers, and what goes onto
// the library shelf. athlete_id is here (T-008) for the same reason: the
// guardian-consent gate needs the row's own athlete_id, not a caller-supplied
// one that could name a different athlete than the publication actually covers.
export async function getPublicationForPublish(
  organizationId: string,
  publicationId: string,
): Promise<PublicationGateRecord | null> {
  return queryOne<PublicationGateRecord>(
    `select publication_id, video_session_id, athlete_id, submitted_by_account_id, title, description, tags,
            status, compliance_check_status
     from pilot.video_publications
     where organization_id = $1 and publication_id = $2`,
    [organizationId, publicationId],
  );
}

export async function publishToResearchLibrary(params: {
  organizationId: string;
  publicationId: string;
  videoSessionId: string;
  title: string;
  description: string;
  tags?: string[];
  // Same contract as decidePublicationCompliance's verifyBeforeCommit: a
  // precondition re-run on THIS transaction's client immediately before the
  // claim, so a condition checked before the call (guardian consent) cannot
  // change in the gap between that check returning and the publish
  // committing. If it throws, the transaction rolls back and nothing lands
  // on the shelf.
  verifyBeforeCommit?: (client: { query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }> }) => Promise<void>;
}): Promise<string | null> {
  const libraryId = `lib_${Date.now()}_${crypto.randomUUID().split('-')[0]}`;

  // research_library's foreign keys accept any organization's publication_id
  // and video_session_id -- only organization_id says whose shelf the row
  // lands on. Both statements therefore run in one transaction that starts by
  // claiming the publication FOR THIS ORGANIZATION: no claim, no library row,
  // and the caller is told nothing was published rather than being handed a
  // library id for a row that mutated nobody's publication.
  //
  // The claim also carries the clearance predicate. A publication reaches the
  // research library only from 'approved' with its compliance checks passed,
  // and holding that here rather than only in the caller means a check that
  // fails between the caller's read and this write cannot be outrun.
  return withTransaction(async (client) => {
    if (params.verifyBeforeCommit) {
      await params.verifyBeforeCommit(client);
    }

    const claimed = await client.query<{ publication_id: string }>(
      `update pilot.video_publications
       set status = 'published',
           updated_at = now(),
           published_at = now()
       where organization_id = $1
         and publication_id = $2
         and status = 'approved'
         and compliance_check_status = 'passed'
       returning publication_id`,
      [params.organizationId, params.publicationId],
    );

    if (claimed.rows.length === 0) {
      return null;
    }

    await client.query(
      `insert into pilot.research_library (
        library_id, organization_id, publication_id, video_session_id, title, description, tags
      ) values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        libraryId,
        params.organizationId,
        params.publicationId,
        params.videoSessionId,
        params.title,
        params.description,
        params.tags || [],
      ],
    );

    return libraryId;
  });
}

/**
 * The CAS-guarded status transition and its compliance-check record, in one
 * transaction. The two writes were once separate and non-transactional -- a
 * status flip that committed while the check insert failed left a decided
 * row with no record of who decided it or why, and the admin's retry hit
 * the CAS guard as "already decided by another reviewer" (factually wrong)
 * with no way back into the queue, since GET only lists
 * status='pending_review' rows. One transaction, one outcome.
 *
 * The check-row insert carries no organization guard of its own on purpose:
 * it only runs after the CAS UPDATE in the same transaction matched a row
 * scoped by organization_id, so a cross-org publication_id writes nothing.
 *
 * Returns false (and writes nothing) when the CAS predicate does not match
 * -- another reviewer's decision already committed since the caller read the
 * row.
 */
export async function decidePublicationCompliance(params: {
  organizationId: string;
  publicationId: string;
  newStatus: string;
  checkStatus: string;
  checkType: string;
  details: string;
  decidedByAccountId: string;
  approvedByAccountId?: string;
  expectedCurrentStatus: string;
  // T-008: an optional precondition checked on the SAME transaction client,
  // immediately before the CAS UPDATE below. A caller that already checked
  // something (e.g. guardian consent) BEFORE calling this function checked
  // it outside any transaction -- the gap between that check returning and
  // this UPDATE committing is a real window for the checked condition to
  // change underneath it (a guardian withdrawing consent between an admin's
  // click and the write landing). Running the same check again in here,
  // against the same client, closes that window: if it throws, the
  // transaction rolls back and nothing commits.
  verifyBeforeCommit?: (client: { query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }> }) => Promise<void>;
}): Promise<boolean> {
  return withTransaction(async (client) => {
    if (params.verifyBeforeCommit) {
      await params.verifyBeforeCommit(client);
    }

    const now = new Date().toISOString();

    const updated = await client.query<{ publication_id: string }>(
      `update pilot.video_publications
       set status = $3,
           updated_at = $4,
           compliance_check_status = $5,
           approved_by_account_id = coalesce($6, approved_by_account_id),
           published_at = case when $3 = 'published' then $4::timestamptz else published_at end
       where organization_id = $1 and publication_id = $2 and status = $7
       returning publication_id`,
      [
        params.organizationId,
        params.publicationId,
        params.newStatus,
        now,
        params.checkStatus,
        params.approvedByAccountId ?? null,
        params.expectedCurrentStatus,
      ],
    );

    if (updated.rows.length === 0) {
      return false;
    }

    const checkId = `check_${Date.now()}_${randomUUID().split('-')[0]}`;
    await client.query(
      `insert into pilot.publication_checks
         (check_id, organization_id, publication_id, check_type, check_status, details, checked_by_account_id, checked_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        checkId,
        params.organizationId,
        params.publicationId,
        params.checkType,
        params.checkStatus,
        params.details,
        params.decidedByAccountId,
        now,
      ],
    );

    return true;
  });
}

/**
 * Retraction: the controlled non-distributable state (owner decision,
 * 2026-08-14). One transaction flips the publication off 'published' and
 * suppresses its research-library rows -- attributed, dated, reasoned, and
 * never deleted. The CAS on 'published' means a retract racing another
 * retract (or a reopen) applies nothing rather than double-writing.
 *
 * There is deliberately NO transition out of 'retracted' here except
 * reopenRetractedPublication below, which goes only to 'pending_review'
 * with the compliance check reset -- republishing structurally requires a
 * fresh consent-gated approval and a fresh consent-gated publish. A direct
 * retracted -> published path must never exist.
 */
export async function retractPublication(params: {
  organizationId: string;
  publicationId: string;
  suppressedByAccountId: string;
  reason: string;
}): Promise<boolean> {
  return withTransaction(async (client) => {
    const claimed = await client.query<{ publication_id: string }>(
      `update pilot.video_publications
       set status = 'retracted',
           updated_at = now()
       where organization_id = $1 and publication_id = $2 and status = 'published'
       returning publication_id`,
      [params.organizationId, params.publicationId],
    );

    if (claimed.rows.length === 0) {
      return false;
    }

    await client.query(
      `update pilot.research_library
       set suppressed_at = now(),
           suppressed_by_account_id = $3,
           suppressed_reason = $4,
           updated_at = now()
       where organization_id = $1 and publication_id = $2 and suppressed_at is null`,
      [params.organizationId, params.publicationId, params.suppressedByAccountId, params.reason],
    );

    return true;
  });
}

/**
 * The consent-withdrawal sweep: every currently-published publication of
 * this athlete becomes retracted, and its shelf rows suppressed, in one
 * transaction. Returns the retracted publication_ids so the caller can
 * audit each suppression independently of the withdrawal itself.
 *
 * The FOR UPDATE on guardian_links is the race lock against an in-flight
 * publish. The publish claim re-checks consent inside its own transaction
 * (assertGuardianMediaConsentWithClient), whose guardian_links read holds
 * FOR SHARE -- so either the publish commits first and this sweep then sees
 * and retracts it, or this sweep's lock wins and the publish's re-check
 * runs after the withdrawal committed and refuses. In no interleaving does
 * a publish survive a withdrawal unsuppressed.
 */
export async function suppressPublishedMediaForAthlete(params: {
  organizationId: string;
  athleteId: string;
  suppressedByAccountId: string;
  reason: string;
}): Promise<string[]> {
  return withTransaction(async (client) => {
    await client.query(
      `select parent_id from pilot.guardian_links
       where organization_id = $1 and athlete_id = $2
       for update`,
      [params.organizationId, params.athleteId],
    );

    const retracted = await client.query<{ publication_id: string }>(
      `update pilot.video_publications
       set status = 'retracted',
           updated_at = now()
       where organization_id = $1 and athlete_id = $2 and status = 'published'
       returning publication_id`,
      [params.organizationId, params.athleteId],
    );

    const publicationIds = retracted.rows.map((row) => row.publication_id);
    if (publicationIds.length === 0) {
      return [];
    }

    await client.query(
      `update pilot.research_library
       set suppressed_at = now(),
           suppressed_by_account_id = $3,
           suppressed_reason = $4,
           updated_at = now()
       where organization_id = $1 and publication_id = any($2) and suppressed_at is null`,
      [params.organizationId, publicationIds, params.suppressedByAccountId, params.reason],
    );

    return publicationIds;
  });
}

// The only exit from 'retracted', and it goes backwards, not forwards: into
// the review queue with the compliance check reset to 'pending', so the
// fresh consent-gated approval and the fresh consent-gated publish are both
// structurally required. Re-consent alone republishes nothing.
export async function reopenRetractedPublication(
  organizationId: string,
  publicationId: string,
): Promise<boolean> {
  const result = await query<{ publication_id: string }>(
    `update pilot.video_publications
     set status = 'pending_review',
         compliance_check_status = 'pending',
         updated_at = now()
     where organization_id = $1 and publication_id = $2 and status = 'retracted'
     returning publication_id`,
    [organizationId, publicationId],
  );

  return result.length > 0;
}

export interface PublicationCheckSummary {
  check_status: string;
  details: string;
  checked_at: string | null;
}

// The most recent review verdict on a publication, if any -- surfaced back
// to a reviewer so a re-queued item (e.g. after 'request_changes') does not
// look identical to one nobody has ever looked at.
export async function getLatestPublicationCheck(
  organizationId: string,
  publicationId: string,
): Promise<PublicationCheckSummary | null> {
  return queryOne<PublicationCheckSummary>(
    `select check_status, details, checked_at
     from pilot.publication_checks
     where organization_id = $1 and publication_id = $2
     order by created_at desc
     limit 1`,
    [organizationId, publicationId],
  );
}

export async function getResearchLibrary(
  organizationId: string,
  filters?: {
    tags?: string[];
    limit?: number;
    offset?: number;
  },
): Promise<Array<{ library_id: string; publication_id?: string; video_session_id?: string; title: string; tags: string[] }>> {
  let sql = `
    select library_id, publication_id, video_session_id, title, description, tags, view_count, published_at
    from pilot.research_library
    where organization_id = $1 and archived_at is null and suppressed_at is null
  `;
  const params: unknown[] = [organizationId];

  if (filters?.tags && filters.tags.length > 0) {
    sql += ` and tags && $${params.length + 1}`;
    params.push(filters.tags);
  }

  sql += ` order by published_at desc limit $${params.length + 1} offset $${params.length + 2}`;
  params.push(
    filters?.limit || 20,
    filters?.offset || 0,
  );

  return query(sql, params);
}

export async function getOrganizationPublications(
  organizationId: string,
  filters?: {
    status?: string;
    publicationType?: string;
    limit?: number;
  },
): Promise<VideoPublication[]> {
  let sql = `
    select publication_id, video_session_id, athlete_id, submitted_by_account_id, publication_type,
           title, description, tags, compliance_check_status, metadata_complete, visibility, status,
           created_at
    from pilot.video_publications
    where organization_id = $1
  `;
  const params: unknown[] = [organizationId];

  if (filters?.status) {
    sql += ` and status = $${params.length + 1}`;
    params.push(filters.status);
  }

  if (filters?.publicationType) {
    sql += ` and publication_type = $${params.length + 1}`;
    params.push(filters.publicationType);
  }

  sql += ` order by created_at desc limit $${params.length + 1}`;
  params.push(filters?.limit || 50);

  return query<VideoPublication>(sql, params);
}

// No callers yet. Org-scoped and suppression-aware anyway, so whoever wires
// it up cannot count a view against another gym's shelf or against a
// suppressed/archived row.
export async function trackLibraryView(organizationId: string, libraryId: string): Promise<void> {
  const now = new Date().toISOString();

  await query(
    `update pilot.research_library
     set view_count = view_count + 1, last_accessed_at = $1
     where organization_id = $2 and library_id = $3
       and suppressed_at is null and archived_at is null`,
    [now, organizationId, libraryId],
  );
}
