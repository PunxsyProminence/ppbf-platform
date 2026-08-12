import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const manifestUrl = pathToFileURL(
  path.resolve(__dirname, 'runtime-probes.manifest.mjs'),
).href;
const engineUrl = pathToFileURL(path.resolve(__dirname, 'lib/runtime-probe.mjs')).href;

const appRoot = path.resolve(__dirname, '..');
const queuePath = path.resolve(__dirname, '../../../docs/current/WORK_QUEUE.md');

/**
 * The scripts are ESM and this suite is compiled to CommonJS, so they are
 * evaluated in a child process. Same approach as check-source-retractions.test.ts.
 */
function evaluate(moduleUrl: string, expression: string) {
  const script = `
    import * as m from ${JSON.stringify(moduleUrl)};
    const value = await (${expression});
    process.stdout.write(JSON.stringify(value === undefined ? null : value));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
}

/** Returns the thrown message, or null if the expression did not throw. */
function throwsWith(moduleUrl: string, expression: string): string | null {
  const script = `
    import * as m from ${JSON.stringify(moduleUrl)};
    try {
      await (${expression});
      process.stdout.write(JSON.stringify(null));
    } catch (error) {
      process.stdout.write(JSON.stringify(String(error && error.message ? error.message : error)));
    }
  `;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
}

type ManifestEntry = {
  item: string;
  title?: string;
  probes?: Array<Record<string, unknown>>;
  noRuntimeProbe?: string;
  acceptanceProbeOutstanding?: string;
};

const manifest: ManifestEntry[] = evaluate(manifestUrl, 'm.MANIFEST.map((e) => ({ ...e, probes: (e.probes || []).map((p) => ({ ...p, predicate: undefined })) }))');

/** Item ids from the queue table, which has 15 columns; the state-machine table has 4. */
function queueItemIds(): string[] {
  const markdown = fs.readFileSync(queuePath, 'utf8');
  const ids: string[] = [];

  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|');
    if (cells.length < 14) continue;

    const id = cells[1].trim();
    if (!id || id === 'ID' || /^-+$/.test(id)) continue;
    ids.push(id);
  }

  return [...new Set(ids)];
}

describe('runtime probe manifest covers the queue', () => {
  // Without this, every assertion below passes when the queue file moves or its
  // table shape changes: an empty parse means an empty diff, which reads as
  // "fully covered". The coverage tests are only worth anything if the parser
  // is known to have found the table.
  test('the queue parser actually finds the table', () => {
    expect(queueItemIds().length).toBeGreaterThan(30);
  });

  // The whole point of the manifest. If someone adds a row to the queue and
  // does not decide how it gets verified, that decision should block here
  // rather than silently reduce coverage while the ledger still reports green.
  test('every queue item is either probed or explicitly excused', () => {
    const covered = new Set(manifest.map((entry) => entry.item));
    const missing = queueItemIds().filter((id) => !covered.has(id));

    expect(missing).toEqual([]);
  });

  test('the manifest names no item the queue does not have', () => {
    const known = new Set(queueItemIds());
    const stale = manifest.map((entry) => entry.item).filter((item) => !known.has(item));

    expect(stale).toEqual([]);
  });

  test('every entry declares probes or a reason for having none', () => {
    const undecided = manifest
      .filter((entry) => !entry.noRuntimeProbe && !(entry.probes && entry.probes.length > 0))
      .map((entry) => entry.item);

    expect(undecided).toEqual([]);
  });
});

describe('every declared probe is well formed', () => {
  test('validateProbe accepts the whole manifest', () => {
    const result = throwsWith(
      manifestUrl,
      `import(${JSON.stringify(engineUrl)}).then((e) => m.PROBES.map((p) => e.validateProbe(p)).length)`,
    );

    expect(result).toBeNull();
  });

  test('no probe can mutate a real environment', () => {
    const offenders = manifest.flatMap((entry) =>
      (entry.probes || [])
        .filter((probe) => {
          const method = String(probe.method || 'GET').toUpperCase();
          if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return false;
          const expected = Array.isArray(probe.expect) ? probe.expect : [probe.expect];
          return expected.some((status) => Number(status) >= 200 && Number(status) < 300);
        })
        .map((probe) => probe.id),
    );

    expect(offenders).toEqual([]);
  });
});

describe('probe paths point at surfaces that actually exist', () => {
  // Catches the failure this harness is built to catch, one layer earlier: a
  // probe against a route that was renamed answers 404, which looks like a
  // deploy problem and is really a stale manifest.
  test('every API path has a route file', () => {
    const apiProbes = manifest.flatMap((entry) =>
      (entry.probes || []).filter(
        (probe) => probe.kind === 'http' && String(probe.path).startsWith('/api/'),
      ),
    );

    expect(apiProbes.length).toBeGreaterThan(0);

    const missing = apiProbes
      .filter((probe) => !fs.existsSync(path.join(appRoot, 'app', String(probe.path), 'route.ts')))
      .map((probe) => `${probe.id} -> ${probe.path}`);

    expect(missing).toEqual([]);
  });

  test('every page path has a page file', () => {
    const pageProbes = manifest.flatMap((entry) =>
      (entry.probes || []).filter((probe) => probe.kind === 'page'),
    );

    expect(pageProbes.length).toBeGreaterThan(0);

    const missing = pageProbes
      .filter((probe) => !fs.existsSync(path.join(appRoot, 'app', String(probe.path), 'page.tsx')))
      .map((probe) => `${probe.id} -> ${probe.path}`);

    expect(missing).toEqual([]);
  });
});

describe('engine safety invariants', () => {
  test('rejects a mutating probe that expects success', () => {
    const message = throwsWith(
      engineUrl,
      `m.assertProbeCannotMutate({ id: 'x', kind: 'http', method: 'POST', path: '/api/pilot/incidents', expect: 200 })`,
    );

    expect(message).toContain('may never succeed at mutating');
  });

  test('allows a mutating probe that expects a refusal', () => {
    const message = throwsWith(
      engineUrl,
      `m.assertProbeCannotMutate({ id: 'x', kind: 'http', method: 'POST', path: '/api/pilot/incidents', expect: 403 })`,
    );

    expect(message).toBeNull();
  });

  test('rejects SQL that is not a read', () => {
    const message = throwsWith(
      engineUrl,
      `m.assertSqlIsRead({ id: 'x', sql: 'delete from pilot.accounts' })`,
    );

    expect(message).toContain('never write');
  });

  test('rejects a probe with no stated reason', () => {
    const message = throwsWith(
      engineUrl,
      `m.validateProbe({ id: 'x', kind: 'http', path: '/api/pilot/incidents', expect: 401 })`,
    );

    expect(message).toContain('no "because"');
  });

  test('refuses to mint a session against production by default', () => {
    // No network call happens: the refusal is decided before the request, so
    // this runs offline and touches nothing.
    const ledger = evaluate(
      engineUrl,
      `m.runProbes({
        target: 'production',
        baseUrl: 'https://example.invalid',
        probes: [{
          item: 'T-003',
          id: 'probe',
          kind: 'http',
          path: '/api/pilot/video/list',
          as: 'coach',
          expect: 403,
          because: 'test',
        }],
      })`,
    );

    expect(ledger.results[0].status).toBe('SKIPPED');
    expect(ledger.results[0].reason).toContain('Refusing to mint');
    expect(ledger.sessionsMinted).toBe(0);
  });

  test('a skipped probe does not make the run report failure', () => {
    const ledger = evaluate(
      engineUrl,
      `m.runProbes({
        target: 'production',
        baseUrl: 'https://example.invalid',
        probes: [{
          item: 'T-003', id: 'probe', kind: 'http', path: '/api/pilot/video/list',
          as: 'coach', expect: 403, because: 'test',
        }],
      })`,
    );

    expect(ledger.ok).toBe(true);
  });
});

describe('CLI argument handling', () => {
  const cliUrl = pathToFileURL(path.resolve(__dirname, 'pilot-runtime-verify.mjs')).href;

  test('requires an explicit target', () => {
    expect(throwsWith(cliUrl, `m.parseArgs([])`)).toContain('--target=staging');
  });

  test('refuses to guess a staging base url', () => {
    const message = throwsWith(
      cliUrl,
      `m.resolveBaseUrl({ target: 'staging', baseUrl: null }, {})`,
    );

    expect(message).toContain('No base URL for staging');
  });

  test('defaults production to the recorded origin', () => {
    const url = evaluate(cliUrl, `m.resolveBaseUrl({ target: 'production', baseUrl: null }, {})`);

    expect(url).toBe('https://www.punxsyprominence.org');
  });
});
