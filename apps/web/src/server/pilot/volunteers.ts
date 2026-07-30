import { query, queryOne } from './db';

export interface VolunteerRecord {
  volunteer_id: number;
  organization_id: string;
  full_name: string;
  role_focus: string;
  availability: string;
  certification_status: string;
  background_check_status: string;
  status: 'active' | 'pending' | 'inactive';
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
}

let ensured = false;

async function ensureVolunteerTable(): Promise<void> {
  if (ensured) return;

  await query(
    `create table if not exists pilot.volunteers (
      volunteer_id bigserial primary key,
      organization_id text not null,
      full_name text not null,
      role_focus text not null,
      availability text not null,
      certification_status text not null,
      background_check_status text not null,
      status text not null default 'pending',
      notes text null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`,
  );

  await query(
    `create index if not exists idx_volunteers_org_status_created
     on pilot.volunteers(organization_id, status, created_at desc)`,
  );

  ensured = true;
}

export async function listVolunteers(organizationId: string): Promise<VolunteerRecord[]> {
  await ensureVolunteerTable();

  return query<VolunteerRecord>(
    `select
       volunteer_id,
       organization_id,
       full_name,
       role_focus,
       availability,
       certification_status,
       background_check_status,
       status,
       notes,
       created_at,
       updated_at
     from pilot.volunteers
     where organization_id = $1
     order by created_at desc`,
    [organizationId],
  );
}

export async function createVolunteer(input: VolunteerCreateInput): Promise<number> {
  await ensureVolunteerTable();

  const row = await queryOne<{ volunteer_id: number }>(
    `insert into pilot.volunteers
     (organization_id, full_name, role_focus, availability, certification_status, background_check_status, notes)
     values ($1,$2,$3,$4,$5,$6,$7)
     returning volunteer_id`,
    [
      input.organizationId,
      input.fullName,
      input.roleFocus,
      input.availability,
      input.certificationStatus,
      input.backgroundCheckStatus,
      input.notes ?? null,
    ],
  );

  return row?.volunteer_id ?? 0;
}

export async function updateVolunteerStatus(input: {
  organizationId: string;
  volunteerId: number;
  status: VolunteerRecord['status'];
}): Promise<boolean> {
  await ensureVolunteerTable();

  const rows = await query<{ volunteer_id: number }>(
    `update pilot.volunteers
     set status = $3,
         updated_at = now()
     where organization_id = $1
       and volunteer_id = $2
     returning volunteer_id`,
    [input.organizationId, input.volunteerId, input.status],
  );

  return rows.length > 0;
}