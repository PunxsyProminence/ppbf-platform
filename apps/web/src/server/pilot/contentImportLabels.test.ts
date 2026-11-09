import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalRow, datasetUnits, unitContentHash } from './contentImport/canonical';
import { runValidate } from './contentImport/cli';
import { writeCsv } from './contentImport/csv';
import { readCommittedBaseline } from './contentImport/referenceSets';
import { DATASETS, fileSpecByName, rootFileSpec } from './contentImport/specs';
import type { DatasetSpec, FindingCode } from './contentImport/types';
import { EVIDENCE_LABELS, RECORD_STATUSES, STAGE_KEYS } from './contentImport/types';

/*
  THE BACKBONE LABEL COLUMNS (SCHEMA_PROPOSAL P19; lane BB-1a). Every
  dataset's root file takes field_labels, evidence and stage_keys. This file
  proves, without a database:
    - `content:validate` (runValidate, what the npm script calls) accepts a
      package carrying the three columns and refuses each bad shape by name;
    - a package WITHOUT the columns hashes exactly as before they existed, for
      every committed item, so every committed package still plans
      `unchanged`;
    - a filled label is content: changing it is a revision; re-ordering JSON
      keys or stage keys is not.
  contentLabels.pg.test.ts is the database half.
*/

const WEB_DIR = path.resolve(__dirname, '../../..');
const SEED_DATA = path.join(WEB_DIR, 'seed-data');

// Shapes the backbone writes (its data/content records, read 2026-11-08):
// per-field labels, a part label nested under a field, and evidence as a list
// whose entries carry keys of their own beyond the six P19 names.
const FIELD_LABELS = JSON.stringify({
  display_name: { status: 'OBSERVED', sources: ['DOC-027'] },
  evidence_note: { status: 'REPORTED', sources: ['LR-114'], placement: { status: 'INFERRED', sources: [] } },
});
const EVIDENCE = JSON.stringify([
  {
    evidence_category: 'convention',
    evidence_label: 'CONVENTION',
    check_state: 'unchecked',
    evidence_item_ids: [],
    registry_claim_ids: [],
    basis: 'coaching practice',
    source_note: 'Long Road practice',
  },
]);

const BOXING = {
  organization_id: '{{PPBF_ORG_ID}}',
  discipline: 'boxing',
  display_name: 'Boxing',
  lane: 'striking',
  exposure_model: 'head_impact',
  governing_body: 'USA Boxing',
  age_policy_source: 'USA Boxing rulebook; PA state athletic commission for professional',
  youth_permitted: 'true',
  adult_permitted: 'true',
  mixed_age_permitted: 'false',
  evidence_note: '1,193-claim registry; 376 boxing-specific claims. Head impact exposure documented (A2-076, A3-033).',
  active: 'true',
};

function disciplinesCsv(row: Record<string, string>): string {
  const header = (fileSpecByName('seed_disciplines.csv')?.columns ?? []).map((column) => column.name);
  return writeCsv(header, [header.map((name) => row[name] ?? '')]);
}

function validateFolder(row: Record<string, string>): { code: number; out: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-labels-'));
  try {
    fs.mkdirSync(path.join(dir, 'multidiscipline'));
    fs.writeFileSync(path.join(dir, 'multidiscipline', 'seed_disciplines.csv'), disciplinesCsv(row));
    const lines: string[] = [];
    const code = runValidate({ packageDir: dir, seedDataDir: SEED_DATA }, { log: (line: string) => lines.push(line) } as never);
    return { code, out: lines.join('\n') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function blockingCodes(out: string): FindingCode[] {
  return [...out.matchAll(/^ {2}\[([a-z_]+)\]/gm)].map((match) => match[1] as FindingCode);
}

describe('every dataset root file takes the three label columns', () => {
  it.each(DATASETS.map((dataset) => [dataset.name, dataset] as const))('%s', (_name, dataset) => {
    const root = rootFileSpec(dataset);
    expect(root.columns.filter((column) => column.role === 'annotation').map((column) => column.name)).toEqual(['field_labels', 'evidence', 'stage_keys']);
    for (const child of dataset.files.filter((file) => file.parent)) {
      expect(child.columns.some((column) => column.role === 'annotation')).toBe(false);
    }
  });

  it('carries the backbone vocabularies exactly', () => {
    expect(RECORD_STATUSES).toEqual(['OBSERVED', 'REPORTED', 'INFERRED', 'UNVERIFIED']);
    expect(EVIDENCE_LABELS).toEqual(['PROVEN', 'EMERGING', 'EXPERIMENTAL', 'RESEARCH_NEEDED', 'RULE', 'CONVENTION', 'FRAMEWORK', 'UNTIERED']);
    expect(STAGE_KEYS).toHaveLength(18);
  });
});

describe('content:validate on a package carrying the label columns', () => {
  it('accepts the shapes the backbone writes', () => {
    const result = validateFolder({ ...BOXING, field_labels: FIELD_LABELS, evidence: EVIDENCE, stage_keys: 'T1|T2|AM1|RC1' });
    expect(result.out).toContain('RESULT: PASS');
    expect(result.code).toBe(0);
  });

  it("does not read a status inside a field's sources as a record status", () => {
    const sourced = JSON.stringify({ display_name: { status: 'REPORTED', sources: [{ id: 'LR-114', status: 'checked' }] } });
    expect(validateFolder({ ...BOXING, field_labels: sourced }).code).toBe(0);
  });

  it('accepts a single evidence object, and labels left blank', () => {
    expect(validateFolder({ ...BOXING, evidence: JSON.stringify(JSON.parse(EVIDENCE)[0]) }).code).toBe(0);
    expect(validateFolder({ ...BOXING }).code).toBe(0);
  });

  it.each<[string, Record<string, string>, FindingCode]>([
    ['field_labels that is not JSON', { field_labels: '{display_name: OBSERVED}' }, 'bad_json'],
    ['evidence that is not JSON', { evidence: '[{"evidence_label": "RULE"' }, 'bad_json'],
    ['field_labels as a list', { field_labels: '[{"status": "OBSERVED"}]' }, 'bad_json'],
    ['evidence holding a bare string', { evidence: '["CONVENTION"]' }, 'bad_json'],
    ['a field status outside the four', { field_labels: '{"display_name": {"status": "VERIFIED", "sources": []}}' }, 'unknown_status'],
    ['a nested part status outside the four', { field_labels: '{"evidence_note": {"status": "REPORTED", "placement": {"status": "observed"}}}' }, 'unknown_status'],
    ['a bad status on a field that is itself named sources', { field_labels: '{"sources": {"status": "BOGUS", "sources": []}}' }, 'unknown_status'],
    ['an evidence label outside the eight', { evidence: '[{"evidence_category": "research", "evidence_label": "STRONG"}]' }, 'unknown_evidence_label'],
    ['a stage key outside the 18', { stage_keys: 'T1|T3' }, 'unknown_stage_key'],
    ['a lowercase stage key', { stage_keys: 't1' }, 'unknown_stage_key'],
    ['stage keys separated by commas', { stage_keys: 'T1,T2' }, 'bad_separator'],
  ])('refuses %s, by name', (_case, cells, code) => {
    const result = validateFolder({ ...BOXING, ...cells });
    expect(result.code).toBe(1);
    expect(blockingCodes(result.out)).toEqual([code]);
  });
});

describe('a package without the label columns hashes exactly as before they existed', () => {
  // The datasets as they were before P19: the same specs minus the three columns.
  const withoutLabels = (dataset: DatasetSpec): DatasetSpec => ({
    ...dataset,
    files: dataset.files.map((file) => ({ ...file, columns: file.columns.filter((column) => column.role !== 'annotation') })),
  });
  const baseline = readCommittedBaseline(SEED_DATA);

  // Not the pathway catalog: its committed package carries labels from birth (lane BB-1b ruling), so they are its content.
  const predatingLabels = DATASETS.filter((dataset) => dataset.name !== 'pathway-catalog');
  it.each(predatingLabels.map((dataset) => [dataset.name, dataset] as const))('%s: every committed unit', (_name, dataset) => {
    const units = datasetUnits(dataset, baseline);
    for (const unit of units.values()) {
      expect(unitContentHash(dataset, unit)).toBe(unitContentHash(withoutLabels(dataset), unit));
    }
  });

  it('is not vacuous: the committed package has items in the datasets an engine loads', () => {
    const count = ['disciplines', 'drill-library', 'workout-templates', 'session-scripts']
      .map((name) => datasetUnits(DATASETS.find((dataset) => dataset.name === name) as DatasetSpec, baseline).size);
    expect(count.every((n) => n > 0)).toBe(true);
  });
});

describe('a filled label is content', () => {
  const dataset = DATASETS.find((candidate) => candidate.name === 'disciplines') as DatasetSpec;
  const hash = (row: Record<string, string>) => unitContentHash(dataset, { root: row, children: {} });

  it('changing a label is a revision', () => {
    expect(hash({ ...BOXING, stage_keys: 'T1' })).not.toBe(hash(BOXING));
    expect(hash({ ...BOXING, field_labels: FIELD_LABELS })).not.toBe(hash(BOXING));
    expect(hash({ ...BOXING, evidence: EVIDENCE })).not.toBe(hash(BOXING));
  });

  it('JSON key order, whitespace and stage key order are not (the database hands jsonb back in its own order)', () => {
    const reordered = JSON.stringify({ evidence_note: JSON.parse(FIELD_LABELS).evidence_note, display_name: JSON.parse(FIELD_LABELS).display_name }, null, 2);
    expect(hash({ ...BOXING, field_labels: reordered })).toBe(hash({ ...BOXING, field_labels: FIELD_LABELS }));
    expect(hash({ ...BOXING, stage_keys: 'RC1|T1|T1' })).toBe(hash({ ...BOXING, stage_keys: 'T1|RC1' }));
  });

  it('a stored jsonb value read back as an object hashes the same as the package text', () => {
    const spec = rootFileSpec(dataset);
    expect(canonicalRow(spec, { ...BOXING, evidence: JSON.parse(EVIDENCE) }).evidence).toBe(canonicalRow(spec, { ...BOXING, evidence: EVIDENCE }).evidence);
  });
});
