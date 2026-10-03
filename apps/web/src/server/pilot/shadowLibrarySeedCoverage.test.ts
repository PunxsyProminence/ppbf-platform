// What seed:shadow:library sends for capability coverage.
//
// Coverage counts only sources SHADOW search can serve, and everything the seed
// registers lands as pending_review. The seed used to finish with a recompute,
// so on a fresh gym every doctrine rule graded 'uncovered' and
// ensureCoverageGapResearchRequirement opened a research-gap ticket for each.
// Approving the sources at /evidence closes nothing by itself -- only a later
// recompute does -- so every gym seeded this way started with gap tickets that
// were wrong once review finished, feeding the triage view and the research
// bridge export until someone recomputed. A seed run now writes the rules and
// does not grade them; --recompute grades, and does nothing else.
//
// HOW IT RUNS. The script is real ESM and runs only as an entry point, so each
// case runs it in a real node child process, the way its npm script does, with
// fetch replaced by a recorder (--import preload) that answers like the API and
// writes every request to a log. Nothing leaves the machine: the base URL is a
// .invalid host and the recorder never calls the real fetch.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const WEB_ROOT = path.resolve(__dirname, '../../..');
// Relative to cwd = WEB_ROOT, which is how the npm script invokes it; the
// script's own entry-point check resolves argv[1] against the same cwd.
const SCRIPT = 'scripts/seed-shadow-library.mjs';
const COVERAGE_PATH = '/api/pilot/shadow/library/capability-coverage';

interface RecordedRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

interface SeedRun {
  requests: RecordedRequest[];
  stdout: string;
}

const RECORDER = `
import fs from 'node:fs';
const logPath = process.env.SEED_TEST_REQUEST_LOG;
globalThis.fetch = async (url, init = {}) => {
  const target = new URL(String(url));
  const method = init.method ?? 'GET';
  const body = init.body ? JSON.parse(init.body) : null;
  fs.appendFileSync(logPath, JSON.stringify({ method, path: target.pathname, body }) + '\\n');
  let payload = { ok: true };
  if (target.pathname.endsWith('/library/sources')) {
    payload = method === 'GET'
      ? { ok: true, items: [] }
      : { ok: true, source: { source_id: 'source_recorded' } };
  } else if (target.pathname.endsWith('/library/documents')) {
    payload = { ok: true, document: { document_id: 'document_recorded' } };
  } else if (target.pathname.endsWith('/capability-coverage') && body?.action === 'recompute') {
    payload = {
      ok: true,
      items: [{
        capability_key: 'shadow.doctrine.authority-boundary',
        coverage_state: 'covered',
        matched_sources: 1,
        minimum_source_count: 1,
      }],
    };
  }
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
`;

let workdir: string;
let seedRun: SeedRun;
let recomputeRun: SeedRun;
let helpRun: SeedRun;

function runSeed(args: string[], logName: string): SeedRun {
  const logPath = path.join(workdir, `${logName}.jsonl`);
  fs.writeFileSync(logPath, '');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PILOT_SESSION_COOKIE: 'recorded-session',
    PILOT_GATE_BASE_URL: 'http://seed-test.invalid',
    SEED_TEST_REQUEST_LOG: logPath,
  };
  // The default manifest is the one an operator's run reads.
  delete env.PILOT_LIBRARY_MANIFEST;

  let stdout: string;
  try {
    stdout = execFileSync(
      process.execPath,
      ['--import', pathToFileURL(path.join(workdir, 'recorder.mjs')).href, SCRIPT, ...args],
      { encoding: 'utf8', cwd: WEB_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    throw new Error(`seed ${args.join(' ') || '(no args)'} failed:\n${failed.stderr ?? ''}\n${failed.stdout ?? ''}`);
  }

  const requests = fs.readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordedRequest);
  return { requests, stdout };
}

function isRecompute(request: RecordedRequest): boolean {
  return request.method === 'POST' && request.path === COVERAGE_PATH && request.body?.action === 'recompute';
}

beforeAll(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-shadow-seed-coverage-'));
  fs.writeFileSync(path.join(workdir, 'recorder.mjs'), RECORDER);
  try {
    seedRun = runSeed([], 'seed');
    recomputeRun = runSeed(['--recompute'], 'recompute');
    helpRun = runSeed(['--help'], 'help');
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}, 60_000);

describe('seed:shadow:library capability coverage', () => {
  // Proves the recorder saw a real run: without it, a script that never
  // started would pass the "sends no recompute" test below.
  it('a seed run registers the doctrine and writes the coverage rules', () => {
    const paths = seedRun.requests.map((request) => `${request.method} ${request.path}`);
    expect(paths).toContain('POST /api/pilot/shadow/library/sources');
    expect(paths).toContain('POST /api/pilot/shadow/library/documents');

    const rules = seedRun.requests.filter(
      (request) => request.method === 'POST' && request.path === COVERAGE_PATH && !isRecompute(request),
    );
    expect(rules.map((request) => request.body?.capability_key)).toEqual([
      'shadow.doctrine.authority-boundary',
      'shadow.doctrine.research-escalation',
      'shadow.doctrine.organizational-memory',
      'shadow.doctrine.capability-growth',
    ]);
  });

  // The fix. Everything just registered is pending_review, so a grade now can
  // read 'uncovered' and open a gap ticket that outlives the review until the
  // next recompute.
  it('a seed run does not grade coverage', () => {
    expect(seedRun.requests.filter(isRecompute)).toHaveLength(0);
    expect(seedRun.stdout).toContain('--recompute');
  });

  // Grading still has a way to run, and it writes nothing else: no source,
  // document, chunk or rule.
  it('--recompute grades coverage once and registers nothing', () => {
    const writes = recomputeRun.requests.filter((request) => request.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(isRecompute(writes[0])).toBe(true);
    expect(recomputeRun.stdout).toContain('"coverage_state": "covered"');
  });

  // The help states when a ticket a person resolved by hand comes back: not
  // while the gap is the one they resolved, but once the capability has been
  // covered since (syncCapabilityGapRequirement; OD-2026-09-29-002 item 4).
  it('--help tells the operator when a ticket resolved by hand comes back', () => {
    expect(helpRun.requests).toHaveLength(0);
    const help = helpRun.stdout.replace(/\s+/g, ' ');
    expect(help).toContain(
      'A ticket a person resolved by hand stays resolved until the capability has been covered since; '
        + 'a gap that comes back after that reopens it.',
    );
  });
});
