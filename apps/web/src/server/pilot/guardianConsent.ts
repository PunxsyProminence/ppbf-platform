import { query } from './db';
import { guardianAthleteIds, guardianParentIdForAthlete, guardianParentIds } from './guardianAccess';
import { upsertWaiver } from './intake';

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
 *   - Does not retroactively touch an already-published video when a
 *     guardian later withdraws. Blocks future approvals only.
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
  const missingParentIds = perGuardian.filter((g) => g.status !== 'signed').map((g) => g.parentId);

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
  const guardianResult = await client.query<{ parent_id: string }>(
    `select parent_id from pilot.guardian_links where organization_id = $1 and athlete_id = $2`,
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
  const missingParentIds = guardianIds.filter((id) => current.get(id)?.status !== 'signed');
  if (missingParentIds.length > 0) {
    throw new GuardianConsentMissingError(athleteId, missingParentIds);
  }
}

export async function grantMediaConsent(params: {
  organizationId: string;
  athleteId: string;
  parentId: string;
  signedByName: string;
  coversVideo: boolean;
  publicUseAllowed: boolean;
}): Promise<string> {
  return upsertWaiver({
    organizationId: params.organizationId,
    athleteId: params.athleteId,
    waiverType: MEDIA_CONSENT_WAIVER_TYPE,
    signedByName: params.signedByName,
    signedByRole: 'parent',
    signedAt: new Date().toISOString(),
    consentVersion: 'v1',
    status: 'signed',
    parentId: params.parentId,
    coversVideo: params.coversVideo,
    publicUseAllowed: params.publicUseAllowed,
  });
}

export async function withdrawMediaConsent(params: {
  organizationId: string;
  athleteId: string;
  parentId: string;
  signedByName: string;
}): Promise<string> {
  return upsertWaiver({
    organizationId: params.organizationId,
    athleteId: params.athleteId,
    waiverType: MEDIA_CONSENT_WAIVER_TYPE,
    signedByName: params.signedByName,
    signedByRole: 'parent',
    signedAt: new Date().toISOString(),
    consentVersion: 'v1',
    status: 'withdrawn',
    parentId: params.parentId,
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
export async function listOrganizationConsentStatus(organizationId: string): Promise<OrganizationConsentRow[]> {
  const athletes = await query<{ athlete_id: string; full_name: string }>(
    `select athlete_id, full_name from pilot.athletes where organization_id = $1 order by full_name asc`,
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
