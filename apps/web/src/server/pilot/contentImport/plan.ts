import { assertImportActor, type DbClient, type ImportActor } from './actor';
import { sha256Hex } from './canonical';
import {
  DATASET_ENGINES,
  datasetEngine,
  type DatasetPlan,
  type EngineContext,
  UNIT_OUTCOMES,
  type UnitOutcome,
  type UnitPlan,
} from './datasets';
import { loadDatabaseReferenceSets } from './referenceSetsDb';
import { DATASETS } from './specs';
import type { DatasetName, Finding, PackageFileInput, ParsedFile, Warning } from './types';
import { parsePackage, validateParsed } from './validate';

// STAGE 3 OF THE CONTENT-IMPORT CORE: PLAN. READ-ONLY.
//
// THE SEAM (plan, architecture section): the core takes a client, the target
// organization, the acting account and the package files as {name: text}, and
// never reads the environment or the disk. The seed CLI hands it the committed
// seed-data (R1 "for seeding it will be 3"); the later upload route will hand
// it the files from a request body with the organization from the session
// (R1 "for future work it will be 2"). Same code, same answer.
//
// WHAT A PLAN IS. Every item in the package gets one outcome:
//   new          not in the database; would be inserted
//   new_version  in the database with different content; would be revised
//   unchanged    in the database with the same content; nothing is written
//   absent       in the database, not in the package; listed, never touched
//   reject       has a blocking finding; the whole plan cannot be applied
// plus the validator's blocking findings and warnings (validate.ts), judged
// against what THIS organization holds (referenceSetsDb.ts), and a plan_hash.
//
// THE PLAN HASH is what makes "apply what you were shown" enforceable: it
// covers every unit's outcome, the content hashes on both sides, the ledger
// versions it would write, and the blocking findings. apply.ts plans again
// under lock and refuses if the hash moved -- someone else wrote in between,
// so what the person approved is no longer what would be written.

export interface ImportRequest {
  client: DbClient;
  organizationId: string;
  actorAccountId: string;
  /** Package files: name (a path such as 'multidiscipline/seed_disciplines.csv', or the bare file name) -> text. */
  files: Readonly<Record<string, string>>;
}

export type OutcomeCounts = Record<UnitOutcome, number>;

export interface ImportPlan {
  organizationId: string;
  actor: ImportActor;
  /** Datasets present in the package that the engine loads, in apply order. */
  datasets: DatasetName[];
  units: UnitPlan[];
  counts: Partial<Record<DatasetName, OutcomeCounts>>;
  totals: OutcomeCounts;
  blocking: Finding[];
  warnings: Warning[];
  /** new + new_version: the number of items an apply would write. */
  changes: number;
  planHash: string;
}

export interface PlannedImport {
  plan: ImportPlan;
  context: EngineContext;
  datasetPlans: DatasetPlan[];
}

export function packageInputs(files: Readonly<Record<string, string>>): PackageFileInput[] {
  return Object.entries(files).map(([path, text]) => ({ path: path.replace(/\\/g, '/'), text }));
}

function emptyCounts(): OutcomeCounts {
  return Object.fromEntries(UNIT_OUTCOMES.map((outcome) => [outcome, 0])) as OutcomeCounts;
}

function datasetOrder(name: DatasetName): number {
  return DATASETS.findIndex((dataset) => dataset.name === name);
}

/** Dataset order, then key: the order a plan is printed and hashed in. */
export function compareUnits(a: UnitPlan, b: UnitPlan): number {
  return datasetOrder(a.dataset) - datasetOrder(b.dataset) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

function computePlanHash(organizationId: string, actor: ImportActor, datasets: DatasetName[], units: UnitPlan[], blocking: Finding[]): string {
  const unitRows = [...units].sort(compareUnits).map((unit) => [
    unit.dataset,
    unit.key,
    unit.packageKey ?? null,
    unit.outcome,
    // An absent item is never touched, so only its presence counts: an edit
    // made elsewhere to a row this package does not name must not make the
    // plan stale.
    unit.outcome === 'absent' ? null : unit.fileSha256 ?? null,
    unit.outcome === 'absent' ? null : unit.databaseSha256 ?? null,
    unit.fromVersion ?? null,
    unit.toVersion ?? null,
    unit.recordsBefore ?? false,
  ]);
  const findingRows = blocking
    .map((finding) => JSON.stringify([finding.code, finding.file, finding.line ?? null, finding.column ?? null, finding.key ?? null, finding.message]))
    .sort();
  return sha256Hex(JSON.stringify({ format: 1, organizationId, actor: actor.accountId, datasets, units: unitRows, blocking: findingRows }));
}

/**
 * The plan and what the dataset modules need to write it. apply.ts calls this
 * inside its transaction, after taking its locks; `actor` lets it pass the
 * account it already checked there.
 */
export async function planWithState(request: ImportRequest, checkedActor?: ImportActor): Promise<PlannedImport> {
  const { client, organizationId } = request;
  const actor = checkedActor ?? (await assertImportActor(client, organizationId, request.actorAccountId));
  const context: EngineContext = { client, organizationId, actor };

  const { parsed, findings, warnings } = parsePackage(packageInputs(request.files));
  const present = new Set(parsed.files.map((file) => file.spec.dataset));
  const engines = DATASET_ENGINES.filter((engine) => present.has(engine.spec.name));

  // A file of a dataset with no database loader here is refused, not skipped:
  // "a type you leave out is left untouched" is about the hand-off, and this
  // file was handed over. Loading only part of a package would report success
  // for material that never arrived.
  const unloadable: Finding[] = parsed.files
    .filter((file) => !datasetEngine(file.spec.dataset))
    .map((file) => ({
      code: 'dataset_not_loadable',
      file: file.path,
      message: `${file.spec.file} is ${file.spec.dataset} material, which the content-import engine cannot load yet (it loads ${DATASET_ENGINES.map((engine) => engine.spec.name).join(', ')}). Hand it over separately.`,
    }));

  const references = await loadDatabaseReferenceSets(client, organizationId);
  const baseline: ParsedFile[] = [];
  for (const engine of engines) baseline.push(...(await engine.readBaseline(context)));
  const validation = validateParsed(parsed, { references, baseline: { files: baseline } }, findings, warnings);

  const datasetPlans: DatasetPlan[] = [];
  for (const engine of engines) {
    const files = parsed.files.filter((file) => file.spec.dataset === engine.spec.name);
    datasetPlans.push(await engine.plan(context, { files, validation }));
  }

  const units = datasetPlans.flatMap((plan) => plan.units).sort(compareUnits);
  const blocking = [...validation.blocking, ...unloadable, ...datasetPlans.flatMap((plan) => plan.findings)];
  const datasets = engines.map((engine) => engine.spec.name);

  const counts: Partial<Record<DatasetName, OutcomeCounts>> = {};
  const totals = emptyCounts();
  for (const name of datasets) counts[name] = emptyCounts();
  for (const unit of units) {
    (counts[unit.dataset] as OutcomeCounts)[unit.outcome] += 1;
    totals[unit.outcome] += 1;
  }

  const plan: ImportPlan = {
    organizationId,
    actor,
    datasets,
    units,
    counts,
    totals,
    blocking,
    warnings: validation.warnings,
    changes: totals.new + totals.new_version,
    planHash: computePlanHash(organizationId, actor, datasets, units, blocking),
  };
  return { plan, context, datasetPlans };
}

/** Plan an import. Issues SELECTs only; the caller may run it in a READ ONLY transaction. */
export async function planImport(request: ImportRequest): Promise<ImportPlan> {
  return (await planWithState(request)).plan;
}
