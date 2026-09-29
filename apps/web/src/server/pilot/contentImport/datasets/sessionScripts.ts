import { MINT } from '../ids';
import { datasetSpec } from '../specs';
import { integerText, isIntegerText } from '../values';
import type { DatasetEngine } from './index';
import { childFile, versionedDatasetEngine } from './templateScriptVersions';

// SESSION SCRIPTS (IMP-08): pilot.session_scripts + session_script_blocks +
// session_script_renderings (session_scripts migration :27-124), versioned
// under R2 by the shared engine in templateScriptVersions.ts.
//
// A REVISION IS version + 1 UNDER NEW IDS: a new script_id, and every block
// and rendering re-minted under it. Nothing is updated. The table has no
// superseded_at; a higher version in the lineage IS what supersedes
// (lineage.ts, sessionScriptLineageHeads), so there is no supersede step.
//
// RUNS KEEP THE VERSION THEY PINNED. A run stores script_id and
// script_version (session_scripts migration :133-151; sessionScriptRuns.ts
// startSessionScriptRun pins the version it started on), and its
// current_block_id names a block of that version. Because a revision never
// touches the old version's rows, a run started on v1 still reads v1's blocks.
//
// authoring_state IS LIFECYCLE, NOT CONTENT (draft / coach_reviewed / in_use /
// retired). The critique's point: counted as content, a file saying 'retired'
// would make a NEW VERSION instead of retiring anything. So:
//   - it is left out of the content hash: a difference in authoring_state
//     alone never makes a new version, and writes nothing;
//   - a package can never say 'retired' (a blocking row rule in
//     specs/sessionScripts.ts, so `content:validate` reports it before a PR);
//   - what a package writes for it -- on a new script, or on the new version
//     a content change makes -- is the file's value (blank = draft), because
//     handing files over counts as Jason's approval of their content; except
//     that a script already retired stays retired, since a package can
//     neither retire a script nor bring one back.

const LIFECYCLE_COLUMNS = ['authoring_state'] as const;

const dataset = datasetSpec('session-scripts');

export const sessionScriptsEngine: DatasetEngine = versionedDatasetEngine({
  dataset,
  table: 'session_scripts',
  idColumn: 'script_id',
  idPrefix: 'scr',
  head: 'highest_version',
  lifecycleColumns: LIFECYCLE_COLUMNS,
  children: [
    {
      spec: childFile(dataset, 'seed_session_script_blocks.csv'),
      table: 'session_script_blocks',
      idColumn: 'block_id',
      mintId: (scriptId, row) => MINT.block(scriptId, isIntegerText(row.block_order) ? integerText(row.block_order) : row.block_order),
    },
    {
      spec: childFile(dataset, 'seed_session_script_renderings.csv'),
      table: 'session_script_renderings',
      idColumn: 'rendering_id',
      mintId: (scriptId, row) => MINT.rendering(scriptId, row.format),
    },
  ],
  rootOverrides: ({ outcome, head }) =>
    outcome === 'new_version' && head?.row.authoring_state === 'retired' ? { authoring_state: 'retired' } : {},
});
