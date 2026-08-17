// shadowJobQueue.ts — Recovery Round (Background Job System)
// PostgreSQL-backed async jobs with tenant, owner, and subject authorization.
// Schema is deployed from infra/azure; this module never creates or alters tables.

import { accessibleAthleteIds, assertActorCanAccessAthlete, isOrganizationAdminRole, type ActorIdentity } from './access';
import type { PilotRole } from './contracts';
import { query, queryOne } from './db';
import type { ShadowSessionType } from './shadowRouter';

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
    [jobType ?? null, JOB_LEASE_SECONDS],
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

export async function getJobsForActor(
  actor: ActorIdentity,
  requestedLimit = 20,
): Promise<JobStatusResult[]> {
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, 100))
    : 20;
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
     ORDER BY created_at DESC
     LIMIT $4`,
    [actor.organizationId, actor.accountId, actorCanReadAllOrgJobs(actor), limit],
  );

  const subjectIds = rows
    .map((row) => row.subject_id)
    .filter((subjectId): subjectId is string => subjectId !== null);
  const accessibleSubjectIds =
    subjectIds.length > 0 ? await accessibleAthleteIds(actor, subjectIds) : new Set<string>();

  return rows
    .filter((row) => actorCanAccessJobRow(actor, row, accessibleSubjectIds))
    .map((row) => toStatusResult(mapJobRow(row)));
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
