import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';
import { ConflictError } from './errors';

// The programs catalog: the durable named group ("Junior Boxing",
// "Competition Team", "6 PM Adults", "Fight Camp") that
// pilot.program_memberships rows enroll athletes into. Memberships keep
// joining by (organization_id, program_name); this module owns only the
// catalog entry -- its name, its active/archived status, its notes.
//
// Archiving is a status flip on the catalog row ONLY. It never touches
// membership rows: enrollment history is an administrative record that
// outlives the group it names, exactly as an ended membership outlives the
// enrollment. Deleting a program does not exist as an operation.

export const PROGRAM_STATUSES = ['active', 'archived'] as const;

export type ProgramStatus = (typeof PROGRAM_STATUSES)[number];

export interface ProgramRow {
  organization_id: string;
  program_id: string;
  program_name: string;
  status: ProgramStatus;
  notes: string;
  created_at: string;
}

export interface ProgramWithCountRow extends ProgramRow {
  active_member_count: number;
}

const FIELDS = 'organization_id, program_id, program_name, status, notes, created_at';

/** Active programs first, then by name -- the enroll form's select order. */
export async function listPrograms(organizationId: string): Promise<ProgramRow[]> {
  return query<ProgramRow>(
    `select ${FIELDS} from pilot.programs
     where organization_id = $1
     order by (status = 'archived') asc, program_name asc`,
    [organizationId],
  );
}

/**
 * The admin catalog view: every program with how many ACTIVE memberships
 * currently name it. The join is by name because that is how
 * pilot.program_memberships records enrollment -- lapsed and ended rows are
 * deliberately not counted (they are history, not current headcount).
 */
export async function listProgramsWithCounts(organizationId: string): Promise<ProgramWithCountRow[]> {
  return query<ProgramWithCountRow>(
    `select p.organization_id, p.program_id, p.program_name, p.status, p.notes, p.created_at,
            count(m.membership_id)::int as active_member_count
     from pilot.programs p
     left join pilot.program_memberships m
       on m.organization_id = p.organization_id
      and m.program_name = p.program_name
      and m.status = 'active'
     where p.organization_id = $1
     group by p.organization_id, p.program_id, p.program_name, p.status, p.notes, p.created_at
     order by (p.status = 'archived') asc, p.program_name asc`,
    [organizationId],
  );
}

export async function createProgram(input: {
  organizationId: string;
  programName: string;
  notes?: string;
  createdByAccountId: string;
}): Promise<ProgramRow> {
  const programName = input.programName.trim();
  const programId = randomUUID();

  let created: ProgramRow | null;
  try {
    created = await queryOne<ProgramRow>(
      `insert into pilot.programs
         (organization_id, program_id, program_name, notes, created_by_account_id)
       values ($1, $2, $3, $4, $5)
       returning ${FIELDS}`,
      [input.organizationId, programId, programName, input.notes ?? '', input.createdByAccountId],
    );
  } catch (error) {
    // The org-scoped unique name is the table's whole point: spelling drift
    // must be a refused create, reported as a conflict the admin can read,
    // never a second group. Archived programs hold their name too -- the
    // message says so, since "reactivate it" is the fix for that case.
    if (error instanceof Error && /pilot_programs_name_unique/.test(error.message)) {
      throw new ConflictError(
        'A program with this name already exists in this organization (it may be archived). Use the existing program or reactivate it.',
        'PROGRAM_NAME_TAKEN',
      );
    }
    throw error;
  }

  if (!created) {
    throw new Error('Failed to create program');
  }
  return created;
}

/**
 * Status flip only. Archiving does NOT touch pilot.program_memberships --
 * enrollment history stays exactly as recorded. Returns null when the
 * program is not in the caller's organization, so the route can answer with
 * a hidden not-found.
 */
async function setProgramStatus(
  organizationId: string,
  programId: string,
  status: ProgramStatus,
): Promise<ProgramRow | null> {
  return queryOne<ProgramRow>(
    `update pilot.programs
     set status = $3, updated_at = now()
     where organization_id = $1 and program_id = $2
     returning ${FIELDS}`,
    [organizationId, programId, status],
  );
}

export async function archiveProgram(organizationId: string, programId: string): Promise<ProgramRow | null> {
  return setProgramStatus(organizationId, programId, 'archived');
}

export async function reactivateProgram(organizationId: string, programId: string): Promise<ProgramRow | null> {
  return setProgramStatus(organizationId, programId, 'active');
}
