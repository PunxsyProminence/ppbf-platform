import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { query, queryOne } from './db';
import { BOARD_MINIMUM_COHORT_SIZE, boardCountMetric, type BoardCountMetric } from './boardSummary';

export const VOLUNTEER_STATUSES = ['active', 'pending', 'inactive'] as const;
export type VolunteerStatus = (typeof VOLUNTEER_STATUSES)[number];

export function isVolunteerStatus(value: string): value is VolunteerStatus {
  return (VOLUNTEER_STATUSES as readonly string[]).includes(value);
}

export interface VolunteerRecord {
  // text, not a sequence. The canonical key is
  // (organization_id, volunteer_id) -- see the shape note below.
  volunteer_id: string;
  organization_id: string;
  account_id: string | null;
  full_name: string;
  role_focus: string | null;
  availability: string | null;
  certification_status: string | null;
  background_check_status: string | null;
  status: VolunteerStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface VolunteerCreateInput {
  organizationId: string;
  fullName: string;
  // string | null rather than a required string: POST /api/admin/volunteers
  // still validates all four are present before it ever calls this (so that
  // route's behavior is unchanged), but createOrUpdateMicrosoftStaffAccount
  // (staffProvisioning.ts) also calls this to create the roster row a
  // volunteer invite is missing today, and an invite carries only an email --
  // it does not know a role focus or an availability window. The columns are
  // nullable in the base schema for exactly this "not yet known" case; see
  // the migration header.
  roleFocus: string | null;
  availability: string | null;
  certificationStatus: string | null;
  backgroundCheckStatus: string | null;
  notes?: string | null;
  // Set when the volunteer is also a platform account. Most volunteers are
  // not, so this is null far more often than not, and the column is nullable
  // in the base schema for that reason.
  accountId?: string | null;
}

// pilot.volunteers is owned by the base schema plus
// infra/azure/pilot_slice_postgres_volunteer_program_migration.sql, applied
// through the apply-migrations workflow.
//
// There used to be an `ensureVolunteerTable()` here issuing CREATE TABLE from
// inside these functions. It was worse than merely being the wrong owner: it
// declared a DIFFERENT shape from the live table (a `bigserial` single-column
// key), and because `create table if not exists` is a no-op against an
// existing table, it silently agreed with a schema it did not match. Every
// insert then failed on five columns that did not exist. Do not reintroduce
// it -- guardrails §7, and the base schema says so in its own comment.
//
// Shape: `volunteer_id` is text and minted here, because the canonical key is
// the composite (organization_id, volunteer_id) that every other entity uses.
// A sequence-backed integer key would break the multi-org model.

const SELECT_COLUMNS = `
  volunteer_id,
  organization_id,
  account_id,
  full_name,
  role_focus,
  availability,
  certification_status,
  background_check_status,
  status,
  notes,
  created_at,
  updated_at`;

export async function listVolunteers(organizationId: string): Promise<VolunteerRecord[]> {
  return query<VolunteerRecord>(
    `select ${SELECT_COLUMNS}
     from pilot.volunteers
     where organization_id = $1
     order by created_at desc`,
    [organizationId],
  );
}

export async function getVolunteer(
  organizationId: string,
  volunteerId: string,
): Promise<VolunteerRecord | null> {
  return queryOne<VolunteerRecord>(
    `select ${SELECT_COLUMNS}
     from pilot.volunteers
     where organization_id = $1
       and volunteer_id = $2`,
    [organizationId, volunteerId],
  );
}

/**
 * Accepts an optional client so a caller (staffProvisioning.ts's
 * createOrUpdateMicrosoftStaffAccount) can make writing the roster row part
 * of the same transaction that creates the account -- a volunteer invite
 * should never commit an account with no roster row behind it, the same
 * reasoning fileEscalation (escalationLadder.ts) documents for its own
 * optional client.
 */
export async function createVolunteer(input: VolunteerCreateInput, client?: PoolClient): Promise<string> {
  const volunteerId = randomUUID();

  // `role` and `active_flag` are the base schema's own columns and are NOT
  // NULL / defaulted there. `role` is written from role_focus rather than
  // left to a default so the canonical column stays truthful instead of
  // quietly disagreeing with it -- and falls back to the literal 'volunteer'
  // only when role_focus itself is unknown, so a not-null column is never
  // asked to hold a value nobody supplied.
  const values = [
    input.organizationId,
    volunteerId,
    input.accountId ?? null,
    input.fullName,
    input.roleFocus ?? 'volunteer',
    false,
    input.roleFocus ?? null,
    input.availability ?? null,
    input.certificationStatus ?? null,
    input.backgroundCheckStatus ?? null,
    'pending',
    input.notes ?? null,
  ];
  const sql = `insert into pilot.volunteers
       (organization_id, volunteer_id, account_id, full_name, role, active_flag,
        role_focus, availability, certification_status, background_check_status,
        status, notes, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now(), now())`;

  if (client) {
    await client.query(sql, values);
  } else {
    await query(sql, values);
  }

  return volunteerId;
}

export async function updateVolunteerStatus(input: {
  organizationId: string;
  volunteerId: string;
  status: VolunteerStatus;
}): Promise<boolean> {
  const rows = await query<{ volunteer_id: string }>(
    `update pilot.volunteers
     set status = $3,
         active_flag = ($3 = 'active'),
         updated_at = now()
     where organization_id = $1
       and volunteer_id = $2
     returning volunteer_id`,
    [input.organizationId, input.volunteerId, input.status],
  );

  return rows.length > 0;
}

export interface BoardVolunteerSummary {
  scope: 'organization_aggregate';
  minimumCohortSize: number;
  generatedAt: string;
  volunteersByStatus: {
    active: BoardCountMetric;
    pending: BoardCountMetric;
    inactive: BoardCountMetric;
  };
  newVolunteers30Days: BoardCountMetric;
}

interface BoardVolunteerSummaryRow {
  active_count: number;
  pending_count: number;
  inactive_count: number;
  new_count: number;
}

/**
 * Board's ONLY window into the volunteer roster -- count-only and
 * k-anonymity-gated exactly like every other board aggregate (see
 * boardSummary.ts's own metrics and escalationLadder.ts's
 * getBoardEscalationSummary, which this mirrors). Board never reads a
 * pilot.volunteers row directly: no volunteer_id, no account_id, no
 * full_name, no role_focus, no certification_status or
 * background_check_status, no notes -- only how many volunteers sit in each
 * status bucket and how many joined in the last 30 days.
 *
 * Each bucket counts volunteers directly rather than events attached to a
 * volunteer (unlike sessions/goals/reviews in boardSummary.ts, one
 * pilot.volunteers row IS one volunteer), so the record count and the
 * cohort/participant count boardCountMetric gates on are the same number
 * here. That makes this the same shape as boardSummary.ts's activeAthletes
 * metric, not the rate-metric shape used for sessions or coach reviews: a
 * bucket with 1-4 volunteers reports 'insufficient_data' rather than a small
 * real number, and an empty bucket reports 'unavailable' rather than a
 * measured zero, identical to every other board count.
 */
export async function getBoardVolunteerSummary(organizationId: string): Promise<BoardVolunteerSummary> {
  const row = await queryOne<BoardVolunteerSummaryRow>(
    `select
       count(*) filter (where status = 'active')::int as active_count,
       count(*) filter (where status = 'pending')::int as pending_count,
       count(*) filter (where status = 'inactive')::int as inactive_count,
       count(*) filter (where created_at >= now() - interval '30 days')::int as new_count
     from pilot.volunteers
     where organization_id = $1`,
    [organizationId],
  );

  const safe = row ?? {
    active_count: 0,
    pending_count: 0,
    inactive_count: 0,
    new_count: 0,
  };

  return {
    scope: 'organization_aggregate',
    minimumCohortSize: BOARD_MINIMUM_COHORT_SIZE,
    generatedAt: new Date().toISOString(),
    volunteersByStatus: {
      active: boardCountMetric(safe.active_count, safe.active_count),
      pending: boardCountMetric(safe.pending_count, safe.pending_count),
      inactive: boardCountMetric(safe.inactive_count, safe.inactive_count),
    },
    newVolunteers30Days: boardCountMetric(safe.new_count, safe.new_count),
  };
}
