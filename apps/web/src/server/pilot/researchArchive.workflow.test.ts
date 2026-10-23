// How the four RESEARCH_ARCHIVE_* settings reach the production app, read from
// the real workflow files and RUN, not just pattern-matched (the method of
// publicInterestOrg.workflow.test.ts).
//
// WHY THIS TEST EXISTS
//
// In-app filing of research originals in the SharePoint Research Archive is
// switched on by four settings together (readResearchArchiveSetup in
// researchArchiveConfig.ts). Until an operator creates the four GitHub
// production-environment variables, a production deploy must hand the app
// exactly what it handed it before, so filing stays off. Once some exist, three
// things can go wrong and none shows up in a green typecheck:
//
//   - a half-set archive deployed: the app reads it as "incomplete" and refuses
//     every filing, and nobody is told until a curator tries;
//   - a value the app would refuse (each one goes into a Graph URL), or one az
//     would read as `secretref:...`, deployed anyway;
//   - an unset variable still adding an argument -- an empty word or `NAME=` --
//     to the command that deploys production.
//
// So each production deploy step's own script is extracted and executed by
// bash with `az` replaced by a function that prints its arguments, and what is
// asserted is the argument list az would have received.
//
// WHAT THIS CANNOT SHOW. Nothing here evaluates a GitHub expression or talks to
// Azure. It cannot see whether the variables exist on the production
// environment, or whether their values name the real site, drive and folder.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { RESEARCH_ARCHIVE_SETTINGS, readResearchArchiveSetup } from './researchArchiveConfig';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const WORKFLOW_DIR = path.join(REPO_ROOT, '.github/workflows');

const NAMES = [
  'RESEARCH_ARCHIVE_SITE_ID',
  'RESEARCH_ARCHIVE_DRIVE_ID',
  'RESEARCH_ARCHIVE_ROOT_ITEM_ID',
  'RESEARCH_ARCHIVE_ORGANIZATION_IDS',
] as const;
type Name = (typeof NAMES)[number];

/** Shapes only -- invented values, not the real site, drive or folder. */
const VALID: Record<Name, string> = {
  RESEARCH_ARCHIVE_SITE_ID: 'example.sharepoint.com,11111111-2222-3333-4444-555555555555,66666666-7777-8888-9999-000000000000',
  RESEARCH_ARCHIVE_DRIVE_ID: 'b!-Vo_driveId-123',
  RESEARCH_ARCHIVE_ROOT_ITEM_ID: '0154ROOTITEM',
  RESEARCH_ARCHIVE_ORGANIZATION_IDS: 'example_gym,__platform__',
};

const PRODUCTION_STEP = 'Deploy Tested Digest to Azure Container App (Production)';
const DEPLOY_STEPS: Array<{ label: string; file: string }> = [
  { label: 'deploy-production', file: 'deploy-production.yml' },
  { label: 'release-one-approval production', file: 'release-one-approval.yml' },
];
const LAST_STATIC = 'PPBF_DURABLE_RATE_LIMIT=true';

const readsFromGithub = (name: string): RegExp =>
  new RegExp(`(vars|secrets|env)\\s*(\\.\\s*|\\[\\s*['"])${name}\\b`);
const envLine = (name: string): string => `          ${name}: \${{ vars.${name} }}`;

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

function deploy(file: string, values: Partial<Record<string, string>>): Run {
  // GitHub's default for a `run:` step is `bash -e`. The script is fed on
  // stdin so nothing between here and bash re-quotes it.
  const stub = 'az() { echo "AZ_CALL"; printf \'AZ_ARG:%s\\n\' "$@"; }\n';
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    // Job-level values the real run supplies.
    RESOURCE_GROUP: 'rg-test',
    CONTAINER_APP_NAME: 'app-test',
    ACR_LOGIN_SERVER: 'acr.example.test',
    RELEASE_DIGEST: 'sha256:test',
    CONFIRM_SHA: 'test-sha',
    PPBF_APP_ORIGIN: 'https://app.example.test',
  };
  for (const [name, value] of Object.entries(values)) if (value !== undefined) env[name] = value;

  const result = spawnSync(BASH, ['--noprofile', '--norc', '-e', '-s'], {
    input: stub + runScript(file, PRODUCTION_STEP),
    // Deliberately NOT process.env: the variables under test must be absent
    // unless this call sets them, whatever the machine running the suite has.
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

const assignments = (values: Record<Name, string>): string[] => NAMES.map((name) => `${name}=${values[name]}`);
const token = async (): Promise<string> => 'test-token';

// Every proper, non-empty subset of the four: 14 ways to set some but not all.
const PARTIAL: Name[][] = Array.from({ length: 2 ** NAMES.length - 2 }, (_, index) =>
  NAMES.filter((_name, bit) => ((index + 1) >> bit) & 1));

/**
 * Candidate values per variable, both kinds. The app strips whitespace before
 * it checks a shape; none of these holds any, so on these the workflow and the
 * app must agree exactly. Whitespace is covered separately below.
 */
const CANDIDATES: Record<Name, string[]> = {
  RESEARCH_ARCHIVE_SITE_ID: [
    VALID.RESEARCH_ARCHIVE_SITE_ID,
    'EXAMPLE.SharePoint.com,AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE,ffffffff-0000-1111-2222-333333333333',
    'example.sharepoint.com,11111111-2222-3333-4444-555555555555',
    'example.sharepoint.com,11111111-2222-3333-4444-55555555555g,66666666-7777-8888-9999-000000000000',
    'example.sharepoint.com,11111111-2222-3333-4444-55555555555,66666666-7777-8888-9999-000000000000',
    'example.sharepoint.com,11111111-2222-3333-4444-555555555555,66666666-7777-8888-9999-0000000000000',
    'example.sharepoint.com:443,11111111-2222-3333-4444-555555555555,66666666-7777-8888-9999-000000000000',
    'example.sharepoint.com,11111111-2222-3333-4444-555555555555,66666666-7777-8888-9999-000000000000,x',
    ',11111111-2222-3333-4444-555555555555,66666666-7777-8888-9999-000000000000',
    'example.sharepoint.com/sites/x,11111111-2222-3333-4444-555555555555,66666666-7777-8888-9999-000000000000',
    'secretref:azure-ai-key',
  ],
  RESEARCH_ARCHIVE_DRIVE_ID: [
    VALID.RESEARCH_ARCHIVE_DRIVE_ID, 'b!x', 'B!abc', 'b!', 'b!abc/def', 'b!abc;rm', 'b!a:b', 'b!a.b', 'b!a+b', 'b!a=b',
    'secretref:ppbf-ms-client-secret',
  ],
  RESEARCH_ARCHIVE_ROOT_ITEM_ID: [
    VALID.RESEARCH_ARCHIVE_ROOT_ITEM_ID, 'abc123', 'root-item', '01_ROOT', '../root', 'a=b', 'a:b', 'a.b', 'secretref:x',
  ],
  RESEARCH_ARCHIVE_ORGANIZATION_IDS: [
    VALID.RESEARCH_ARCHIVE_ORGANIZATION_IDS,
    'punxsy_prominence',
    'a-b,c_d,E9',
    'example_gym,',
    ',example_gym',
    'example_gym,,__platform__',
    'org.id',
    'a:b',
    'a"b',
    "a'b",
    'secretref:ppbf-pilot-default-org-id',
  ],
};

/** The SHAPE_* patterns a step's own script tests values against. */
function workflowShapes(file: string): Record<Name, RegExp> {
  const shapes: Partial<Record<Name, RegExp>> = {};
  for (const line of runScript(file, PRODUCTION_STEP).split('\n')) {
    const match = /^\s*SHAPE_([A-Z_]+)='([^']*)'$/.exec(line);
    if (match) shapes[`RESEARCH_ARCHIVE_${match[1]}` as Name] = new RegExp(match[2]);
  }
  expect(Object.keys(shapes).sort()).toEqual([...NAMES].sort());
  return shapes as Record<Name, RegExp>;
}

/**
 * Every one-character edit of a valid value: each printable, non-space ASCII
 * character inserted at every position or put in place of every character,
 * and every character deleted or doubled (a GUID one short or one long).
 */
function oneCharacterEdits(value: string): string[] {
  const printable = Array.from({ length: 0x7e - 0x21 + 1 }, (_, offset) => String.fromCharCode(0x21 + offset));
  const edits = new Set<string>();
  for (let at = 0; at <= value.length; at += 1) {
    for (const character of printable) {
      edits.add(value.slice(0, at) + character + value.slice(at));
      if (at < value.length) edits.add(value.slice(0, at) + character + value.slice(at + 1));
    }
    if (at < value.length) {
      edits.add(value.slice(0, at) + value.slice(at + 1));
      edits.add(value.slice(0, at) + value[at] + value.slice(at));
    }
  }
  return [...edits];
}

describe('how the Research Archive settings reach the production app', () => {
  test('the workflows deploy the same four names the app reads', () => {
    expect([...RESEARCH_ARCHIVE_SETTINGS]).toEqual([...NAMES]);
  });

  test.each(DEPLOY_STEPS)('$label: each is sourced from a GitHub variable, through env, never a secret', ({ file }) => {
    const text = stepText(file, PRODUCTION_STEP);
    for (const name of NAMES) {
      const mentions = text.split('\n').filter((line) => readsFromGithub(name).test(line));
      // Exactly one place reads it, and that place is the step's env mapping --
      // so the value reaches the shell as data and is never spliced into it.
      expect({ name, mentions }).toEqual({ name, mentions: [envLine(name)] });
    }
  });

  test.each(['deploy-staging.yml', 'deploy-production.yml', 'release-one-approval.yml'])(
    '%s: nothing outside the production deploy step reads them, and staging never does',
    (file) => {
      const inSteps = DEPLOY_STEPS.filter((entry) => entry.file === file).length;
      for (const name of NAMES) {
        const all = readWorkflow(file).split('\n').filter((line) => readsFromGithub(name).test(line));
        expect({ name, all }).toEqual({ name, all: Array.from({ length: inSteps }, () => envLine(name)) });
      }
    },
  );

  test.each(DEPLOY_STEPS)('$label: none set, the app is handed exactly the static list', ({ file }) => {
    for (const value of [undefined, '']) {
      const run = deploy(file, Object.fromEntries(NAMES.map((name) => [name, value])));

      expect({ status: run.status, azCalls: run.azCalls, output: run.status === 0 ? '' : run.output })
        .toEqual({ status: 0, azCalls: 1, output: '' });
      expect(run.args.filter((arg) => arg.includes('RESEARCH_ARCHIVE'))).toEqual([]);
      // An empty word here would be an empty argument to the production deploy.
      expect(run.args.filter((arg) => arg.trim() === '')).toEqual([]);
      expect(run.args.length).toBeGreaterThan(10);
      expect(run.args[run.args.length - 1]).toBe(LAST_STATIC);
    }
  });

  test('none set, both production deploy steps hand the app the same list', () => {
    // A one-sided edit of the static list would otherwise pass every test here.
    const [direct, release] = DEPLOY_STEPS.map(({ file }) => deploy(file, {}).args);
    expect(direct.length).toBeGreaterThan(10);
    expect(release).toEqual(direct);
  });

  test('no staging deploy mentions them at all', () => {
    const releaseFile = readWorkflow('release-one-approval.yml');
    const releaseStaging = releaseFile.slice(releaseFile.indexOf('\n  staging:\n'), releaseFile.indexOf('\n  production:\n'));
    expect(releaseStaging.length).toBeGreaterThan(1000);
    expect(releaseStaging).toMatch(/- name: Deploy to Azure Container App\n/);
    for (const [label, text] of [['deploy-staging.yml', readWorkflow('deploy-staging.yml')], ['release-one-approval staging job', releaseStaging]]) {
      expect({ label, mentions: text.includes('RESEARCH_ARCHIVE') }).toEqual({ label, mentions: false });
    }
  });

  test.each(DEPLOY_STEPS)('$label: all four set, they are four more assignments and nothing else moves', ({ file }) => {
    const unset = deploy(file, {});
    const set = deploy(file, VALID);
    expect({ status: set.status, azCalls: set.azCalls }).toEqual({ status: 0, azCalls: 1 });
    expect(set.args).toEqual([...unset.args, ...assignments(VALID)]);

    // Beside the interest-form organization, they come after it, and it is unchanged.
    const both = deploy(file, { ...VALID, PPBF_PUBLIC_INTEREST_ORG_ID: 'example_gym' });
    expect(both.args).toEqual([...unset.args, 'PPBF_PUBLIC_INTEREST_ORG_ID=example_gym', ...assignments(VALID)]);
  });

  test.each(DEPLOY_STEPS)('$label: some but not all set stops before az, naming the ones not set', ({ file }) => {
    // GitHub hands a variable that does not exist to the step as '' -- the
    // case that matters -- and the shell sees an absent one the same way.
    for (const absent of [undefined, '']) {
      for (const present of PARTIAL) {
        const notSet = NAMES.filter((name) => !present.includes(name));
        const run = deploy(file, Object.fromEntries(NAMES.map((name) => [name, present.includes(name) ? VALID[name] : absent])));
        expect({ absent, present, status: run.status, azCalls: run.azCalls })
          .toEqual({ absent, present, status: 1, azCalls: 0 });
        expect(run.output).toContain(`Not set: ${notSet.join(' ')}.`);
        // Names, never values.
        for (const name of present) expect(run.output).not.toContain(VALID[name]);
      }
    }
  }, 120_000);

  test.each(DEPLOY_STEPS)('$label: its shapes accept exactly what the app accepts, one character either side', ({ file }) => {
    // Plain JavaScript over the patterns the step's script holds, so every
    // one-character edit of every valid value is affordable; the bash corpus
    // below runs the same question through the real interpreter.
    const shapes = workflowShapes(file);
    for (const name of NAMES) {
      const disagreements: string[] = [];
      let accepted = 0;
      let refused = 0;
      for (const candidate of oneCharacterEdits(VALID[name])) {
        const app = readResearchArchiveSetup({ ...VALID, [name]: candidate }, token).state === 'ready';
        if (shapes[name].test(candidate) !== app) disagreements.push(candidate);
        if (app) accepted += 1;
        else refused += 1;
      }
      expect({ name, disagreements }).toEqual({ name, disagreements: [] });
      expect({ name, both: accepted > 100 && refused > 100 }).toEqual({ name, both: true });
    }
  });

  test.each(DEPLOY_STEPS)('$label: refuses exactly what the app refuses, naming the variable, never the value', ({ file }) => {
    for (const name of NAMES) {
      const outcomes = new Set<string>();
      for (const candidate of CANDIDATES[name]) {
        const values = { ...VALID, [name]: candidate };
        const app = readResearchArchiveSetup(values, token).state;
        const run = deploy(file, values);
        const workflow = run.status === 0 && run.azCalls === 1 ? 'ready' : 'incomplete';
        outcomes.add(app);

        expect({ name, candidate, workflow }).toEqual({ name, candidate, workflow: app });
        if (workflow === 'ready') {
          expect(run.args.slice(-4)).toEqual(assignments(values));
        } else {
          expect({ name, candidate, status: run.status, azCalls: run.azCalls })
            .toEqual({ name, candidate, status: 1, azCalls: 0 });
          expect(run.output).toContain(`(SHAPES in researchArchiveConfig.ts): ${name}.`);
          expect(run.output).not.toContain(candidate);
        }
      }
      // Anti-vacuity: a corpus the app accepts whole, or refuses whole, would
      // agree with any workflow.
      expect({ name, outcomes: [...outcomes].sort() }).toEqual({ name, outcomes: ['incomplete', 'ready'] });
    }
  }, 120_000);

  test.each(DEPLOY_STEPS)('$label: whitespace stops the deploy, where the app would strip it', ({ file }) => {
    // The workflow is the stricter of the two on purpose, as for the interest
    // form's variable: a value somebody created and got wrong stops the deploy
    // by name instead of reaching the app in a form nobody typed on purpose.
    for (const [name, candidate] of [
      ['RESEARCH_ARCHIVE_ORGANIZATION_IDS', 'example_gym, __platform__'],
      ['RESEARCH_ARCHIVE_DRIVE_ID', ' b!-Vo_driveId-123'],
      ['RESEARCH_ARCHIVE_ROOT_ITEM_ID', '0154ROOTITEM\n'],
      ['RESEARCH_ARCHIVE_SITE_ID', ' '],
    ] as const) {
      const run = deploy(file, { ...VALID, [name]: candidate });
      expect({ name, status: run.status, azCalls: run.azCalls, said: run.output.includes(`): ${name}.`) })
        .toEqual({ name, status: 1, azCalls: 0, said: true });
    }
  }, 60_000);

  test('the local template carries the names, empty', () => {
    // environmentInventory.workflow.test.ts cannot hold these to the template:
    // its parser stops at the first appended array.
    const template = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8').split(/\r?\n/);
    for (const name of NAMES) {
      expect({ name, lines: template.filter((line) => line.startsWith(`${name}=`)) }).toEqual({ name, lines: [`${name}=`] });
    }
  });
});
