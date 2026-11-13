import type { DatasetName, DatasetSpec, FileSpec } from '../types';
import { assessmentProtocolsDataset } from './assessmentProtocols';
import { labelColumns } from './common';
import { cohortDefinitionsDataset, competenceLevelsDataset } from './competence';
import { disciplinesDataset } from './disciplines';
import { drillLibraryDataset } from './drills';
import { pathwayCatalogDataset } from './pathwayCatalog';
import { sessionScriptsDataset } from './sessionScripts';
import { workoutTemplatesDataset } from './templates';
import { trainingTracksDataset } from './trainingTracks';
import { transferClaimsDataset } from './transferClaims';
import { universalStopRulesDataset } from './universalStopRules';

// THE ONE SOURCE for what a content package may contain (R4: every material
// type). The validator, the prepare step and docs/CONTENT_PACKAGE_CONTRACT.md
// are all generated from this list; contentPackageContract.test.ts fails if
// the doc and these specs disagree.
//
// Order is dependency order: a dataset only references datasets above it
// (transfer claims point at drills and scripts, cohorts at disciplines, training
// tracks at workout templates; every
// content item's stage_keys at the pathway catalog, so it comes first).

// Every dataset's ROOT file (the one holding its items) also takes the
// backbone's label columns (SCHEMA_PROPOSAL P19), added here once so no
// dataset can miss them. Child files do not: a label describes the item.
function withLabelColumns(dataset: DatasetSpec): DatasetSpec {
  return {
    ...dataset,
    files: dataset.files.map((file) => (file.parent ? file : { ...file, columns: [...file.columns, ...labelColumns()] })),
  };
}

export const DATASETS: readonly DatasetSpec[] = [
  pathwayCatalogDataset,
  disciplinesDataset,
  competenceLevelsDataset,
  cohortDefinitionsDataset,
  drillLibraryDataset,
  universalStopRulesDataset,
  workoutTemplatesDataset,
  sessionScriptsDataset,
  trainingTracksDataset,
  transferClaimsDataset,
  assessmentProtocolsDataset,
].map(withLabelColumns);

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
