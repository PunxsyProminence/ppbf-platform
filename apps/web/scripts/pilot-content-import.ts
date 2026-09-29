import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCliArgs, runDescribe, runPrepare, runValidate } from '../src/server/pilot/contentImport/cli';

// The content hand-off command line (R1 route 3: files handed to Claude,
// validated, committed by PR, loaded by the seed-reference-data workflow).
//
//   npm run content:validate -- --dir <folder>           report only; exit 1 on a blocking problem
//   npm run content:prepare  -- --dir <folder> [--write] mint ids, merge into apps/web/seed-data
//   npm run content:describe [-- --write]                print (or write) docs/CONTENT_PACKAGE_CONTRACT.md
//
// NO DATABASE AND NO SECRETS. Everything it checks against is committed:
// seed-data, the loaded research package and skillFamilies.ts. A THIN SHELL on
// purpose -- the behaviour lives in src/server/pilot/contentImport/cli.ts,
// where the tests reach it (the same split pilot-bootstrap-calibration-clip.ts
// uses).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '..');
const SEED_DATA_DIR = path.join(WEB_DIR, 'seed-data');
const CONTRACT_DOC = path.resolve(WEB_DIR, '../../docs/CONTENT_PACKAGE_CONTRACT.md');

// npm runs scripts from apps/web; INIT_CWD is where the command was typed, so
// a relative --dir means what the person typing it meant.
function resolveDir(dir: string): string {
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), dir);
}

function main(): number {
  const args = parseCliArgs(process.argv.slice(2));
  const io = { log: (line: string) => console.log(line) };

  if (args.command === 'describe') return runDescribe({ docPath: CONTRACT_DOC, write: args.write }, io);

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

try {
  process.exitCode = main();
} catch (error) {
  console.error(`content-import: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
