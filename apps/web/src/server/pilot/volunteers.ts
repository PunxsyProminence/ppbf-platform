import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';

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
  roleFocus: string;
  availability: string;
  certificationStatus: string;
  backgroundCheckStatus: string;
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

export async function createVolunteer(input: VolunteerCreateInput): Promise<string> {
  const volunteerId = randomUUID();

  // `role` and `active_flag` are the base schema's own columns and are NOT
  // NULL / defaulted there. They are written from the program fields rather
  // than left to defaults so the canonical columns stay truthful instead of
  // quietly disagreeing with role_focus and status.
  await query(
    `insert into pilot.volunteers
       (organization_id, volunteer_id, account_id, full_name, role, active_flag,
        role_focus, availability, certification_status, background_check_status,
        status, notes, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now(), now())`,
    [
      input.organizationId,
      volunteerId,
      input.accountId ?? null,
      input.fullName,
      input.roleFocus,
      false,
      input.roleFocus,
      input.availability,
      input.certificationStatus,
      input.backgroundCheckStatus,
      'pending',
      input.notes ?? null,
    ],
  );

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
