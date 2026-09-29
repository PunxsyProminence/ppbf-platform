import { MINT } from '../ids';
import { datasetSpec } from '../specs';
import { integerText, isIntegerText } from '../values';
import type { DatasetEngine } from './index';
import { childFile, versionedDatasetEngine } from './templateScriptVersions';

// WORKOUT TEMPLATES (IMP-08): pilot.workout_templates + workout_template_items
// (workout_templates_v2 migration :43-100), versioned under R2 by the shared
// engine in templateScriptVersions.ts.
//
// A REVISION SUPERSEDES THE OLD HEAD FIRST, THEN INSERTS v(n+1). The old head
// gets superseded_at AND active = false:
//   - superseded_at, because pilot_workout_templates_one_head_per_lineage
//     (content-import migration (2)) allows one row per lineage with
//     superseded_at null, so the new version cannot be inserted before it;
//   - active = false, because pilot_workout_templates_one_active_name is
//     partial on `active` alone (workout_templates_v2 :128-129), so a v2 that
//     keeps the name is refused while v1 is active -- and unlike a drill,
//     nothing adopts a template version (no table references template_id;
//     intake plan IMP-08 CAP), so nothing needs the old one live. The coach
//     browse lists `where active` (workoutTemplates.ts:78-82) and so shows
//     exactly the new version.
//
// A WITHDRAWN TEMPLATE STAYS WITHDRAWN. `active` is decided by the tool, not
// the file (specs/templates.ts: "withdrawing a template is a separate
// action"), so a content revision carries the head's active flag over rather
// than quietly putting a withdrawn template back in front of coaches.
//
// ITEMS NAME A DRILL LINEAGE and store that lineage's CURRENT head drill_id at
// load (templateScriptVersions.ts). A template whose drill merely got a newer
// version is unchanged and keeps the version it was built with.

const dataset = datasetSpec('workout-templates');

export const workoutTemplatesEngine: DatasetEngine = versionedDatasetEngine({
  dataset,
  table: 'workout_templates',
  idColumn: 'template_id',
  idPrefix: 'wtp',
  head: 'not_superseded',
  children: [
    {
      spec: childFile(dataset, 'seed_workout_template_items.csv'),
      table: 'workout_template_items',
      idColumn: 'item_id',
      mintId: (templateId, row) => MINT.templateItem(templateId, isIntegerText(row.ordinal) ? integerText(row.ordinal) : row.ordinal),
    },
  ],
  holdsName: (row) => row.active === true,
  rootOverrides: ({ outcome, head, actorRole }) => ({
    supersedes_template_id: outcome === 'new_version' ? head?.id ?? null : null,
    active: outcome === 'new_version' ? head?.row.active === true : true,
    created_by_role: actorRole,
  }),
  async supersede(ctx, head) {
    const outcome = await ctx.client.query(
      `update pilot.workout_templates
          set superseded_at = now(), active = false, updated_at = now()
        where organization_id = $1 and template_id = $2 and superseded_at is null`,
      [ctx.organizationId, head.id],
    );
    // The head was locked FOR UPDATE and re-read before this plan; anything
    // but exactly one row means the plan no longer describes the table.
    if (outcome.rowCount !== 1) {
      throw new Error(`content-import: expected to supersede 1 current version of template ${head.lineageId} (${head.id}), matched ${outcome.rowCount}`);
    }
  },
});
