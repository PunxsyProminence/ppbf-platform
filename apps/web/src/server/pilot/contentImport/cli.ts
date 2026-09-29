import fs from 'node:fs';
import path from 'node:path';

import { describeContract } from './describe';
import { preparePackage, type PrepareResult } from './prepare';
import { loadOfflineReferenceSets, readCommittedBaseline, skillCodesFromSkillFamilies } from './referenceSets';
import { committedPath, fileSpecByName, FILE_SPECS } from './specs';
import type { Finding, PackageFileInput, Warning } from './types';
import { ARCHIVE_EXTENSIONS, MEDIA_EXTENSIONS, validatePackage, type ValidationResult } from './validate';

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

export interface CliArgs {
  command: 'validate' | 'prepare' | 'describe';
  dir?: string;
  write: boolean;
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const [command, ...rest] = argv;
  if (command !== 'validate' && command !== 'prepare' && command !== 'describe') {
    throw new Error('usage: pilot-content-import.ts validate --dir <path> | prepare --dir <path> [--write] | describe [--write]');
  }
  let dir: string | undefined;
  let write = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--dir') {
      dir = rest[i + 1];
      i += 1;
    } else if (arg.startsWith('--dir=')) {
      dir = arg.slice('--dir='.length);
    } else if (arg === '--write') {
      write = true;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (command !== 'describe' && !dir) throw new Error(`${command} needs --dir <path>`);
  if (command === 'validate' && write) throw new Error('validate never writes; use prepare --write');
  return { command, dir, write };
}
