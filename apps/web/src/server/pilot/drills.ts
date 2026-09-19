import { randomUUID } from 'node:crypto';

import { query, queryOne, withTransaction } from './db';

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
  /**
   * The pilot.drill_library reference drill this operational drill was promoted
   * from, per OD-2026-09-16-001. NULL for a drill the gym authored itself, which
   * is most of them and stays legal.
   *
   * It pins the exact reference VERSION that was promoted, because a
   * drill_library row IS a version. So reference supersession never changes this
   * drill, and adopting a newer version is a separate coach action rather than
   * something that happens underneath one.
   *
   * The reference row remains canonical for instructional and safety content --
   * stop rules, scale levels, cue metadata and authorization all stay there and
   * are never copied here. This column is the link back to them, not a copy of
   * them.
   */
  reference_drill_id: string | null;
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
  'organization_id, drill_id, name, category, focus, cues, difficulty, active, created_at, '
  + 'updated_at, reference_drill_id';

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

/**
 * A reference drill this gym has already promoted.
 *
 * Kept distinct from DrillNameTakenError because the two have different
 * remedies: a name collision is resolved by choosing another name, and this one
 * is resolved by using the operational drill that already exists. Collapsing
 * them would tell a coach to rename their way out of a duplicate they should not
 * create at all.
 *
 * Held by the partial unique index pilot_drills_one_reference_per_org rather
 * than a read-then-write check, for the same reason as the name index: two
 * concurrent promotions each read no existing row and both write.
 */
export class ReferenceDrillAlreadyPromotedError extends Error {
  readonly referenceDrillId: string;

  constructor(referenceDrillId: string) {
    super('This reference drill has already been promoted into this gym.');
    this.name = 'ReferenceDrillAlreadyPromotedError';
    this.referenceDrillId = referenceDrillId;
  }
}

/**
 * A restore the lifecycle does not allow (W-D4C). Restore brings back the SAME
 * operational identity -- the retired lineage's newest version -- and nothing
 * else, so each refusal names what the coach can do instead.
 */
export type RestoreRefusal = 'not_latest_version' | 'another_version_active' | 'reference_withdrawn' | 'state_changed';

const RESTORE_REFUSAL_MESSAGES: Record<RestoreRefusal, string> = {
  not_latest_version: 'This is an earlier version of the drill. Restore its newest version instead.',
  another_version_active: 'Another version of this drill is already in use in this gym.',
  reference_withdrawn: "This drill's reference has been withdrawn, so it cannot be restored.",
  state_changed: 'This drill changed while it was being restored. Reload the page and try again.',
};

export class DrillRestoreRefusedError extends Error {
  readonly reason: RestoreRefusal;

  constructor(reason: RestoreRefusal) {
    super(RESTORE_REFUSAL_MESSAGES[reason]);
    this.name = 'DrillRestoreRefusedError';
    this.reason = reason;
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

function isReferencePromotionCollision(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === UNIQUE_VIOLATION && constraint === 'pilot_drills_one_reference_per_org';
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
 * Promotes a reference drill into this gym's operational library --
 * OD-2026-09-16-001.
 *
 * ONE INSERT, and deliberately nothing else. It writes a NEW operational
 * identity carrying the reference drill's id; it does not write to
 * pilot.drill_library, does not assign the drill to anyone, and creates no
 * completion or progression record. Promotion is adoption, not prescription.
 *
 * The caller supplies the mapped content rather than this function reading the
 * reference drill, so the mapping decision (which reference field becomes
 * `focus`, how many cues survive the operational ceiling) lives at the route
 * boundary where it is validated and tested, and this stays the write.
 *
 * Two conflicts, two errors. The gym may already have a drill under that name
 * (DrillNameTakenError), or may already have promoted this exact reference drill
 * under any name (ReferenceDrillAlreadyPromotedError). Both are unique-index
 * violations and each has its own remedy, so they are never merged.
 */
export async function promoteReferenceDrill(params: {
  organizationId: string;
  referenceDrillId: string;
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
         (organization_id, drill_id, name, category, focus, cues, difficulty, reference_drill_id)
       values ($1, $2, $3, $4, $5, $6::text[], $7, $8)
       returning ${DRILL_FIELDS}`,
      [
        params.organizationId,
        drillId,
        params.name,
        params.category,
        params.focus,
        params.cues ?? [],
        params.difficulty ?? 'intermediate',
        params.referenceDrillId,
      ],
    );

    return rows[0];
  } catch (error) {
    if (isReferencePromotionCollision(error)) {
      throw new ReferenceDrillAlreadyPromotedError(params.referenceDrillId);
    }
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

  // RESTORE IS GUARDED IN THE SAME STATEMENT (W-D4C). Setting active=true on a
  // row that is already active is an ordinary edit and passes. Bringing back a
  // retired row is allowed only for the lineage's newest version, only when no
  // version of that lineage is active, and only while its reference (if any) is
  // still active -- the same refusal the promote route makes for a withdrawn
  // reference. Held in the WHERE clause of the UPDATE rather than in a read
  // beforehand, so the target row is checked and changed together and a direct
  // API call gets the same rule as the coach page. A restore first locks the
  // lineage, in a statement of its own -- see below.
  const restoreGuard = params.active === true
    ? `
       and (
         d.active
         or (
           d.version = (
             select max(l.version) from pilot.drills l
             where l.organization_id = d.organization_id and l.lineage_id = d.lineage_id
           )
           and not exists (
             select 1 from pilot.drills l
             where l.organization_id = d.organization_id and l.lineage_id = d.lineage_id and l.active
           )
           and (
             d.reference_drill_id is null
             or exists (
               select 1 from pilot.drill_library r
               where r.organization_id = d.organization_id
                 and r.drill_id = d.reference_drill_id
                 and r.active
             )
           )
         )
       )`
    : '';

  const updateSql = `update pilot.drills d
       set ${assignments.join(', ')}, updated_at = now()
       where d.organization_id = $1 and d.drill_id = $2${restoreGuard}
       returning ${DRILL_FIELDS.split(', ').map((column) => `d.${column}`).join(', ')}`;

  try {
    if (params.active !== true) {
      const rows = await query<PilotDrill>(updateSql, values);
      return rows[0] ?? null;
    }

    // A RESTORE LOCKS THE LINEAGE FIRST, IN A STATEMENT OF ITS OWN (Codex P1 on
    // PR #939). The guard's "newest version" and "no version active" read the
    // lineage's OTHER rows. Adopting a change proposal locks the lineage's
    // newest row, marks it inactive and inserts an active successor. Were the
    // guarded UPDATE itself to wait on that row, PostgreSQL would re-check it
    // once the adoption commits against the statement's ORIGINAL snapshot --
    // which cannot see the successor -- and bring the old version back beside
    // it: two active versions. Locking the lineage's rows here and running the
    // guard in the next statement means the guard reads a snapshot taken after
    // any writer holding those rows has committed; an adoption that starts
    // later waits for this restore instead, then retires the row it restored.
    const restored = await withTransaction(async (client) => {
      await client.query(
        `select 1 from pilot.drills l
         where l.organization_id = $1
           and l.lineage_id = (
             select d.lineage_id from pilot.drills d
             where d.organization_id = $1 and d.drill_id = $2
           )
         for update`,
        [params.organizationId, params.drillId],
      );
      const result = await client.query<PilotDrill>(updateSql, values);
      return result.rows[0] ?? null;
    });
    if (restored) {
      return restored;
    }
    // Nothing changed: either there is no such drill (null, as before), or the
    // guard refused the restore -- and then the coach is told which rule.
    const refusal = await restoreRefusalFor(params.organizationId, params.drillId);
    if (refusal) {
      throw new DrillRestoreRefusedError(refusal);
    }
    return null;
  } catch (error) {
    if (isDrillNameCollision(error)) {
      // A restore sends no name, so name the drill that could not come back
      // rather than printing an empty pair of quotes.
      const name = params.name ?? (await getDrill(params.organizationId, params.drillId))?.name ?? '';
      throw new DrillNameTakenError(name);
    }
    throw error;
  }
}

async function restoreRefusalFor(organizationId: string, drillId: string): Promise<RestoreRefusal | null> {
  const row = await queryOne<{ latest: boolean; lineage_active: boolean; reference_withdrawn: boolean }>(
    `select
       d.version = (
         select max(l.version) from pilot.drills l
         where l.organization_id = d.organization_id and l.lineage_id = d.lineage_id
       ) as latest,
       exists (
         select 1 from pilot.drills l
         where l.organization_id = d.organization_id and l.lineage_id = d.lineage_id and l.active
       ) as lineage_active,
       (
         d.reference_drill_id is not null
         and not exists (
           select 1 from pilot.drill_library r
           where r.organization_id = d.organization_id and r.drill_id = d.reference_drill_id and r.active
         )
       ) as reference_withdrawn
     from pilot.drills d
     where d.organization_id = $1 and d.drill_id = $2`,
    [organizationId, drillId],
  );
  if (!row) return null;
  if (!row.latest) return 'not_latest_version';
  if (row.lineage_active) return 'another_version_active';
  if (row.reference_withdrawn) return 'reference_withdrawn';
  // The drill exists and nothing refuses it NOW, but the guarded update refused
  // it a moment ago: something changed in between. That is a conflict to retry,
  // not a missing drill.
  return 'state_changed';
}
