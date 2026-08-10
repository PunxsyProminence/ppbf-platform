import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';

// pilot.drills is owned by
// infra/azure/pilot_slice_postgres_drills_migration.sql, applied through the
// apply-migrations workflow like every other table. Nothing here issues DDL: a
// missing table means the migration has not run, and the query should say so
// loudly rather than create schema from inside a request.

// The vocabulary pilot.drill_assignments.drill_difficulty already carries, and
// the one pilot_drills_difficulty_check enforces. A drill's difficulty and the
// difficulty recorded on an assignment of it are one vocabulary, so both sides
// read it from here.
export const DRILL_DIFFICULTIES = ['beginner', 'intermediate', 'advanced', 'elite'] as const;

export type DrillDifficulty = (typeof DRILL_DIFFICULTIES)[number];

export function isDrillDifficulty(value: unknown): value is DrillDifficulty {
  return DRILL_DIFFICULTIES.includes(value as DrillDifficulty);
}

export interface PilotDrill {
  organization_id: string;
  drill_id: string;
  name: string;
  category: string;
  focus: string;
  cues: string[];
  difficulty: DrillDifficulty;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * The body GET /api/pilot/drills answers with.
 *
 * This exists so the route and its clients cannot disagree about the key. They
 * did: the route has always sent `items`, both clients read `drills`, and the
 * drill library therefore rendered empty from the day it shipped. Route tests
 * passed and component tests passed, because each side was only ever tested
 * against its own idea of the shape.
 *
 * Import this on both sides. A rename is then a type error at every call site
 * rather than an empty list nobody can explain.
 */
export interface DrillLibraryResponse {
  ok: true;
  organization_id: string;
  items: PilotDrill[];
}

const DRILL_FIELDS =
  'organization_id, drill_id, name, category, focus, cues, difficulty, active, created_at, updated_at';

// One name per gym is held by the unique index pilot_drills_one_name_per_org,
// not by a read-then-write check here -- two concurrent creates each read no
// existing row and both write, so only the index can hold it. This turns the
// index's violation into an outcome a caller can act on instead of an opaque
// failure.
export class DrillNameTakenError extends Error {
  readonly drillName: string;

  constructor(drillName: string) {
    super(`This gym already has a drill named "${drillName}"`);
    this.name = 'DrillNameTakenError';
    this.drillName = drillName;
  }
}

const UNIQUE_VIOLATION = '23505';

function isDrillNameCollision(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === UNIQUE_VIOLATION && constraint === 'pilot_drills_one_name_per_org';
}

/**
 * A gym's drills. Retired drills are left out by default: the library is what
 * the gym teaches now. `includeRetired` is for the coach's editing surface,
 * which has to be able to find a retired drill to restore it.
 *
 * Ordered the way the index is built (category, name), so the read is served
 * by idx_pilot_drills_org_active.
 */
export async function listDrills(
  organizationId: string,
  options: { includeRetired?: boolean } = {},
): Promise<PilotDrill[]> {
  return query<PilotDrill>(
    `select ${DRILL_FIELDS}
     from pilot.drills
     where organization_id = $1
       and (active or $2::boolean)
     order by category, name`,
    [organizationId, options.includeRetired === true],
  );
}

// Organization-scoped by the composite key, so a drill_id from another gym
// reads as absent rather than as someone else's drill.
export async function getDrill(organizationId: string, drillId: string): Promise<PilotDrill | null> {
  return queryOne<PilotDrill>(
    `select ${DRILL_FIELDS}
     from pilot.drills
     where organization_id = $1 and drill_id = $2`,
    [organizationId, drillId],
  );
}

export async function createDrill(params: {
  organizationId: string;
  name: string;
  category: string;
  focus: string;
  cues?: string[];
  difficulty?: DrillDifficulty;
}): Promise<PilotDrill> {
  const drillId = randomUUID();

  try {
    const rows = await query<PilotDrill>(
      `insert into pilot.drills
         (organization_id, drill_id, name, category, focus, cues, difficulty)
       values ($1, $2, $3, $4, $5, $6::text[], $7)
       returning ${DRILL_FIELDS}`,
      [
        params.organizationId,
        drillId,
        params.name,
        params.category,
        params.focus,
        params.cues ?? [],
        params.difficulty ?? 'intermediate',
      ],
    );

    return rows[0];
  } catch (error) {
    if (isDrillNameCollision(error)) {
      throw new DrillNameTakenError(params.name);
    }
    throw error;
  }
}

/**
 * Edits the drill itself. Only the fields present are written, so a surface
 * that edits cues alone cannot blank the focus it never sent.
 *
 * `active` retires and restores. A gym stops teaching a drill far more often
 * than it decides the drill never existed, and every assignment that references
 * it is history -- so there is no delete path here, and the foreign key refuses
 * one anyway.
 *
 * Returns null when no row in this organization carries that id, so the caller
 * can report a miss rather than a silent success. Renaming a drill changes only
 * this row: the drill_name stored on an assignment is what the coach typed on
 * the day and is never rewritten from here.
 */
export async function updateDrill(params: {
  organizationId: string;
  drillId: string;
  name?: string;
  category?: string;
  focus?: string;
  cues?: string[];
  difficulty?: DrillDifficulty;
  active?: boolean;
}): Promise<PilotDrill | null> {
  const assignments: string[] = [];
  const values: unknown[] = [params.organizationId, params.drillId];

  const setField = (column: string, value: unknown, cast = '') => {
    values.push(value);
    assignments.push(`${column} = $${values.length}${cast}`);
  };

  if (params.name !== undefined) {
    setField('name', params.name);
  }
  if (params.category !== undefined) {
    setField('category', params.category);
  }
  if (params.focus !== undefined) {
    setField('focus', params.focus);
  }
  if (params.cues !== undefined) {
    setField('cues', params.cues, '::text[]');
  }
  if (params.difficulty !== undefined) {
    setField('difficulty', params.difficulty);
  }
  if (params.active !== undefined) {
    setField('active', params.active);
  }

  if (assignments.length === 0) {
    throw new Error('Missing drill fields to update');
  }

  try {
    const rows = await query<PilotDrill>(
      `update pilot.drills
       set ${assignments.join(', ')}, updated_at = now()
       where organization_id = $1 and drill_id = $2
       returning ${DRILL_FIELDS}`,
      values,
    );

    return rows[0] ?? null;
  } catch (error) {
    if (isDrillNameCollision(error)) {
      throw new DrillNameTakenError(params.name ?? '');
    }
    throw error;
  }
}
