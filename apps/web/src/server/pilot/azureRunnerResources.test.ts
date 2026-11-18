import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * PR-2a of the Azure-hosted database runners (lane DBT, OD-2026-11-17-008): infra/gh-runner/
 * resources.sh, which Overwatch runs to create the identity, vault, Container Apps job and the
 * vault role, and azure-runner.conf, the one place for their names and the image digest.
 *
 * What these tests hold it to:
 *   - a dry run calls az not once;
 *   - --apply checks `az account show` against --subscription before ANY other az call;
 *   - without the fake az, --apply fails closed (the 2026-11-18 defect: an earlier test reached the
 *     real, signed-in az and created three objects);
 *   - each role has the designed scope: AcrPull on the registry, Secrets Officer on the vault for
 *     the named writer, Secrets User on the one secret for the OIDC app, and only once it exists;
 *   - the job is Manual, retry 0, image by digest, and its identity's lifecycle is None.
 * METHOD: resources.sh runs against a fake az (an exported bash function). None of it proves
 * Azure accepts these calls; Overwatch's run does.
 */

const root = path.resolve(__dirname, '../../../../..');
const confPath = path.join(root, 'infra/gh-runner/azure-runner.conf');
const resourcesPath = path.join(root, 'infra/gh-runner/resources.sh');
const posix = (p: string) => p.replace(/\\/g, '/');
const read = (p: string) => fs.readFileSync(p, 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-runner-resources-test-'));

describe('azure-runner.conf', () => {
  it('pins the image by digest in the registry, and resources.sh names no digest of its own', () => {
    expect(read(confPath)).toMatch(/^IMAGE=acrppbfenterprise\.azurecr\.io\/ppbf-gh-runner@sha256:[0-9a-f]{64}$/m);
    expect(read(resourcesPath)).not.toMatch(/sha256:[0-9a-f]{64}/);
  });

  it('holds plain KEY=value lines and no ID: the repository is public', () => {
    const lines = read(confPath).split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    for (const line of lines) expect(line).toMatch(/^[A-Z][A-Z0-9_]*=[A-Za-z0-9._:/@-]+$/);
    expect(read(confPath)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});

describe('resources.sh', () => {
  // A fake az: logs every call, answers the reads, keeps a copy of the job body.
  // It is an EXPORTED BASH FUNCTION, not a file on PATH: a function wins over PATH on every OS.
  // (A PATH entry like C:/... splits at the drive-letter colon on Windows; on 2026-11-18 that let
  // an earlier version of this test reach the real, logged-in az and create Azure resources.)
  // Second guard: AZURE_CONFIG_DIR is an empty folder, so a real az would have no login at all.
  // Third: the wrapper refuses to start resources.sh unless `az` resolves to the function there.
  const fakeAz = path.join(tmp, 'fake-az.sh');
  const noLogin = fs.mkdtempSync(path.join(tmp, 'azure-config-'));
  fs.writeFileSync(fakeAz, [
    'az() {',
    'printf "%s\\n" "$*" >> "$AZ_LOG"',
    'case "$*" in',
    '  "account show"*) echo 11111111-2222-3333-4444-555555555555 ;;',
    '  "identity show"*"--query id"*) echo /subscriptions/s/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-ppbf-gh-runner ;;',
    '  "identity show"*principalId*) echo aaaaaaaa-0000-0000-0000-000000000001 ;;',
    '  "acr show"*) echo /subscriptions/s/resourceGroups/rg/providers/Microsoft.ContainerRegistry/registries/acrppbfenterprise ;;',
    '  "keyvault show --name kv-ppbf-gh-runner -o none") return 3 ;;',
    '  "keyvault show"*) echo /subscriptions/s/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/kv-ppbf-gh-runner ;;',
    '  "ad user show"*) echo bbbbbbbb-0000-0000-0000-000000000002 ;;',
    '  "ad sp show"*) echo cccccccc-0000-0000-0000-000000000003 ;;',
    '  "containerapp env show"*) echo /subscriptions/s/resourceGroups/rg/providers/Microsoft.App/managedEnvironments/cae-ppbf-enterprise-staging ;;',
    '  "rest --method put"*) local a="$*"; a="${a##*--body @}"; cp "${a%% -o none}" "$AZ_BODY" ;;',
    '  "containerapp job show"*) echo Succeeded ;;',
    '  "rest --method get"*"/secrets/"*) [ "${AZ_SECRET_PRESENT:-0}" = 1 ] || return 3; echo github-app-private-key ;;',
    'esac',
    '}',
    'export -f az',
    '',
  ].join('\n'));

  function sh(args: string[], extra: Record<string, string> = {}) {
    const log = path.join(tmp, `az-${Math.random().toString(36).slice(2)}.log`);
    const body = `${log}.body`;
    fs.writeFileSync(log, '');
    const wrapper = 'source "$FAKE_AZ"; [ "$(bash -c \'type -t az\')" = function ] || { echo "FAKE AZ NOT ACTIVE"; exit 99; }; exec bash "$SCRIPT" "$@"';
    const r = spawnSync('bash', ['-c', wrapper, 'resources.sh', ...args], {
      encoding: 'utf8',
      env: {
        ...process.env, AZURE_CONFIG_DIR: noLogin, FAKE_AZ: posix(fakeAz), SCRIPT: posix(resourcesPath),
        AZ_LOG: posix(log), AZ_BODY: posix(body), ...extra,
      },
    });
    expect(r.status).not.toBe(99);
    return { code: r.status, out: `${r.stdout}${r.stderr}`, calls: read(log).split('\n').filter(Boolean), body: fs.existsSync(body) ? read(body) : '' };
  }


  // Fake values only: the repository is public, so no real subscription, account or object ID.
  const SUB = '11111111-2222-3333-4444-555555555555';
  const WRITER = 'writer@example.invalid';
  const OIDC = '00000000-0000-4000-8000-0000000000aa';

  it('a dry run calls az not once and shows the plan, the target subscription included', () => {
    const r = sh(['create', '--subscription', SUB, '--secret-writer', WRITER]);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain('DRY RUN: nothing is called.');
    expect(r.out).toContain(`Target subscription: ${SUB}`);
    expect(r.out).toContain(`az ad user show --id ${WRITER}`);
    expect(r.out).toContain('"lifecycle": "None"');
    expect(r.out).toContain('"replicaRetryLimit": 0');
  });

  it('create --apply: AcrPull on the registry only, Secrets Officer on the vault for the named writer only, a Manual job pinned by digest', () => {
    const r = sh(['create', '--subscription', SUB, '--secret-writer', WRITER, '--apply']);
    expect(r.code).toBe(0);
    expect(r.calls[0]).toBe('account show --query id -o tsv');
    const roles = r.calls.filter((c) => c.startsWith('role assignment create'));
    expect(roles).toEqual([
      'role assignment create --assignee-object-id aaaaaaaa-0000-0000-0000-000000000001 --assignee-principal-type ServicePrincipal --role AcrPull --scope /subscriptions/s/resourceGroups/rg/providers/Microsoft.ContainerRegistry/registries/acrppbfenterprise -o none',
      'role assignment create --assignee-object-id bbbbbbbb-0000-0000-0000-000000000002 --assignee-principal-type User --role Key Vault Secrets Officer --scope /subscriptions/s/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/kv-ppbf-gh-runner -o none',
    ]);
    expect(r.calls).toContain('keyvault create --resource-group rg-ppbf-enterprise-staging --name kv-ppbf-gh-runner --location eastus --enable-rbac-authorization true --enable-purge-protection true --retention-days 90 -o none');
    expect(r.calls.find((c) => c.startsWith('rest --method put'))).toContain(`/subscriptions/${SUB}/resourceGroups/rg-ppbf-enterprise-staging/providers/Microsoft.App/jobs/caj-ppbf-gh-runner?api-version=`);
    const job = JSON.parse(r.body) as { identity: unknown; properties: { configuration: Record<string, unknown>; template: { containers: Array<Record<string, unknown>> } } };
    const id = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-ppbf-gh-runner';
    expect(job.identity).toEqual({ type: 'UserAssigned', userAssignedIdentities: { [id]: {} } });
    expect(job.properties.configuration).toEqual({
      triggerType: 'Manual', replicaTimeout: 3600, replicaRetryLimit: 0,
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 },
      registries: [{ server: 'acrppbfenterprise.azurecr.io', identity: id }],
      identitySettings: [{ identity: id, lifecycle: 'None' }],
    });
    expect(job.properties.template.containers).toEqual([{ name: 'runner', image: /^IMAGE=(.+)$/m.exec(read(confPath))?.[1], resources: { cpu: 2, memory: '4Gi' } }]);
    expect(r.calls.some((c) => c.includes('secret set') || c.includes('secret show'))).toBe(false);
  });

  it('grant refuses until the secret exists, then gives Secrets User on that one secret to the OIDC app', () => {
    const app = ['grant', '--subscription', SUB, '--oidc-app-id', OIDC, '--apply'];
    const before = sh(app);
    expect(before.code).toBe(3);
    expect(before.calls.filter((c) => c.startsWith('role assignment create'))).toEqual([]);
    const after = sh(app, { AZ_SECRET_PRESENT: '1' });
    expect(after.code).toBe(0);
    expect(after.calls.filter((c) => c.startsWith('role assignment create'))).toEqual([
      'role assignment create --assignee-object-id cccccccc-0000-0000-0000-000000000003 --assignee-principal-type ServicePrincipal --role Key Vault Secrets User --scope /subscriptions/s/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/kv-ppbf-gh-runner/secrets/github-app-private-key -o none',
    ]);
    // Existence is read through the management plane: no Key Vault data role, and no value.
    for (const run of [before, after]) {
      expect(run.calls).toContain('rest --method get --url https://management.azure.com/subscriptions/s/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/kv-ppbf-gh-runner/secrets/github-app-private-key?api-version=2023-07-01 --query name -o tsv');
      expect(run.calls.some((c) => c.startsWith('keyvault secret'))).toBe(false);
    }
  });

  it('refuses a config that sets a key twice, and an account name that starts with a dash', () => {
    const dup = path.join(tmp, 'dup.conf');
    fs.writeFileSync(dup, `${read(confPath)}\nJOB_NAME=other\n`);
    const r1 = sh(['create', '--subscription', SUB, '--secret-writer', WRITER], { PPBF_RUNNER_CONF: posix(dup) });
    expect(r1.code).toBe(2);
    expect(r1.out).toContain('azure-runner.conf sets JOB_NAME twice');
    const r2 = sh(['create', '--subscription', SUB, '--secret-writer', '-oops@example.invalid']);
    expect(r2.code).toBe(2);
    expect(r2.calls).toEqual([]);
  });

  it('keeps LF line ends and no CR byte, so git treats it as text', () => {
    expect(fs.readFileSync(resourcesPath).includes(0x0d)).toBe(false);
  });

  it('--apply against any other subscription stops after `az account show`, before any write', () => {
    for (const phase of [['create', '--secret-writer', WRITER], ['grant', '--oidc-app-id', OIDC]]) {
      const r = sh([...phase, '--subscription', '99999999-2222-3333-4444-555555555555', '--apply']);
      expect(r.code).toBe(6);
      expect(r.out).toContain('REFUSED --apply');
      expect(r.calls).toEqual(['account show --query id -o tsv']);
    }
  });

  it('without the fake, --apply fails closed: a tripwire az lets only `account show` reach the real CLI, with no login', () => {
    // The 2026-11-18 failure mode, on purpose: no fake answers. The tripwire records every call and
    // blocks all but the read; the empty AZURE_CONFIG_DIR means even that read finds no login.
    const trip = path.join(tmp, 'trip.log');
    fs.writeFileSync(trip, '');
    const tripwire = [
      'az() {',
      'printf "%s\\n" "$*" >> "$TRIP_LOG"',
      'case "$*" in "account show --query id -o tsv") command az "$@" ;; *) return 97 ;; esac',
      '}',
      'export -f az',
    ].join('\n');
    for (const phase of [['create', '--secret-writer', WRITER], ['grant', '--oidc-app-id', OIDC]]) {
      const r = spawnSync('bash', ['-c', `${tripwire}\nexec bash "$SCRIPT" "$@"`, 'resources.sh', ...phase, '--subscription', SUB, '--apply'], {
        encoding: 'utf8',
        env: { ...process.env, AZURE_CONFIG_DIR: noLogin, AZURE_CORE_COLLECT_TELEMETRY: 'false', SCRIPT: posix(resourcesPath), TRIP_LOG: posix(trip) },
      });
      expect(r.status).toBe(6);
    }
    expect(read(trip).split('\n').filter(Boolean)).toEqual(['account show --query id -o tsv', 'account show --query id -o tsv']);
  });

  it('refuses a missing writer, app id or subscription, a malformed app id, and a tag instead of a digest, calling nothing', () => {
    for (const args of [
      ['create', '--subscription', SUB, '--apply'],
      ['grant', '--subscription', SUB, '--apply'],
      ['create', '--secret-writer', WRITER, '--apply'],
      ['grant', '--subscription', SUB, '--oidc-app-id', 'not-a-guid'],
    ]) {
      const r = sh(args);
      expect(r.code).toBe(2);
      expect(r.calls).toEqual([]);
    }
    const bad = path.join(tmp, 'bad.conf');
    fs.writeFileSync(bad, read(confPath).replace(/@sha256:[0-9a-f]{64}/, ':latest'));
    const r = sh(['create', '--subscription', SUB, '--secret-writer', WRITER, '--apply'], { PPBF_RUNNER_CONF: posix(bad) });
    expect(r.code).toBe(2);
    expect(r.calls).toEqual([]);
  });
});
