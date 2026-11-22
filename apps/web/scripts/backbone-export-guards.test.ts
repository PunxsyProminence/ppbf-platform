import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The two exporter stops (scripts/lib/backbone-export-guards.mjs), without a Backbone. The module
 * is native ESM and this suite runs under the plain `jest` of `npm test`, so it is evaluated in a
 * child node process, as embedded-pg-cleanup.test.ts does. Every id in this file is made up; the
 * exporters' own suites prove the stops through the command line.
 */

const moduleUrl = pathToFileURL(path.resolve(__dirname, 'lib/backbone-export-guards.mjs')).href;
const youthExporterUrl = pathToFileURL(path.resolve(__dirname, 'backbone-export-youth-recreational.mjs')).href;

function evaluate<T>(body: string): T {
  const script = `
    import * as m from ${JSON.stringify(moduleUrl)};
    const out = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify(out ?? null));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })) as T;
}

interface Finding { kind: string; file: string; row?: string; column?: string; template?: string; ordinal?: string; drill?: string }

const MADE_UP_HELD = 'wtp_0000000000aaaa';
const NOT_HELD = 'wtp_0000000000bbbb';
const TRACKS = 'training-tracks/seed_training_tracks.csv';
const ITEMS = 'workout-templates/seed_workout_template_items.csv';

describe('the held list', () => {
  it('is the six held template ids of the youth-recreational exporter, kept as hashes and never as ids', () => {
    const result = evaluate<{ count: number; same: boolean; shapes: boolean }>(`
      const yr = await import(${JSON.stringify(youthExporterUrl)});
      const own = Object.keys(yr.HELD_TEMPLATES).map(m.hashOfId).sort();
      return {
        count: m.HELD_ID_HASHES.length,
        same: JSON.stringify([...m.HELD_ID_HASHES].sort()) === JSON.stringify(own),
        shapes: m.HELD_ID_HASHES.every((hash) => /^[0-9a-f]{16}$/.test(hash)),
      };
    `);
    expect(result).toEqual({ count: 6, same: true, shapes: true });
  });
});

describe('heldTextFindings', () => {
  const run = (rows: Record<string, string>[], header: string[], useMadeUpList = true) => evaluate<Finding[]>(`
    const held = ${useMadeUpList ? `[m.hashOfId(${JSON.stringify(MADE_UP_HELD)})]` : 'undefined'};
    return m.heldTextFindings(${JSON.stringify(TRACKS)}, ${JSON.stringify(header)}, ${JSON.stringify(rows)}, held);
  `);
  const header = ['organization_id', 'track_id', 'name', 'details', 'sources'];

  it('finds a held template id inside a cell and names the file, the row and the column', () => {
    const found = run([
      { organization_id: '{{PPBF_ORG_ID}}', track_id: 'trk_00000000000001', name: 'A', details: JSON.stringify({ session_refs: [{ week: 1, template_id: MADE_UP_HELD }] }), sources: '["LR-1"]' },
      { organization_id: '{{PPBF_ORG_ID}}', track_id: 'trk_00000000000002', name: 'B', details: JSON.stringify({ session_refs: [{ week: 1, template_id: NOT_HELD }] }), sources: '["LR-1"]' },
    ], header);
    expect(found).toEqual([{ kind: 'held_text', file: TRACKS, row: 'track_id trk_00000000000001', column: 'details' }]);
  });

  it('finds the DOC-136 source key, and not a key that only looks like it', () => {
    const found = run([
      { track_id: 'trk_00000000000001', sources: '["LR-1","DOC-136 (a made-up source line)"]' },
      { track_id: 'trk_00000000000002', details: '{"groups":[{"label":"DOC-136 home day"}]}' },
      { track_id: 'trk_00000000000003', sources: '["DOC-1360","XDOC-136","DOC-13","DOC-135"]' },
    ], header);
    expect(found).toEqual([
      { kind: 'held_text', file: TRACKS, row: 'track_id trk_00000000000001', column: 'sources' },
      { kind: 'held_text', file: TRACKS, row: 'track_id trk_00000000000002', column: 'details' },
    ]);
  });

  it('never prints a held id: a row whose own id is held is named without it', () => {
    const result = evaluate<{ found: Finding[]; message: string }>(`
      const held = [m.hashOfId(${JSON.stringify(MADE_UP_HELD)})];
      const found = m.heldTextFindings('workout-templates/seed_workout_templates.csv', ['organization_id', 'template_id', 'name'],
        [{ organization_id: '{{PPBF_ORG_ID}}', template_id: ${JSON.stringify(MADE_UP_HELD)}, name: 'A held day' }], held);
      return { found, message: m.stopMessage(found) };
    `);
    expect(result.found).toEqual([{ kind: 'held_text', file: 'workout-templates/seed_workout_templates.csv', row: 'template_id (a held record)', column: 'template_id' }]);
    expect(result.message).toContain('workout-templates/seed_workout_templates.csv template_id (a held record): template_id names a held DOC-136 record');
    expect(result.message.includes(MADE_UP_HELD)).toBe(false);
  });

  it('names a row with no id by its position, and finds nothing in clean rows', () => {
    expect(run([{ name: 'A', details: 'DOC-136' }], header)).toEqual([{ kind: 'held_text', file: TRACKS, row: 'row 1', column: 'details' }]);
    expect(run([{ organization_id: '{{PPBF_ORG_ID}}', track_id: 'trk_00000000000001', name: 'A', details: '{"groups":[]}', sources: '["DOC-151"]' }], header)).toEqual([]);
  });

  it('by default holds the real list: a made-up id is not on it', () => {
    expect(run([{ track_id: 'trk_00000000000001', details: MADE_UP_HELD }], header, false)).toEqual([]);
  });
});

describe('typedLineFindings', () => {
  const step = (template: string, ordinal: string, drill: string, extra: Record<string, string> = {}) =>
    ({ item_id: `wti_${template.slice(-4)}${ordinal.padStart(10, '0')}`, template_id: template, ordinal, drill_id: drill, free_text_drill: drill ? '' : 'Jump rope', ...extra });
  const run = (committed: Record<string, string>[], fresh: Record<string, string>[]) => evaluate<Finding[]>(
    `return m.typedLineFindings(${JSON.stringify(ITEMS)}, ${JSON.stringify(committed)}, ${JSON.stringify(fresh)});`,
  );
  const T = 'wtp_00000000000001';
  const D = 'drl_00000000000001';

  it('finds a committed step that links a drill where the export has a typed line', () => {
    expect(run([step(T, '1', D), step(T, '2', D)], [step(T, '1', D), step(T, '2', '')])).toEqual([
      { kind: 'typed_line', file: ITEMS, template: T, ordinal: '2', drill: D },
    ]);
  });

  it('matches a step by template and position, so one re-minted under another item id is still found', () => {
    expect(run([step(T, '2', D, { item_id: 'wti_0000000000ffff' })], [step(T, '2', '')])).toEqual([
      { kind: 'typed_line', file: ITEMS, template: T, ordinal: '2', drill: D },
    ]);
  });

  it('follows a step by its item id first: one that moved and comes back typed is found; one that moved and keeps its link is not', () => {
    // Review F1 on #2098: matched by position alone, the first was missed and the second was a false stop.
    const linked = { item_id: 'wti_00000000000b0b' };
    expect(run([step(T, '1', ''), step(T, '2', '', { item_id: 'wti_00000000000c0c' }), step(T, '3', D, linked)],
      [step(T, '1', ''), step(T, '2', '', linked)])).toEqual([
      { kind: 'typed_line', file: ITEMS, template: T, ordinal: '3', drill: D },
    ]);
    expect(run([step(T, '2', D, linked)], [step(T, '2', '', { item_id: 'wti_00000000000c0c' }), step(T, '3', D, linked)])).toEqual([]);
    // A removed linked step is not one: the typed step that moved into its place is another committed step,
    // followed by its own item id (fix-delta review on #2098). The overwrite guard names the removal.
    expect(run([step(T, '1', D, linked), step(T, '2', '', { item_id: 'wti_00000000000c0c' })], [step(T, '1', '', { item_id: 'wti_00000000000c0c' })])).toEqual([]);
  });

  it('finds nothing when the line was typed all along, the link is kept or changed, the export links a typed line, or the step is gone', () => {
    expect(run([step(T, '1', '')], [step(T, '1', '')])).toEqual([]);
    expect(run([step(T, '1', D)], [step(T, '1', D)])).toEqual([]);
    expect(run([step(T, '1', D)], [step(T, '1', 'drl_00000000000002')])).toEqual([]);
    expect(run([step(T, '1', '')], [step(T, '1', D)])).toEqual([]);
    expect(run([step(T, '1', D)], [])).toEqual([]);
    // The same position in another template is another step.
    expect(run([step(T, '1', D)], [step('wtp_00000000000002', '1', '')])).toEqual([]);
  });
});

describe('stopMessage', () => {
  it('is null with nothing to stop, and otherwise says nothing was written and that --allow-overwrite does not change that', () => {
    const result = evaluate<{ none: string | null; both: string }>(`
      return {
        none: m.stopMessage([]),
        both: m.stopMessage([
          { kind: 'held_text', file: 'a.csv', row: 'track_id trk_00000000000001', column: 'details' },
          { kind: 'typed_line', file: 'b.csv', template: 'wtp_00000000000001', ordinal: '2', drill: 'drl_00000000000001' },
        ]),
      };
    `);
    expect(result.none).toBeNull();
    // An exporter with no --allow-overwrite (pathway-catalog) does not name it (review F2 on #2098).
    const noFlag = evaluate<string>(`return m.stopMessage([{ kind: 'held_text', file: 'a.csv', row: 'row 1', column: 'details' }], { overwriteFlag: false });`);
    expect(noFlag.split('\n')[0]).toMatch(/ Nothing was written\.$/);
    expect(noFlag).not.toContain('--allow-overwrite');
    expect(result.both.split('\n')).toEqual([
      'refused: this run would write 1 cell(s) that name a held DOC-136 record (held out of this repository, OW25-49 (c)), and write 1 typed line(s) back over a step that links a drill (OW26-05 B, OW27-09 B). Nothing was written, and --allow-overwrite does not change that.',
      '  a.csv track_id trk_00000000000001: details names a held DOC-136 record',
      '  b.csv template_id wtp_00000000000001: step 2 links drill drl_00000000000001; the export would write it back as a typed line',
    ]);
  });
});
