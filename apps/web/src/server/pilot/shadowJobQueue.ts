// shadowJobQueue.ts — Recovery Round (Background Job System)
// PostgreSQL-backed async jobs with tenant, owner, and subject authorization.
// Schema is deployed from infra/azure; this module never creates or alters tables.

import { assertActorCanAccessAthlete, isOrganizationAdminRole, type ActorIdentity } from './access';
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
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string;
}

interface JobAccessRow {
  job_id: string;
  account_id: string;
  subject_id: string | null;
}

const MAX_JOB_PAYLOAD_BYTES = 100_000;
const JOB_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,79}$/;

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
    error: job.status === 'failed' ? job.errorCode : null,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
  };
}

function actorCanReadAllOrgJobs(actor: ActorIdentity): boolean {
  return isOrganizationAdminRole(actor.role);
}

async function actorCanAccessJob(actor: ActorIdentity, job: JobAccessRow): Promise<boolean> {
  if (job.account_id !== actor.accountId && !actorCanReadAllOrgJobs(actor)) {
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

export async function getJobStatusForActor(
  jobId: string,
  actor: ActorIdentity,
): Promise<JobStatusResult | null> {
  const accessRow = await queryOne<JobAccessRow>(
    `SELECT job_id, account_id, subject_id
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
            priority, retry_count, max_retries, created_at, started_at,
            completed_at, expires_at
     FROM pilot.shadow_jobs
     WHERE job_id = $1 AND organization_id = $2`,
    [jobId, actor.organizationId],
  );

  return row ? toStatusResult(mapJobRow(row)) : null;
}

export async function claimNextJob(jobType?: JobType): Promise<ShadowJob | null> {
  const row = await queryOne<ShadowJobRow>(
    `UPDATE pilot.shadow_jobs
     SET status = 'running', started_at = NOW(), updated_at = NOW(),
         error_message = NULL
     WHERE job_id = (
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
     RETURNING job_id, job_type, organization_id, account_id, subject_id, role,
               status, input_payload, output_payload, error_message, safety_status,
               priority, retry_count, max_retries, created_at, started_at,
               completed_at, expires_at`,
    [jobType ?? null],
  );

  return row ? mapJobRow(row) : null;
}

export async function completeJob(
  job: Pick<ShadowJob, 'jobId' | 'organizationId' | 'accountId'>,
  output: Record<string, unknown>,
  safetyStatus: Exclude<JobSafetyStatus, 'pending'>,
): Promise<void> {
  const result = await queryOne<{ job_id: string }>(
    `UPDATE pilot.shadow_jobs
     SET status = 'completed',
         output_payload = $4::jsonb,
         input_payload = '{}'::jsonb,
         safety_status = $5,
         error_message = NULL,
         completed_at = NOW(),
         updated_at = NOW()
     WHERE job_id = $1
       AND organization_id = $2
       AND account_id = $3
       AND status = 'running'
     RETURNING job_id`,
    [job.jobId, job.organizationId, job.accountId, serializeJobPayload(output), safetyStatus],
  );

  if (!result) {
    throw new Error('Job completion rejected because the claimed job no longer matches');
  }
}

export async function failJob(
  job: Pick<ShadowJob, 'jobId' | 'organizationId' | 'accountId'>,
  errorCode: string,
): Promise<void> {
  await query(
    `UPDATE pilot.shadow_jobs
     SET
       status = CASE
         WHEN retry_count + 1 >= max_retries THEN 'failed'
         ELSE 'pending'
       END,
       retry_count = retry_count + 1,
       error_message = $4,
       input_payload = CASE
         WHEN retry_count + 1 >= max_retries THEN '{}'::jsonb
         ELSE input_payload
       END,
       output_payload = NULL,
       safety_status = 'pending',
       started_at = NULL,
       completed_at = CASE
         WHEN retry_count + 1 >= max_retries THEN NOW()
         ELSE NULL
       END,
       updated_at = NOW()
     WHERE job_id = $1
       AND organization_id = $2
       AND account_id = $3
       AND status = 'running'`,
    [job.jobId, job.organizationId, job.accountId, sanitizeJobErrorCode(errorCode)],
  );
}

export async function cancelJobForActor(jobId: string, actor: ActorIdentity): Promise<boolean> {
  const accessRow = await queryOne<JobAccessRow>(
    `SELECT job_id, account_id, subject_id
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
            priority, retry_count, max_retries, created_at, started_at,
            completed_at, expires_at
     FROM pilot.shadow_jobs
     WHERE organization_id = $1
       AND (account_id = $2 OR $3::boolean)
     ORDER BY created_at DESC
     LIMIT $4`,
    [actor.organizationId, actor.accountId, actorCanReadAllOrgJobs(actor), limit],
  );

  const visible: JobStatusResult[] = [];
  for (const row of rows) {
    if (await actorCanAccessJob(actor, row)) {
      visible.push(toStatusResult(mapJobRow(row)));
    }
  }
  return visible;
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
