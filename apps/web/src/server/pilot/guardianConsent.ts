import { query, withTransaction } from './db';
import { guardianAthleteIds, guardianParentIdForAthlete, guardianParentIds } from './guardianAccess';
import { upsertWaiver, upsertWaiverWithClient, type UpsertWaiverParams } from './intake';
import { normalizeWaiverStatusText } from './waiverCompliance';

// Structural, not `import type { PoolClient } from 'pg'`: the only thing
// callers inside a withTransaction() block actually have is something
// query-shaped, and pg's own QueryResult already returns { rows }. Matches
// the shape publication.ts's decidePublicationCompliance already uses.
interface QueryExecutor {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * T-008: guardian consent for a minor's photo/video.
 *
 * pilot.waivers already recorded "photo_media" as a first-class waiver_type
 * (apps/web/app/admin/consent/page.tsx), and its append-only shape (a new
 * row supersedes the last one; status admits signed/declined/withdrawn) was
 * already exactly "revocable and auditable" -- this module is deliberately a
 * thin layer over that table, not a second one. See
 * pilot_slice_postgres_guardian_media_consent_migration.sql for the schema
 * change (parent_id, covers_video, public_use_allowed) and the full
 * reasoning for extending rather than duplicating.
 *
 * WHAT "CONSENT" MEANS HERE: every one of an athlete's guardians
 * (pilot.guardian_links) must have a CURRENT (latest by created_at)
 * photo_media waiver with status='signed'. An athlete with zero linked
 * guardians on file cannot have consent verified at all -- that reads as
 * missing, not as vacuously satisfied, because an empty guardian_links table
 * is far more likely to be a data gap than an athlete with no guardians.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO (see the migration's header and the
 * T-008 ticket delivery note for the full reasoning):
 *   - Does not match consent scope (covers_video / public_use_allowed)
 *     against a specific publication's media type or visibility. Recorded,
 *     not yet enforced -- a documented MVP cut, not an oversight.
 *   - Withdrawal DOES retract already-published media: the parent consent
 *     route sweeps the athlete's published publications into 'retracted'
 *     and suppresses their research-library rows in the same request
 *     (publication.ts suppressPublishedMediaForAthlete, owner decision
 *     2026-08-14). Approvals and publishes are also blocked going forward.
 */

export const MEDIA_CONSENT_WAIVER_TYPE = 'photo_media';

export class GuardianConsentMissingError extends Error {
  constructor(readonly athleteId: string, readonly missingParentIds: string[]) {
    super(
      missingParentIds.length > 0
        ? `Blocked: guardian media consent is missing or withdrawn for ${missingParentIds.length} of this athlete's guardians. Every guardian must have a current, signed photo/video consent on file before this can be approved.`
        : 'Blocked: this athlete has no guardians on file, so guardian media consent cannot be verified. Link a guardian before approving media of this athlete.',
    );
    this.name = 'GuardianConsentMissingError';
  }
}

interface CurrentConsentRow {
  parent_id: string;
  status: string;
  covers_video: boolean;
  public_use_allowed: boolean;
  created_at: string;
}

// pilot.waivers is append-only: "current" for a guardian is their latest row
// for this waiver_type, and DISTINCT ON with an ORDER BY is the one query
// shape that answers "latest per group" without a second round trip.
async function currentConsentByGuardian(
  organizationId: string,
  athleteId: string,
): Promise<Map<string, CurrentConsentRow>> {
  const rows = await query<CurrentConsentRow>(
    `select distinct on (parent_id) parent_id, status, covers_video, public_use_allowed, created_at
     from pilot.waivers
     where organization_id = $1 and athlete_id = $2 and waiver_type = $3 and parent_id is not null
     order by parent_id, created_at desc`,
    [organizationId, athleteId, MEDIA_CONSENT_WAIVER_TYPE],
  );

  const map = new Map<string, CurrentConsentRow>();
  for (const row of rows) {
    map.set(row.parent_id, row);
  }
  return map;
}

export interface GuardianConsentStatus {
  parentId: string;
  status: string | null;
  coversVideo: boolean | null;
  publicUseAllowed: boolean | null;
  signedAt: string | null;
}

export interface ConsentCheckResult {
  ok: boolean;
  guardianIds: string[];
  missingParentIds: string[];
  perGuardian: GuardianConsentStatus[];
}

export async function checkGuardianMediaConsent(
  organizationId: string,
  athleteId: string,
): Promise<ConsentCheckResult> {
  const guardianIds = await query<{ parent_id: string }>(
    `select parent_id from pilot.guardian_links where organization_id = $1 and athlete_id = $2`,
    [organizationId, athleteId],
  ).then((rows) => rows.map((row) => row.parent_id));

  if (guardianIds.length === 0) {
    return { ok: false, guardianIds: [], missingParentIds: [], perGuardian: [] };
  }

  const current = await currentConsentByGuardian(organizationId, athleteId);
  const perGuardian = guardianIds.map((parentId) => {
    const row = current.get(parentId);
    return {
      parentId,
      status: row?.status ?? null,
      coversVideo: row?.covers_video ?? null,
      publicUseAllowed: row?.public_use_allowed ?? null,
      signedAt: row?.created_at ?? null,
    };
  });
  /*
   * NORMALISED, not raw. Owner decision, 2026-08-28.
   *
   * pilot.waivers.status is `text not null` with no CHECK constraint, and
   * /api/pilot/intake/domain-upsert stores `asString(body.payload.status,
   * 'signed')` -- any string a caller sends. waiverCompliance.ts records a
   * waiver stored as ' Signed ' as something that ACTUALLY HAPPENED, and its
   * own gate has trimmed and lowercased since it was written, on the stated
   * ground that "refusing to take a child to a competition over whitespace
   * punishes the family for a data-entry artifact".
   *
   * This function read the same column and did NOT, so one guardian's
   * signature was a signature to that gate and not-consent to this one. The
   * asymmetry is the defect, not either half of it.
   *
   * ONLY CASE AND PADDING MOVE. 'active', 'approved', 'pending', a typo or an
   * empty string still fail this test, exactly as before -- the shared helper
   * does not map an unrecognised value onto anything. This loosens the gate
   * for a real signature recorded untidily and for nothing else.
   *
   * perGuardian keeps the RAW value: it is what the row says, and the parent
   * console renders it. Only the comparison normalises.
   */
  const missingParentIds = perGuardian
    .filter((g) => normalizeWaiverStatusText(g.status) !== 'signed')
    .map((g) => g.parentId);

  return { ok: missingParentIds.length === 0, guardianIds, missingParentIds, perGuardian };
}

export async function assertGuardianMediaConsent(organizationId: string, athleteId: string): Promise<void> {
  const result = await checkGuardianMediaConsent(organizationId, athleteId);
  if (!result.ok) {
    throw new GuardianConsentMissingError(athleteId, result.missingParentIds);
  }
}

// Round-8 review finding: the plain SELECT-based check above completes and
// returns before the CAS-guarded approval transaction even opens, so a
// guardian's withdrawal can commit in the gap between "checked" and
// "approved" -- video-compliance/route.ts closes that window by calling
// THIS variant from inside decidePublicationCompliance's own transaction
// (verifyBeforeCommit), on the same client, so the re-check is serialized
// against a concurrent withdrawal rather than racing it. Duplicates
// currentConsentByGuardian's query rather than sharing it, because a
// PoolClient's query() and db.ts's module-level query() return different
// shapes ({rows} vs a bare array) -- the same asymmetry
// decidePublicationCompliance itself already works around.
export async function assertGuardianMediaConsentWithClient(
  client: QueryExecutor,
  organizationId: string,
  athleteId: string,
): Promise<void> {
  // FOR SHARE is the race lock against a concurrent withdrawal sweep: the
  // sweep (publication.ts suppressPublishedMediaForAthlete) takes FOR UPDATE
  // on these same rows before retracting. Either this transaction commits
  // first and the sweep then retracts what it published/approved, or the
  // sweep's lock wins and this re-check runs after the withdrawal committed
  // and refuses. In no interleaving does a publish outlive a withdrawal
  // unsuppressed.
  const guardianResult = await client.query<{ parent_id: string }>(
    `select parent_id from pilot.guardian_links
     where organization_id = $1 and athlete_id = $2
     for share`,
    [organizationId, athleteId],
  );
  const guardianIds = guardianResult.rows.map((row) => row.parent_id);
  if (guardianIds.length === 0) {
    throw new GuardianConsentMissingError(athleteId, []);
  }

  const consentResult = await client.query<CurrentConsentRow>(
    `select distinct on (parent_id) parent_id, status, covers_video, public_use_allowed, created_at
     from pilot.waivers
     where organization_id = $1 and athlete_id = $2 and waiver_type = $3 and parent_id is not null
     order by parent_id, created_at desc`,
    [organizationId, athleteId, MEDIA_CONSENT_WAIVER_TYPE],
  );
  const current = new Map(consentResult.rows.map((row) => [row.parent_id, row]));
  // Normalised for the reason checkGuardianMediaConsent gives above. These
  // two are the same rule on the same rows and must not answer differently:
  // the transactional variant exists to re-check inside a transaction, not to
  // apply a stricter test than the one that let the caller in.
  const missingParentIds = guardianIds.filter(
    (id) => normalizeWaiverStatusText(current.get(id)?.status) !== 'signed',
  );
  if (missingParentIds.length > 0) {
    throw new GuardianConsentMissingError(athleteId, missingParentIds);
  }
}

/*
 * THE WRITE SIDE OF THE LOCK. Owner decision D-2, 2026-08-28.
 *
 * Every reader of this athlete's consent takes a lock on pilot.guardian_links
 * before deciding -- FOR SHARE in assertGuardianMediaConsentWithClient, FOR
 * UPDATE in publication.ts's suppression sweep and in
 * staffProvisioning.removeGuardianLink. The WRITE took none. It was a bare
 * pooled insert that committed on its own, so no lock any reader held could
 * order itself against it: a withdrawal committing between a reader's check
 * and its action was simply missed, and on the unlink path it was missed
 * PERMANENTLY -- the withdrawal recorded, the link deleted, and the guardian
 * who withdrew no longer counted at all.
 *
 * Now the write claims the same row the readers claim, and records the waiver
 * inside that transaction. Whichever side acquires first, the other waits and
 * then sees the committed result. There is no interleaving left in which a
 * withdrawal lands unseen.
 *
 * THE LOCK IS SCOPED TO ONE ROW -- this guardian, this athlete -- and that is
 * not tidiness. The sweep locks every guardian of one athlete; removeGuardianLink
 * locks the single row it deletes. A writer that locked a wider set than the
 * readers, or a different set, would give two transactions overlapping ranges
 * acquired in opposite orders, which is a deadlock waiting for load. One row,
 * matching the narrowest reader, cannot be half of a cycle.
 *
 * A MISSING LINK ROW DOES NOT BLOCK THE WRITE. `for update` over zero rows
 * locks nothing and returns; the waiver is still recorded. That is deliberate:
 * a guardian whose link is missing or already removed must still be able to
 * put their decision on file, and refusing to record a WITHDRAWAL because the
 * link is gone would be the platform losing a "no" for a bookkeeping reason.
 * The consent readers already treat an athlete with no guardian links as
 * unverifiable rather than consented, which is the fail-closed direction.
 *
 * BOTH WRITERS TAKE IT, not just the withdrawal. A grant that raced a
 * concurrent read would be lost the same way, and two writers to one table
 * with two different concurrency rules is how one of them later stops
 * matching the other.
 */
async function writeMediaConsentUnderLock(
  organizationId: string,
  athleteId: string,
  parentId: string,
  waiver: Omit<UpsertWaiverParams, 'organizationId' | 'athleteId' | 'waiverType' | 'parentId'>,
): Promise<string> {
  return withTransaction(async (client) => {
    await client.query(
      `select 1 from pilot.guardian_links
        where organization_id = $1 and parent_id = $2 and athlete_id = $3
        for update`,
      [organizationId, parentId, athleteId],
    );

    return upsertWaiverWithClient(client, {
      ...waiver,
      organizationId,
      athleteId,
      waiverType: MEDIA_CONSENT_WAIVER_TYPE,
      parentId,
    });
  });
}

export async function grantMediaConsent(params: {
  organizationId: string;
  athleteId: string;
  parentId: string;
  signedByName: string;
  coversVideo: boolean;
  publicUseAllowed: boolean;
  /* The guardian's own signed-in account. On this path the entrant and the
     signer really are the same person -- unlike intake, where a staff member
     enters what a guardian signed on paper -- but the column still records
     only the former, because that is the one thing it can mean everywhere. */
  recordedByAccountId: string;
}): Promise<string> {
  return writeMediaConsentUnderLock(params.organizationId, params.athleteId, params.parentId, {
    recordedByAccountId: params.recordedByAccountId,
    signedByName: params.signedByName,
    signedByRole: 'parent',
    signedAt: new Date().toISOString(),
    consentVersion: 'v1',
    status: 'signed',
    coversVideo: params.coversVideo,
    publicUseAllowed: params.publicUseAllowed,
  });
}

export async function withdrawMediaConsent(params: {
  organizationId: string;
  athleteId: string;
  parentId: string;
  signedByName: string;
  recordedByAccountId: string;
}): Promise<string> {
  return writeMediaConsentUnderLock(params.organizationId, params.athleteId, params.parentId, {
    recordedByAccountId: params.recordedByAccountId,
    signedByName: params.signedByName,
    signedByRole: 'parent',
    signedAt: new Date().toISOString(),
    consentVersion: 'v1',
    status: 'withdrawn',
    coversVideo: false,
    publicUseAllowed: false,
  });
}

// Every athlete this account guards, with a full per-guardian consent
// breakdown for each -- the shape the guardian-facing console renders
// directly. NOT the admin org-wide audit (see listOrganizationConsentStatus)
// -- this is viewer-scoped to one signed-in guardian's own children.
export async function listConsentForGuardian(
  organizationId: string,
  accountId: string,
): Promise<Array<{ athleteId: string; consent: ConsentCheckResult }>> {
  const athleteIds = await guardianAthleteIds(organizationId, accountId);
  const results = await Promise.all(
    athleteIds.map(async (athleteId) => ({
      athleteId,
      consent: await checkGuardianMediaConsent(organizationId, athleteId),
    })),
  );
  return results;
}

export interface ActingParent {
  parentId: string;
  fullName: string;
}

// The signed-in guardian's own parent row -- FOR THIS SPECIFIC ATHLETE. Round-8
// review finding: a first cut resolved "the account's first parent row" with
// no athlete scoping and no ORDER BY, which is wrong whenever one account
// backs more than one pilot.parents row (a real, schema-permitted shape --
// pilot.parents has no uniqueness constraint on account_id, only on
// (organization_id, parent_id)). Two different children linked through two
// different parent rows on the same account meant a grant/withdraw for child
// B could silently write under child A's parent_id -- passing this route's
// own authorization check (which only verifies athlete_id membership, not
// which parent row reaches it) while never actually touching the row
// checkGuardianMediaConsent(B) reads. The fix is to require the caller name
// the athlete; the actual join lives in guardianAccess.ts
// (guardianParentIdForAthlete) alongside every other viewer-scoped
// guardian_links join, per that module's own consolidation doctrine -- this
// is a thin re-export, not a second copy of the query.
export async function resolveActingParent(
  organizationId: string,
  accountId: string,
  athleteId: string,
): Promise<ActingParent | null> {
  return guardianParentIdForAthlete(organizationId, accountId, athleteId);
}

// The set of parent_ids this account backs, for the READ side (rendering
// "which of these guardian rows is you") -- membership-tested per row rather
// than picking a single "first" one, since a guardian of multiple children
// can legitimately be backed by different parent rows per child.
export async function callerParentIdSet(organizationId: string, accountId: string): Promise<Set<string>> {
  const parentIds = await guardianParentIds(organizationId, accountId);
  return new Set(parentIds);
}

export interface OrganizationConsentRow {
  athleteId: string;
  athleteName: string;
  consent: ConsentCheckResult;
}

// Admin-facing, org-wide: every athlete in the org WITH at least one
// guardian link, and their current consent status. Athletes with zero
// guardian_links rows are surfaced too (consent unverifiable is itself the
// finding an org-admin auditing this needs to see), listed separately by the
// caller rather than folded silently into "missing".
export async function listOrganizationConsentStatus(
  organizationId: string,
  page?: { limit: number; offset?: number },
): Promise<OrganizationConsentRow[]> {
  // page is opt-in and defaults to unbounded. This function backs the org-
  // wide consent AUDIT (see the route's own doc comment): a default cap
  // would silently drop athletes from the one screen whose entire purpose
  // is catching a missing or lapsed consent. Hiding the finding this route
  // exists to surface is worse than the query being slow -- a caller that
  // genuinely wants a bounded page opts in explicitly.
  const athletes = page
    ? await query<{ athlete_id: string; full_name: string }>(
        `select athlete_id, full_name from pilot.athletes
          where organization_id = $1 and deleted_at is null
          order by full_name asc limit $2 offset $3`,
        [organizationId, page.limit, page.offset ?? 0],
      )
    : await query<{ athlete_id: string; full_name: string }>(
        `select athlete_id, full_name from pilot.athletes
          where organization_id = $1 and deleted_at is null
          order by full_name asc`,
        [organizationId],
      );

  return Promise.all(
    athletes.map(async (athlete) => ({
      athleteId: athlete.athlete_id,
      athleteName: athlete.full_name,
      consent: await checkGuardianMediaConsent(organizationId, athlete.athlete_id),
    })),
  );
}
