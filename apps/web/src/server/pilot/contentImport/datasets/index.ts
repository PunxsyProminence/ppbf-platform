import type { DbClient, ImportActor } from '../actor';
import { DATASETS } from '../specs';
import type { DatasetName, DatasetSpec, Finding, ParsedFile } from '../types';
import type { ValidationResult } from '../validate';
import { REGISTRY_ENGINES } from './registries';

// THE DATASET REGISTRY OF THE DATABASE HALF. Each dataset module turns the
// validated rows of its files into a plan (what each item WOULD become) and
// writes that plan. plan.ts and apply.ts only orchestrate: they never know how
// a discipline differs from a drill.
//
// ONE LINE PER DATASET MODULE. The drill library and universal stop rules
// (IMP-07) and workout templates and session scripts (IMP-08) register here
// when they land; until then a package carrying their files is refused at plan
// with dataset_not_loadable, rather than half-loaded.

export type UnitOutcome = 'new' | 'new_version' | 'unchanged' | 'absent' | 'reject';

export const UNIT_OUTCOMES: readonly UnitOutcome[] = ['new', 'new_version', 'unchanged', 'absent', 'reject'];

/** One item's fate in a plan. */
export interface UnitPlan {
  dataset: DatasetName;
  /** The item's key in the database: the minted id for a new:<short-name>. */
  key: string;
  /** The key as written in the package, when it differs (new:<short-name>). */
  packageKey?: string;
  outcome: UnitOutcome;
  /** canonical.ts unit hash of the package content. */
  fileSha256?: string;
  /** canonical.ts unit hash of the current database content. */
  databaseSha256?: string;
  /** History-ledger versions: what the database content is recorded as, and what this import records. */
  fromVersion?: number;
  toVersion?: number;
  /** A revision first records the database row as fromVersion, because the ledger does not hold that content yet. */
  recordsBefore?: boolean;
  /** For a reject: why, in plain English. */
  reasons?: string[];
}

export interface EngineContext {
  client: DbClient;
  organizationId: string;
  actor: ImportActor;
}

export interface DatasetPlan {
  dataset: DatasetName;
  units: UnitPlan[];
  /** Blocking findings this dataset adds beyond the validator's (e.g. ordinal_change). */
  findings: Finding[];
  /** Whatever the dataset module needs to write this plan; opaque to plan.ts and apply.ts. */
  state: unknown;
}

export interface DatasetWriteResult {
  inserted: string[];
  updated: string[];
  ledgerRows: number;
}

export interface DatasetEngine {
  readonly spec: DatasetSpec;
  /** The organization's current rows, as parsed files, so the validator judges uniqueness against the database. */
  readBaseline(ctx: EngineContext): Promise<ParsedFile[]>;
  /** SELECT ... FOR UPDATE on the rows these keys name (those that exist). */
  lockKeys(ctx: EngineContext, keys: readonly string[]): Promise<void>;
  plan(ctx: EngineContext, input: { files: readonly ParsedFile[]; validation: ValidationResult }): Promise<DatasetPlan>;
  /** Writes exactly what `plan` decided. Called only with a plan made inside the same transaction. */
  apply(ctx: EngineContext, plan: DatasetPlan, write: { importId: string }): Promise<DatasetWriteResult>;
}

// Applied in the specs' dependency order (specs/index.ts: a dataset only
// references datasets above it), whatever order the modules register in, so
// cohorts are written after the disciplines they point at in an 'all' load.
export const DATASET_ENGINES: readonly DatasetEngine[] = [...REGISTRY_ENGINES].sort(
  (a, b) => DATASETS.indexOf(a.spec) - DATASETS.indexOf(b.spec),
);

export function datasetEngine(name: DatasetName): DatasetEngine | undefined {
  return DATASET_ENGINES.find((engine) => engine.spec.name === name);
}

/** Dataset names the engine can load, in the order they are applied (a dataset only references those before it). */
export const LOADABLE_DATASETS: readonly DatasetName[] = DATASET_ENGINES.map((engine) => engine.spec.name);
