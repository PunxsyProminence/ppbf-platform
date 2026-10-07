// shadowJobQueue.ts — Recovery Round (Background Job System)
// PostgreSQL-backed async jobs with tenant, owner, and subject authorization.
// Schema is deployed from infra/azure; this module never creates or alters tables.

import { accessibleAthleteIds, assertActorCanAccessAthlete, isOrganizationAdminRole, type ActorIdentity } from './access';
import type { PilotRole } from './contracts';
import { query, queryOne } from './db';
import type { ShadowSessionType } from './shadowRouter';

/**
 * The version of the CONTEXT CONTRACT a job payload was written under.
 *
 * A background job does not re-derive the context it is answered from. The
 * enqueuing request assembles it, stores it on the row, and the worker reads
 * `payload.authorizedContext` at EXECUTION time -- possibly long after, and
 * possibly under code that assembles context by different rules. Nothing in
 * the payload recorded which rules applied, so a job written before a change
 * and executed after it was answered from the old context with no way for the
 * worker to know.
 *
 * That is not hypothetical. The near-miss audience gate (OD-2026-09-26-002, "Near-miss records are
 * coach and organization-admin chat context only")
 * removed athlete and parent access to recorded near-miss events in prompt
 * context; a Heavy Bag job enqueued before it and executed after would still
 * have carried those records into the answer, and the worker's allowed-role
 * set includes athlete and parent.
 *
 * BUMP THIS whenever a change alters WHAT GOES INTO `authorizedContext` for
 * any role. Jobs stamped with an older version -- and jobs carrying no stamp
 * at all, which means they were enqueued before this existed -- are refused
 * at execution rather than answered from stale context.
 *
 * The owner's instruction that produced it, 2026-09-26: "Nothing is real if
 * anything is waiting." A deploy-time queue check can only look once and
 * cannot see a job enqueued a second later; this makes the guarantee a
 * property of the payload instead of a property of timing.
 */
export const SHADOW_CONTEXT_CONTRACT_VERSION = 17;
// 5: #1176 -- Film Study analysis now also checks every tagged athlete's
// consent before enqueueing (shadow/video-analysis route).
// 6: Film Study's consent check moved to filmStudyConsent.ts: photo-only and
// withdrawn consent of the video's own athlete now refuse too, and the worker
// re-checks at run time. A v5 job still queued at deploy is refused as STALE.
// 7: source rights (A2 of #1238): shadowLibrary.ts gained write-side columns
// (rights_status, text_kind, excerpt_locator) and a rights update. What goes
// into authorizedContext is unchanged; bumped because a listed file moved. A v6
// job still queued at deploy is refused as STALE.
// 8: source-rights P0 (#1258): createShadowLibrarySource/Document refuse
// importer-only provenance metadata keys. What goes into authorizedContext is
// unchanged; bumped because a listed file moved. A v7 job still queued at
// deploy is refused as STALE.
// 9: research export (#1272, CL-C3): createShadowLibraryChunk resets the
// document and inserts the chunk in one transaction, and the bridge export
// reads source rights. What goes into authorizedContext is unchanged; bumped
// because a listed file moved. A v8 job still queued at deploy is refused as
// STALE.
// 10: SHADOW filters (CL-C7/C8/C10): shadowChat.ts's response filter catches
// more diagnostic and prescriptive phrasings, and an answer that passed no
// longer asks for a review row. What goes into authorizedContext is
// unchanged; bumped because a listed file moved. A v9 job still queued at
// deploy is refused as STALE. (#1267 also claims 10; whichever merges second
// re-bumps to 11.)
// 11: owner role/read-scope rulings (#1267, re-bumped after #1288 took 10; OD-2026-10-05-024 ruling 3):
// canReviewChatSafetyTelemetry is organization admins only, no longer
// platform_owner. What goes into authorizedContext is unchanged; bumped
// because a listed file moved. A v10 job still queued at deploy is refused as
// STALE.
// 13: Library claims (CL-C15): ensureClaimResearchRequirement finds the open
// duplicate in SQL and keys new rows with a random id. What goes into
// authorizedContext is unchanged; bumped because a listed file moved. A v12 job still queued at deploy is
// refused as STALE.
// 14: Library search (CL-C13, #1283): semantic search ranks every embedded
// chunk in keyset batches instead of the first 200 by tier and age; the
// empty-Library check counts gym-wide chunks only (CL-C21). What goes into
// authorizedContext is unchanged; bumped because a listed file moved. A v13
// job still queued at deploy is refused as STALE.
// 15: SHADOW emergency phrases: collapsed, unresponsive, won't wake up, not
// breathing and "cant" reach the existing emergency response (shadowChat.ts
// request patterns). What goes into authorizedContext is unchanged; bumped
// because a listed file moved. A v14 job still queued at deploy is refused as
// STALE.
// 16: #1036 ordering: shadowChat.ts's request validator answers an emergency
// before any other return (educational framing, prescription or weight-cut
// language, clearance, an earlier topic row), and an emergency about a
// specific someone else gets the emergency line. What goes into
// authorizedContext is unchanged; bumped because a listed file moved. A v15
// job still queued at deploy is refused as STALE.
// 17: the Library's per-source excerpt budget (shadowLibrary.ts, CL-C2): a source
// that is not owned or open-licence refuses chunks past 10 / 15,000 characters.
// What goes into authorizedContext is unchanged; bumped because a listed file
// moved. A v16 job still queued at deploy is refused as STALE.
// 3: the first bump made by the fingerprint below -- #1133, #1132 and
// others changed watched files after v2 was recorded.
// 2 was BUMPED for the near-miss
// audience gate. It should have been bumped BY that change and was not: #975
// altered what goes into `authorizedContext` for athlete and parent -- exactly
// the trigger named above -- and touched only shadowChat.ts, its test and two
// documents. The stamp had merged four hours earlier, so between the two
// merges jobs were enqueued stamped 1 carrying pre-gate context, and a worker
// also at 1 accepted them. The mechanism was correct and nobody pulled the
// lever, which is the failure mode of any guard whose arming is a separate
// human step.
//
// The owner chose to close that (OD-2026-09-30-007 section 2, S3 "A"): the
// lever is now pulled by CI. shadowContextContract.test.ts hashes the files
// below and fails until the version is bumped and a new entry is appended to
// SHADOW_CONTEXT_CONTRACT_FINGERPRINTS. The number itself stays a number, not
// the hash: the worker needs ORDER (older = stale and failed, newer = the
// worker is behind and retries; shadowJobProcessor.ts), and a hash has none.
//
// A bump costs only jobs queued across that deploy, and the production deploy
// already refuses to run while any are waiting. So when in doubt, bump: a
// comment-only edit to a listed file still trips the test, on purpose.

/**
 * The files whose code decides what goes into `authorizedContext`, repo
 * paths relative to apps/web. Add a file here when it starts shaping that
 * string; access.ts is deliberately absent (it guards who may ask, not what
 * the context says, and changes too often to bump on).
 */
export const SHADOW_CONTEXT_CONTRACT_SOURCES: readonly string[] = [
  'app/api/pilot/shadow/chat/route.ts',
  'app/api/pilot/shadow/video-analysis/route.ts',
  'src/server/pilot/libraryServability.ts',
  'src/server/pilot/omegaPlatformContext.ts',
  'src/server/pilot/platformLibraryScope.ts',
  'src/server/pilot/shadowChat.ts',
  'src/server/pilot/shadowChatCapabilities.ts',
  'src/server/pilot/shadowContextBuilder.ts',
  'src/server/pilot/shadowContextWeights.ts',
  'src/server/pilot/shadowEvidence.ts',
  'src/server/pilot/shadowHeavyBag.ts',
  'src/server/pilot/shadowLibrary.ts',
  'src/server/pilot/shadowNearMisses.ts',
  'src/server/pilot/shadowPersonalizationGate.ts',
  'src/server/pilot/shadowRoleSets.ts',
  'src/server/pilot/shadowUnlocks.ts',
];

/**
 * Append-only: one entry per version, the SHA-256 of the sources above at
 * that version (see shadowContextContract.test.ts for the exact recipe).
 * Never edit an existing entry -- bump the version and append.
 */
export const SHADOW_CONTEXT_CONTRACT_FINGERPRINTS: readonly { version: number; sha256: string }[] = [
  { version: 2, sha256: '7ae5ffd399407dbd80638f016239074db05387891d96c74c45d5084590f37389' },
  { version: 3, sha256: 'f5b4fe633606652fcec80021320b447abc2b804892de8eadafa18353263bfbba' },
  { version: 4, sha256: '96a1b13e85dd86f79546492dfe5cce1e4f47502c72840b1f07ca1acd9a826515' },
  { version: 5, sha256: '2b1b58ad308fa5c48ae6b4b65f86bd244ccc701a1d20fbe5d565151609a03d86' },
  { version: 6, sha256: '7b72dd1cb1e006c967fe36cc06de53bd5d9d10b60bf6858e3d2f6c345cb3668a' },
  { version: 7, sha256: '89b51b15eaa9c8c93dad39df694b1fe55f312eea897964ba868a733f221fdfb2' },
  { version: 8, sha256: 'b85aec5f0ba1997dd8858b2dde3d9f9903f39a7c7e3fcccad5052616885fcb2b' },
  { version: 9, sha256: 'a212014dfeeced705d843be036e03384357cad75ee9bccea0ceaefb0a788dcf6' },
  { version: 10, sha256: '931ddb2d93063c18bade41f7035e4c085060f9464c04c2e8e63ec77540f1b2f0' },
  { version: 11, sha256: '309eaf2f0b964f712ec52e3a86f2f68f239d71a3f79a2e2ba86f0e48f96482eb' },
  { version: 12, sha256: '02ca4b2140ab238fa06755fb45fdb91909bec81b0b524674540c3f3f453e75da' },
  { version: 13, sha256: '435b25f37584181cef0745ba007e81d6d94713db6a6f870468247cb2fa043065' },
  { version: 14, sha256: 'd0b7e589980df7e8c6025baed7ecf3b3b03212461f9078c58f46c8b9c20c8608' },
  { version: 15, sha256: '4d19cdd8ad71091f373e5cfeef8750cfc93d011f5bdb3a7e85d7e95aba4d05be' },
  { version: 16, sha256: '4f6d0ba64c024bfe8ccabe6c59e36e724111bd91ae9366c412ac50047c74b4b4' },
  { version: 17, sha256: 'f25ed1d7e0c0b72d57d1877bbf294c73ba74b94b75906bd555a50dc362d61dca' },
];

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type JobType =
  | 'heavy_bag_session'
  | 'scout_report'
  | 'board_summary'
  | 'library_update'
  | 'film_study'
  | 'learning_loop';

export type JobSafetyStatus = 'pending' | 'passed' | 'filtered' | 'not_applicable';

export interface ShadowJob {
  jobId: string;
  jobType: JobType;
  organizationId: string;
  accountId: string;
  subjectId: string | null;
  role: PilotRole;
  status: JobStatus;
  inputPayload: Record<string, unknown>;
  outputPayload: Record<string, unknown> | null;
  errorCode: string | null;
  safetyStatus: JobSafetyStatus;
  priority: number;
  retryCount: number;
  maxRetries: number;
  leaseToken: string;
  leaseExpiresAt: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string;
}

export interface CreateJobInput {
  jobType: JobType;
  organizationId: string;
  accountId: string;
  subjectId?: string | null;
  role: PilotRole;
  inputPayload: Record<string, unknown>;
  priority?: number;
  ttlHours?: number;
}

export interface JobStatusResult {
  jobId: string;
  status: JobStatus;
  sessionType: ShadowSessionType;
  subjectId: string | null;
  safetyStatus: JobSafetyStatus;
  output?: Record<string, unknown> | null;
  error?: string | null;
  createdAt: string;
  completedAt?: string | null;
}

interface ShadowJobRow {
  job_id: string;
  job_type: JobType;
  organization_id: string;
  account_id: string;
  subject_id: string | null;
  role: PilotRole;
  status: JobStatus;
  input_payload: Record<string, unknown>;
  output_payload: Record<string, unknown> | null;
  error_message: string | null;
  safety_status: JobSafetyStatus;
  priority: number;
  retry_count: number;
  max_retries: number;
  lease_token: string;
  lease_expires_at: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string;
}

interface JobAccessRow {
  job_id: string;
  job_type: JobType;
  account_id: string;
  subject_id: string | null;
}

const MAX_JOB_PAYLOAD_BYTES = 100_000;
const JOB_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,79}$/;
// Must exceed worst-case job execution or completion itself fails: the
// provider call alone may run to its 120s timeout, and completeJob/failJob
// both require a live lease -- at exactly 120 a full-length generation
// appended its answer, lost the lease, threw on completion, and the
// stale_running re-queue regenerated it into the same conversation up to
// max_retries times. 300 = provider ceiling + validation/persistence
// overhead with a wide margin; the stale-claim CTE still reclaims a
// genuinely dead worker's job 5 minutes later.
const JOB_LEASE_SECONDS = 300;
const OWNER_ONLY_JOB_TYPES = new Set<JobType>(['heavy_bag_session', 'scout_report']);

export function normalizeJobTtlHours(ttlHours: number | undefined): number {
  if (ttlHours === undefined) return 24;
  if (!Number.isFinite(ttlHours)) throw new Error('Job TTL must be a finite number');
  return Math.min(168, Math.max(1, Math.trunc(ttlHours)));
}

export function normalizeJobPriority(priority: number | undefined): number {
  if (priority === undefined) return 3;
  if (!Number.isFinite(priority)) throw new Error('Job priority must be a finite number');
  return Math.min(5, Math.max(1, Math.trunc(priority)));
}

function serializeJobPayload(payload: Record<string, unknown>): string {
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_JOB_PAYLOAD_BYTES) {
    throw new Error('Job payload exceeds the allowed size');
  }
  return serialized;
}

function sanitizeJobErrorCode(errorCode: string): string {
  return JOB_ERROR_CODE.test(errorCode) ? errorCode : 'SHADOW_JOB_EXECUTION_FAILED';
}

function mapJobRow(row: ShadowJobRow): ShadowJob {
  return {
    jobId: row.job_id,
    jobType: row.job_type,
    organizationId: row.organization_id,
    accountId: row.account_id,
    subjectId: row.subject_id,
    role: row.role,
    status: row.status,
    inputPayload: row.input_payload ?? {},
    outputPayload: row.output_payload,
    errorCode: row.error_message,
    safetyStatus: row.safety_status,
    priority: row.priority,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
  };
}

function toStatusResult(job: ShadowJob): JobStatusResult {
  return {
    jobId: job.jobId,
    status: job.status,
    sessionType: jobTypeToSessionType(job.jobType),
    subjectId: job.subjectId,
    safetyStatus: job.safetyStatus,
    output: job.status === 'completed' ? job.outputPayload : null,
    // Cancelled jobs carry their reason too (SHADOW_JOB_EXPIRED et al.);
    // hiding it rendered a bare "cancelled" chip with no explanation
    // (audit 2026-07-31 finding B3).
    error: job.status === 'failed' || job.status === 'cancelled' ? job.errorCode : null,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
  };
}

function actorCanReadAllOrgJobs(actor: ActorIdentity): boolean {
  return isOrganizationAdminRole(actor.role);
}

async function actorCanAccessJob(actor: ActorIdentity, job: JobAccessRow): Promise<boolean> {
  const isOwner = job.account_id === actor.accountId;
  if (!isOwner && OWNER_ONLY_JOB_TYPES.has(job.job_type)) {
    return false;
  }
  if (!isOwner && !actorCanReadAllOrgJobs(actor)) {
    return false;
  }

  if (!job.subject_id) {
    return true;
  }

  try {
    await assertActorCanAccessAthlete(actor, job.subject_id);
    return true;
  } catch {
    return false;
  }
}

// Same predicate as actorCanAccessJob, but takes the subject's accessibility
// as a precomputed fact rather than awaiting it per row -- getJobsForActor
// batches accessibleAthleteIds() once for the whole page instead of calling
// actorCanAccessJob (and therefore assertActorCanAccessAthlete) per row,
// which for a full page of subject-bearing jobs was up to 2 sequential
// round trips per row (coach primary-assignment check, then a coverage
// check on miss).
function actorCanAccessJobRow(
  actor: ActorIdentity,
  job: JobAccessRow,
  accessibleSubjectIds: ReadonlySet<string>,
): boolean {
  const isOwner = job.account_id === actor.accountId;
  if (!isOwner && OWNER_ONLY_JOB_TYPES.has(job.job_type)) {
    return false;
  }
  if (!isOwner && !actorCanReadAllOrgJobs(actor)) {
    return false;
  }

  if (!job.subject_id) {
    return true;
  }

  return accessibleSubjectIds.has(job.subject_id);
}

export async function enqueueJob(input: CreateJobInput): Promise<string> {
  if (!input.organizationId.trim() || !input.accountId.trim()) {
    throw new Error('Job requires an organization-scoped owner');
  }

  const ttlHours = normalizeJobTtlHours(input.ttlHours);
  const priority = normalizeJobPriority(input.priority);
  const payload = serializeJobPayload(input.inputPayload);

  const row = await queryOne<{ job_id: string }>(
    `INSERT INTO pilot.shadow_jobs (
       job_type, organization_id, account_id, subject_id, role,
       status, input_payload, priority, retry_count, max_retries,
       safety_status, created_at, updated_at, expires_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       'pending', $6::jsonb, $7, 0, 3,
       'pending', NOW(), NOW(), NOW() + ($8 * INTERVAL '1 hour')
     )
     RETURNING job_id`,
    [
      input.jobType,
      input.organizationId,
      input.accountId,
      input.subjectId ?? null,
      input.role,
      payload,
      priority,
      ttlHours,
    ],
  );

  if (!row) throw new Error('Failed to create job');
  return row.job_id;
}

// Terminal rows are not history the product reads -- completed output is
// adopted into the conversation at poll time, and failed/cancelled rows only
// matter while someone might still ask about them. Before this sweep existed
// nothing ever deleted them, so output payloads and up to 12k chars of
// authorized context in input_payload outlived their declared TTLs
// indefinitely (audit 2026-07-31 finding B2; owner decision: 30 days).
export const TERMINAL_JOB_RETENTION_DAYS = 30;

export async function purgeTerminalShadowJobs(): Promise<number> {
  const rows = await query<{ job_id: string }>(
    `DELETE FROM pilot.shadow_jobs
     WHERE status IN ('completed', 'failed', 'cancelled')
       AND COALESCE(completed_at, updated_at, created_at) < NOW() - ($1 * INTERVAL '1 day')
     RETURNING job_id`,
    [TERMINAL_JOB_RETENTION_DAYS],
  );
  return rows.length;
}

export async function getJobStatusForActor(
  jobId: string,
  actor: ActorIdentity,
): Promise<JobStatusResult | null> {
  const accessRow = await queryOne<JobAccessRow>(
    `SELECT job_id, job_type, account_id, subject_id
     FROM pilot.shadow_jobs
     WHERE job_id = $1 AND organization_id = $2`,
    [jobId, actor.organizationId],
  );

  if (!accessRow || !(await actorCanAccessJob(actor, accessRow))) {
    return null;
  }

  const row = await queryOne<ShadowJobRow>(
    `SELECT job_id, job_type, organization_id, account_id, subject_id, role,
            status, input_payload, output_payload, error_message, safety_status,
            priority, retry_count, max_retries, lease_token, lease_expires_at,
            created_at, started_at,
            completed_at, expires_at
     FROM pilot.shadow_jobs
     WHERE job_id = $1 AND organization_id = $2`,
    [jobId, actor.organizationId],
  );

  return row ? toStatusResult(mapJobRow(row)) : null;
}

export async function claimNextJob(jobType?: JobType): Promise<ShadowJob | null> {
  const row = await queryOne<ShadowJobRow>(
    `WITH expired_pending AS (
       UPDATE pilot.shadow_jobs
       SET status = 'cancelled',
           input_payload = '{}'::jsonb,
           output_payload = NULL,
           error_message = 'SHADOW_JOB_EXPIRED',
           safety_status = 'not_applicable',
           completed_at = NOW(),
           lease_token = NULL,
           lease_expires_at = NULL,
           updated_at = NOW()
       WHERE status = 'pending'
         AND expires_at <= NOW()
     ),
     stale_running AS (
       UPDATE pilot.shadow_jobs
       SET status = CASE
             WHEN retry_count + 1 >= max_retries THEN 'failed'
             ELSE 'pending'
           END,
           retry_count = retry_count + 1,
           input_payload = CASE
             WHEN retry_count + 1 >= max_retries THEN '{}'::jsonb
             ELSE input_payload
           END,
           output_payload = NULL,
           error_message = 'SHADOW_JOB_LEASE_EXPIRED',
           safety_status = CASE
             WHEN retry_count + 1 >= max_retries THEN 'not_applicable'
             ELSE 'pending'
           END,
           started_at = NULL,
           completed_at = CASE
             WHEN retry_count + 1 >= max_retries THEN NOW()
             ELSE NULL
           END,
           lease_token = NULL,
           lease_expires_at = NULL,
           updated_at = NOW()
       WHERE status = 'running'
         AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
     ),
     next_job AS (
       SELECT job_id
       FROM pilot.shadow_jobs
       WHERE status = 'pending'
         AND expires_at > NOW()
         AND retry_count < max_retries
         AND ($1::text IS NULL OR job_type = $1)
         -- A job stamped by a NEWER context contract is left for a worker
         -- that runs it (audit CL-C17). During a rollout the old revision's
         -- worker is still polling; claiming such a job made the processor
         -- fail it as CONTRACT_AHEAD, each failure spent a retry, and the
         -- third wiped input_payload, so the question was never answered.
         -- CASE, not AND: Postgres does not promise to short-circuit AND, and
         -- the cast must only see a JSON number. Unstamped jobs still claim.
         AND CASE
           WHEN jsonb_typeof(input_payload -> 'contextContractVersion') = 'number'
             THEN (input_payload ->> 'contextContractVersion')::numeric <= $3
           ELSE TRUE
         END
       ORDER BY priority ASC, created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE pilot.shadow_jobs AS jobs
     SET status = 'running',
         started_at = NOW(),
         updated_at = NOW(),
         error_message = NULL,
         lease_token = gen_random_uuid(),
         lease_expires_at = NOW() + ($2 * INTERVAL '1 second')
     FROM next_job
     WHERE jobs.job_id = next_job.job_id
     -- Every column is qualified with the jobs alias, and must stay that way.
     -- Unqualified job_id is ambiguous here -- next_job has one too -- and
     -- Postgres rejects the whole statement with
     --   42702: column reference "job_id" is ambiguous
     -- That made claimNextJob throw on every call, so the worker logged
     -- "tick failed { errorClass: 'error' }" once per interval and never
     -- claimed a job; the background queue had never processed anything.
     -- Reproduced against the staging database in a rolled-back transaction:
     -- unqualified raises 42702, qualified claims a real pending job.
     --
     -- Two things hid it. The worker logs error.name only, and
     -- node-postgres sets DatabaseError.name to the lowercase string 'error',
     -- so a SQL fault renders identically to a generic catch-all. And the
     -- handler's own comment assumes it means "the database being
     -- unreachable", which sent diagnosis the wrong way.
     --
     -- The non-key columns are qualified too: they are unambiguous only
     -- because next_job selects a single column, and widening that CTE later
     -- must not silently break the claim again.
     RETURNING jobs.job_id, jobs.job_type, jobs.organization_id, jobs.account_id,
               jobs.subject_id, jobs.role, jobs.status, jobs.input_payload,
               jobs.output_payload, jobs.error_message, jobs.safety_status,
               jobs.priority, jobs.retry_count, jobs.max_retries, jobs.lease_token,
               jobs.lease_expires_at, jobs.created_at, jobs.started_at,
               jobs.completed_at, jobs.expires_at`,
    [jobType ?? null, JOB_LEASE_SECONDS, SHADOW_CONTEXT_CONTRACT_VERSION],
  );

  return row ? mapJobRow(row) : null;
}

export async function completeJob(
  job: Pick<ShadowJob, 'jobId' | 'organizationId' | 'accountId' | 'leaseToken'>,
  output: Record<string, unknown>,
  safetyStatus: Exclude<JobSafetyStatus, 'pending'>,
): Promise<void> {
  const result = await queryOne<{ job_id: string }>(
    `UPDATE pilot.shadow_jobs
     SET status = 'completed',
         output_payload = $5::jsonb,
         input_payload = '{}'::jsonb,
         safety_status = $6,
         error_message = NULL,
         completed_at = NOW(),
         lease_token = NULL,
         lease_expires_at = NULL,
         updated_at = NOW()
     WHERE job_id = $1
       AND organization_id = $2
       AND account_id = $3
       AND status = 'running'
       AND lease_token = $4::uuid
       AND lease_expires_at > NOW()
     RETURNING job_id`,
    [
      job.jobId,
      job.organizationId,
      job.accountId,
      job.leaseToken,
      serializeJobPayload(output),
      safetyStatus,
    ],
  );

  if (!result) {
    throw new Error('Job completion rejected because the claimed job no longer matches');
  }
}

export async function failJob(
  job: Pick<ShadowJob, 'jobId' | 'organizationId' | 'accountId' | 'leaseToken'>,
  errorCode: string,
  options: Readonly<{ retryable?: boolean }> = {},
): Promise<void> {
  const retryable = options.retryable !== false;
  const result = await queryOne<{ job_id: string }>(
    `UPDATE pilot.shadow_jobs
     SET
       status = CASE
         WHEN NOT $6::boolean OR retry_count + 1 >= max_retries THEN 'failed'
         ELSE 'pending'
       END,
       retry_count = retry_count + 1,
       error_message = $5,
       input_payload = CASE
         WHEN NOT $6::boolean OR retry_count + 1 >= max_retries THEN '{}'::jsonb
         ELSE input_payload
       END,
       output_payload = NULL,
       safety_status = CASE
         WHEN NOT $6::boolean OR retry_count + 1 >= max_retries THEN 'not_applicable'
         ELSE 'pending'
       END,
       started_at = NULL,
       completed_at = CASE
         WHEN NOT $6::boolean OR retry_count + 1 >= max_retries THEN NOW()
         ELSE NULL
       END,
       lease_token = NULL,
       lease_expires_at = NULL,
       updated_at = NOW()
     WHERE job_id = $1
       AND organization_id = $2
       AND account_id = $3
       AND status = 'running'
       AND lease_token = $4::uuid
       AND lease_expires_at > NOW()
     RETURNING job_id`,
    [
      job.jobId,
      job.organizationId,
      job.accountId,
      job.leaseToken,
      sanitizeJobErrorCode(errorCode),
      retryable,
    ],
  );

  if (!result) {
    throw new Error('Job failure rejected because the claimed lease is no longer active');
  }
}

export async function cancelJobForActor(jobId: string, actor: ActorIdentity): Promise<boolean> {
  const accessRow = await queryOne<JobAccessRow>(
    `SELECT job_id, job_type, account_id, subject_id
     FROM pilot.shadow_jobs
     WHERE job_id = $1 AND organization_id = $2`,
    [jobId, actor.organizationId],
  );
  if (!accessRow || !(await actorCanAccessJob(actor, accessRow))) {
    return false;
  }

  const result = await queryOne<{ job_id: string }>(
    `UPDATE pilot.shadow_jobs
     SET status = 'cancelled',
         input_payload = '{}'::jsonb,
         output_payload = NULL,
         safety_status = 'not_applicable',
         lease_token = NULL,
         lease_expires_at = NULL,
         updated_at = NOW(),
         completed_at = NOW()
     WHERE job_id = $1
       AND organization_id = $2
       AND status = 'pending'
     RETURNING job_id`,
    [jobId, actor.organizationId],
  );

  return result !== null;
}

// Upper bound on rows one job listing reads while filling its page, and the
// rows read per query, so a small page does not mean hundreds of round trips.
export const JOB_LIST_MAX_SCANNED_ROWS = 500;
export const JOB_LIST_BATCH_ROWS = 100;

export async function getJobsForActor(
  actor: ActorIdentity,
  requestedLimit = 20,
): Promise<JobStatusResult[]> {
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, 100))
    : 20;
  const canReadAllOrgJobs = actorCanReadAllOrgJobs(actor);
  const results: JobStatusResult[] = [];
  const seenJobIds = new Set<string>();

  // The athlete-access filter runs here, after SQL, so a page cut at `limit`
  // in SQL came back short whenever some of its rows were athletes this
  // actor cannot reach (audit CL-C23). Read batch after batch until the page
  // is full or the rows run out, capped so one listing cannot walk the
  // whole table. job_id breaks created_at ties so the order is total; a job
  // enqueued between batches shifts OFFSET by one and would repeat the last
  // row read, so rows already seen are skipped.
  for (let offset = 0; offset < JOB_LIST_MAX_SCANNED_ROWS; offset += JOB_LIST_BATCH_ROWS) {
    const rows = await query<ShadowJobRow>(
      `SELECT job_id, job_type, organization_id, account_id, subject_id, role,
              status, input_payload, output_payload, error_message, safety_status,
              priority, retry_count, max_retries, lease_token, lease_expires_at,
              created_at, started_at,
              completed_at, expires_at
       FROM pilot.shadow_jobs
       WHERE organization_id = $1
         AND (
           account_id = $2
           OR (
             $3::boolean
             AND job_type NOT IN ('heavy_bag_session', 'scout_report')
           )
         )
       ORDER BY created_at DESC, job_id DESC
       LIMIT $4 OFFSET $5`,
      [actor.organizationId, actor.accountId, canReadAllOrgJobs, JOB_LIST_BATCH_ROWS, offset],
    );

    const subjectIds = rows
      .map((row) => row.subject_id)
      .filter((subjectId): subjectId is string => subjectId !== null);
    const accessibleSubjectIds =
      subjectIds.length > 0 ? await accessibleAthleteIds(actor, subjectIds) : new Set<string>();

    for (const row of rows) {
      if (seenJobIds.has(row.job_id)) continue;
      seenJobIds.add(row.job_id);
      if (!actorCanAccessJobRow(actor, row, accessibleSubjectIds)) continue;
      results.push(toStatusResult(mapJobRow(row)));
      if (results.length === limit) return results;
    }
    if (rows.length < JOB_LIST_BATCH_ROWS) break;
  }

  return results;
}

function jobTypeToSessionType(jobType: JobType): ShadowSessionType {
  const map: Record<JobType, ShadowSessionType> = {
    heavy_bag_session: 'heavy_bag',
    scout_report: 'scout_report',
    board_summary: 'board_summary',
    library_update: 'recovery_round',
    film_study: 'film_study',
    learning_loop: 'recovery_round',
  };
  return map[jobType] ?? 'recovery_round';
}
