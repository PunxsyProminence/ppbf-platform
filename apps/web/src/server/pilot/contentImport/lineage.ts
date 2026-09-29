import type { DbClient } from './actor';

// LINEAGE KEY -> CURRENT VERSION. A package names a drill, template or script
// by its LINEAGE key (the id of its first version; contract "Identity"), never
// by a later version's id, so every reference in a package has to be resolved
// to the version that is current in the database before it can be checked or
// stored. One module, so the reference sets now and the drill/template/script
// datasets later (IMP-07, IMP-08) resolve heads the same way.
//
// WHAT "CURRENT" MEANS, per table:
//   drill_library, workout_templates: superseded_at is null. The content-import
//     migration makes that exactly one row per lineage
//     (pilot_drill_library_one_head_per_lineage,
//     pilot_workout_templates_one_head_per_lineage), partial on superseded_at
//     and NOT on active: a withdrawn head is still the head.
//   session_scripts: the highest version in the lineage. The table has no
//     superseded_at; a newer version existing IS what supersedes
//     (session_scripts migration :29-31, unique (org, lineage_id, version)).

export interface DrillHead {
  lineageId: string;
  drillId: string;
  version: number;
  discipline: string;
  name: string;
  skillId: string;
}

export interface VersionHead {
  lineageId: string;
  id: string;
  version: number;
}

export async function drillLineageHeads(client: DbClient, organizationId: string): Promise<Map<string, DrillHead>> {
  const { rows } = await client.query<{
    lineage_id: string;
    drill_id: string;
    version: number;
    discipline: string;
    name: string;
    skill_id: string | null;
  }>(
    `select lineage_id, drill_id, version, discipline, name, skill_id
       from pilot.drill_library
      where organization_id = $1 and superseded_at is null`,
    [organizationId],
  );
  return new Map(
    rows.map((row) => [
      row.lineage_id,
      {
        lineageId: row.lineage_id,
        drillId: row.drill_id,
        version: row.version,
        discipline: row.discipline,
        name: row.name,
        skillId: row.skill_id ?? '',
      },
    ]),
  );
}

export async function templateLineageHeads(client: DbClient, organizationId: string): Promise<Map<string, VersionHead>> {
  const { rows } = await client.query<{ lineage_id: string; template_id: string; version: number }>(
    `select lineage_id, template_id, version
       from pilot.workout_templates
      where organization_id = $1 and superseded_at is null`,
    [organizationId],
  );
  return new Map(rows.map((row) => [row.lineage_id, { lineageId: row.lineage_id, id: row.template_id, version: row.version }]));
}

export async function sessionScriptLineageHeads(client: DbClient, organizationId: string): Promise<Map<string, VersionHead>> {
  const { rows } = await client.query<{ lineage_id: string; script_id: string; version: number }>(
    `select distinct on (lineage_id) lineage_id, script_id, version
       from pilot.session_scripts
      where organization_id = $1
      order by lineage_id, version desc`,
    [organizationId],
  );
  return new Map(rows.map((row) => [row.lineage_id, { lineageId: row.lineage_id, id: row.script_id, version: row.version }]));
}

/** Block ids of the CURRENT version of each script; a block of an older version is history, not a target. */
export async function currentScriptBlockIds(client: DbClient, organizationId: string): Promise<Set<string>> {
  const { rows } = await client.query<{ block_id: string }>(
    `select b.block_id
       from pilot.session_script_blocks b
       join (
         select distinct on (lineage_id) script_id
           from pilot.session_scripts
          where organization_id = $1
          order by lineage_id, version desc
       ) head on head.script_id = b.script_id
      where b.organization_id = $1`,
    [organizationId],
  );
  return new Set(rows.map((row) => row.block_id));
}
