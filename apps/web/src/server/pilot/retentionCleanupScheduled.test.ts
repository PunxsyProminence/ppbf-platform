import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * A retention policy that nothing runs is a claim, not a control.
 *
 * docs/DATA_RETENTION.md commits this organization to erasing a withdrawn
 * family's records after a fixed window. The soft-delete path shipped, the
 * hard-delete script shipped, an npm script was added beside it -- and no
 * scheduler ever called it. Nothing in the codebase noticed, because every
 * piece existed; only the line connecting them was missing. Soft-deleted
 * records would have accumulated indefinitely while the published policy said
 * they had been purged.
 *
 * This asserts the connection itself: some workflow, on a schedule, invokes the
 * cleanup script.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const WORKFLOWS = path.join(REPO_ROOT, '.github/workflows');
const CLEANUP_INVOCATION = 'pilot:cleanup-deleted-data';

function workflowSources(): { name: string; source: string }[] {
  return readdirSync(WORKFLOWS)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .map((file) => ({ name: file, source: readFileSync(path.join(WORKFLOWS, file), 'utf8') }));
}

describe('the retention policy is actually enforced by something', () => {
  const workflows = workflowSources();

  test('the workflow directory was read, so this guard cannot pass vacuously', () => {
    expect(workflows.length).toBeGreaterThan(3);
  });

  test('a workflow invokes the retention cleanup script', () => {
    const invoking = workflows.filter((workflow) => workflow.source.includes(CLEANUP_INVOCATION));
    expect(invoking.map((workflow) => workflow.name)).not.toEqual([]);
  });

  test('that workflow runs on a schedule rather than only on request', () => {
    // A dispatch-only cleanup is the state this test exists to catch: it looks
    // like enforcement in a file listing and enforces nothing until someone
    // remembers.
    const scheduled = workflows.filter(
      (workflow) => workflow.source.includes(CLEANUP_INVOCATION) && /^\s*schedule:/m.test(workflow.source),
    );
    expect(scheduled.map((workflow) => workflow.name)).not.toEqual([]);
  });

  test('the scheduled sweep cannot delete without a person asking it to', () => {
    // The schedule reports; deleting requires a dispatch that typed APPLY. A
    // scheduled run supplies no inputs, so inputs.apply is empty and the
    // comparison below is false. If this ever becomes unconditionally true, an
    // unattended job gained the ability to permanently erase minors' records.
    const sweep = workflows.find((workflow) => workflow.source.includes(CLEANUP_INVOCATION));
    expect(sweep).toBeDefined();
    expect(sweep!.source).toContain("PPBF_RETENTION_APPLY: ${{ inputs.apply == 'APPLY' }}");
  });

  test('the sweep gets a storage account URL, and never the storage key', () => {
    // The purge deletes a purged athlete's video and portrait files (CL-B3).
    // Without an account URL every such athlete is blocked; with the
    // connection string exported, the job would hold the account key rather
    // than reach storage as its own OIDC identity.
    const source = workflows.find((workflow) => workflow.source.includes(CLEANUP_INVOCATION))!.source;
    const fetched = source.indexOf('--secret-name azure-storage-connection-string');
    const masked = source.indexOf('echo "::add-mask::$STORAGE"');
    const parsed = source.indexOf('STORAGE="$STORAGE" node -e');
    const exported = source.indexOf('PPBF_RETENTION_STORAGE_ACCOUNT_URL=$URL" >> "$GITHUB_ENV"');
    const sweep = source.indexOf(CLEANUP_INVOCATION);
    // Fetched, masked, parsed, only the URL exported -- all before the sweep.
    expect(fetched).toBeGreaterThan(-1);
    expect(fetched).toBeLessThan(masked);
    expect(masked).toBeLessThan(parsed);
    expect(parsed).toBeLessThan(exported);
    expect(exported).toBeLessThan(sweep);
    // The key never reaches the job's environment, under any spelling, and no
    // shared override variable can point a target at another target's account.
    expect(source).not.toMatch(/AZURE_STORAGE_CONNECTION_STRING|\$\{?STORAGE\}?"?\s*>>|vars\.PPBF_RETENTION_STORAGE/);
  });

  test('the npm script the workflow calls exists', () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'apps/web/package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts[CLEANUP_INVOCATION]).toBe(
      'node scripts/pilot-cleanup-deleted-data.mjs',
    );
  });
});
