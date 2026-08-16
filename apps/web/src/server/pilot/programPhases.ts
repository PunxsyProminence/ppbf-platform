import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';

// Program phases (register module 129): which block a program is in,
// declared by a human. Starting a new phase closes the previous one on
// the day before the new one begins -- history stays intact, so a session
// recorded in March still reads as having happened during March's phase.
//
// Nothing here computes a phase, recommends one, or touches an athlete
// record. A phase is program-level context and nothing else.

export interface ProgramPhaseRow {
  organization_id: string;
  phase_id: string;
  program_name: string;
  phase_name: string;
  focus: string;
  started_on: string;
  ended_on: string | null;
  notes: string;
  created_by_account_id: string;
  created_at: string;
}

const FIELDS = `organization_id, phase_id, program_name, phase_name, focus,
  started_on::text as started_on, ended_on::text as ended_on, notes,
  created_by_account_id, created_at`;

/** Current phases first (open ones), then history newest first. */
export async function listPhases(organizationId: string, programName?: string): Promise<ProgramPhaseRow[]> {
  return query<ProgramPhaseRow>(
    `select ${FIELDS} from pilot.program_phases
     where organization_id = $1 and ($2::text is null or program_name = $2)
     order by (ended_on is not null) asc, started_on desc`,
    [organizationId, programName ?? null],
  );
}

export async function getPhase(organizationId: string, phaseId: string): Promise<ProgramPhaseRow | null> {
  return queryOne<ProgramPhaseRow>(
    `select ${FIELDS} from pilot.program_phases
     where organization_id = $1 and phase_id = $2`,
    [organizationId, phaseId],
  );
}

/** Starts a phase, closing whatever was open for that program the day
 * before this one begins. Returns null when the requested start would
 * predate the open phase's own start -- phases are a timeline, and a new
 * block cannot begin before the one it replaces. */
export async function startPhase(input: {
  organizationId: string;
  programName: string;
  phaseName: string;
  focus?: string;
  startedOn: string;
  notes?: string;
  createdByAccountId: string;
}): Promise<ProgramPhaseRow | null> {
  const open = await queryOne<{ phase_id: string; started_on: string }>(
    `select phase_id, started_on::text as started_on from pilot.program_phases
     where organization_id = $1 and program_name = $2 and ended_on is null`,
    [input.organizationId, input.programName],
  );

  if (open) {
    if (input.startedOn <= open.started_on) return null;
    await queryOne(
      `update pilot.program_phases
       set ended_on = ($3::date - 1), updated_at = now()
       where organization_id = $1 and phase_id = $2
       returning phase_id`,
      [input.organizationId, open.phase_id, input.startedOn],
    );
  }

  const phaseId = randomUUID();
  await queryOne(
    `insert into pilot.program_phases
       (organization_id, phase_id, program_name, phase_name, focus, started_on, notes, created_by_account_id)
     values ($1, $2, $3, $4, $5, $6::date, $7, $8)
     returning phase_id`,
    [
      input.organizationId,
      phaseId,
      input.programName,
      input.phaseName,
      input.focus ?? '',
      input.startedOn,
      input.notes ?? '',
      input.createdByAccountId,
    ],
  );

  return getPhase(input.organizationId, phaseId);
}

/** Ends an open phase without starting another -- a program between
 * blocks is an honest state, not a gap to paper over. */
export async function endPhase(input: {
  organizationId: string;
  phaseId: string;
  endedOn: string;
}): Promise<ProgramPhaseRow | null> {
  const row = await queryOne<{ phase_id: string }>(
    `update pilot.program_phases
     set ended_on = $3::date, updated_at = now()
     where organization_id = $1 and phase_id = $2 and ended_on is null
       and $3::date >= started_on
     returning phase_id`,
    [input.organizationId, input.phaseId, input.endedOn],
  );
  if (!row) return null;
  return getPhase(input.organizationId, input.phaseId);
}
