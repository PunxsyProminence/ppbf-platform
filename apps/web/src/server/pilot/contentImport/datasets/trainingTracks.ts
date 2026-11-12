import { hex14 } from '../ids';
import { datasetSpec, rootFileSpec } from '../specs';
import { BLOCKS_FILE, SESSIONS_FILE } from '../specs/trainingTracks';
import type { Finding } from '../types';
import { integerText, isIntegerText } from '../values';
import type { DatasetEngine } from './index';
import { childFile, versionedDatasetEngine, type VersionedItem, type VersionedState } from './templateScriptVersions';

// TRAINING TRACKS (SCHEMA_PROPOSAL P17; lane FT1a): pilot.training_tracks +
// track_blocks + track_block_sessions (training_tracks migration), versioned
// under R2 by the shared engine in templateScriptVersions.ts, as a workout
// template and its items are.
//
// A REVISION SUPERSEDES THE OLD HEAD FIRST, THEN INSERTS v(n+1): the old head
// gets superseded_at (pilot_training_tracks_one_head_per_lineage allows one
// row per lineage with it null) and active = false, so a reader of `where
// active` sees exactly the current version. Its blocks and block sessions stay
// as they were: a block a later file leaves out is kept on the superseded
// version's rows and absent from the new one. A content revision carries the
// head's active flag over, as a template's does.
//
// BOTH CHILD FILES NAME THE TRACK. A block session reaches its block by
// (track_id, block_order) -- a foreign key -- so a new version's sessions find
// its re-minted blocks without a lookup (Overwatch, FT1a step 1, decision 1).
//
// THREE CHECKS AT PLAN, each refused by name (a blocking finding, so nothing
// is written):
//   - a block session names a block_order the unit's blocks do not have;
//   - a block session names a template lineage whose current version is
//     withdrawn (active = false). One with no current version at all is an
//     orphan_reference already (validate.ts, against this package and the
//     organization's current templates);
//   - child rows whose track is neither in this package nor loaded.

const dataset = datasetSpec('training-tracks');
const blocks = childFile(dataset, BLOCKS_FILE);
const sessions = childFile(dataset, SESSIONS_FILE);

const order = (value: string) => (isIntegerText(value) ? integerText(value) : value);

/** Ids of a track version's children: the ids.ts shape ('<prefix>_' + 14 hex), fed the VERSION's id. */
export const MINT_TRACK = {
  block: (trackId: string, blockOrder: string) => `trb_${hex14(`${trackId}:${order(blockOrder)}`)}`,
  session: (trackId: string, blockOrder: string, ordinal: string) => `tbs_${hex14(`${trackId}:${order(blockOrder)}:${order(ordinal)}`)}`,
};

const shared = versionedDatasetEngine({
  dataset,
  table: 'training_tracks',
  idColumn: 'track_id',
  idPrefix: 'trk',
  head: 'not_superseded',
  children: [
    { spec: blocks, table: 'track_blocks', idColumn: 'track_block_id', mintId: (trackId, row) => MINT_TRACK.block(trackId, row.block_order) },
    {
      spec: sessions,
      table: 'track_block_sessions',
      idColumn: 'block_session_id',
      mintId: (trackId, row) => MINT_TRACK.session(trackId, row.block_order, row.ordinal),
    },
  ],
  rootOverrides: ({ outcome, head, actorRole }) => ({
    supersedes_track_id: outcome === 'new_version' ? head?.id ?? null : null,
    active: outcome === 'new_version' ? head?.row.active === true : true,
    created_by_role: actorRole,
  }),
  async supersede(ctx, head) {
    const outcome = await ctx.client.query(
      `update pilot.training_tracks
          set superseded_at = now(), active = false, updated_at = now()
        where organization_id = $1 and track_id = $2 and superseded_at is null`,
      [ctx.organizationId, head.id],
    );
    if (outcome.rowCount !== 1) {
      throw new Error(`content-import: expected to supersede 1 current version of track ${head.lineageId} (${head.id}), matched ${outcome.rowCount}`);
    }
  },
});

function reject(item: VersionedItem, message: string): void {
  item.unit.outcome = 'reject';
  delete item.unit.fromVersion;
  delete item.unit.toVersion;
  item.unit.reasons = [...(item.unit.reasons ?? []), message];
}

export const trainingTracksEngine: DatasetEngine = {
  ...shared,

  async plan(ctx, input) {
    const planned = await shared.plan(ctx, input);
    const state = planned.state as VersionedState;
    const findings: Finding[] = [...planned.findings];
    const sessionsPath = input.files.find((file) => file.spec === sessions)?.path;
    const rootPath = input.files.find((file) => file.spec === rootFileSpec(dataset))?.path;

    // A template's current version is withdrawn when it is stored with
    // active = false. A package cannot change that: a revision keeps its
    // head's flag (datasets/templates.ts), and a template new in this package
    // has no stored version and loads active.
    const { rows } = await ctx.client.query<{ lineage_id: string }>(
      `select lineage_id from pilot.workout_templates
        where organization_id = $1 and superseded_at is null and active = false`,
      [ctx.organizationId],
    );
    const withdrawnTemplates = new Set(rows.map((row) => row.lineage_id));
    const sessionFile = input.files.find((file) => file.spec === sessions);
    const lineOf = (trackId: string, cells: Readonly<Record<string, string>>) =>
      sessionFile?.rows.find(
        (row) => row.values.track_id === trackId
          && order(row.values.block_order) === order(cells.block_order)
          && order(row.values.ordinal) === order(cells.ordinal),
      )?.line;

    for (const item of state.items) {
      const { unit } = item;
      if (unit.outcome === 'absent') continue;

      if (!item.root) {
        const message = `track ${unit.key} has rows in ${BLOCKS_FILE} or ${SESSIONS_FILE} but is neither in this package nor loaded in ${ctx.organizationId}`;
        if (unit.outcome !== 'reject') reject(item, message);
        const childPath = input.files.find((file) => file.spec !== rootFileSpec(dataset))?.path;
        findings.push({ code: 'orphan_reference', file: childPath ?? 'database:pilot.training_tracks', column: 'track_id', key: unit.key, message });
        continue;
      }
      if (unit.outcome === 'unchanged') continue;

      const blockOrders = new Set((item.children?.get(blocks) ?? []).map((cells) => order(cells.block_order)));
      for (const cells of item.children?.get(sessions) ?? []) {
        const at = `track ${unit.key} block ${order(cells.block_order)} session ${order(cells.ordinal)}`;
        // A session carried over from the stored version has no line; it is located at the file or the table.
        const file = sessionsPath ?? rootPath ?? 'database:pilot.track_block_sessions';
        const line = lineOf(unit.packageKey ?? unit.key, cells);
        if (!blockOrders.has(order(cells.block_order))) {
          const message = `${at} names block_order ${order(cells.block_order)}, which ${unit.key} has no block for`;
          reject(item, message);
          findings.push({ code: 'orphan_reference', file, line, column: 'block_order', key: unit.key, message });
        }
        const template = cells.template_lineage_id;
        if (template && withdrawnTemplates.has(template)) {
          const message = `${at} names template ${template}, whose current version in ${ctx.organizationId} is withdrawn. Name an active template, or restore it first.`;
          reject(item, message);
          findings.push({ code: 'withdrawn_template', file, line, column: 'template_lineage_id', key: unit.key, message });
        }
      }
    }
    return { ...planned, units: state.items.map((item) => item.unit), findings };
  },
};
