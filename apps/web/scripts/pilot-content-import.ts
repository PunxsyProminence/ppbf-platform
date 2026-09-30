import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import {
  type CliArgs,
  datasetsFor,
  parseCliArgs,
  readDatabaseEnv,
  runApply,
  runDescribe,
  runPlan,
  runPrepare,
  runValidate,
  seedSslConfig,
} from '../src/server/pilot/contentImport/cli';
import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// The content hand-off command line (R1 route 3: files handed to Claude,
// validated, committed by PR, loaded by the seed-reference-data workflow).
//
//   npm run content:validate -- --dir <folder>           report only; exit 1 on a blocking problem
//   npm run content:prepare  -- --dir <folder> [--write] mint ids, merge into apps/web/seed-data
//   npm run content:describe [-- --write]                print (or write) docs/CONTENT_PACKAGE_CONTRACT.md
//   npm run content:plan  -- --dataset <name|all>             what a load WOULD do; writes nothing
//   npm run content:apply -- [--dry-run] --dataset <name|all> load the committed seed-data in ONE transaction
//
// validate, prepare and describe need NO DATABASE AND NO SECRETS: everything
// they check against is committed (seed-data, the loaded research package,
// skillFamilies.ts).
//
// plan and apply connect to AZURE_POSTGRES_CONNECTION_STRING, load into
// PPBF_SEED_ORG_ID as PPBF_SEED_ACCOUNT_ID (no defaults: a guessed
// organization or author is the failure), and first assert the connection
// string names the database the operator declared in
// PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE (lib/postgres-write-target.mjs;
// it fails closed when they are unset). The account is checked in the
// database by the engine (contentImport/actor.ts): gym content is loaded by an
// organization admin of that gym, never the platform owner.
//
// A THIN SHELL on purpose -- the behaviour lives in
// src/server/pilot/contentImport/cli.ts, where the tests reach it (the same
// split pilot-bootstrap-calibration-clip.ts uses).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '..');
const SEED_DATA_DIR = path.join(WEB_DIR, 'seed-data');
const CONTRACT_DOC = path.resolve(WEB_DIR, '../../docs/CONTENT_PACKAGE_CONTRACT.md');

// npm runs scripts from apps/web; INIT_CWD is where the command was typed, so
// a relative --dir means what the person typing it meant.
function resolveDir(dir: string): string {
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), dir);
}

async function runDatabaseCommand(args: CliArgs, io: { log(line: string): void }): Promise<number> {
  // Everything that can be wrong without a network is checked before one is
  // opened: a mistyped dataset should cost no connection at all.
  const datasets = datasetsFor(args.dataset as string);
  const env = readDatabaseEnv(process.env);
  const target = assertDeclaredWriteTargetFromEnv(env.connectionString);

  // Printed BEFORE anything is read or written, so an operator who declared
  // the wrong target sees which one they actually reached while Ctrl-C still
  // helps (the reasoning in pilot-bootstrap-calibration-clip.ts).
  io.log(`target_hostname: ${target.hostname}`);
  io.log(`target_database: ${target.database}`);
  io.log(`organization_id: ${env.organizationId}`);
  io.log(`seed_account_id: ${env.actorAccountId}`);

  const client = new Client({ connectionString: env.connectionString, ssl: seedSslConfig(process.env) });
  await client.connect();
  try {
    const command = {
      client,
      organizationId: env.organizationId,
      actorAccountId: env.actorAccountId,
      seedDataDir: SEED_DATA_DIR,
      datasets,
    };
    return args.command === 'plan' ? await runPlan(command, io) : await runApply({ ...command, dryRun: args.dryRun }, io);
  } finally {
    await client.end();
  }
}

async function main(): Promise<number> {
  const args = parseCliArgs(process.argv.slice(2));
  const io = { log: (line: string) => console.log(line) };

  if (args.command === 'describe') return runDescribe({ docPath: CONTRACT_DOC, write: args.write }, io);
  if (args.command === 'plan' || args.command === 'apply') return runDatabaseCommand(args, io);

  const packageDir = resolveDir(args.dir as string);
  if (!fs.existsSync(packageDir) || !fs.statSync(packageDir).isDirectory()) {
    throw new Error(`--dir ${packageDir} is not a folder`);
  }
  if (path.resolve(packageDir) === path.resolve(SEED_DATA_DIR)) {
    throw new Error('--dir is the committed seed-data folder itself; point it at the hand-off folder');
  }
  const paths = { packageDir, seedDataDir: SEED_DATA_DIR };
  return args.command === 'validate' ? runValidate(paths, io) : runPrepare({ ...paths, write: args.write }, io);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`content-import: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
