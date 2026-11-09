import { hex14 } from '../ids';
import type { ColumnSpec, DatasetSpec, FileSpec, Finding, ParsedFile, ParsedPackage, RowRule } from '../types';
import { integer, number, organizationColumn, systemColumn, text, vocabulary } from './common';

// THE PATHWAY CATALOG (SCHEMA_PROPOSAL P1, P2 and the catalog half of P7;
// pathway_catalog migration). The backbone's stages, the links between them
// and the defaults each stage or lane starts from, per organization. It
// describes the pathway and informs coaches: nothing reads it to compute,
// change or restrict where a coach places a member.
//
// EACH FILE IS A WHOLE SNAPSHOT of its table. A row the file carries is new,
// unchanged or revised (the old content kept in the history ledger); a row the
// table holds that the file leaves out is RETIRED (active_flag false), kept,
// never deleted. A file the package leaves out leaves its table alone.
//
// Keys are the backbone's own: a stage key in its human form (R-ID-7), a link
// by its two ends, a default by the backbone-minted dft_ id (kept as given,
// never re-minted). None takes new:<name>.

export const PATHWAY_STAGES_FILE = 'seed_pathway_stages.csv';
export const PATHWAY_LINKS_FILE = 'seed_pathway_stage_links.csv';
export const PATHWAY_DEFAULTS_FILE = 'seed_pathway_stage_defaults.csv';

/** A stage key in its human form: letters then digits (Y3, AM1, EX1). */
export const STAGE_KEY_PATTERN = /^[A-Z]+[0-9]+$/;
/** The lanes a default may be scoped to instead of a stage (DATA_MODEL s3.2). */
export const DEFAULT_LANE_SCOPES = ['lane:non_contact'] as const;

const backboneVersion = () =>
  text('backbone_version', 'The backbone snapshot the row comes from (e.g. draft-1). A new value is a new version of the row.', { label: true });
const activeFlag = () =>
  systemColumn('active_flag', 'true', 'a row the file carries is active; one a later snapshot leaves out is retired (false), never deleted');

function stageKey(name: string, role: 'key' | 'content', description: string): ColumnSpec {
  return { name, role, type: 'text', required: true, description };
}

/** The label column a catalog row does not use: a stage, a link and a default place themselves. */
const NO_STAGE_KEYS: RowRule = {
  description: 'stage_keys stays blank: a stage is its own key, a link names its two stages, a default names its scope.',
  check: (row) => (row.stage_keys ? `stage_keys is for content items; leave it blank on a pathway catalog row ('${row.stage_keys}')` : null),
};

function keyShape(column: string, mirrors?: RowRule['mirrors']): RowRule {
  return {
    description: `${column} is a stage key in its human form: capital letters then digits (Y3, AM1).`,
    mirrors,
    check: (row) => (row[column] && !STAGE_KEY_PATTERN.test(row[column]) ? `${column} '${row[column]}' is not a stage key (capital letters then digits, e.g. Y3, AM1)` : null),
  };
}

const stagesFile: FileSpec = {
  dataset: 'pathway-catalog',
  folder: 'pathway-catalog',
  file: PATHWAY_STAGES_FILE,
  rowMeaning: 'one pathway stage',
  key: ['stage_key'],
  nameColumn: 'name',
  columns: [
    organizationColumn(),
    stageKey('stage_key', 'key', 'The stage key in its human form (Y1 ... EX1). Keep it on a revision.'),
    vocabulary('segment', 'pathway_segment', 'The part of the pathway the stage belongs to.', { required: true }),
    integer('ordinal', 'The stage\'s place in the printed order (1 = first).', { required: true, bound: 'positive' }),
    text('name', 'What the stage is called (the descriptor, e.g. Technical Development).', { required: true }),
    text('who_text', 'Who the stage is for. A guide, never a gate.'),
    text('develops_text', 'What the stage develops.'),
    text('typical_duration_text', 'How long members usually spend in it.'),
    vocabulary('contact_default', 'contact_level', 'The contact level the stage starts from (a default a coach may change).', { required: true }),
    text('competition_text', 'Competition at this stage, and whose rules apply on which route.'),
    text('age_band_guide_text', 'The age band as a guide; placement uses age, experience and ability (the placement rule).'),
    text('ppbf_name', 'The PPBF name of the stage (e.g. CRESCENS).'),
    text('ppbf_name_meaning', 'What the PPBF name means.', { label: true }),
    text('ppbf_name_language', 'The language the PPBF name comes from.', { label: true }),
    backboneVersion(),
    activeFlag(),
  ],
  rowRules: [keyShape('stage_key', { table: 'pathway_stages', constraint: 'pilot_pathway_stages_key_check' }), NO_STAGE_KEYS],
};

const linksFile: FileSpec = {
  dataset: 'pathway-catalog',
  folder: 'pathway-catalog',
  file: PATHWAY_LINKS_FILE,
  rowMeaning: 'one next-stage link',
  key: ['from_stage_key', 'to_stage_key'],
  columns: [
    organizationColumn(),
    stageKey('from_stage_key', 'key', 'The stage the link starts from: a stage in seed_pathway_stages.csv (or, without that file, the loaded catalog).'),
    stageKey('to_stage_key', 'key', 'The stage the link leads to, named the same way.'),
    vocabulary('link_kind', 'pathway_link_kind', 'What kind of move the link is. A link describes the map; it never restricts where a coach places anyone.', { required: true }),
    backboneVersion(),
    activeFlag(),
  ],
  rowRules: [
    // The table needs no shape check of its own: both ends are foreign keys to pathway_stages.
    keyShape('from_stage_key'),
    keyShape('to_stage_key'),
    {
      description: 'A link joins two different stages.',
      mirrors: { table: 'pathway_stage_links', constraint: 'pilot_pathway_stage_links_ends_check' },
      check: (row) => (row.from_stage_key && row.from_stage_key === row.to_stage_key ? `a link joins two different stages (${row.from_stage_key} to itself)` : null),
    },
    NO_STAGE_KEYS,
  ],
};

const defaultsFile: FileSpec = {
  dataset: 'pathway-catalog',
  folder: 'pathway-catalog',
  file: PATHWAY_DEFAULTS_FILE,
  rowMeaning: 'one stage or lane default',
  key: ['default_id'],
  nameColumn: 'default_key',
  columns: [
    organizationColumn(),
    {
      name: 'default_id',
      role: 'key',
      type: 'text',
      required: true,
      description: "The backbone's own id: 'dft_' + first 14 hex of sha256(scope + ':' + default_key). Kept as given, never re-minted.",
    },
    text('scope', `A stage key (in seed_pathway_stages.csv, or the loaded catalog) or a lane: ${DEFAULT_LANE_SCOPES.join(', ')}.`, { required: true }),
    text('default_key', 'What the default is about (e.g. contact_level_default). One per scope.', { required: true, label: true }),
    vocabulary('kind', 'pathway_default_kind', 'What sort of entry it is.', { required: true }),
    text('value_text', 'A worded value (e.g. light_technical).'),
    text('value_vocabulary', 'The list value_text is drawn from, separated by |.', { label: true }),
    number('value_min', 'The lowest number the default allows.'),
    number('value_max', 'The highest number the default allows.'),
    text('unit', 'What value_min and value_max count (e.g. rounds).', { label: true }),
    integer('window_days', 'The window value_min and value_max count over, in days.', { bound: 'positive' }),
    text('sparring_type', 'The sparring type a sparring default counts.', { label: true }),
    text('composite_parent', 'The wider default this one is part of.', { label: true }),
    text('phases', 'JSON list: values that change within the stage (e.g. by months in stage).'),
    text('display_text', 'The default as a coach reads it.'),
    vocabulary('status', 'record_status', 'The record status (backbone RULES section 10).', { required: true }),
    { name: 'sources', role: 'content', type: 'text', list: '|', label: true, description: 'Source keys, separated by |.' },
    backboneVersion(),
    activeFlag(),
  ],
  rowRules: [
    {
      description: "default_id is 'dft_' and 14 lowercase hex.",
      mirrors: { table: 'pathway_stage_defaults', constraint: 'pilot_pathway_stage_defaults_id_check' },
      check: (row) => (row.default_id && !/^dft_[0-9a-f]{14}$/.test(row.default_id) ? `default_id '${row.default_id}' is not 'dft_' and 14 lowercase hex` : null),
    },
    {
      // Checked, never re-minted: the id the package gives is the id stored.
      // A mismatch means the row and its id disagree; loading it would make a
      // second default for the same scope and key.
      description: "default_id is the backbone's id for its scope and default_key: 'dft_' + first 14 hex of sha256(scope + ':' + default_key).",
      check: (row) => {
        if (!/^dft_[0-9a-f]{14}$/.test(row.default_id ?? '') || !row.scope || !row.default_key) return null;
        const expected = `dft_${hex14(`${row.scope}:${row.default_key}`)}`;
        return row.default_id === expected ? null : `default_id '${row.default_id}' is not the id of ${row.scope}:${row.default_key} (${expected})`;
      },
    },
    {
      description: `scope is a stage key (capital letters then digits) or ${DEFAULT_LANE_SCOPES.join(', ')}.`,
      mirrors: { table: 'pathway_stage_defaults', constraint: 'pilot_pathway_stage_defaults_scope_check' },
      check: (row) =>
        row.scope && !STAGE_KEY_PATTERN.test(row.scope) && !(DEFAULT_LANE_SCOPES as readonly string[]).includes(row.scope)
          ? `scope '${row.scope}' is neither a stage key nor ${DEFAULT_LANE_SCOPES.join(', ')}`
          : null,
    },
    {
      description: 'value_min is not above value_max.',
      mirrors: { table: 'pathway_stage_defaults', constraint: 'pilot_pathway_stage_defaults_range_check' },
      check: (row) => (row.value_min && row.value_max && Number(row.value_min) > Number(row.value_max) ? `value_min ${row.value_min} is above value_max ${row.value_max}` : null),
    },
    {
      description: 'phases, when set, is a JSON list.',
      mirrors: { table: 'pathway_stage_defaults', constraint: 'pilot_pathway_stage_defaults_phases_check' },
      check: (row) => {
        if (!row.phases) return null;
        try {
          return Array.isArray(JSON.parse(row.phases)) ? null : 'phases must be a JSON list';
        } catch {
          return 'phases is not readable JSON';
        }
      },
    },
    NO_STAGE_KEYS,
  ],
};

export const pathwayCatalogDataset: DatasetSpec = {
  name: 'pathway-catalog',
  title: 'Pathway catalog',
  folder: 'pathway-catalog',
  summary:
    'The backbone\'s pathway stages, the links between them and the defaults each stage or lane starts from (SCHEMA_PROPOSAL '
    + 'P1, P2, P7). Describes the pathway; never restricts where a coach places a member. Each file is a whole snapshot of its '
    + 'table: a changed row is revised in place with the old content kept in the history ledger, and a row the file leaves '
    + 'out is retired (kept, marked inactive), never deleted. A file the package leaves out leaves its table alone. Content '
    + 'items name stages in their stage_keys column; at plan each must be an active stage of this catalog. field_labels and '
    + 'evidence are stored on the catalog row itself, and each version of the row, labels included, in the history ledger.',
  loadedToday:
    'A PROVISIONAL Backbone snapshot is committed (seed-data/pathway-catalog: 18 stages, 74 links, 2913 defaults; '
    + 'backbone_version "spine c9a5b0158362c230 / catalogs 876ac31f5c677584 / 2026-11-09T04:18:17Z, 2026-11-09T13:32:02Z"), '
    + 'exported by scripts/backbone-export-pathway-catalog.mjs, which regenerates it at the final Backbone hand-off. '
    + 'It loads through the seed path or the admin content-import screen; no screen shows the catalog yet.',
  files: [stagesFile, linksFile, defaultsFile],
};

function fileOf(parsed: ParsedPackage, name: string): ParsedFile | undefined {
  return parsed.files.find((file) => file.spec.file === name);
}

/**
 * Link ends and default scopes against the stages they may name: the
 * package's own seed_pathway_stages.csv when it carries one (that file is the
 * whole catalog after this load), otherwise `fallback` -- at plan, the
 * organization's active stages (datasets/pathwayCatalog.ts). Offline there is
 * no fallback: without a stage file the plan stage decides. Each unknown
 * stage is refused by name. A malformed key has its own finding and is not
 * compared.
 */
export function pathwayStageReferenceFindings(parsed: ParsedPackage, fallback?: (stageKey: string) => boolean, where = ''): Finding[] {
  const stages = fileOf(parsed, PATHWAY_STAGES_FILE);
  if (!stages && !fallback) return [];
  const inFile = new Set(stages?.rows.map((row) => row.values.stage_key).filter(Boolean));
  const known = (key: string) => (stages ? inFile.has(key) : fallback?.(key) === true);
  const source = stages ? `${PATHWAY_STAGES_FILE} of this package` : where;
  const out: Finding[] = [];
  const check = (file: ParsedFile, line: number, column: string, value: string, what: string) => {
    if (!value || !STAGE_KEY_PATTERN.test(value) || known(value)) return;
    out.push({ code: 'orphan_reference', file: file.path, line, column, message: `${what} names stage '${value}', which is not in ${source}` });
  };
  const links = fileOf(parsed, PATHWAY_LINKS_FILE);
  for (const row of links?.rows ?? []) {
    for (const column of ['from_stage_key', 'to_stage_key']) check(links as ParsedFile, row.line, column, row.values[column], 'the link');
  }
  const defaults = fileOf(parsed, PATHWAY_DEFAULTS_FILE);
  for (const row of defaults?.rows ?? []) check(defaults as ParsedFile, row.line, 'scope', row.values.scope, `default ${row.values.default_id}`);
  return out;
}
