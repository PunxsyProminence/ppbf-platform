// How PPBF_PUBLIC_INTEREST_ORG_ID reaches the running app, read from the real
// workflow files and RUN, not just pattern-matched.
//
// WHY THIS TEST EXISTS
//
// The variable is optional: until an operator creates the GitHub environment
// variable, a deploy must hand the app exactly what it handed it before. The
// deploy steps therefore append it to `--set-env-vars` only when it is
// non-empty. Two things can go wrong with that and neither shows up in a
// green typecheck:
//
//   - an unset variable still adding an argument (an empty word, or an empty
//     `NAME=`) to the command that deploys production;
//   - the value being treated as something other than a plain organization id
//     -- `secretref:...` would be read by az as a secret reference.
//
// So each deploy step's own script is extracted and executed by bash with `az`
// replaced by a function that prints its arguments. What is asserted is the
// argument list az would have received.
//
// environmentInventory.workflow.test.ts does not see this variable: its parser
// reads the static assignment lines and stops at the appended array. That is
// the reason this file exists rather than an oversight in that one.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const WORKFLOW_DIR = path.resolve(__dirname, '../../../../../.github/workflows');

const NAME = 'PPBF_PUBLIC_INTEREST_ORG_ID';
const ENV_LINE = `          ${NAME}: \${{ vars.${NAME} }}`;

const DEPLOY_STEPS: Array<{ label: string; file: string; step: string; lastStatic: string }> = [
  {
    label: 'deploy-staging',
    file: 'deploy-staging.yml',
    step: 'Deploy to Azure Container App',
    lastStatic: 'AZURE_TENANT_ID=secretref:ppbf-ms-tenant-id',
  },
  {
    label: 'deploy-production',
    file: 'deploy-production.yml',
    step: 'Deploy Tested Digest to Azure Container App (Production)',
    lastStatic: 'PPBF_DURABLE_RATE_LIMIT=true',
  },
  {
    label: 'release-one-approval staging',
    file: 'release-one-approval.yml',
    step: 'Deploy to Azure Container App',
    lastStatic: 'AZURE_TENANT_ID=secretref:ppbf-ms-tenant-id',
  },
  {
    label: 'release-one-approval production',
    file: 'release-one-approval.yml',
    step: 'Deploy Tested Digest to Azure Container App (Production)',
    lastStatic: 'PPBF_DURABLE_RATE_LIMIT=true',
  },
];

function readWorkflow(file: string): string {
  return fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8').replace(/\r\n/g, '\n');
}

/** One named step, from its `- name:` line to the line before the next step. */
function stepText(file: string, step: string): string {
  const lines = readWorkflow(file).split('\n');
  const starts = lines.flatMap((line, index) => (line === `      - name: ${step}` ? [index] : []));
  if (starts.length !== 1) throw new Error(`${file}: expected one step "${step}", found ${starts.length}`);
  let end = starts[0] + 1;
  while (end < lines.length && !/^ {6}- name: /.test(lines[end]) && !/^ {0,4}\S/.test(lines[end])) end += 1;
  return lines.slice(starts[0], end).join('\n');
}

/** The step's `run: |` body, dedented, with GitHub expressions made inert. */
function runScript(file: string, step: string): string {
  const lines = stepText(file, step).split('\n');
  const runAt = lines.indexOf('        run: |');
  if (runAt === -1) throw new Error(`${file}: step "${step}" has no run block`);
  const body: string[] = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== '' && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return body.join('\n').replace(/\$\{\{[^}]*\}\}/g, 'GITHUB_EXPRESSION');
}

const BASH = process.platform === 'win32' && fs.existsSync('C:/Program Files/Git/bin/bash.exe')
  ? 'C:/Program Files/Git/bin/bash.exe'
  : 'bash';

interface Run {
  status: number | null;
  azCalls: number;
  args: string[];
  output: string;
}

function deploy(file: string, step: string, value: string | undefined): Run {
  // GitHub's default for a `run:` step is `bash -e`. The script is fed on
  // stdin so nothing between here and bash re-quotes it.
  const stub = 'az() { echo "AZ_CALL"; printf \'AZ_ARG:%s\\n\' "$@"; }\n';
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    // Job-level values the real run supplies; without them the command would
    // carry empty words that have nothing to do with the variable under test.
    RESOURCE_GROUP: 'rg-test',
    CONTAINER_APP_NAME: 'app-test',
    ACR_LOGIN_SERVER: 'acr.example.test',
    RELEASE_DIGEST: 'sha256:test',
    CONFIRM_SHA: 'test-sha',
    PPBF_APP_ORIGIN: 'https://app.example.test',
    RESEARCH_BRIDGE_EXPORT_AUDIENCE: 'audience',
    RESEARCH_BRIDGE_EXPORT_ALLOWED_CLIENT_IDS: 'client',
    RESEARCH_BRIDGE_EXPORT_ALLOWED_HOST: 'host.example.test',
  };
  if (value !== undefined) env[NAME] = value;

  const result = spawnSync(BASH, ['--noprofile', '--norc', '-e', '-s'], {
    input: stub + runScript(file, step),
    // Deliberately NOT process.env: the variable under test must be absent
    // unless this call sets it, whatever the machine running the suite has.
    env: env as NodeJS.ProcessEnv,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;

  const stdout = result.stdout.replace(/\r\n/g, '\n').split('\n');
  return {
    status: result.status,
    azCalls: stdout.filter((line) => line === 'AZ_CALL').length,
    args: stdout.filter((line) => line.startsWith('AZ_ARG:')).map((line) => line.slice('AZ_ARG:'.length)),
    output: `${result.stdout}\n${result.stderr}`,
  };
}

describe('how the interest-form organization reaches the app', () => {
  test.each(DEPLOY_STEPS)('$label: sourced from a GitHub variable, through env, never a secret', ({ file, step }) => {
    const text = stepText(file, step);
    const mentions = text.split('\n').filter((line) => line.includes(`vars.${NAME}`) || line.includes(`secrets.${NAME}`));

    // Exactly one place reads it, and that place is the step's env mapping --
    // so the value reaches the shell as data and is never spliced into it.
    expect(mentions).toEqual([ENV_LINE]);
  });

  test.each(['deploy-staging.yml', 'deploy-production.yml', 'release-one-approval.yml'])(
    '%s: nothing outside the deploy steps reads it',
    (file) => {
      const inSteps = DEPLOY_STEPS.filter((entry) => entry.file === file).length;
      const all = readWorkflow(file).split('\n').filter((line) => line.includes(`{ vars.${NAME} }`) || line.includes(`secrets.${NAME}`));
      expect(all).toEqual(Array.from({ length: inSteps }, () => ENV_LINE));
    },
  );

  test.each(DEPLOY_STEPS)('$label: unset, the app is handed exactly the static list', ({ file, step, lastStatic }) => {
    for (const value of [undefined, '']) {
      const run = deploy(file, step, value);

      expect({ status: run.status, azCalls: run.azCalls, output: run.status === 0 ? '' : run.output })
        .toEqual({ status: 0, azCalls: 1, output: '' });
      expect(run.args.filter((arg) => arg.includes('PUBLIC_INTEREST'))).toEqual([]);
      // An empty word here would be an empty argument to the production deploy.
      expect(run.args.filter((arg) => arg.trim() === '')).toEqual([]);
      expect(run.args[run.args.length - 1]).toBe(lastStatic);
      expect(run.args).toContain('PPBF_PILOT_DEFAULT_ORG_ID=secretref:ppbf-pilot-default-org-id');
    }
  });

  test.each(DEPLOY_STEPS)('$label: set, it is one more assignment and nothing else moves', ({ file, step }) => {
    const unset = deploy(file, step, undefined);
    const set = deploy(file, step, 'punxsy_prominence');

    expect({ status: set.status, azCalls: set.azCalls }).toEqual({ status: 0, azCalls: 1 });
    expect(unset.args.length).toBeGreaterThan(10);
    expect(set.args).toEqual([...unset.args, `${NAME}=punxsy_prominence`]);
  });

  test.each(DEPLOY_STEPS)('$label: a value that is not a plain organization id stops before az', ({ file, step }) => {
    for (const value of ['secretref:azure-ai-key', 'two words', 'a=b', 'org;id', ' ']) {
      const run = deploy(file, step, value);
      expect({ value, status: run.status, azCalls: run.azCalls }).toEqual({ value, status: 1, azCalls: 0 });
    }
  });
});
