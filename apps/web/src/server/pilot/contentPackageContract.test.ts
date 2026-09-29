import fs from 'node:fs';
import path from 'node:path';

import { readCsv, writeCsv } from './contentImport/csv';
import { describeContract } from './contentImport/describe';
import { MINT } from './contentImport/ids';
import { loadOfflineReferenceSets, readCommittedBaseline } from './contentImport/referenceSets';
import { committedPath, DATASETS } from './contentImport/specs';
import type { ParsedPackage, RowValues } from './contentImport/types';
import { validateParsed } from './contentImport/validate';

/*
  THE FAST GUARD FOR COMMITTED CONTENT. Named *Contract.test.ts so `npm run
  guards` runs it on every push, and it needs no database.

  Every committed seed dataset must pass the same validator a hand-off passes
  (the specs in contentImport/specs are the one source), so a PR that edits a
  seed CSV by hand is held to the contract too. One dataset is known broken
  and is pinned EXACTLY rather than excused: transfer-claims points at 61 drill
  ids that are not in the library (seed-reference-data.yml:42-49 leaves it out
  of the workflow for that reason). Pinning the count means a fix shows up
  here as a change to review, and so does any new orphan.
*/

const WEB_DIR = path.resolve(__dirname, '../../..');
const SEED_DATA = path.join(WEB_DIR, 'seed-data');
const CONTRACT_DOC = path.resolve(WEB_DIR, '../../docs/CONTENT_PACKAGE_CONTRACT.md');

const baseline = readCommittedBaseline(SEED_DATA);
const references = loadOfflineReferenceSets(SEED_DATA, baseline);

function rows(file: string): RowValues[] {
  return baseline.files.find((f) => f.spec.file === file)?.rows.map((row) => row.values) ?? [];
}

function datasetPackage(name: string): ParsedPackage {
  return { files: baseline.files.filter((file) => file.spec.dataset === name) };
}

const COMMITTED = DATASETS.filter((dataset) => datasetPackage(dataset.name).files.length > 0).map((dataset) => dataset.name);

describe('committed seed content meets the content package contract', () => {
  it('finds the committed datasets at all, so the cases below cannot pass vacuously', () => {
    expect(COMMITTED).toEqual([
      'disciplines',
      'competence-levels',
      'cohort-definitions',
      'drill-library',
      'workout-templates',
      'session-scripts',
      'transfer-claims',
    ]);
    expect(rows('seed_drill_library.csv')).toHaveLength(119);
    // The LOADED research package (import-shadow-research.mjs:16), one claim per chunk.
    expect(references.claimIds.size).toBe(1193);
  });

  it.each(COMMITTED.filter((name) => name !== 'transfer-claims'))('%s has zero blocking findings', (name) => {
    const result = validateParsed(datasetPackage(name), { references, baseline });
    expect(result.blocking).toEqual([]);
  });

  it('transfer-claims reports exactly its known orphans: 173 rows over 61 drill ids, and nothing else', () => {
    const result = validateParsed(datasetPackage('transfer-claims'), { references, baseline });
    const orphanDrills = new Set(
      result.blocking.map((finding) => rows('seed_transfer_claims.csv').find((row) => row.transfer_id === finding.key)?.drill_id),
    );

    expect(result.blocking.map((finding) => `${finding.code}:${finding.column}`)).toEqual(
      Array(173).fill('orphan_reference:drill_id'),
    );
    expect(orphanDrills.size).toBe(61);
    expect([...orphanDrills].some((id) => id === undefined || references.drills.has(id))).toBe(false);
  });

  it('the whole committed set, validated as one package, reports only those same 173', () => {
    const result = validateParsed(baseline, { references, baseline });
    expect(result.blocking).toHaveLength(173);
    expect(new Set(result.blocking.map((finding) => finding.file))).toEqual(new Set(['transfer-claims/seed_transfer_claims.csv']));
  });
});

describe('the id minting formulas reproduce every committed id they claim to', () => {
  // ids.ts states each formula as OBSERVED. This is where that stays true: a
  // content edit that changes a name without its id, or a formula edit, fails here.
  it('drl_ = sha256(discipline:name) for all 119 drills', () => {
    const drills = rows('seed_drill_library.csv');
    expect(drills.filter((row) => MINT.drill(row.discipline, row.name) === row.drill_id)).toHaveLength(119);
  });

  it('wtp_ = sha256(name) for all 12 templates, coh_ = sha256(cohort_name) for all 6 cohorts', () => {
    expect(rows('seed_workout_templates.csv').every((row) => MINT.template(row.name) === row.template_id)).toBe(true);
    expect(rows('seed_workout_templates.csv')).toHaveLength(12);
    expect(rows('seed_cohort_definitions.csv').every((row) => MINT.cohort(row.cohort_name) === row.cohort_id)).toBe(true);
    expect(rows('seed_cohort_definitions.csv')).toHaveLength(6);
  });

  it('wti_, blk_ and rnd_ child ids for all 82 items, 65 blocks and 4 renderings', () => {
    expect(rows('seed_workout_template_items.csv').filter((row) => MINT.templateItem(row.template_id, row.ordinal) === row.item_id)).toHaveLength(82);
    expect(rows('seed_session_script_blocks.csv').filter((row) => MINT.block(row.script_id, row.block_order) === row.block_id)).toHaveLength(65);
    expect(rows('seed_session_script_renderings.csv').filter((row) => MINT.rendering(row.script_id, row.format) === row.rendering_id)).toHaveLength(4);
  });
});

describe('prepare can rewrite a committed file without touching rows it did not change', () => {
  it.each(baseline.files.map((file) => file.path))('%s round-trips through readCsv + writeCsv byte for byte', (relative) => {
    const text = fs.readFileSync(path.join(SEED_DATA, relative), 'utf8');
    const table = readCsv(text);
    expect(table.problems).toEqual([]);
    expect(writeCsv(table.header, table.records.map((record) => record.cells))).toBe(text);
  });

  it('every committed file the specs name is read', () => {
    const onDisk = DATASETS.flatMap((dataset) => dataset.files)
      .map(committedPath)
      .filter((relative) => fs.existsSync(path.join(SEED_DATA, relative)));
    expect(baseline.files.map((file) => file.path)).toEqual(onDisk);
  });
});

describe('docs/CONTENT_PACKAGE_CONTRACT.md', () => {
  it('is exactly what `npm run content:describe` generates from the specs', () => {
    // Regenerate with: npm run content:describe -- --write
    expect(fs.readFileSync(CONTRACT_DOC, 'utf8')).toBe(describeContract());
  });
});
