// shadow-eval.mjs -- print SHADOW's offline evaluation table.
//
//   npm run shadow:eval               print pass/fail per case, compared with baseline.json
//   npm run shadow:eval -- --update   rewrite baseline.json from the current code first
//
// Runs the evaluation jest suite with its report switched on. Fixed cases from
// the repo only: no live data, no hosted model call.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jestBin = path.resolve(webRoot, '../../node_modules/jest/bin/jest.js');
const update = process.argv.includes('--update');

const run = spawnSync(
  process.execPath,
  [jestBin, '--runTestsByPath', 'src/server/pilot/evaluation/evaluation.test.ts', '--silent=false'],
  {
    cwd: webRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      SHADOW_EVAL_REPORT: '1',
      ...(update ? { SHADOW_EVAL_UPDATE: '1' } : {}),
    },
  },
);

process.exit(run.status ?? 1);
