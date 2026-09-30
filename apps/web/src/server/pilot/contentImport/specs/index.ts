import type { DatasetName, DatasetSpec, FileSpec } from '../types';
import { assessmentProtocolsDataset } from './assessmentProtocols';
import { cohortDefinitionsDataset, competenceLevelsDataset } from './competence';
import { disciplinesDataset } from './disciplines';
import { drillLibraryDataset } from './drills';
import { sessionScriptsDataset } from './sessionScripts';
import { workoutTemplatesDataset } from './templates';
import { transferClaimsDataset } from './transferClaims';
import { universalStopRulesDataset } from './universalStopRules';

// THE ONE SOURCE for what a content package may contain (R4: every material
// type). The validator, the prepare step and docs/CONTENT_PACKAGE_CONTRACT.md
// are all generated from this list; contentPackageContract.test.ts fails if
// the doc and these specs disagree.
//
// Order is dependency order: a dataset only references datasets above it
// (transfer claims point at drills and scripts, cohorts at disciplines).

export const DATASETS: readonly DatasetSpec[] = [
  disciplinesDataset,
  competenceLevelsDataset,
  cohortDefinitionsDataset,
  drillLibraryDataset,
  universalStopRulesDataset,
  workoutTemplatesDataset,
  sessionScriptsDataset,
  transferClaimsDataset,
  assessmentProtocolsDataset,
];

export const FILE_SPECS: readonly FileSpec[] = DATASETS.flatMap((dataset) => dataset.files);

/**
 * Columns a package may carry on ANY file (a database export has them) but
 * that the tool alone decides. Blank only; the loader writes them.
 */
export const UNIVERSAL_SYSTEM_COLUMNS = ['created_by_role', 'created_at', 'updated_at'] as const;

const BY_FILE_NAME = new Map(FILE_SPECS.map((spec) => [spec.file.toLowerCase(), spec]));

export function fileSpecByName(fileName: string): FileSpec | undefined {
  return BY_FILE_NAME.get(fileName.toLowerCase());
}

export function datasetSpec(name: DatasetName): DatasetSpec {
  const found = DATASETS.find((dataset) => dataset.name === name);
  if (!found) throw new Error(`unknown dataset ${name}`);
  return found;
}

/** The file that holds a dataset's items (the one with no parent). */
export function rootFileSpec(dataset: DatasetSpec): FileSpec {
  const root = dataset.files.find((file) => !file.parent);
  if (!root) throw new Error(`dataset ${dataset.name} has no root file`);
  return root;
}

/** Where a spec's committed file lives, relative to apps/web/seed-data. */
export function committedPath(spec: FileSpec): string {
  return `${spec.folder}/${spec.file}`;
}
