import { MINT } from '../ids';
import { datasetSpec } from '../specs';
import { withinItemIdOf } from '../specs/templates';
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
//     nothing adopts a template version, so nothing needs the old one live
//     (intake plan IMP-08 CAP). pilot.workout_issues does reference
//     template_id (lane P7c: the workout a coach issued), which is why a
//     replaced version is superseded and withdrawn here and never deleted:
//     the row an issued workout names stays. The coach
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

/** An item's details cell as an object, or undefined for a blank or unparsable cell (the validator refuses bad JSON). */
function detailsOf(cell: string | undefined): Record<string, unknown> | undefined {
  if (!cell) return undefined;
  try {
    const value: unknown = JSON.parse(cell);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** An item's ordinal in the form mintId uses and the table stores: whole-number text ('01', '1.0') as its integer. */
function ordinalKey(ordinal: string): string {
  return isIntegerText(ordinal) ? integerText(ordinal) : ordinal;
}

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
      mintId: (templateId, row) => MINT.templateItem(templateId, ordinalKey(row.ordinal)),
      // An owner's step placed inside another names it by item id in details.within_item_id (D-PK73-3;
      // issued straight after it, workoutTemplates.ts issueOrder). The spec refuses a link that names no
      // other item of the template in the file, so a new version, which re-mints every item id, carries
      // the link to its parent's new id (App Overwatch on #2205, comment 7176799374).
      siblingLink: {
        read: (cells) => withinItemIdOf(cells.details),
        write: (cells, value) => ({ ...cells, details: JSON.stringify({ ...detailsOf(cells.details), within_item_id: value }) }),
        // The ordinal as stored ('01' and '1.0' are stored as 1), so a file and its stored version agree.
        key: (cells) => ordinalKey(cells.ordinal ?? ''),
      },
    },
  ],
  holdsName: (row) => row.active === true,
  // workoutTemplateEdit.ts records each in-app edit under this entity type.
  inAppEditAuditEntity: 'workout_template',
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
