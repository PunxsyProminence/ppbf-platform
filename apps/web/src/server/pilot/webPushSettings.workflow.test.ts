// How the three web push settings reach the running app, read from the real
// workflow files and RUN, not just pattern-matched (lane W5-WP, WP-2b-2c; QD (b)
// and QM on #2228).
//
// WHY THIS TEST EXISTS
//
// Push is off until App Overwatch makes the key pair in a release. Until then a
// deploy must hand the app exactly what it handed it before (QD (b)'s
// condition: "a deploy with no push secrets is unchanged"). Once the public key
// and the subject are set as GitHub environment variables, all three settings
// go on together: the two variables, and the private key as a reference to the
// Container App secret, never as a value. What can go wrong, none of it visible
// to a typecheck:
//
//   - an unset variable still adding an argument to the command that deploys
//     production;
//   - one variable set without the other, deploying a push setup the app
//     refuses (pushKeys needs all three);
//   - a value az would read as something else (`secretref:...`), or a private
//     key put in a variable;
//   - a value the app would refuse, deployed anyway.
//
// So each deploy step's own script is extracted and executed by bash with `az`
// replaced by a function that prints its arguments, as
// publicInterestOrg.workflow.test.ts does. What is asserted is the argument
// list az would have received.

import { spawnSync } from 'node:child_process';
import { createECDH } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { pushKeys } from './pushSubscriptions';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const WORKFLOW_DIR = path.join(REPO_ROOT, '.github/workflows');

const PUBLIC_KEY = 'PPBF_WEB_PUSH_VAPID_PUBLIC_KEY';
const SUBJECT = 'PPBF_WEB_PUSH_SUBJECT';
const PRIVATE_KEY = 'PPBF_WEB_PUSH_VAPID_PRIVATE_KEY';
const VARIABLES = [PUBLIC_KEY, SUBJECT] as const;
const PRIVATE_KEY_REFERENCE = `${PRIVATE_KEY}=secretref:ppbf-web-push-vapid-private-key`;

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

/** A line that takes the named value from GitHub: a `vars.`, `secrets.` or `env.` expression in any spelling. */
function readsFromGithub(name: string): RegExp {
  return new RegExp(`(vars|secrets|env)\\s*(\\.\\s*|\\[\\s*['"])${name}`);
}

function envLine(name: string): string {
  return `          ${name}: \${{ vars.${name} }}`;
}

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

function deploy(file: string, step: string, values: Partial<Record<string, string>>): Run {
  // GitHub's default for a `run:` step is `bash -e`; the script goes on stdin.
  const stub = 'az() { echo "AZ_CALL"; printf \'AZ_ARG:%s\\n\' "$@"; }\n';
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
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
  for (const [name, value] of Object.entries(values)) if (value !== undefined) env[name] = value;
  const result = spawnSync(BASH, ['--noprofile', '--norc', '-e', '-s'], {
    input: stub + runScript(file, step),
    // Deliberately NOT process.env: a variable under test is absent unless set here.
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

/** What the step itself printed: everything but the az stand-in's own lines. */
function said(run: Run): string {
  return run.output.split('\n').filter((line) => !line.startsWith('AZ_')).join('\n');
}

/** A real VAPID key pair, as App Overwatch's release would make one: P-256, base64url, no padding. */
function keyPair(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url') };
}

const KEYS = keyPair();
const GOOD = { [PUBLIC_KEY]: KEYS.publicKey, [SUBJECT]: 'mailto:push@example.test' };

describe('how the web push settings reach the app', () => {
  test.each(DEPLOY_STEPS)('$label: the two variables come from GitHub variables, through env; the private key never does', ({ file, step }) => {
    const lines = stepText(file, step).split('\n');
    for (const name of VARIABLES) {
      expect(lines.filter((line) => readsFromGithub(name).test(line))).toEqual([envLine(name)]);
    }
    expect(lines.filter((line) => readsFromGithub(PRIVATE_KEY).test(line))).toEqual([]);
    // The private key is named once, as the secret reference, and nowhere given a value.
    expect(lines.filter((line) => line.includes(PRIVATE_KEY))).toEqual([
      expect.stringContaining(`"${PRIVATE_KEY_REFERENCE}"`),
    ]);
  });

  test.each(['deploy-staging.yml', 'deploy-production.yml', 'release-one-approval.yml'])(
    '%s: nothing outside the deploy steps reads them',
    (file) => {
      const inSteps = DEPLOY_STEPS.filter((entry) => entry.file === file).length;
      const all = readWorkflow(file).split('\n');
      for (const name of VARIABLES) {
        expect(all.filter((line) => readsFromGithub(name).test(line))).toEqual(Array.from({ length: inSteps }, () => envLine(name)));
      }
      expect(all.filter((line) => readsFromGithub(PRIVATE_KEY).test(line))).toEqual([]);
    },
  );

  test.each(DEPLOY_STEPS)('$label: neither set, the app is handed exactly the static list', ({ file, step, lastStatic }) => {
    for (const value of [undefined, '']) {
      const run = deploy(file, step, { [PUBLIC_KEY]: value, [SUBJECT]: value });
      expect({ status: run.status, azCalls: run.azCalls, output: run.status === 0 ? '' : run.output })
        .toEqual({ status: 0, azCalls: 1, output: '' });
      expect(run.args.filter((arg) => arg.includes('WEB_PUSH'))).toEqual([]);
      expect(run.args.filter((arg) => arg.trim() === '')).toEqual([]);
      expect(run.args[run.args.length - 1]).toBe(lastStatic);
      expect(said(run)).not.toMatch(/WEB_PUSH|push/i);
    }
    // And beside the interest-form organization, still that one assignment last.
    const withOrg = deploy(file, step, { PPBF_PUBLIC_INTEREST_ORG_ID: 'punxsy_prominence' });
    expect(withOrg.args[withOrg.args.length - 1]).toBe('PPBF_PUBLIC_INTEREST_ORG_ID=punxsy_prominence');
  });

  test.each(DEPLOY_STEPS)('$label: both set, three assignments are added at the end and nothing else moves', ({ file, step }) => {
    for (const subject of ['mailto:push@example.test', 'https://ppbf.example.test/push-contact']) {
      const unset = deploy(file, step, {});
      const set = deploy(file, step, { ...GOOD, [SUBJECT]: subject });
      expect({ status: set.status, azCalls: set.azCalls }).toEqual({ status: 0, azCalls: 1 });
      expect(unset.args.length).toBeGreaterThan(10);
      expect(set.args).toEqual([
        ...unset.args,
        `${PUBLIC_KEY}=${KEYS.publicKey}`,
        `${SUBJECT}=${subject}`,
        PRIVATE_KEY_REFERENCE,
      ]);
      // The step's own words never carry a value (az's own output is az's: see the step's comment).
      expect(said(set)).not.toContain(KEYS.publicKey);
      expect(said(set)).not.toContain(subject);
      // Beside the interest-form organization, still after it: nothing else moves.
      const withOrg = deploy(file, step, { PPBF_PUBLIC_INTEREST_ORG_ID: 'punxsy_prominence' });
      const both = deploy(file, step, { ...GOOD, [SUBJECT]: subject, PPBF_PUBLIC_INTEREST_ORG_ID: 'punxsy_prominence' });
      expect(both.args).toEqual([...withOrg.args, `${PUBLIC_KEY}=${KEYS.publicKey}`, `${SUBJECT}=${subject}`, PRIVATE_KEY_REFERENCE]);
    }
  });

  test.each(DEPLOY_STEPS)('$label: the push settings are the last argument of az, one quoted array', ({ file, step }) => {
    // Every other optional array (the interest-form organization, the Research
    // Archive) comes before it, so a run with those set cannot be reordered.
    const lines = runScript(file, step).split('\n').map((line) => line.trim());
    // Expanded in one place only, as one quoted array (the other mentions count it or fill it).
    const at = lines.flatMap((line, index) => (line.includes('${WEB_PUSH_ENV[@]}') ? [index] : []));
    expect(at).toHaveLength(1);
    expect(lines[at[0]]).toBe('"${WEB_PUSH_ENV[@]}"');
    expect(lines[at[0] - 1].endsWith(' \\')).toBe(true);
    expect(lines.slice(0, at[0]).some((line) => line.startsWith('az containerapp update'))).toBe(true);
    expect(lines.slice(0, at[0]).filter((line) => /^"\$\{[A-Z_]+_ENV\[@\]\}" \\$/.test(line)).length).toBeGreaterThan(0);
  });

  test.each(DEPLOY_STEPS)('$label: only one set stops before az, naming the other', ({ file, step }) => {
    for (const [set, missing] of [[PUBLIC_KEY, SUBJECT], [SUBJECT, PUBLIC_KEY]] as const) {
      const run = deploy(file, step, { [set]: GOOD[set] });
      expect({ status: run.status, azCalls: run.azCalls, said: run.output.includes(`Not set: ${missing}.`) })
        .toEqual({ status: 1, azCalls: 0, said: true });
      expect(run.output).not.toContain(GOOD[set]);
    }
  });

  test.each(DEPLOY_STEPS)('$label: a value this deploy does not take stops before az, named but never printed', ({ file, step }) => {
    const badKeys = [
      KEYS.publicKey.slice(1), `${KEYS.publicKey}A`, `${KEYS.publicKey.slice(1)}=`, `${KEYS.publicKey.slice(1)}+`,
      'secretref:ppbf-web-push-vapid-private-key', KEYS.privateKey, `${KEYS.publicKey}\n`, ` ${KEYS.publicKey.slice(1)}`,
    ];
    for (const value of badKeys) {
      const run = deploy(file, step, { ...GOOD, [PUBLIC_KEY]: value });
      expect({ value, status: run.status, azCalls: run.azCalls, said: run.output.includes(`this deploy takes (see pushKeys in pushSubscriptions.ts): ${PUBLIC_KEY}.`) })
        .toEqual({ value, status: 1, azCalls: 0, said: true });
      expect(run.output).not.toContain(value.trim());
    }
    // Stricter than pushKeys for the subject: a mailto: with no address, or a
    // URL with characters a plain contact URL does not need, is not deployed.
    const badSubjects = [
      'http://ppbf.example.test/contact', 'push team', 'mailto:', 'mailto:nobody', 'https://', 'https://a b.example.test',
      'secretref:ppbf-web-push-vapid-private-key', 'mailto:push@example.test\n', 'https://ppbf.example.test/"x',
    ];
    for (const value of badSubjects) {
      const run = deploy(file, step, { ...GOOD, [SUBJECT]: value });
      expect({ value, status: run.status, azCalls: run.azCalls, said: run.output.includes(`this deploy takes (see pushKeys in pushSubscriptions.ts): ${SUBJECT}.`) })
        .toEqual({ value, status: 1, azCalls: 0, said: true });
      if (value.trim().length > 'mailto:'.length) expect(run.output).not.toContain(value.trim());
      expect(run.output).not.toContain(KEYS.publicKey);
    }
  });

  test('a real key pair and contact pass the deploy and the app alike', () => {
    for (const subject of ['mailto:push@example.test', 'https://ppbf.example.test/push-contact']) {
      const { publicKey, privateKey } = keyPair();
      expect(pushKeys({ [PUBLIC_KEY]: publicKey, [PRIVATE_KEY]: privateKey, [SUBJECT]: subject })).toEqual({ publicKey });
      const run = deploy(DEPLOY_STEPS[1].file, DEPLOY_STEPS[1].step, { [PUBLIC_KEY]: publicKey, [SUBJECT]: subject });
      expect({ status: run.status, azCalls: run.azCalls }).toEqual({ status: 0, azCalls: 1 });
    }
  });

  test('the local template carries all three names, blank', () => {
    const template = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8').split(/\r?\n/);
    for (const name of [PUBLIC_KEY, PRIVATE_KEY, SUBJECT]) {
      expect(template.filter((line) => line.startsWith(`${name}=`))).toEqual([`${name}=`]);
    }
  });
});
