import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * release-one-approval.yml: one run, two jobs, one production approval.
 *
 * The workflow reaches production, and it does so by COPYING the deploy, verify
 * and gate steps of deploy-staging.yml and deploy-production.yml into one file.
 * A copy drifts. So this pins two different kinds of thing:
 *
 *   PROPERTIES AND ORDER -- what must be true of the release whatever the step
 *   text says: one job names `production` and it waits on staging; staging is
 *   the only half that builds; the digest production promotes is the staging
 *   job's output and nothing else; every read-only refusal runs before the
 *   production migration; the SHADOW queue is checked again as the step
 *   directly before the update; a re-run changes nothing; a gate fixture that
 *   could not be cleaned up stops the promotion.
 *
 *   PARITY -- every copied step equals its source step, apart from the
 *   substitutions declared in this file. And the other direction, which is the
 *   one that catches drift: every step of the two source jobs is either copied
 *   or named in OMITTED with its reason, so a safeguard added to
 *   deploy-production.yml and not mirrored here fails this suite.
 *
 * Parity is also what answers the existing deployment guards. The environment
 * inventory, the SHADOW token budget and the provider timeout tests each read
 * deploy-staging.yml and deploy-production.yml. This workflow's two deploy
 * steps are held byte-equal to the steps those tests already read, so a value
 * they accept there cannot differ here.
 *
 * METHOD: raw workflow text, the idiom of deployPromotionContract.test.ts
 * (js-yaml is only an undeclared transitive dependency). Every `run:` block is
 * also handed to `bash -n`.
 *
 * WHAT THIS CANNOT SHOW. It is structural. The workflow has never run. Nothing
 * here executes a step, evaluates a GitHub expression, talks to Azure, or
 * observes how GitHub orders an environment approval against a job's
 * concurrency group. It also cannot see GitHub's environment settings: the
 * one-click property depends on `staging` having no required reviewer, which is
 * a repository setting and not in any file.
 */
const WORKFLOW_DIR = path.resolve(__dirname, '../../../../../.github/workflows');

/** Normalized: a CRLF checkout defeats $-anchored regexes silently. */
function readWorkflow(file: string): string {
  return fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8').replace(/\r\n/g, '\n');
}

const release = readWorkflow('release-one-approval.yml');
const SOURCES = {
  'deploy-staging.yml': readWorkflow('deploy-staging.yml'),
  'deploy-production.yml': readWorkflow('deploy-production.yml'),
} as const;
type SourceFile = keyof typeof SOURCES;

/** Lines that are code: full-line comments carry no behaviour. */
function codeLines(text: string): string[] {
  return text.split('\n').filter((line) => !/^\s*#/.test(line));
}

/** One job: its key line through the line before the next 2-space key. */
function jobText(workflow: string, job: string): string {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`  ${job}:`);
  if (start === -1) throw new Error(`no job named ${job}`);
  let end = start + 1;
  while (end < lines.length && !/^ {0,2}\S/.test(lines[end])) end += 1;
  return lines.slice(start, end).join('\n');
}

/** The lines of a job above its `steps:` -- environment, needs, concurrency. */
function jobHeader(job: string): string[] {
  const lines = jobText(release, job).split('\n');
  const stepsAt = lines.indexOf('    steps:');
  if (stepsAt === -1) throw new Error(`job ${job} has no steps`);
  return codeLines(lines.slice(0, stepsAt).join('\n'));
}

interface Step {
  name: string;
  /** The step as written, minus the comment block leading into the next one. */
  text: string;
}

function stepsOf(job: string): Step[] {
  const lines = job.split('\n');
  const starts = lines
    .map((line, index) => (/^ {6}- name: /.test(line) ? index : -1))
    .filter((index) => index >= 0);

  return starts.map((start, i) => {
    let end = i + 1 < starts.length ? starts[i + 1] : lines.length;
    while (end > start + 1 && (lines[end - 1].trim() === '' || /^ {6}#/.test(lines[end - 1]))) end -= 1;
    return {
      name: lines[start].replace(/^ {6}- name: /, ''),
      text: lines.slice(start, end).join('\n'),
    };
  });
}

const staging = stepsOf(jobText(release, 'staging'));
const production = stepsOf(jobText(release, 'production'));
const sourceSteps: Record<SourceFile, Step[]> = {
  'deploy-staging.yml': stepsOf(jobText(SOURCES['deploy-staging.yml'], 'build-and-deploy')),
  'deploy-production.yml': stepsOf(jobText(SOURCES['deploy-production.yml'], 'build-and-deploy')),
};

function step(steps: Step[], name: string): Step {
  const found = steps.filter((candidate) => candidate.name === name);
  if (found.length !== 1) throw new Error(`expected exactly one step "${name}", found ${found.length}`);
  return found[0];
}

const at = (steps: Step[], name: string): number => steps.indexOf(step(steps, name));

/** `id:` is the one line a copy may add: the final report reads outcomes by id. */
const withoutIds = (text: string): string =>
  text.split('\n').filter((line) => !/^ {8}id: /.test(line)).join('\n');

const DIGEST_INPUT = '${{ inputs.release_digest }}';
const DIGEST_OUTPUT = '${{ needs.staging.outputs.digest }}';
const SHA_INPUT = '${{ inputs.confirm_sha }}';
const FROZEN_SHA = '${{ github.sha }}';

interface Copy {
  job: 'staging' | 'production';
  name: string;
  source: SourceFile;
  /** The source step's name, where the copy is renamed. */
  sourceName?: string;
  /** Applied to the SOURCE text, each anchor exactly once, before comparing. */
  substitutions?: [string, string][];
}

const fromStaging = (name: string, substitutions?: [string, string][]): Copy =>
  ({ job: 'staging', name, source: 'deploy-staging.yml', substitutions });
const fromProduction = (name: string, substitutions?: [string, string][]): Copy =>
  ({ job: 'production', name, source: 'deploy-production.yml', substitutions });

const SHADOW_QUEUE = 'Refuse To Deploy While SHADOW Jobs Are Waiting';
const SHADOW_QUEUE_EARLY = 'Refuse To Migrate While SHADOW Jobs Are Waiting';

/**
 * Every copied step and exactly how it may differ from its source.
 *
 * The differences are of three kinds and no others: the digest comes from the
 * staging job instead of a dispatch input; the SHA is the run's own instead of
 * a dispatch input; and three messages that told the operator to go and run
 * another workflow now say what is true of a run that did the work itself.
 */
const COPIES: Copy[] = [
  fromStaging('Checkout Source Code'),
  fromStaging('Authenticate via Azure OIDC'),
  fromStaging('Set up Node For The Schema Check'),
  fromStaging('Install Locked Dependencies'),
  fromStaging('Verify Staging Schema Matches This Commit', [
    ['Run apply-migrations against staging first.', 'The migrations this run just applied did not produce them.'],
  ]),
  fromStaging('Set up Docker Buildx'),
  fromStaging('Log in to Azure Container Registry'),
  fromStaging('Build and Push Container Image to ACR'),
  fromStaging('Capture Staging Image Digest'),
  fromStaging('Upload Staging Digest Artifact'),
  fromStaging('Validate Staging AI Configuration'),
  fromStaging('Deploy to Azure Container App'),
  fromStaging('Verify Staging AI Secret Reference'),
  fromStaging('Wait For New Revision To Take Traffic'),
  fromStaging('Resolve Staging API Base URL'),
  fromStaging('Resolve Staging Database Connection For Gate'),
  fromStaging('Resolve Staging Default Organization For Gate'),
  fromStaging('Mint Ephemeral Gate Athlete PIN'),
  fromStaging('Provision Gate Fixture Accounts'),
  fromStaging('Run SHADOW E2E Gate'),
  fromStaging('Guardian Contact Runtime Probe'),
  fromStaging('Runtime Verification Ledger'),
  fromStaging('Deactivate Gate Athlete Fixture'),
  fromStaging('Report Release Digest Last'),

  fromProduction('Checkout Source Code'),
  fromProduction('Resolve Production Resource Group'),
  fromProduction('Authenticate via Azure OIDC'),
  fromProduction('Set up Node For The Schema Check'),
  fromProduction('Install Locked Dependencies'),
  fromProduction('Verify release digest exists in ACR and was built from this commit', [
    [DIGEST_INPUT, DIGEST_OUTPUT],
    [SHA_INPUT, FROZEN_SHA],
    [
      "Most likely the SHA and the digest came from different staging runs. Take both from the SAME deploy-staging run: confirm_sha is that run's head, release_digest is the value its 'Report Release Digest Last' step printed.",
      'The staging job of this run pushed that digest tagged with this commit, so the tag has been moved or removed since. Do not approve a re-dispatch until that is explained.',
    ],
  ]),
  fromProduction('Refuse a Rollback Nobody Asked For', [
    [SHA_INPUT, FROZEN_SHA],
    [DIGEST_INPUT, DIGEST_OUTPUT],
  ]),
  fromProduction('Validate Production AI Configuration'),
  {
    job: 'production',
    name: SHADOW_QUEUE_EARLY,
    source: 'deploy-production.yml',
    sourceName: SHADOW_QUEUE,
    substitutions: [[`      - name: ${SHADOW_QUEUE}`, `      - name: ${SHADOW_QUEUE_EARLY}`]],
  },
  fromProduction('Verify Production Schema Matches This Commit', [
    [
      'Run apply-migrations against production first. migrations_complete=CONFIRMED was not true.',
      'The migrations this run just applied did not produce them. Production schema may now be AHEAD of the running app.',
    ],
  ]),
  fromProduction(SHADOW_QUEUE),
  fromProduction('Deploy Tested Digest to Azure Container App (Production)', [
    [DIGEST_INPUT, DIGEST_OUTPUT],
    [SHA_INPUT, FROZEN_SHA],
  ]),
  fromProduction('Wait For Promoted Revision To Take Traffic', [[DIGEST_INPUT, DIGEST_OUTPUT]]),
  fromProduction('Resolve Production Base URL'),
  fromProduction('Pilot API Smoke Checks'),
];

/** Steps written for this workflow, with no source to be held equal to. */
const OWN: Record<'staging' | 'production', string[]> = {
  staging: [
    'Refuse A Re-Run, A Wrong Ref Or A Wrong Commit',
    'Verify The Checkout Is The Frozen Commit',
    'Apply Staging Migrations',
    'Refuse Promotion While The Gate Athlete Fixture May Be Live',
  ],
  production: [
    'Refuse A Re-Run, A Wrong Ref Or A Wrong Commit',
    'Verify The Staged Digest Was Handed On',
    'Verify The Checkout Is The Frozen Commit',
    'Apply Production Migrations',
    'Report What Production Now Runs',
  ],
};

/**
 * Source steps deliberately NOT copied, and what stands in for each.
 *
 * A step added to either source job that is neither copied nor listed here
 * fails the coverage test below. That is the point: a new safeguard on the
 * three-workflow path must be mirrored on this one, or left out on purpose.
 */
const OMITTED: Record<SourceFile, Record<string, string>> = {
  'deploy-staging.yml': {
    'Verify Exact Tested SHA And Schema Gate':
      'Replaced by "Refuse A Re-Run, A Wrong Ref Or A Wrong Commit" plus the checkout check. Its '
      + 'schema_migrations_complete attestation has no counterpart: this run applies the migrations itself.',
    'Install Web Dependencies For Gate':
      'A second `npm ci` in the same job. "Install Locked Dependencies" has already run and nothing '
      + 'between the two removes the install.',
    'Report Gate Athlete Fixture Still Live':
      'Replaced by "Refuse Promotion While The Gate Athlete Fixture May Be Live", which fails the job '
      + 'instead of reporting, so production is never offered while a gate credential may be live.',
  },
  'deploy-production.yml': {},
};

const GUARD = 'Refuse A Re-Run, A Wrong Ref Or A Wrong Commit';

describe('release-one-approval: one run, two jobs, one production approval', () => {
  test('the workflow was read and its steps were found (guard against a vacuous suite)', () => {
    expect(staging.length).toBeGreaterThan(20);
    expect(production.length).toBeGreaterThan(15);
    expect(sourceSteps['deploy-staging.yml'].length).toBeGreaterThan(20);
    expect(sourceSteps['deploy-production.yml'].length).toBeGreaterThan(10);
  });

  test('it runs only when dispatched', () => {
    const on = codeLines(release.slice(release.indexOf('\non:\n'), release.indexOf('\npermissions:\n')));
    expect(on.filter((line) => /^ {2}\S/.test(line))).toEqual(['  workflow_dispatch:']);
  });

  test('there are exactly two jobs, staging then production', () => {
    const jobs = release.slice(release.indexOf('\njobs:\n'));
    expect(codeLines(jobs).filter((line) => /^ {2}\S/.test(line))).toEqual(['  staging:', '  production:']);
  });

  test('exactly one job names the production environment, and it is a literal', () => {
    // GitHub asks for a review at every job that names a protected
    // environment. Two of them is two clicks; none is no gate at all. An
    // expression here could resolve to anything.
    const environments = codeLines(release).filter((line) => /^\s*environment\s*:/.test(line));
    expect(environments).toEqual(['    environment: staging', '    environment: production']);
    expect(jobHeader('staging')).toContain('    environment: staging');
    expect(jobHeader('production')).toContain('    environment: production');
  });

  test('production waits on staging and cannot be made to run without it', () => {
    const header = jobHeader('production');
    expect(header).toContain('    needs: staging');
    // `if: always()` on the job would run it after a FAILED staging job.
    expect(header.filter((line) => /^\s*if\s*:/.test(line))).toEqual([]);
    expect(header.filter((line) => /continue-on-error/.test(line))).toEqual([]);
    expect(jobHeader('staging').filter((line) => /continue-on-error/.test(line))).toEqual([]);
  });

  test('the dispatch inputs are the four ruled, with no digest and no migration attestation', () => {
    const inputs = release.slice(release.indexOf('    inputs:\n'), release.indexOf('\npermissions:\n'));
    expect(codeLines(inputs).filter((line) => /^ {6}\S/.test(line))).toEqual([
      '      confirm_sha:',
      '      confirm_production:',
      '      allow_rollback:',
      '      enable_shadow_gate:',
    ]);

    // The copied "Report Release Digest Last" step still prints the words
    // "deploy-production release_digest" in a log line, which is true of the
    // image it names. What must not exist is the INPUT, or any read of it.
    const code = codeLines(release).join('\n');
    expect(code).not.toMatch(/^\s+release_digest\s*:/m);
    expect(code).not.toMatch(/inputs\.release_digest/);
    expect(code).not.toMatch(/migrations_complete/);
    expect(code).not.toMatch(/NOT_CONFIRMED/);
  });

  test('dispatch inputs reach the shell through env bindings, never by interpolation', () => {
    // `${{ }}` inside a run block is substituted before the shell parses it,
    // so free text there is a command. An input may appear only as the whole
    // value of an env binding, or as the enable_shadow_gate step condition.
    const offenders = codeLines(release)
      .filter((line) => /\binputs\./.test(line))
      .filter((line) => !/^ {10}[A-Z_]+: \$\{\{ inputs\.[a-z_]+ \}\}$/.test(line))
      .filter((line) => !/^ {8}if: (always\(\) && )?inputs\.enable_shadow_gate$/.test(line));
    expect(offenders).toEqual([]);
  });
});

describe('release-one-approval: a re-run changes nothing', () => {
  test.each([['staging', staging], ['production', production]] as const)(
    'the first step of the %s job refuses any attempt after the first',
    (_job, steps) => {
      expect(steps[0].name).toBe(GUARD);
      const guard = steps[0].text;
      expect(guard).toMatch(/RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/);
      expect(guard).toMatch(/if \[ "\$RUN_ATTEMPT" != "1" \]; then\n\s+echo "::error::[^\n]*\n\s+exit 1\n/);
      expect(guard).not.toMatch(/continue-on-error/);
      expect(guard).not.toMatch(/^ {8}if:/m);
    },
  );

  test('the same guard, byte for byte, opens both jobs', () => {
    // A re-run of the production job alone reuses the earlier attempt's staging
    // output and approval context. The guard has to be on that job too, and a
    // weaker copy there is the one that matters.
    expect(production[0].text).toBe(staging[0].text);
  });

  test('the guard also holds the ref, the commit and the retyped target', () => {
    const guard = staging[0].text;
    expect(guard).toMatch(/if \[ "\$REF" != "refs\/heads\/main" \]/);
    expect(guard).toMatch(/REF: \$\{\{ github\.ref \}\}/);
    expect(guard).toMatch(/HEAD_SHA: \$\{\{ github\.sha \}\}/);
    expect(guard).toMatch(/if \[ -z "\$CONFIRM_SHA" \]/);
    expect(guard).toMatch(/if \[ "\$CONFIRM_SHA" != "\$HEAD_SHA" \]/);
    expect(guard).toMatch(/if \[ "\$CONFIRM_PRODUCTION" != "production" \]/);
    expect(guard.match(/^\s+exit 1$/gm)).toHaveLength(5);
  });
});

describe('release-one-approval: concurrency', () => {
  const topLevel = (workflow: string): string[] => {
    const lines = workflow.split('\n');
    const start = lines.indexOf('concurrency:');
    if (start === -1) throw new Error('no top-level concurrency block');
    const body: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (line.trim() !== '' && !/^\s/.test(line)) break;
      if (line.trim() !== '' && !/^\s*#/.test(line)) body.push(line);
    }
    return body;
  };
  const jobConcurrency = (job: string): string[] => {
    const header = jobHeader(job);
    const start = header.indexOf('    concurrency:');
    if (start === -1) throw new Error(`job ${job} has no concurrency block`);
    return header.slice(start + 1, start + 3);
  };
  const deployGroup = (file: SourceFile): string => {
    const group = topLevel(SOURCES[file]).find((line) => /^ {2}group: /.test(line));
    if (!group) throw new Error(`${file}: no group`);
    return group.replace(/^ {2}group: /, '');
  };

  test('one whole-run group, so a second release cannot start staging while the first waits', () => {
    expect(topLevel(release)).toEqual(['  group: release-one-approval', '  cancel-in-progress: false']);
  });

  test('each job holds the deploy group of its environment', () => {
    // Read from the deploy workflows, so a renamed group there fails here.
    expect(jobConcurrency('staging')).toEqual([
      `      group: ${deployGroup('deploy-staging.yml')}`,
      '      cancel-in-progress: false',
    ]);
    expect(jobConcurrency('production')).toEqual([
      `      group: ${deployGroup('deploy-production.yml')}`,
      '      cancel-in-progress: false',
    ]);
  });

  test('nothing in the file cancels a run in progress', () => {
    expect(codeLines(release).filter((line) => /cancel-in-progress/.test(line)))
      .toEqual(['  cancel-in-progress: false', '      cancel-in-progress: false', '      cancel-in-progress: false']);
  });
});

describe('release-one-approval: staging builds once and hands the digest on', () => {
  test('the staging job runs in the ruled order', () => {
    const order = [
      GUARD,
      'Checkout Source Code',
      'Verify The Checkout Is The Frozen Commit',
      'Authenticate via Azure OIDC',
      'Apply Staging Migrations',
      'Verify Staging Schema Matches This Commit',
      'Build and Push Container Image to ACR',
      'Capture Staging Image Digest',
      'Validate Staging AI Configuration',
      'Deploy to Azure Container App',
      'Wait For New Revision To Take Traffic',
      'Run SHADOW E2E Gate',
      'Guardian Contact Runtime Probe',
      'Runtime Verification Ledger',
      'Deactivate Gate Athlete Fixture',
      'Refuse Promotion While The Gate Athlete Fixture May Be Live',
    ];
    const positions = order.map((name) => at(staging, name));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(positions).size).toBe(order.length);
  });

  test('staging is the only half that builds, it builds once, and the tag is the commit', () => {
    const build = step(staging, 'Build and Push Container Image to ACR').text;
    expect(build).toMatch(/^ {8}id: build-image$/m);
    expect(build).toMatch(/tags: \$\{\{ env\.ACR_LOGIN_SERVER \}\}\/ppbf-frontend:\$\{\{ github\.sha \}\}/);
    expect(codeLines(release).filter((line) => /docker\/build-push-action/.test(line))).toHaveLength(1);

    const productionCode = codeLines(jobText(release, 'production')).join('\n');
    expect(productionCode).not.toMatch(/docker\/build-push-action|docker\/setup-buildx-action/);
    expect(productionCode).not.toMatch(/\bdocker (build|push|login)\b/);
    expect(productionCode).not.toMatch(/az acr (build|login)/);
  });

  test('the digest leaves the staging job as an output of the build step, not of a log', () => {
    const header = jobHeader('staging');
    const outputsAt = header.indexOf('    outputs:');
    expect(outputsAt).toBeGreaterThan(-1);
    expect(header[outputsAt + 1]).toBe('      digest: ${{ steps.build-image.outputs.digest }}');
  });

  test.each([
    'Resolve Staging Database Connection For Gate',
    'Resolve Staging Default Organization For Gate',
    'Mint Ephemeral Gate Athlete PIN',
    'Provision Gate Fixture Accounts',
    'Run SHADOW E2E Gate',
    'Guardian Contact Runtime Probe',
    'Runtime Verification Ledger',
  ])('the gate step "%s" runs when the gate is enabled', (name) => {
    expect(step(staging, name).text).toMatch(/^ {8}if: inputs\.enable_shadow_gate$/m);
  });

  test('the gate is on unless the operator turns it off', () => {
    const input = release.slice(release.indexOf('      enable_shadow_gate:'), release.indexOf('\npermissions:\n'));
    expect(input).toMatch(/^ {8}default: true$/m);
    expect(input).toMatch(/^ {8}type: boolean$/m);
  });

  test('a gate fixture that could not be deactivated fails the job, so production is never offered', () => {
    const cleanup = step(staging, 'Deactivate Gate Athlete Fixture').text;
    expect(cleanup).toMatch(/^ {8}id: deactivate-gate-athlete$/m);
    expect(cleanup).toMatch(/^ {8}if: always\(\) && inputs\.enable_shadow_gate$/m);

    const refusal = step(staging, 'Refuse Promotion While The Gate Athlete Fixture May Be Live').text;
    // Keyed on that step's own outcome: a continue-on-error step's failure
    // never sets failure(), so nothing else would see it.
    expect(refusal).toMatch(/^ {8}if: always\(\) && steps\.deactivate-gate-athlete\.outcome == 'failure'$/m);
    expect(refusal).not.toMatch(/continue-on-error/);
    // The last thing the script does, unconditionally.
    expect(refusal.trimEnd().split('\n').pop()).toBe('          exit 1');
    // deploy-staging's version of this step exits 0. That one must not come back.
    expect(refusal).not.toMatch(/exit 0/);
    expect(refusal).not.toMatch(/GATE_ATHLETE_PIN/);
    expect(at(staging, 'Refuse Promotion While The Gate Athlete Fixture May Be Live'))
      .toBe(at(staging, 'Deactivate Gate Athlete Fixture') + 1);
  });
});

describe('release-one-approval: production refuses before it writes', () => {
  const MIGRATE = 'Apply Production Migrations';
  const DEPLOY = 'Deploy Tested Digest to Azure Container App (Production)';

  test('the production job runs in the ruled order', () => {
    const order = [
      GUARD,
      'Verify The Staged Digest Was Handed On',
      'Checkout Source Code',
      'Resolve Production Resource Group',
      'Authenticate via Azure OIDC',
      'Verify release digest exists in ACR and was built from this commit',
      'Refuse a Rollback Nobody Asked For',
      'Validate Production AI Configuration',
      SHADOW_QUEUE_EARLY,
      MIGRATE,
      'Verify Production Schema Matches This Commit',
      SHADOW_QUEUE,
      DEPLOY,
      'Wait For Promoted Revision To Take Traffic',
      'Pilot API Smoke Checks',
      'Report What Production Now Runs',
    ];
    const positions = order.map((name) => at(production, name));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(positions).size).toBe(order.length);
  });

  test('nothing before the migration writes to production', () => {
    const before = production.slice(0, at(production, MIGRATE));
    expect(before.length).toBeGreaterThan(8);
    for (const { name, text } of before) {
      const code = codeLines(text).join('\n');
      expect({ name, writes: /containerapp update|pilot:apply-|npm run seed|psql/.test(code) })
        .toEqual({ name, writes: false });
    }
  });

  test('the SHADOW queue refusal is the step directly before the update', () => {
    // "Nothing is real if anything is waiting" (owner ruling 2026-09-26). The
    // guarantee is worth what the gap between check and update is, so there
    // is no step in it.
    expect(at(production, SHADOW_QUEUE)).toBe(at(production, DEPLOY) - 1);
  });

  test('the image production runs is the staging job output and nothing else', () => {
    const deploy = step(production, DEPLOY).text;
    expect(deploy).toMatch(/^ {10}RELEASE_DIGEST: \$\{\{ needs\.staging\.outputs\.digest \}\}$/m);
    expect(deploy).toMatch(/--image "\$\{ACR_LOGIN_SERVER\}\/ppbf-frontend@\$\{RELEASE_DIGEST\}"/);
    expect(deploy).toMatch(/PPBF_RELEASE_SHA="\$CONFIRM_SHA"/);
    expect(deploy).toMatch(/^ {10}CONFIRM_SHA: \$\{\{ github\.sha \}\}$/m);

    // Every binding of the digest anywhere in the production job is that one
    // expression: no step may be handed a digest from somewhere else.
    const bindings = codeLines(jobText(release, 'production'))
      .filter((line) => /^\s+(RELEASE_DIGEST|INCOMING_DIGEST): /.test(line))
      .map((line) => line.trim().replace(/^[A-Z_]+: /, ''));
    expect(bindings.length).toBeGreaterThanOrEqual(5);
    expect([...new Set(bindings)]).toEqual([DIGEST_OUTPUT]);
  });

  test('the handed-on digest is checked for shape before anything trusts it', () => {
    const check = step(production, 'Verify The Staged Digest Was Handed On').text;
    expect(check).toMatch(/grep -Eq '\^sha256:\[0-9a-f\]\{64\}\$'/);
    expect(check).toMatch(/^\s+exit 1$/m);
    expect(at(production, 'Verify The Staged Digest Was Handed On')).toBe(1);
  });

  test('the resource group is the production secret with no fallback', () => {
    const header = jobHeader('production');
    expect(header).toContain('      RESOURCE_GROUP: ${{ secrets.AZURE_PRODUCTION_RESOURCE_GROUP }}');
    expect(header).toContain('      CONTAINER_APP_NAME: app-ppbf-production');
    expect(header.join('\n')).not.toMatch(/rg-ppbf-enterprise-staging/);
    expect(codeLines(jobText(release, 'production')).join('\n')).not.toMatch(/app-ppbf-staging/);
  });

  test('the final report always runs and says so when the schema may be ahead', () => {
    const report = production[production.length - 1];
    expect(report.name).toBe('Report What Production Now Runs');
    expect(report.text).toMatch(/^ {8}if: always\(\)$/m);
    expect(report.text).toMatch(/MIGRATE_OUTCOME: \$\{\{ steps\.migrate-production\.outcome \}\}/);
    expect(report.text).toMatch(/DEPLOY_OUTCOME: \$\{\{ steps\.deploy-production\.outcome \}\}/);
    expect(report.text).toMatch(/SMOKE_OUTCOME: \$\{\{ steps\.smoke\.outcome \}\}/);
    expect(report.text).toMatch(/This is NOT a production deploy/);
    expect(report.text).toMatch(/schema may be AHEAD of the running app/);
    expect(step(production, MIGRATE).text).toMatch(/^ {8}id: migrate-production$/m);
    expect(step(production, DEPLOY).text).toMatch(/^ {8}id: deploy-production$/m);
    expect(step(production, 'Pilot API Smoke Checks').text).toMatch(/^ {8}id: smoke$/m);
  });
});

describe('release-one-approval: migrations come from the one reader', () => {
  const stagingMigrate = step(staging, 'Apply Staging Migrations').text;
  const productionMigrate = step(production, 'Apply Production Migrations').text;

  test('both environments run the same step, differing only in which app is asked', () => {
    const asProduction = stagingMigrate
      .replace('Apply Staging Migrations', 'Apply Production Migrations')
      .replace('id: migrate-staging', 'id: migrate-production')
      .replace('--name app-ppbf-staging \\', '--name "$CONTAINER_APP_NAME" \\');
    expect(asProduction).toBe(productionMigrate);
    expect(stagingMigrate).toMatch(/--name app-ppbf-staging \\/);
  });

  test('the order is read from migration-apply-order.mjs and an empty answer is refused', () => {
    const lines = stagingMigrate.split('\n').map((line) => line.trim());
    expect(lines).toContain('set -euo pipefail');

    // An ASSIGNMENT: under `set -e` a refusal by the reader stops the step.
    // `for m in $(node ...)` would discard the status and loop over nothing.
    const read = lines.indexOf('SLUGS="$(node scripts/migration-apply-order.mjs --slugs)"');
    const empty = lines.indexOf('if [ -z "$SLUGS" ]; then');
    const loop = lines.indexOf('for m in $SLUGS; do');
    expect(read).toBeGreaterThan(-1);
    expect(empty).toBeGreaterThan(read);
    expect(loop).toBeGreaterThan(empty);
    expect(lines.slice(empty, loop)).toContain('exit 1');
    expect(lines).toContain('npm run "pilot:apply-$m"');
    expect(stagingMigrate).not.toMatch(/\|\| true|continue-on-error|set \+e/);
  });

  test('the workflow carries no migration list and no second parser of its own', () => {
    const code = codeLines(release);
    expect(code.filter((line) => /\bfor m in\b/.test(line)).map((line) => line.trim()))
      .toEqual(['for m in $SLUGS; do', 'for m in $SLUGS; do']);
    expect(code.filter((line) => /pilot:apply-/.test(line)).map((line) => line.trim()).sort())
      .toEqual([
        'echo "::group::npm run pilot:apply-$m"',
        'echo "::group::npm run pilot:apply-$m"',
        'npm run "pilot:apply-$m"',
        'npm run "pilot:apply-$m"',
      ]);
    expect(code.join('\n')).not.toMatch(/apply-migrations\.yml/);
  });

  test('the connection string stays inside the migration step', () => {
    expect(stagingMigrate).toMatch(/echo "::add-mask::\$CONN"/);
    // Code lines only: the step's own comment names GITHUB_ENV to say it is
    // not used.
    expect(codeLines(stagingMigrate).join('\n')).not.toMatch(/GITHUB_ENV|GITHUB_OUTPUT|GITHUB_STEP_SUMMARY/);
  });

  test('each environment verifies its schema directly after migrating', () => {
    expect(at(staging, 'Verify Staging Schema Matches This Commit'))
      .toBe(at(staging, 'Apply Staging Migrations') + 1);
    expect(at(production, 'Verify Production Schema Matches This Commit'))
      .toBe(at(production, 'Apply Production Migrations') + 1);
  });
});

describe('release-one-approval: every copied step equals its source', () => {
  function expectedFromSource(copy: Copy): string {
    let text = step(sourceSteps[copy.source], copy.sourceName ?? copy.name).text;
    for (const [find, replace] of copy.substitutions ?? []) {
      const parts = text.split(find);
      if (parts.length !== 2) {
        throw new Error(`"${copy.name}": substitution anchor found ${parts.length - 1} times, expected 1: ${find}`);
      }
      text = parts.join(replace);
    }
    return withoutIds(text);
  }

  test.each(COPIES.map((copy) => [copy.job, copy.name, copy] as const))(
    '%s: "%s"',
    (_job, _name, copy) => {
      const steps = copy.job === 'staging' ? staging : production;
      expect(withoutIds(step(steps, copy.name).text)).toBe(expectedFromSource(copy));
    },
  );

  test.each([['staging', staging], ['production', production]] as const)(
    'every step of the %s job is either a declared copy or a declared step of its own',
    (job, steps) => {
      const declared = [
        ...COPIES.filter((copy) => copy.job === job).map((copy) => copy.name),
        ...OWN[job],
      ];
      expect(steps.map((candidate) => candidate.name).sort()).toEqual([...declared].sort());
    },
  );

  test.each(Object.keys(SOURCES) as SourceFile[])(
    'every step of %s is either copied here or omitted for a stated reason',
    (source) => {
      // The direction that catches drift. A safeguard added to the
      // three-workflow path lands in this list as "neither", by name.
      const copied = new Set(
        COPIES.filter((copy) => copy.source === source).map((copy) => copy.sourceName ?? copy.name),
      );
      const neither = sourceSteps[source]
        .map((candidate) => candidate.name)
        .filter((name) => !copied.has(name) && !(name in OMITTED[source]));
      expect(neither).toEqual([]);

      // And no stale entry: an omission that names a step no longer there.
      const names = sourceSteps[source].map((candidate) => candidate.name);
      expect(Object.keys(OMITTED[source]).filter((name) => !names.includes(name))).toEqual([]);
      expect(Object.keys(OMITTED[source]).filter((name) => copied.has(name))).toEqual([]);
    },
  );

  test('every omission states its reason', () => {
    const unreasoned = Object.values(OMITTED)
      .flatMap((entries) => Object.entries(entries))
      .filter(([, reason]) => reason.trim().length < 40)
      .map(([name]) => name);
    expect(unreasoned).toEqual([]);
  });

  test('only id lines are ignored by the comparison, and only these three were added', () => {
    const added = [...staging, ...production]
      .flatMap(({ name, text }) => text.split('\n').filter((line) => /^ {8}id: /.test(line)).map((line) => `${name} | ${line.trim()}`))
      .sort();
    expect(added).toEqual([
      'Apply Production Migrations | id: migrate-production',
      'Apply Staging Migrations | id: migrate-staging',
      'Build and Push Container Image to ACR | id: build-image',
      'Deactivate Gate Athlete Fixture | id: deactivate-gate-athlete',
      'Deploy Tested Digest to Azure Container App (Production) | id: deploy-production',
      'Pilot API Smoke Checks | id: smoke',
    ]);
  });
});

describe('release-one-approval: every run block is parseable shell', () => {
  /** Every `run: |` block, dedented, as in migrationDispatchCoverage.test.ts. */
  function shellSteps(): { line: number; script: string }[] {
    const lines = release.split('\n');
    const found: { line: number; script: string }[] = [];
    lines.forEach((line, index) => {
      if (!/\brun: \|\s*$/.test(line)) return;
      const openIndent = line.length - line.trimStart().length;
      const body: string[] = [];
      for (const candidate of lines.slice(index + 1)) {
        if (candidate.trim() === '') {
          body.push('');
          continue;
        }
        if (candidate.length - candidate.trimStart().length <= openIndent) break;
        body.push(candidate);
      }
      const bodyIndent = Math.min(
        ...body.filter((l) => l.trim() !== '').map((l) => l.length - l.trimStart().length),
      );
      found.push({
        line: index + 1,
        script: body.map((l) => (l.trim() === '' ? '' : l.slice(bodyIndent))).join('\n'),
      });
    });
    return found;
  }

  test('bash -n accepts each one', () => {
    const blocks = shellSteps();
    expect(blocks.length).toBeGreaterThan(25);
    for (const { line, script } of blocks) {
      let error = '';
      try {
        execFileSync('bash', ['-n'], { input: script, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (cause) {
        error = String((cause as { stderr?: Buffer }).stderr ?? cause);
      }
      expect(`release-one-approval.yml run block at line ${line}: ${error}`).toBe(
        `release-one-approval.yml run block at line ${line}: `,
      );
    }
  });
});
