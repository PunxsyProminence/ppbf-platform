#!/usr/bin/env node
//
// Runs every .pg.test.ts suite, discovered rather than listed.
//
// WHY THIS REPLACED A CHAIN. `test:migrations` was a single 5,000-character
// package.json line naming 118 scripts with `&&`. Two things were wrong with
// it, and only one was cosmetic.
//
// The cosmetic one: it is a conflict magnet. Any two branches that add a pg
// suite both append to that one line, so they conflict every time. That
// happened FIVE times in a single session.
//
// The one that mattered: it is a hand-maintained list, and this repository has
// been bitten by that three times over. pgTestCoverage.test.ts exists because
// this exact chain silently lost SEVEN suites -- complianceMigration,
// progressionMigration, publicationsMigration, drillsPersistence,
// guardianInviteLink, durableRateLimit and assistantMessageIdempotency all
// existed, all passed, and none had ever run in CI. The guard caught it after
// the fact; discovery makes it unrepresentable.
//
// EQUIVALENCE, MEASURED BEFORE THE SWAP. At the moment of this change the two
// sets were identical: the chain named 118 scripts, package.json defined 118
// `test:migrations:*` scripts, and the difference in BOTH directions was
// empty. So running every defined script executes exactly what the chain
// executed. That is asserted continuously by migrationRunnerCoverage.test.ts,
// not just claimed here.
//
// This matters more than a test script usually would: `npm run test:migrations`
// runs inside deploy-production.yml and pre-release-migrations.yml. A runner
// that quietly skipped a suite would drop a migration guard immediately before
// a production deploy.
//
// ORDER is package.json definition order -- deterministic, and no list anybody
// has to maintain. Each suite provisions its own disposable database, so no
// suite depends on another having run first.
//
// FAIL-FAST, like the `&&` chain it replaces. Stopping at the first failure is
// the behaviour CI and the deploy workflows already depend on.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_JSON = path.join(WEB_DIR, 'package.json');

/** Every `test:migrations:<slug>` script, in definition order. */
export function discoverSuiteScripts(scripts) {
  return Object.keys(scripts).filter((name) => /^test:migrations:[a-z0-9-]+$/.test(name));
}

/**
 * The suites one CI shard runs: `--shard=N/M` takes every M-th suite starting
 * at the N-th, in definition order. No argument runs every suite, which is
 * what every caller but ci.yml's `pg` matrix passes.
 *
 * ROUND-ROBIN, NOT TIMED. Measured on #1685 (314 suites, 2427 s): round-robin
 * over 4 shards gave a slowest shard of 10.5 min against 10.1 for a split
 * balanced on the measured durations, so a timing file would buy 0.4 min and
 * need maintaining.
 *
 * Any other argument is refused rather than ignored: `--shard 1/4` (a space)
 * or a misspelling would otherwise run every suite in every shard, or none.
 */
export function selectShard(suites, argv) {
  if (argv.length === 0) return suites;
  const match = argv.length === 1 ? /^--shard=([1-9]\d*)\/([1-9]\d*)$/.exec(argv[0]) : null;
  if (!match) {
    throw new Error(`expected no arguments or one --shard=N/M, got: ${argv.join(' ')}`);
  }
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (index > total || total > suites.length) {
    throw new Error(`--shard=${index}/${total} is out of range for ${suites.length} suites`);
  }
  return suites.filter((_, position) => position % total === index - 1);
}

function main() {
  const { scripts } = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  const discovered = discoverSuiteScripts(scripts);

  // A floor, not decoration. If the regex or the manifest shape ever changed,
  // discovery could return nothing -- and a runner that runs zero suites and
  // exits 0 would report every migration guarded while guarding none. That is
  // the failure mode a chain cannot have and a discovery runner can, so it is
  // refused explicitly.
  if (discovered.length < 50) {
    console.error(
      `run-migration-suites: discovered only ${discovered.length} suite scripts, which cannot be right.\n`
      + 'Expected 100+. Either package.json is truncated (see scripts/verify-package-integrity.mjs\n'
      + 'for why that is a real failure mode here) or the naming convention changed. Refusing to\n'
      + 'report success while running almost nothing.',
    );
    process.exit(1);
  }

  let suites;
  try {
    suites = selectShard(discovered, process.argv.slice(2));
  } catch (error) {
    console.error(`run-migration-suites: ${error.message}`);
    process.exit(1);
  }

  console.log(
    suites === discovered
      ? `run-migration-suites: ${discovered.length} suites discovered\n`
      : `run-migration-suites: ${discovered.length} suites discovered; ${process.argv[2]} runs ${suites.length}\n`,
  );

  let index = 0;
  for (const suite of suites) {
    index += 1;
    console.log(`--- [${index}/${suites.length}] ${suite}`);
    const result = spawnSync('npm', ['run', suite], { cwd: WEB_DIR, stdio: 'inherit' });

    if (result.error) {
      console.error(`run-migration-suites: could not start ${suite}: ${result.error.message}`);
      process.exit(1);
    }
    if (result.status !== 0) {
      // Fail-fast, matching the `&&` chain. The suite has already printed its
      // own failure; this names which one stopped the run so the reader does
      // not have to scroll for it.
      console.error(`\nrun-migration-suites: FAILED at [${index}/${suites.length}] ${suite}`);
      process.exit(result.status ?? 1);
    }
  }

  console.log(`\nrun-migration-suites: all ${suites.length} suites passed`);
}

// Importable for the coverage test without running the suites.
const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  main();
}
