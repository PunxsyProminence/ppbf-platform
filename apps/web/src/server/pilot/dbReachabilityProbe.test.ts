import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * scripts/db-reachability-probe.mjs -- the database preflight (lane DBT).
 *
 * WHY THIS EXISTS. GitHub places some Linux jobs on AWS runners, and the
 * Postgres firewall admits Azure ranges and named single IPs only. Since
 * 2026-11-03, 10 of 10 DB jobs on AWS runners hung ~134 s and died with
 * `connect ETIMEDOUT`; no Azure-runner job did. The probe fails such a job fast
 * and plainly, once per job, before that job's first database contact.
 *
 * What these tests hold it to: the retry count and backoff, the final message,
 * that it sends no byte (so there is no auth or SQL to retry and nothing it can
 * write), that the connection string never reaches the output, and that every
 * connection-resolve site in the workflows is followed by the probe.
 */

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const probePath = path.join(repositoryRoot, 'scripts/db-reachability-probe.mjs');
const probeUrl = pathToFileURL(probePath).href;
const workflowsDir = path.join(repositoryRoot, '.github/workflows');

const SECRET = 'S3cr3t-pw-do-not-print';
const USER = 'ppbf_probe_user';

/** Run a snippet that imports the probe module; it prints JSON, which is returned parsed. */
function inModule(body: string): unknown {
  const script = `import * as p from ${JSON.stringify(probeUrl)};\n${body}`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  return JSON.parse(out);
}

function runCli(args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    // Only PATH plus what the case sets: no ambient variable can satisfy the probe by accident.
    const childEnv = { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv;
    execFile(
      process.execPath,
      [probePath, ...args],
      { encoding: 'utf8', env: childEnv },
      (err: (Error & { code?: unknown }) | null, stdout: string, stderr: string) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, out: `${stdout}${stderr}` });
      },
    );
  });
}

function conn(port: number): string {
  return `postgresql://${USER}:${SECRET}@127.0.0.1:${port}/ppbf?sslmode=require`;
}

describe('db-reachability-probe: retry and backoff', () => {
  it('tries exactly `attempts` times, backing off 1x then 2x the base, and reports every code', () => {
    const r = inModule(`
      const sleeps = []; let calls = 0;
      const res = await p.probe({ host: 'h', port: 5432, attempts: 3, backoffMs: 100,
        connect: async () => { calls += 1; return { ok: false, code: 'ETIMEDOUT' }; },
        sleep: async (ms) => { sleeps.push(ms); } });
      console.log(JSON.stringify({ res, calls, sleeps }));
    `) as { res: { ok: boolean; attempt: number; codes: string[] }; calls: number; sleeps: number[] };
    expect(r.calls).toBe(3);
    expect(r.sleeps).toEqual([100, 200]);
    expect(r.res).toEqual({ ok: false, attempt: 3, codes: ['ETIMEDOUT', 'ETIMEDOUT', 'ETIMEDOUT'] });
  });

  it('stops at the first success and does not sleep after it', () => {
    const r = inModule(`
      const sleeps = []; let calls = 0;
      const res = await p.probe({ host: 'h', port: 5432, attempts: 3, backoffMs: 100,
        connect: async () => { calls += 1; return calls === 2 ? { ok: true, ms: 7 } : { ok: false, code: 'ECONNREFUSED' }; },
        sleep: async (ms) => { sleeps.push(ms); } });
      console.log(JSON.stringify({ res, calls, sleeps }));
    `) as { res: { ok: boolean; attempt: number; ms: number; codes: string[] }; calls: number; sleeps: number[] };
    expect(r.calls).toBe(2);
    expect(r.sleeps).toEqual([100]);
    expect(r.res).toEqual({ ok: true, attempt: 2, ms: 7, codes: ['ECONNREFUSED'] });
  });

  it('defaults to 3 attempts, 5 s each, 2 s then 4 s apart (about 21 s worst case)', () => {
    const r = inModule(`console.log(JSON.stringify({ d: p.DEFAULTS, b1: p.backoffDelay(1, 2000), b2: p.backoffDelay(2, 2000) }));`) as {
      d: { attempts: number; timeoutMs: number; backoffMs: number };
      b1: number;
      b2: number;
    };
    expect(r.d).toEqual({ attempts: 3, timeoutMs: 5000, backoffMs: 2000 });
    expect([r.b1, r.b2]).toEqual([2000, 4000]);
  });
});

describe('db-reachability-probe: against a real socket', () => {
  it('succeeds against a listening port and sends it zero bytes', async () => {
    let received = 0;
    let connections = 0;
    const server = net.createServer((s) => {
      connections += 1;
      s.on('data', (d) => {
        received += d.length;
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as net.AddressInfo;
    try {
      const { code, out } = await runCli([], { AZURE_POSTGRES_CONNECTION_STRING: conn(port) });
      // Give the server's event loop a tick to drain anything the client sent.
      await new Promise((r) => setTimeout(r, 100));
      expect(code).toBe(0);
      expect(out).toContain(`db-preflight: 127.0.0.1:${port} reachable (attempt 1,`);
      expect(connections).toBe(1);
      expect(received).toBe(0);
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain(USER);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('fails after the set attempts with the plain error, and never prints the connection string', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as net.AddressInfo;
    await new Promise((r) => server.close(r)); // now nothing listens there
    const { code, out } = await runCli(['--attempts', '3', '--timeout-ms', '1000', '--backoff-ms', '20'], {
      AZURE_POSTGRES_CONNECTION_STRING: conn(port),
    });
    expect(code).toBe(1);
    expect(out).toContain(`attempt 1/3 to 127.0.0.1:${port} failed (ECONNREFUSED)`);
    expect(out).toContain(`attempt 3/3 to 127.0.0.1:${port} failed (ECONNREFUSED)`);
    expect(out).toContain('::error title=Database unreachable from this runner::');
    expect(out).toContain(`Could not open a TCP connection to 127.0.0.1:${port} after 3 attempt(s) (last: ECONNREFUSED).`);
    expect(out).toContain("This check sends no data and runs before this job's first database step, so the job has not touched the database.");
    expect(out).toContain('re-run the job, or dispatch a fresh run where re-runs are refused (release-one-approval)');
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(USER);
  });

  it('still runs (does not silently skip itself) when started through a linked folder', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as net.AddressInfo;
    const link = path.join(os.tmpdir(), `ppbf-probe-link-${process.pid}-${Date.now()}`);
    // 'junction' needs no admin rights on Windows; elsewhere the type is ignored.
    fs.symlinkSync(path.dirname(probePath), link, 'junction');
    try {
      const out = await new Promise<{ code: number; out: string }>((resolve) => {
        execFile(
          process.execPath,
          [path.join(link, path.basename(probePath))],
          { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', AZURE_POSTGRES_CONNECTION_STRING: conn(port) } as unknown as NodeJS.ProcessEnv },
          (err: (Error & { code?: unknown }) | null, stdout: string, stderr: string) =>
            resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}${stderr}` }),
        );
      });
      expect(out.code).toBe(0);
      expect(out.out).toContain('reachable (attempt 1,');
    } finally {
      // Remove the LINK only, never recursively (a recursive delete would follow it into scripts/).
      try {
        fs.unlinkSync(link);
      } catch {
        fs.rmdirSync(link);
      }
      await new Promise((r) => server.close(r));
    }
  });

  it('reads the variable NAMED by --env (the gate steps use GATE_DB_CONNECTION)', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as net.AddressInfo;
    try {
      const { code, out } = await runCli(['--env', 'GATE_DB_CONNECTION'], { GATE_DB_CONNECTION: conn(port) });
      expect(code).toBe(0);
      expect(out).toContain('reachable');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe('db-reachability-probe: misuse and odd input', () => {
  it('refuses when the named variable is empty', async () => {
    const { code, out } = await runCli([], {});
    expect(code).toBe(1);
    expect(out).toContain('::error title=db-preflight misused::AZURE_POSTGRES_CONNECTION_STRING is empty or unset');
  });

  it('steps aside, without echoing it, when the string is not URL-shaped', async () => {
    const { code, out } = await runCli([], { AZURE_POSTGRES_CONNECTION_STRING: `host=x user=${USER} password=${SECRET}` });
    expect(code).toBe(0);
    expect(out).toContain('::warning title=db-preflight skipped::');
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(USER);
  });

  it('rejects an --env that is not a variable name and unknown flags', async () => {
    expect((await runCli(['--env', '$(id)'], {})).code).toBe(1);
    expect((await runCli(['--bogus', '1'], {})).code).toBe(1);
  });

  it('parses host and default port, and refuses a bad port', () => {
    const r = inModule(`console.log(JSON.stringify([
      p.targetFromConnectionString('postgresql://u:pw@Ppbf-PG-1.postgres.database.azure.com/db'),
      p.targetFromConnectionString('postgresql://u:pw@h:6543/db'),
      p.targetFromConnectionString('postgresql://u:pw@h:0/db'),
      p.targetFromConnectionString('postgresql://u:pw@[::1]:5433/db'),
      p.targetFromConnectionString('not a url'),
    ]));`);
    expect(r).toEqual([
      { host: 'ppbf-pg-1.postgres.database.azure.com', port: 5432 },
      { host: 'h', port: 6543 },
      null,
      { host: '::1', port: 5433 },
      null,
    ]);
  });
});

describe('db-reachability-probe: naming the runner cloud', () => {
  const setupInfo = JSON.stringify([
    { group: 'Runner Image Provisioner', detail: 'Hosted Compute Agent\nVersion: 20261103.629\nRegion: us-west-2\nCloud: AWS' },
    { group: 'Operating System', detail: 'Ubuntu\n26.04.1\nLTS' },
  ]);

  it('reads Cloud and Region from .setup_info', () => {
    const r = inModule(`console.log(JSON.stringify([p.parseSetupInfo(${JSON.stringify(setupInfo)}), p.parseSetupInfo('nope'), p.parseSetupInfo('[{"group":"x","detail":"y"}]')]));`);
    expect(r).toEqual([{ cloud: 'AWS', region: 'us-west-2' }, null, null]);
  });

  it('finds .setup_info by walking up to the Runner.Worker process', () => {
    const r = inModule(`
      const files = {
        '/proc/300/stat': '300 (node) S 200 1 1',
        '/proc/200/stat': '200 (bash -e) S 100 1 1',
        '/home/runner/actions-runner/cached/.setup_info': ${JSON.stringify(setupInfo)},
      };
      const links = { '/proc/300/exe': '/usr/bin/node', '/proc/200/exe': '/usr/bin/bash',
        '/proc/100/exe': '/home/runner/actions-runner/cached/bin/Runner.Worker' };
      const readlink = (f) => { if (f in links) return links[f]; throw new Error('ENOENT'); };
      const readFile = (f) => { if (f in files) return files[f]; throw new Error('ENOENT'); };
      console.log(JSON.stringify([
        p.findRunnerProvisioner({ startPid: 300, readlink, readFile }),
        p.findRunnerProvisioner({ startPid: 300, readlink: () => { throw new Error('x'); }, readFile: () => { throw new Error('x'); } }),
      ]));
    `);
    expect(r).toEqual([{ cloud: 'AWS', region: 'us-west-2' }, null]);
  });

  it('says which case it is: not Azure, Azure, or unknown', () => {
    const r = inModule(`console.log(JSON.stringify([
      p.failureMessage({ host: 'h', port: 5432, attempts: 3, codes: ['PROBE_TIMEOUT'], runner: { cloud: 'AWS', region: 'us-west-2' } }),
      p.failureMessage({ host: 'h', port: 5432, attempts: 3, codes: ['PROBE_TIMEOUT'], runner: { cloud: 'Azure', region: 'eastus2' } }),
      p.failureMessage({ host: 'h', port: 5432, attempts: 3, codes: [], runner: null }),
    ]));`) as string[];
    expect(r[0]).toContain('Runner cloud: AWS, region us-west-2');
    expect(r[0]).toContain('This runner is not on Azure.');
    expect(r[1]).toContain('This runner IS on Azure');
    expect(r[2]).toContain('Runner cloud: unknown');
    expect(r[2]).toContain('(last: unknown)');
  });
});

describe('db-reachability-probe: cannot write', () => {
  const source = fs.readFileSync(probePath, 'utf8');

  it('never writes to the socket and loads no database driver', () => {
    expect(source).not.toMatch(/\.write\(/);
    expect(source).not.toMatch(/\.end\(/);
    expect(source).not.toMatch(/from ['"]pg['"]|require\(['"]pg['"]\)|import\(['"]pg['"]\)/);
  });
});

describe("workflows: one probe per job, before that job's first database contact", () => {
  const PROBE_STEP = 'uses: ./.github/actions/db-preflight';
  const PROBE_INLINE = 'AZURE_POSTGRES_CONNECTION_STRING="$CONN" node "$GITHUB_WORKSPACE/scripts/db-reachability-probe.mjs"';
  const isStep = (l: string) => /^ {6}- name: /.test(l);

  interface Site {
    file: string;
    job: string;
    line: number;
    /** The resolve step's text and the step after it. */
    step: string;
    next: string;
  }

  // A job can reach Postgres only after it has fetched the connection string,
  // so the first fetch in a job comes before that job's first database contact.
  const sites: Site[] = [];
  for (const file of fs.readdirSync(workflowsDir).filter((f) => f.endsWith('.yml'))) {
    const lines = fs.readFileSync(path.join(workflowsDir, file), 'utf8').split('\n');
    let inJobs = false;
    let job = '';
    lines.forEach((l, i) => {
      if (/^jobs:\s*$/.test(l)) inJobs = true;
      const header = inJobs ? /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l) : null;
      if (header) job = header[1];
      if (!l.includes('--secret-name azure-postgres-connection-string')) return;
      let end = i + 1;
      while (end < lines.length && !isStep(lines[end])) end += 1;
      let nextEnd = end + 1;
      while (nextEnd < lines.length && !isStep(lines[nextEnd])) nextEnd += 1;
      sites.push({ file, job, line: i + 1, step: lines.slice(i, end).join('\n'), next: lines.slice(end, nextEnd).join('\n') });
    });
  }

  const probed = (s: Site): boolean => {
    if (s.step.includes('>> "$GITHUB_ENV"')) return s.next.includes(PROBE_STEP);
    const afterMask = s.step.split('echo "::add-mask::$CONN"')[1] ?? '';
    const first = afterMask.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    return first === PROBE_INLINE;
  };

  const jobs = new Map<string, Site[]>();
  for (const s of sites) jobs.set(`${s.file} ${s.job}`, [...(jobs.get(`${s.file} ${s.job}`) ?? []), s]);

  it('finds the jobs it guards', () => {
    expect(jobs.size).toBeGreaterThanOrEqual(21);
  });

  it.each([...jobs.entries()])('%s', (_label, jobSites) => {
    const [first, ...later] = jobSites;
    // The first fetch is followed by the probe ...
    expect({ at: `${first.file}:${first.line}`, probed: probed(first) }).toEqual({ at: `${first.file}:${first.line}`, probed: true });
    // ... and no later fetch in the same job is: the runner has already reached
    // the server, so a later probe cannot catch the non-Azure-runner case and
    // would only add a short-fused gate between steps that may already have written.
    for (const s of later) {
      expect({ at: `${s.file}:${s.line}`, probed: probed(s) }).toEqual({ at: `${s.file}:${s.line}`, probed: false });
    }
  });

  it('the composite action is used nowhere else', () => {
    const uses = fs.readdirSync(workflowsDir)
      .filter((f) => f.endsWith('.yml'))
      .reduce((n, f) => n + fs.readFileSync(path.join(workflowsDir, f), 'utf8').split(PROBE_STEP).length - 1, 0);
    const inline = fs.readdirSync(workflowsDir)
      .filter((f) => f.endsWith('.yml'))
      .reduce((n, f) => n + fs.readFileSync(path.join(workflowsDir, f), 'utf8').split(PROBE_INLINE).length - 1, 0);
    expect(uses + inline).toBe(jobs.size);
  });
});
