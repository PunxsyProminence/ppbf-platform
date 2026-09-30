import fs from 'node:fs';
import path from 'node:path';

import type { DbClient } from './actor';
import { applyImport, type ApplyResult } from './apply';
import { emitContentImportAuditMirror } from './auditRow';
import { LOADABLE_DATASETS } from './datasets';
import { describeContract } from './describe';
import { type ImportPlan, planImport } from './plan';
import { preparePackage, type PrepareResult } from './prepare';
import { loadOfflineReferenceSets, readCommittedBaseline, skillCodesFromSkillFamilies } from './referenceSets';
import { ContentImportRefusal } from './refusal';
import { committedPath, datasetSpec, DATASETS, fileSpecByName, FILE_SPECS } from './specs';
import type { DatasetName, Finding, PackageFileInput, Warning } from './types';
import { ARCHIVE_EXTENSIONS, MEDIA_EXTENSIONS, validatePackage, validateParsed, type ValidationResult } from './validate';

// The command-line half of the core: reading a folder, printing a report,
// writing files. scripts/pilot-content-import.ts only parses argv and calls
// these, so the tests drive exactly what `npm run content:*` runs.

export interface Io {
  log(line: string): void;
}

const SKIP_DIRS = new Set(['node_modules', '.git']);

/**
 * Every file under a hand-off folder, '/'-separated and relative to it. Media
 * and archives are listed by name only -- never read -- because the only thing
 * that matters about them is that they are refused.
 */
export function readPackageDir(dir: string): PackageFileInput[] {
  const out: PackageFileInput[] = [];
  const walk = (current: string, relative: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(current, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(abs, rel);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      const isBinary = (MEDIA_EXTENSIONS as readonly string[]).includes(ext) || (ARCHIVE_EXTENSIONS as readonly string[]).includes(ext);
      const known = !isBinary && fileSpecByName(entry.name) !== undefined;
      out.push({ path: rel, text: known ? fs.readFileSync(abs, 'utf8') : '' });
    }
  };
  walk(dir, '');
  return out;
}

function where(finding: Finding): string {
  const at = finding.line ? `${finding.file}:${finding.line}` : finding.file;
  const column = finding.column ? ` ${finding.column}` : '';
  const key = finding.key ? ` (${finding.key})` : '';
  return `${at}${column}${key}`;
}

function printFindings(result: ValidationResult, io: Io): void {
  for (const file of result.parsed.files) io.log(`  read ${file.path}: ${file.rows.length} rows`);
  io.log(`BLOCKING: ${result.blocking.length}`);
  for (const finding of result.blocking) io.log(`  [${finding.code}] ${where(finding)}: ${finding.message}`);
  io.log(`WARNINGS: ${result.warnings.length}`);
  for (const warning of result.warnings) io.log(`  [${warning.code}] ${warningWhere(warning)}: ${warning.message}`);
}

function warningWhere(warning: Warning): string {
  const parts = [warning.file ?? '(package)'];
  if (warning.column) parts.push(warning.column);
  const extra: string[] = [];
  if (warning.count !== undefined) extra.push(`${warning.count} rows`);
  if (warning.samples?.length) extra.push(`e.g. ${warning.samples.join('; ')}`);
  return extra.length ? `${parts.join(' ')} (${extra.join(', ')})` : parts.join(' ');
}

interface Paths {
  packageDir: string;
  seedDataDir: string;
}

function validateDir(paths: Paths) {
  const baseline = readCommittedBaseline(paths.seedDataDir);
  const references = loadOfflineReferenceSets(paths.seedDataDir, baseline);
  const inputs = readPackageDir(paths.packageDir);
  return { baseline, references, result: validatePackage(inputs, { references, baseline }) };
}

export function runValidate(paths: Paths, io: Io): number {
  io.log(`content-import validate: ${paths.packageDir}`);
  const { result } = validateDir(paths);
  printFindings(result, io);
  if (result.parsed.files.length === 0 && result.blocking.length === 0) {
    io.log('RESULT: NOTHING TO CHECK -- no file in the folder is one the contract knows (npm run content:describe lists them).');
    return 1;
  }
  if (result.blocking.length > 0) {
    io.log(`RESULT: BLOCKED -- fix the ${result.blocking.length} blocking problem(s) above; warnings never block.`);
    return 1;
  }
  io.log(`RESULT: PASS -- 0 blocking, ${result.warnings.length} warning(s).`);
  return 0;
}

/**
 * validate --dataset <name[,name...]|all>: the COMMITTED files a load of those
 * datasets would read (readDatasetFiles, the same selection apply makes),
 * checked offline against the committed baseline -- exactly what
 * contentPackageContract.test.ts holds every PR to. No database and no secrets,
 * so the seed workflow runs it before its Azure login: a dispatch whose files
 * would be refused stops there, before any credential or connection exists
 * (seed-reference-data.yml, "Validate Package"). A dispatch may run on any
 * branch, not only main, so the PR guard alone does not cover what it loads.
 */
export function runValidateCommitted(options: { seedDataDir: string; datasets: readonly DatasetName[] }, io: Io): number {
  io.log(`content-import validate (committed seed-data): ${options.datasets.join(', ')}`);
  const baseline = readCommittedBaseline(options.seedDataDir);
  const references = loadOfflineReferenceSets(options.seedDataDir, baseline);
  const wanted = new Set<string>(options.datasets);
  const result = validateParsed({ files: baseline.files.filter((file) => wanted.has(file.spec.dataset)) }, { references, baseline });
  printFindings(result, io);
  if (result.parsed.files.length === 0) {
    io.log('RESULT: NOTHING TO CHECK -- none of those datasets has a committed file.');
    return 1;
  }
  if (result.blocking.length > 0) {
    io.log(`RESULT: BLOCKED -- ${result.blocking.length} blocking problem(s) in the committed files; a load would refuse them.`);
    return 1;
  }
  io.log(`RESULT: PASS -- 0 blocking, ${result.warnings.length} warning(s).`);
  return 0;
}

function printPrepare(result: PrepareResult, io: Io): void {
  io.log(`MINTED: ${result.minted.length} new id(s), ${result.mintedChildIds} child id(s) filled`);
  for (const entry of result.minted) io.log(`  ${entry.kind} ${entry.from} -> ${entry.to}`);
  io.log('CHANGES (relative to apps/web/seed-data):');
  for (const change of result.changes) {
    const same = change.before === change.after;
    const head = change.before === null ? 'NEW FILE' : same ? 'no change' : 'changed';
    io.log(`  ${change.path}: ${head}`);
    if (change.added.length) io.log(`    added: ${change.added.join(', ')}`);
    if (change.replaced.length) io.log(`    revised: ${change.replaced.join(', ')}`);
    if (change.unchanged.length) io.log(`    unchanged: ${change.unchanged.length}`);
    for (const parent of change.parentsReplaced) {
      io.log(
        parent.removed === 0
          ? `    ${parent.parent}: ${parent.added} row(s) added`
          : `    ${parent.parent}: its ${parent.removed} committed row(s) replaced by ${parent.added}`,
      );
    }
  }
  if (result.packageRewrites.length) {
    io.log(`HAND-OFF FILES that get their minted ids: ${result.packageRewrites.map((rewrite) => rewrite.path).join(', ')}`);
  }
  for (const notice of result.notices) io.log(`NOTICE: ${notice}`);
}

export function runPrepare(paths: Paths & { write: boolean }, io: Io): number {
  io.log(`content-import prepare: ${paths.packageDir}${paths.write ? '' : ' (dry run: nothing is written)'}`);
  const { baseline, references, result } = validateDir(paths);
  printFindings(result, io);
  if (result.blocking.length > 0) {
    io.log(`RESULT: BLOCKED -- ${result.blocking.length} blocking problem(s); nothing prepared.`);
    return 1;
  }
  if (result.parsed.files.length === 0) {
    io.log('RESULT: NOTHING TO PREPARE -- no file in the folder is one the contract knows.');
    return 1;
  }

  const baselineText = new Map<string, string>();
  for (const spec of FILE_SPECS) {
    const abs = path.join(paths.seedDataDir, committedPath(spec));
    if (fs.existsSync(abs)) baselineText.set(committedPath(spec), fs.readFileSync(abs, 'utf8'));
  }
  const prepared = preparePackage({
    validation: result,
    baseline,
    baselineText,
    claimIds: references.claimIds,
    skillCodes: skillCodesFromSkillFamilies(),
  });
  printPrepare(prepared, io);

  if (prepared.introducedFindings.length > 0) {
    io.log(`RESULT: REFUSED -- the merged files would carry ${prepared.introducedFindings.length} blocking problem(s) the committed files do not:`);
    for (const finding of prepared.introducedFindings) io.log(`  [${finding.code}] ${where(finding)}: ${finding.message}`);
    return 1;
  }

  const toWrite = prepared.changes.filter((change) => change.before !== change.after);
  if (!paths.write) {
    io.log(`RESULT: DRY RUN -- ${toWrite.length} file(s) would change. Re-run with --write to write them.`);
    return 0;
  }
  for (const change of toWrite) {
    const abs = path.join(paths.seedDataDir, change.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, change.after, 'utf8');
  }
  for (const rewrite of prepared.packageRewrites) {
    fs.writeFileSync(path.join(paths.packageDir, rewrite.path), rewrite.after, 'utf8');
  }
  io.log(
    `RESULT: WROTE ${toWrite.length} file(s) under ${paths.seedDataDir}`
    + (prepared.packageRewrites.length ? ` and put the minted ids into ${prepared.packageRewrites.length} hand-off file(s).` : '.'),
  );
  return 0;
}

export function runDescribe(options: { docPath: string; write: boolean }, io: Io): number {
  const text = describeContract();
  if (!options.write) {
    io.log(text.replace(/\n$/, ''));
    return 0;
  }
  fs.writeFileSync(options.docPath, text, 'utf8');
  io.log(`wrote ${options.docPath}`);
  return 0;
}

// ---------------------------------------------------------------------------
// plan and apply: the database half (R1 route 3's load step).
//
// They read the COMMITTED seed-data -- what the PR merged -- never a hand-off
// folder: a hand-off reaches the database only through validate, prepare, a
// PR and the seed workflow. The script supplies the connection, the target
// organization (PPBF_SEED_ORG_ID) and the acting account
// (PPBF_SEED_ACCOUNT_ID); everything below takes them as arguments, so the
// tests drive exactly this code against an embedded Postgres.

/**
 * The datasets a --dataset value names, in APPLY order (dependency order,
 * specs/index.ts), whatever order they were typed in.
 *
 *   all                                   every dataset the engine loads
 *   drill-library                         one dataset
 *   competence-levels,cohort-definitions  several, loaded together in ONE
 *                                         transaction (npm run
 *                                         seed:competence-cohorts: one
 *                                         seed-data folder, two datasets)
 *
 * A dataset the engine cannot load yet (transfer-claims) is refused by name,
 * before any connection is opened, rather than skipped: a load that reported
 * success for material it never wrote is the failure.
 */
export function datasetsFor(choice: string): DatasetName[] {
  if (choice === 'all') return [...LOADABLE_DATASETS];
  const names = choice.split(',').map((name) => name.trim());
  for (const name of names) {
    if (name === 'all') throw new Error(`'all' cannot be combined with other datasets (${choice})`);
    if ((LOADABLE_DATASETS as readonly string[]).includes(name)) continue;
    const known = DATASETS.some((dataset) => dataset.name === name);
    throw new Error(
      known
        ? `dataset ${name} has no database loader in the content-import engine yet; it loads: ${LOADABLE_DATASETS.join(', ')}`
        : `unknown dataset ${name || '(empty)'}; choose all, or one or more (comma-separated) of: ${LOADABLE_DATASETS.join(', ')}`,
    );
  }
  if (new Set(names).size !== names.length) throw new Error(`a dataset is named twice in ${choice}`);
  return LOADABLE_DATASETS.filter((name) => names.includes(name));
}

/** The committed files of these datasets, keyed by their path under seed-data. A missing file is simply not handed over. */
export function readDatasetFiles(seedDataDir: string, datasets: readonly DatasetName[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of datasets) {
    for (const spec of datasetSpec(name).files) {
      const relative = committedPath(spec);
      const absolute = path.join(seedDataDir, relative);
      if (fs.existsSync(absolute)) files[relative] = fs.readFileSync(absolute, 'utf8');
    }
  }
  return files;
}

const OUTCOME_LABEL = {
  new: 'new',
  new_version: 'new version',
  unchanged: 'unchanged',
  absent: 'absent',
  reject: 'reject',
} as const;

/** The plan as printed. `plan` and `apply --dry-run` print exactly these lines for the same database state. */
export function formatPlan(plan: ImportPlan): string[] {
  const lines = [`PLAN for organization ${plan.organizationId}, acting account ${plan.actor.accountId} (${plan.actor.role})`];
  for (const name of plan.datasets) {
    const counts = plan.counts[name];
    if (!counts) continue;
    lines.push(
      `  ${name}: ${(Object.keys(OUTCOME_LABEL) as (keyof typeof OUTCOME_LABEL)[])
        .map((outcome) => `${counts[outcome]} ${OUTCOME_LABEL[outcome]}`)
        .join(', ')}`,
    );
    for (const unit of plan.units) {
      if (unit.dataset !== name) continue;
      const label = unit.packageKey ? `${unit.key} (${unit.packageKey})` : unit.key;
      switch (unit.outcome) {
        case 'new':
          lines.push(`    new ${label}: history v${unit.toVersion}`);
          break;
        case 'new_version':
          lines.push(
            `    new version ${label}: history v${unit.fromVersion} -> v${unit.toVersion}`
            + (unit.recordsBefore ? ` (v${unit.fromVersion} records the row as it stands now)` : ''),
          );
          break;
        case 'reject':
          lines.push(`    reject ${label}: ${(unit.reasons ?? []).join(' | ')}`);
          break;
        case 'absent':
          lines.push(`    absent ${label}: not in the files; left alone`);
          break;
        default:
          break;
      }
    }
  }
  lines.push(`BLOCKING: ${plan.blocking.length}`);
  for (const finding of plan.blocking) lines.push(`  [${finding.code}] ${where(finding)}: ${finding.message}`);
  lines.push(`WARNINGS: ${plan.warnings.length}`);
  for (const warning of plan.warnings) lines.push(`  [${warning.code}] ${warningWhere(warning)}: ${warning.message}`);
  lines.push(`PLAN_HASH: ${plan.planHash}`);
  return lines;
}

export interface DatabaseCommand {
  client: DbClient;
  organizationId: string;
  actorAccountId: string;
  seedDataDir: string;
  datasets: readonly DatasetName[];
}

async function previewPlan(command: DatabaseCommand, files: Record<string, string>): Promise<ImportPlan> {
  // READ ONLY: the database itself refuses any write the plan might attempt,
  // which is a stronger promise than "plan only issues SELECTs".
  await command.client.query('BEGIN READ ONLY');
  try {
    return await planImport({ client: command.client, organizationId: command.organizationId, actorAccountId: command.actorAccountId, files });
  } finally {
    await command.client.query('ROLLBACK').catch(() => undefined);
  }
}

function startLine(command: DatabaseCommand, verb: string): string {
  return `content-import ${verb}: ${command.datasets.join(', ')}`;
}

export async function runPlan(command: DatabaseCommand, io: Io): Promise<number> {
  io.log(startLine(command, 'plan'));
  const files = readDatasetFiles(command.seedDataDir, command.datasets);
  if (Object.keys(files).length === 0) {
    io.log('RESULT: NOTHING TO PLAN -- none of those datasets has a committed file.');
    return 1;
  }
  let plan: ImportPlan;
  try {
    plan = await previewPlan(command, files);
  } catch (error) {
    if (error instanceof ContentImportRefusal) {
      io.log(`RESULT: REFUSED -- ${error.message}`);
      return 1;
    }
    throw error;
  }
  for (const line of formatPlan(plan)) io.log(line);
  if (plan.blocking.length > 0) {
    io.log(`RESULT: BLOCKED -- ${plan.blocking.length} blocking problem(s); apply would refuse.`);
    return 1;
  }
  io.log(`RESULT: PLANNED -- ${plan.changes} item(s) would be written. Nothing was written.`);
  return 0;
}

function printApplied(result: ApplyResult, io: Io): void {
  for (const [name, written] of Object.entries(result.written)) {
    if (!written) continue;
    io.log(
      `  ${name}: inserted ${written.inserted.length}${written.inserted.length ? ` (${written.inserted.join(', ')})` : ''}, `
      + `revised ${written.updated.length}${written.updated.length ? ` (${written.updated.join(', ')})` : ''}, `
      + `history rows ${written.ledgerRows}`,
    );
  }
  if (result.importId) io.log(`  import_id ${result.importId}, audit_id ${result.auditId}`);
}

/**
 * Plan, print, then apply in ONE transaction: every dataset asked for (all of
 * them for 'all') commits together or not at all. --dry-run still APPLIES --
 * every insert, update, ledger and audit row really runs -- and then rolls
 * back, so a dry run proves the data fits the live schema (its CHECKs,
 * foreign keys and triggers), which a plan alone cannot (the critique's
 * correction: seed-reference-data.yml's dry-run has always meant this).
 */
export async function runApply(command: DatabaseCommand & { dryRun: boolean }, io: Io): Promise<number> {
  io.log(startLine(command, command.dryRun ? 'apply --dry-run' : 'apply'));
  const files = readDatasetFiles(command.seedDataDir, command.datasets);
  if (Object.keys(files).length === 0) {
    io.log('RESULT: NOTHING TO APPLY -- none of those datasets has a committed file.');
    return 1;
  }

  let result: ApplyResult;
  try {
    const plan = await previewPlan(command, files);
    for (const line of formatPlan(plan)) io.log(line);
    if (plan.blocking.length > 0) {
      io.log(`RESULT: BLOCKED -- ${plan.blocking.length} blocking problem(s); nothing was written.`);
      return 1;
    }

    await command.client.query('BEGIN');
    try {
      result = await applyImport({
        client: command.client,
        organizationId: command.organizationId,
        actorAccountId: command.actorAccountId,
        files,
        expectedPlanHash: plan.planHash,
      });
    } catch (error) {
      // Whatever threw -- a refusal, Postgres, or plain JavaScript after the
      // first write -- nothing of this import may commit.
      await command.client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
    await command.client.query(command.dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (error) {
    if (error instanceof ContentImportRefusal) {
      io.log(`RESULT: REFUSED -- ${error.message}`);
      return 1;
    }
    throw error;
  }

  printApplied(result, io);
  if (!result.importId) {
    io.log('RESULT: NOTHING TO APPLY -- every item is unchanged or absent; nothing was written.');
    return 0;
  }
  if (command.dryRun) {
    io.log(`RESULT: DRY RUN -- applied inside the transaction and ROLLED BACK; nothing was written (${result.plan.changes} item(s) would change).`);
    return 0;
  }
  io.log(`RESULT: COMMITTED -- ${result.plan.changes} item(s) written, import_id ${result.importId}.`);

  if (result.audit) {
    try {
      await emitContentImportAuditMirror(command.client, result.audit);
    } catch (error) {
      io.log(
        `WARNING: the import IS COMMITTED (import_id ${result.importId}, audit_id ${result.auditId}); only the SHADOW audit mirror `
        + `written after commit failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }
  return 0;
}

/** The TLS rule the retired seed-*.mjs loaders used (their resolveSslConfig): off only for a test run that asks. */
export function seedSslConfig(env: Readonly<Record<string, string | undefined>>): false | { rejectUnauthorized: true } {
  return env.NODE_ENV === 'test' && env.PPBF_POSTGRES_DISABLE_SSL === 'true' ? false : { rejectUnauthorized: true };
}

export interface DatabaseEnv {
  connectionString: string;
  organizationId: string;
  actorAccountId: string;
}

/**
 * No defaults, on purpose: a loader that guesses its organization writes real
 * rows under the wrong one (the retired seed loaders once defaulted to
 * 'ppbf-default-org'; seedWorkflowContract.test.ts records that drift), and a
 * guessed account is a guessed author.
 */
export function readDatabaseEnv(env: Readonly<Record<string, string | undefined>>): DatabaseEnv {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  };
  return {
    connectionString: required('AZURE_POSTGRES_CONNECTION_STRING'),
    organizationId: required('PPBF_SEED_ORG_ID'),
    actorAccountId: required('PPBF_SEED_ACCOUNT_ID'),
  };
}

export interface CliArgs {
  command: 'validate' | 'prepare' | 'describe' | 'plan' | 'apply';
  dir?: string;
  write: boolean;
  /** plan, apply, and validate of the committed files: a dataset, a comma-separated list, or 'all'. */
  dataset?: string;
  dryRun: boolean;
}

const USAGE =
  'usage: pilot-content-import.ts validate --dir <path> | validate --dataset <name|all> | prepare --dir <path> [--write]'
  + ' | describe [--write] | plan --dataset <name|all> | apply [--dry-run] --dataset <name|all>';

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const [command, ...rest] = argv;
  if (command !== 'validate' && command !== 'prepare' && command !== 'describe' && command !== 'plan' && command !== 'apply') {
    throw new Error(USAGE);
  }
  let dir: string | undefined;
  let dataset: string | undefined;
  let write = false;
  let dryRun = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--dir') {
      dir = rest[i + 1];
      i += 1;
    } else if (arg.startsWith('--dir=')) {
      dir = arg.slice('--dir='.length);
    } else if (arg === '--dataset') {
      dataset = rest[i + 1];
      i += 1;
    } else if (arg.startsWith('--dataset=')) {
      dataset = arg.slice('--dataset='.length);
    } else if (arg === '--write') {
      write = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }

  if (command === 'plan' || command === 'apply') {
    if (!dataset) throw new Error(`${command} needs --dataset <name|all>`);
    if (dir !== undefined) throw new Error(`${command} reads the committed seed-data, not a folder; check a hand-off with validate --dir`);
    if (write) throw new Error(`${command} does not take --write`);
    if (command === 'plan' && dryRun) throw new Error('plan never writes; --dry-run belongs to apply');
    return { command, dataset, write, dryRun };
  }

  if (dryRun) throw new Error(`${command} does not take --dry-run`);
  if (command === 'validate' && write) throw new Error('validate never writes; use prepare --write');
  if (command === 'validate' && dataset !== undefined) {
    // The committed files a load would read, not a hand-off folder: the seed
    // workflow's offline check (runValidateCommitted).
    if (dir !== undefined) throw new Error('validate takes --dir <hand-off folder> or --dataset <name|all>, not both');
    return { command, dataset, write, dryRun };
  }
  if (dataset !== undefined) throw new Error(`${command} does not take --dataset`);
  if (command !== 'describe' && !dir) throw new Error(`${command} needs --dir <path>`);
  return { command, dir, write, dryRun };
}
