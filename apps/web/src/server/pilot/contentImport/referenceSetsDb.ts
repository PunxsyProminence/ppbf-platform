import { libraryRetrievalOrganizationIds } from '../platformLibraryScope';
import type { DbClient } from './actor';
import {
  currentScriptBlockIds,
  drillLineageHeads,
  sessionScriptLineageHeads,
  templateLineageHeads,
} from './lineage';
import { skillCodesFromSkillFamilies } from './referenceSets';
import type { ReferenceSets } from './types';

// WHAT A PACKAGE IS CHECKED AGAINST WHEN THERE IS A DATABASE: the same
// ReferenceSets the offline validator builds from committed files
// (referenceSets.ts), built instead from what the TARGET ORGANIZATION actually
// holds. The plan stage uses this, so a hand-off is judged against the
// database it will be written into -- a discipline the committed CSV lists but
// this gym never loaded is an orphan here, as it would be at the foreign key.
//
//   claim ids    metadata->>'claim_id' of the research chunks this org can
//                read: its own plus the shared __platform__ baseline, the
//                same pair every retrieval query uses
//                (libraryRetrievalOrganizationIds). A drill citing a claim no
//                loaded chunk carries points at nothing an athlete-facing
//                reader could ever resolve.
//   SK codes     still skillFamilies.ts. There is no skills table: the plan's
//                pilot.skills would be dropped by every `all` migration run
//                (dead_schema_removal_migration.sql:53; the critique's first
//                defect), so none is created here.
//   disciplines, level ordinals   the org's pilot.disciplines and
//                pilot.competence_levels rows.
//   drills, templates, scripts    lineage keys of the CURRENT versions
//                (lineage.ts), because a package names a lineage.
//   blocks       block ids of each script's current version.

export async function loadDatabaseReferenceSets(client: DbClient, organizationId: string): Promise<ReferenceSets> {
  const claims = await client.query<{ claim_id: string }>(
    `select distinct metadata->>'claim_id' as claim_id
       from pilot.shadow_library_chunks
      where organization_id = any($1::text[])
        and coalesce(metadata->>'claim_id', '') <> ''`,
    [libraryRetrievalOrganizationIds(organizationId)],
  );
  const disciplines = await client.query<{ discipline: string }>(
    'select discipline from pilot.disciplines where organization_id = $1',
    [organizationId],
  );
  const levels = await client.query<{ ordinal: number }>(
    'select ordinal from pilot.competence_levels where organization_id = $1',
    [organizationId],
  );
  const drills = await drillLineageHeads(client, organizationId);
  const templates = await templateLineageHeads(client, organizationId);
  const scripts = await sessionScriptLineageHeads(client, organizationId);
  const blocks = await currentScriptBlockIds(client, organizationId);

  return {
    claimIds: new Set(claims.rows.map((row) => row.claim_id)),
    skillCodes: skillCodesFromSkillFamilies(),
    disciplines: new Set(disciplines.rows.map((row) => row.discipline)),
    levelOrdinals: new Set(levels.rows.map((row) => Number(row.ordinal))),
    drills: new Map(
      [...drills.values()].map((head) => [head.lineageId, { discipline: head.discipline, name: head.name, skillId: head.skillId }]),
    ),
    templates: new Set(templates.keys()),
    scripts: new Set(scripts.keys()),
    blocks,
  };
}
