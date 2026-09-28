// Guards on the SHADOW job-queue deploy gate.
//
// WHY THIS FILE EXISTS. The script's whole job is to say "no" to a production
// deploy while background jobs are still waiting, because a queued job holds
// its own copy of the context it will be answered from and a context change
// does not reach it. The owner ruled that this be enforced rather than written
// down -- "Nothing is real if anything is waiting" -- and an enforcement whose
// decision nobody tests is the note he declined, wearing a script's clothes.
//
// WHAT IT CANNOT DO. It cannot prove the script works against the real
// database. Production PostgreSQL is firewalled from the build machine, so the
// first real execution is the first production deploy that runs it. What is
// provable here is the DECISION: given what the database says, does the script
// pass or refuse. The pg client is stubbed and no network call is made.
//
// HOW IT RUNS. The module is loaded in a real node subprocess, the way the
// workflow consumes it, rather than through a jest transform -- matching
// check-evidence-applicability.test.ts. A transpiled copy could pass while the
// file node actually loads is broken.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

jest.setTimeout(120_000);

const MODULE_URL = pathToFileURL(
  path.resolve(__dirname, 'pilot-check-shadow-job-queue.mjs'),
).href;

type StubSpec = {
  database?: string;
  tablePresent?: boolean;
  open?: Array<{ status: string; job_type: string; n: number }>;
  failOn?: string;
};

type Outcome = {
  ok: boolean;
  error?: string;
  report?: { database: string; tablePresent: boolean; open: StubSpec['open']; openCount: number };
  text?: string;
  calls: string[];
};

/** Runs checkShadowJobQueue against a stub client inside a real node process. */
function runCheck(spec: StubSpec): Outcome {
  const script = `
    import * as m from ${JSON.stringify(MODULE_URL)};
    const spec = ${JSON.stringify(spec)};
    const calls = [];
    const client = {
      async query(text) {
        calls.push(text.trim());
        if (spec.failOn && new RegExp(spec.failOn, 'i').test(text)) throw new Error('stub: statement failed');
        if (/^BEGIN TRANSACTION READ ONLY/i.test(text)) return { rows: [] };
        if (/^ROLLBACK/i.test(text)) return { rows: [] };
        if (/current_database/i.test(text)) return { rows: [{ db: spec.database ?? 'postgres' }] };
        if (/to_regclass/i.test(text)) return { rows: [{ present: spec.tablePresent !== false }] };
        if (/from pilot\\.shadow_jobs/i.test(text)) return { rows: spec.open ?? [] };
        throw new Error('stub: unexpected statement: ' + text);
      },
    };
    try {
      const report = await m.checkShadowJobQueue(client);
      console.log(JSON.stringify({ ok: true, report, text: m.describe(report).join('\\n'), calls }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: String(error && error.message || error), calls }));
    }
  `;

  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    cwd: __dirname,
  }));
}

describe('SHADOW job-queue deploy gate', () => {
  describe('the decision it hands the deploy', () => {
    test('an empty queue passes', () => {
      const out = runCheck({ open: [] });

      expect(out.ok).toBe(true);
      expect(out.report!.tablePresent).toBe(true);
      expect(out.report!.openCount).toBe(0);
      expect(out.text).toContain('EMPTY');
    });

    test('a pending job refuses', () => {
      const out = runCheck({ open: [{ status: 'pending', job_type: 'heavy_bag_session', n: 1 }] });

      expect(out.report!.openCount).toBe(1);
      expect(out.text).toContain('1 JOB(S) STILL WAITING');
    });

    // A job already executing is the exact case this guard is about: it is
    // answering from its stored payload right now. A check that counted only
    // 'pending' would call this an empty queue.
    test('a RUNNING job refuses, not just a pending one', () => {
      const out = runCheck({ open: [{ status: 'running', job_type: 'scout_report', n: 1 }] });

      expect(out.report!.openCount).toBe(1);
      expect(out.text).toContain('STILL WAITING');
    });

    test('counts are summed across statuses and job types', () => {
      const out = runCheck({
        open: [
          { status: 'pending', job_type: 'board_summary', n: 2 },
          { status: 'pending', job_type: 'heavy_bag_session', n: 3 },
          { status: 'running', job_type: 'scout_report', n: 1 },
        ],
      });

      expect(out.report!.openCount).toBe(6);
      expect(out.text).toContain('6 JOB(S) STILL WAITING');
      expect(out.text).toContain('board_summary');
    });

    // Terminal statuses are history. If these counted, the gate would refuse
    // every deploy forever the moment SHADOW answered its first job.
    test('completed, failed and cancelled are not among the statuses asked for', () => {
      const out = runCheck({ open: [] });

      const queueQuery = out.calls.find((c) => /from pilot\.shadow_jobs/i.test(c));
      expect(queueQuery).toBeDefined();
      expect(queueQuery).not.toMatch(/completed|failed|cancelled/i);
      expect(queueQuery).toMatch(/status\s*=\s*any/i);
    });
  });

  describe('the posture it runs under', () => {
    // Postgres refuses the write, so the script cannot damage production even
    // if it were edited carelessly later. That is a property of the session,
    // not of this file's good intentions.
    test('every read happens inside an explicit READ ONLY transaction', () => {
      const out = runCheck({ open: [] });

      expect(out.calls[0]).toMatch(/^BEGIN TRANSACTION READ ONLY/i);
      expect(out.calls.filter((c) => /select/i.test(c)).length).toBeGreaterThan(0);
      expect(out.calls[out.calls.length - 1]).toMatch(/^ROLLBACK/i);
    });

    test('the transaction is closed even when a read throws', () => {
      const out = runCheck({ open: [], failOn: 'from pilot\\.shadow_jobs' });

      expect(out.ok).toBe(false);
      expect(out.error).toContain('stub: statement failed');
      expect(out.calls[out.calls.length - 1]).toMatch(/^ROLLBACK/i);
    });
  });

  describe('a database with no queue table', () => {
    // Honest distinction. "No table" and "table empty" are both passes, and
    // they are not the same fact -- one means SHADOW's job system was never
    // provisioned here. Reporting them identically would let a later reader
    // record "queue checked and empty" about an environment with no queue.
    test('passes, and says so differently from an empty queue', () => {
      const out = runCheck({ tablePresent: false, database: 'somewhere_else' });

      expect(out.report!.tablePresent).toBe(false);
      expect(out.report!.openCount).toBe(0);
      expect(out.text).toContain('NO QUEUE TABLE');
      expect(out.text).not.toContain('EMPTY');
      expect(out.text).toContain('not the same fact as an empty queue');
    });

    test('does not query the table it just found absent', () => {
      const out = runCheck({ tablePresent: false });

      expect(out.calls.some((c) => /from pilot\.shadow_jobs/i.test(c))).toBe(false);
    });
  });

  test('the report names the database it read', () => {
    const out = runCheck({ database: 'ppbf_production', open: [] });

    expect(out.report!.database).toBe('ppbf_production');
    expect(out.text).toContain('ppbf_production');
  });
});
