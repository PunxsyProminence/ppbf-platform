import fs from 'node:fs';
import path from 'node:path';

import { parse as csvParse } from 'csv-parse/sync';

import { datasetSpec, rootFileSpec } from './contentImport/specs';
import { DEFAULT_DISCIPLINES } from './disciplineSeeds';

// The guard that keeps the two copies of the discipline registry in lockstep.
//
// complianceRuleSeedsOwnership.test.ts parses a MIGRATION, because compliance
// rules are seeded by one. Disciplines are not: the second copy is
// seed_disciplines.csv, loaded into one organization per run by the seed
// workflow through the content-import core (`npm run seed:disciplines` runs the
// same thing). So this file parses the CSV instead, and the
// property is the same one -- a discipline added to either copy and not the
// other is a red build, rather than two gyms that disagree about what the
// platform runs depending on which path created them.
//
// The CSV is the older copy and the one an operator edits, so it is treated as
// authoritative here: every assertion is written as "the module matches the
// CSV", not the reverse.

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const CSV_PATH = path.join(REPO_ROOT, 'apps/web/seed-data/multidiscipline/seed_disciplines.csv');
const SEEDS_PATH = path.join(__dirname, 'disciplineSeeds.ts');

type CsvRow = Record<string, string>;

const csvRows: CsvRow[] = csvParse(fs.readFileSync(CSV_PATH, 'utf8'), {
  columns: true,
  skip_empty_lines: true,
});

/** The CSV writes booleans as the strings postgres accepts. */
function bool(value: string): boolean {
  return value.trim() === 'true';
}

describe('discipline seeds ownership', () => {
  test('the CSV is the five-discipline registry this module claims to mirror', () => {
    // A floor, so a CSV emptied by a bad edit cannot make every case below
    // vacuously true.
    expect(csvRows).toHaveLength(5);
    expect(DEFAULT_DISCIPLINES).toHaveLength(csvRows.length);
  });

  test('names the same disciplines, in the same order', () => {
    expect(DEFAULT_DISCIPLINES.map((seed) => seed.discipline)).toEqual(
      csvRows.map((row) => row.discipline),
    );
  });

  test.each(csvRows.map((row) => [row.discipline, row] as const))(
    '%s matches the CSV field for field',
    (discipline, row) => {
      const seed = DEFAULT_DISCIPLINES.find((candidate) => candidate.discipline === discipline);
      expect(seed).toBeDefined();

      // Every column the loader writes, so a value edited in the CSV and not
      // here -- a governing body, an age policy source, an evidence note --
      // fails rather than silently giving one path's gyms different metadata.
      expect(seed).toEqual({
        discipline: row.discipline,
        displayName: row.display_name,
        lane: row.lane,
        exposureModel: row.exposure_model,
        governingBody: row.governing_body,
        agePolicySource: row.age_policy_source,
        youthPermitted: bool(row.youth_permitted),
        adultPermitted: bool(row.adult_permitted),
        mixedAgePermitted: bool(row.mixed_age_permitted),
        evidenceNote: row.evidence_note,
        active: bool(row.active),
      });
    },
  );

  test('agrees with the CSV about which disciplines a gym starts running', () => {
    // Stated as its own case because `active` is the one field with an
    // immediate product consequence: it decides what /coach/disciplines shows.
    // Boxing and physical preparation ship active; the three grappling and
    // mixed lanes ship registered but inactive, present so the training-content
    // tables can reference them.
    const activeInModule = DEFAULT_DISCIPLINES.filter((s) => s.active).map((s) => s.discipline);
    const activeInCsv = csvRows.filter((row) => bool(row.active)).map((row) => row.discipline);

    expect(activeInModule).toEqual(activeInCsv);
    expect(activeInModule).toEqual(['boxing', 'conditioning']);
  });

  test('the organization is a parameter here and a placeholder there, never a literal', () => {
    // The CSV templates the tenant; this module takes it as an argument. If
    // either ever hard-coded a real organization id, one path would seed a
    // gym's registry into somebody else's.
    for (const row of csvRows) {
      expect(row.organization_id).toBe('{{PPBF_ORG_ID}}');
    }
    expect(fs.readFileSync(SEEDS_PATH, 'utf8')).not.toMatch(/\{\{PPBF_ORG_ID\}\}/);
  });

  test('writes the same registry columns the content-import loader does', () => {
    // Reading both rather than trusting them to agree: a column added to
    // pilot.disciplines and wired into only one path would leave gyms with a
    // null where the other path puts a value. The loader's columns are its
    // spec's (contentImport/specs/disciplines.ts), the one source the seed
    // workflow loads through since the per-dataset loaders were retired.
    const specColumns = rootFileSpec(datasetSpec('disciplines')).columns.map((column) => column.name);
    const columns = [
      'organization_id', 'discipline', 'display_name', 'lane', 'exposure_model',
      'governing_body', 'age_policy_source', 'youth_permitted', 'adult_permitted',
      'mixed_age_permitted', 'evidence_note', 'active',
    ];
    const seeds = fs.readFileSync(SEEDS_PATH, 'utf8');

    expect([...specColumns].sort()).toEqual([...columns].sort());
    for (const column of columns) {
      expect(seeds).toContain(column);
    }

    // A new gym's defaults must leave an existing row alone: the registry's
    // own key is what makes re-running it safe. (The seed path differs on
    // purpose: under R2 it revises a changed row in place and keeps the old
    // content in pilot.reference_content_revisions.)
    expect(seeds).toContain('on conflict (organization_id, discipline) do nothing');
  });
});
