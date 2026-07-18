// shadowJobQueue.ts — Recovery Round (Background Job System)
// Manages async SHADOW jobs: heavy bag sessions, scout reports, library updates.
// Uses PostgreSQL as the job store (no additional infrastructure needed).
// Jobs are picked up by a polling API route or a future Azure Function trigger.

import { query, queryOne } from './db';
import type { ShadowSessionType } from './shadowRouter';
import type { PilotRole } from './contracts';

// ─── Job Types ────────────────────────────────────────────────────────────────

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type JobType =
  | 'heavy_bag_session'     // Deep reasoning for a complex user query
  | 'scout_report'          // Generate user intelligence report
  | 'board_summary'         // Governance/compliance summary
  | 'library_update'        // Refresh The Playbook entries
  | 'film_study'            // Video technique analysis (future)
  | 'learning_loop';        // Process feedback → update profile

export interface ShadowJob {
  jobId: string;             // UUID
  jobType: JobType;
  organizationId: string;
  accountId: string;
  role: PilotRole;
  status: JobStatus;
  inputPayload: Record<string, unknown>;
  outputPayload?: Record<string, unknown> | null;
  errorMessage?: string | null;
  priority: number;          // 1 (high) – 5 (low)
  retryCount: number;
  maxRetries: number;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  expiresAt: string;         // Auto-delete after this timestamp
}

export interface CreateJobInput {
  jobType: JobType;
  organizationId: string;
  accountId: string;
  role: PilotRole;
  inputPayload: Record<string, unknown>;
  priority?: number;         // Default: 3
  ttlHours?: number;         // Default: 24h
}

export interface JobStatusResult {
  jobId: string;
  status: JobStatus;
  sessionType: ShadowSessionType;
  estimatedWaitMs?: number;
  output?: Record<string, unknown> | null;
  error?: string | null;
  createdAt: string;
  completedAt?: string | null;
}

// ─── Job Management ───────────────────────────────────────────────────────────

/**
 * Enqueue a new Recovery Round job.
 * Returns the job ID for polling.
 */
export async function enqueueJob(input: CreateJobInput): Promise<string> {
  const ttlHours = input.ttlHours ?? 24;
  const priority = input.priority ?? 3;

  const row = await queryOne<{ job_id: string }>(
    `INSERT INTO pilot.shadow_jobs (
       job_type, organization_id, account_id, role,
       status, input_payload, priority, retry_count, max_retries,
       created_at, expires_at
     ) VALUES ($1, $2, $3, $4, 'pending', $5::jsonb, $6, 0, 3, NOW(), NOW() + INTERVAL '${ttlHours} hours')
     RETURNING job_id`,
    [
      input.jobType,
      input.organizationId,
      input.accountId,
      input.role,
      JSON.stringify(input.inputPayload),
      priority,
    ],
  );

  if (!row) throw new Error('Failed to create job');
  return row.job_id;
}

/**
 * Poll job status by ID.
 * Multi-tenant safe: returns null if org_id doesn't match.
 */
export async function getJobStatus(
  jobId: string,
  organizationId: string,
): Promise<JobStatusResult | null> {
  const row = await queryOne<{
    job_id: string;
    job_type: JobType;
    status: JobStatus;
    output_payload: Record<string, unknown> | null;
    error_message: string | null;
    created_at: string;
    completed_at: string | null;
  }>(
    `SELECT job_id, job_type, status, output_payload, error_message, created_at, completed_at
     FROM pilot.shadow_jobs
     WHERE job_id = $1 AND organization_id = $2`,
    [jobId, organizationId],
  );

  if (!row) return null;

  return {
    jobId: row.job_id,
    status: row.status,
    sessionType: jobTypeToSessionType(row.job_type),
    output: row.output_payload,
    error: row.error_message,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/**
 * Claim the next pending job for processing (used by job processor).
 * Atomic claim to prevent double-processing.
 */
export async function claimNextJob(jobType?: JobType): Promise<ShadowJob | null> {
  const typeFilter = jobType ? `AND job_type = '${jobType}'` : '';

  const row = await queryOne<ShadowJob>(
    `UPDATE pilot.shadow_jobs
     SET status = 'running', started_at = NOW()
     WHERE job_id = (
       SELECT job_id FROM pilot.shadow_jobs
       WHERE status = 'pending'
         AND expires_at > NOW()
         AND retry_count < max_retries
         ${typeFilter}
       ORDER BY priority ASC, created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [],
  );

  return row ?? null;
}

/**
 * Mark a job as completed with its output.
 */
export async function completeJob(
  jobId: string,
  output: Record<string, unknown>,
): Promise<void> {
  await query(
    `UPDATE pilot.shadow_jobs
     SET status = 'completed', output_payload = $2::jsonb, completed_at = NOW()
     WHERE job_id = $1`,
    [jobId, JSON.stringify(output)],
  );
}

/**
 * Mark a job as failed; increment retry count.
 * If retries exhausted, status stays 'failed'.
 */
export async function failJob(jobId: string, error: string): Promise<void> {
  await query(
    `UPDATE pilot.shadow_jobs
     SET
       status = CASE WHEN retry_count + 1 >= max_retries THEN 'failed' ELSE 'pending' END,
       retry_count = retry_count + 1,
       error_message = $2,
       started_at = NULL
     WHERE job_id = $1`,
    [jobId, error],
  );
}

/**
 * Cancel a pending job. Only the owning org can cancel.
 */
export async function cancelJob(jobId: string, organizationId: string): Promise<boolean> {
  const result = await queryOne<{ job_id: string }>(
    `UPDATE pilot.shadow_jobs
     SET status = 'cancelled'
     WHERE job_id = $1 AND organization_id = $2 AND status = 'pending'
     RETURNING job_id`,
    [jobId, organizationId],
  );

  return result !== null;
}

/**
 * Get all recent jobs for an org (admin view — The Scorecard).
 */
export async function getOrgJobs(
  organizationId: string,
  limit = 20,
): Promise<JobStatusResult[]> {
  const rows = await query<{
    job_id: string;
    job_type: JobType;
    status: JobStatus;
    output_payload: Record<string, unknown> | null;
    error_message: string | null;
    created_at: string;
    completed_at: string | null;
  }>(
    `SELECT job_id, job_type, status, output_payload, error_message, created_at, completed_at
     FROM pilot.shadow_jobs
     WHERE organization_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [organizationId, limit],
  );

  return rows.map((row) => ({
    jobId: row.job_id,
    status: row.status,
    sessionType: jobTypeToSessionType(row.job_type),
    output: row.output_payload,
    error: row.error_message,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  }));
}

// ─── DB Migration SQL ─────────────────────────────────────────────────────────

/**
 * SQL to create the jobs table. Run once against the database.
 * Exported so it can be called from a migration script.
 */
export const SHADOW_JOBS_MIGRATION = `
CREATE TABLE IF NOT EXISTS pilot.shadow_jobs (
  job_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type       TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  account_id     TEXT NOT NULL,
  role           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  input_payload  JSONB NOT NULL DEFAULT '{}',
  output_payload JSONB,
  error_message  TEXT,
  priority       INTEGER NOT NULL DEFAULT 3,
  retry_count    INTEGER NOT NULL DEFAULT 0,
  max_retries    INTEGER NOT NULL DEFAULT 3,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX IF NOT EXISTS idx_shadow_jobs_status_priority
  ON pilot.shadow_jobs (status, priority ASC, created_at ASC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_shadow_jobs_org
  ON pilot.shadow_jobs (organization_id, created_at DESC);
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
