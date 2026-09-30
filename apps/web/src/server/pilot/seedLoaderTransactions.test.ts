// Transaction control of the seed path: runApply (contentImport/cli.ts), which
// `npm run seed:<dataset>`, `npm run content:apply` and the seed-reference-data
// workflow all run.
//
// WHY THIS FILE EXISTS. Four of the seven seed-*.mjs loaders the core replaced
// (IMP-10) put COMMIT in a `finally`. `finally` runs on the throwing path too.
// A PostgreSQL error aborts the transaction, so its rows are gone whether or not
// a COMMIT follows -- which is why that shape looked safe. A JavaScript error
// never reaches the server, leaves the transaction open and committable, and
// the `finally` COMMIT kept every row written before it while the run reported
// failure (#1020 fixed the loaders; this suite held them to it). The loaders are
// gone; the property is now runApply's, and this is where it is pinned.
//
// And the one the workflow depends on: `dataset: all` used to be a chain of
// per-loader transactions, so a failure half way left the earlier datasets
// committed. runApply plans every dataset first, then applies them all in ONE
// transaction.
//
// A real database cannot show the difference for an error the database itself
// raises, so these run runApply against a fake client that records every
// statement, with the plan and the apply engine replaced by stand-ins that
// write through that client and, per case, throw a plain TypeError -- no
// SQLSTATE, nothing a server would have seen -- AFTER rows were written. The
// real engine against real Postgres, one transaction included, is
// contentImportEngine.pg.test.ts ('apply --dataset all commits every loadable
// dataset together', 'a JavaScript error after the first write leaves nothing
// committed').

import path from 'node:path';

import type { DbClient } from './contentImport/actor';
import { applyImport, type ApplyResult } from './contentImport/apply';
import { datasetsFor, readDatasetFiles, runApply } from './contentImport/cli';
import { LOADABLE_DATASETS } from './contentImport/datasets';
import { type ImportPlan, planImport } from './contentImport/plan';

jest.mock('./contentImport/plan', () => ({ ...jest.requireActual('./contentImport/plan'), planImport: jest.fn() }));
jest.mock('./contentImport/apply', () => ({ ...jest.requireActual('./contentImport/apply'), applyImport: jest.fn() }));

const SEED_DATA_DIR = path.resolve(__dirname, '../../../seed-data');
const ORG = 'punxsy_prominence';
const ACCOUNT = 'ppbf@punxsyprominence.org';
const INDUCED = 'INDUCED_NON_DATABASE_FAILURE';

const mockedPlan = planImport as jest.MockedFunction<typeof planImport>;
const mockedApply = applyImport as jest.MockedFunction<typeof applyImport>;

function fakePlan(files: Record<string, string>, blocking = 0): ImportPlan {
  return {
    organizationId: ORG,
    actor: { accountId: ACCOUNT, role: 'organization_admin', isPlatformOwner: false },
    datasets: [...LOADABLE_DATASETS],
    units: [],
    counts: {},
    totals: { new: Object.keys(files).length, new_version: 0, unchanged: 0, absent: 0, reject: 0 },
    blocking: Array.from({ length: blocking }, () => ({ code: 'orphan_reference' as const, file: 'x.csv', message: 'refused' })),
    warnings: [],
    changes: Object.keys(files).length,
    planHash: `plan-of-${Object.keys(files).length}-files`,
  };
}

interface Recorded {
  sql: string;
}

/** Records every statement. `rollbackFails` models a connection that is already gone. */
function fakeClient(options: { rollbackFails?: boolean } = {}) {
  const calls: Recorded[] = [];
  return {
    calls,
    async query(sql: string) {
      calls.push({ sql: sql.trim().replace(/\s+/g, ' ') });
      if (options.rollbackFails && /^rollback$/i.test(sql.trim())) throw new Error('Connection terminated');
      return { rows: [], rowCount: 1 };
    },
  };
}

/**
 * The engine stand-in: one insert per file handed to it (so "rows were
 * written" is literal), then an optional plain JavaScript failure.
 */
function applyWriting(options: { throwAfterWrites?: number } = {}) {
  mockedApply.mockImplementation(async (request) => {
    const files = Object.keys(request.files);
    let written = 0;
    for (const file of files) {
      await request.client.query(`insert into pilot.fake_rows (file) values ('${file}')`);
      written += 1;
      if (options.throwAfterWrites !== undefined && written === options.throwAfterWrites) throw new TypeError(INDUCED);
    }
    const plan = fakePlan(request.files as Record<string, string>);
    const result: ApplyResult = {
      plan,
      importId: 'import-1',
      auditId: 'audit-1',
      audit: { importId: 'import-1', organizationId: ORG, actor: plan.actor, details: {} },
      written: {},
      ledgerRows: 0,
    };
    return result;
  });
}

function command(client: ReturnType<typeof fakeClient>, dryRun: boolean, datasets = datasetsFor('all')) {
  return { client: client as unknown as DbClient, organizationId: ORG, actorAccountId: ACCOUNT, seedDataDir: SEED_DATA_DIR, datasets, dryRun };
}

const quietIo = () => {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
};

const statements = (client: ReturnType<typeof fakeClient>) => client.calls.map((call) => call.sql);
const count = (list: string[], pattern: RegExp) => list.filter((sql) => pattern.test(sql)).length;
const WRITE_BEGIN = /^begin$/i;
const COMMIT = /^commit$/i;
const ROLLBACK = /^rollback$/i;
const INSERT = /^insert into pilot\.fake_rows/i;

beforeEach(() => {
  mockedPlan.mockReset();
  mockedApply.mockReset();
  mockedPlan.mockImplementation(async (request) => fakePlan(request.files as Record<string, string>));
});

describe("runApply: 'all' plans every dataset, then applies them all in ONE transaction", () => {
  test('one read-only plan over every dataset, then one BEGIN, one apply call with every file, one COMMIT', async () => {
    applyWriting();
    const client = fakeClient();
    const io = quietIo();
    expect(await runApply(command(client, false), io)).toBe(0);

    const every = readDatasetFiles(SEED_DATA_DIR, datasetsFor('all'));
    // A floor on what 'all' covers, so the equalities below cannot pass on a
    // package that lost its datasets.
    expect(Object.keys(every).length).toBeGreaterThanOrEqual(12);

    // PLANNED FIRST, over every dataset, and read-only.
    expect(mockedPlan).toHaveBeenCalledTimes(1);
    expect(Object.keys(mockedPlan.mock.calls[0][0].files).sort()).toEqual(Object.keys(every).sort());
    const list = statements(client);
    expect(list.slice(0, 2)).toEqual(['BEGIN READ ONLY', 'ROLLBACK']);

    // THEN ONE apply, handed every file at once and the hash of the plan shown.
    expect(mockedApply).toHaveBeenCalledTimes(1);
    expect(Object.keys(mockedApply.mock.calls[0][0].files).sort()).toEqual(Object.keys(every).sort());
    expect(mockedApply.mock.calls[0][0].expectedPlanHash).toBe(fakePlan(every).planHash);

    // ONE transaction: one BEGIN, every write inside it, one COMMIT after the last write.
    expect(count(list, WRITE_BEGIN)).toBe(1);
    expect(count(list, COMMIT)).toBe(1);
    const begin = list.findIndex((sql) => WRITE_BEGIN.test(sql));
    const commit = list.findIndex((sql) => COMMIT.test(sql));
    const inserts = list.map((sql, index) => (INSERT.test(sql) ? index : -1)).filter((index) => index > -1);
    expect(inserts).toHaveLength(Object.keys(every).length);
    expect(inserts.every((index) => index > begin && index < commit)).toBe(true);
    // Nothing rolls back the write transaction on success.
    expect(list.slice(begin).some((sql) => ROLLBACK.test(sql))).toBe(false);
    // The SHADOW mirror is written after COMMIT, never inside it.
    const mirror = list.findIndex((sql) => /^insert into pilot\.shadow_events/i.test(sql));
    expect(mirror).toBeGreaterThan(commit);
    expect(io.lines).toContain(`RESULT: COMMITTED -- ${Object.keys(every).length} item(s) written, import_id import-1.`);
  });
});

describe('runApply transaction control (the finally-COMMIT defect, pinned on the one loader left)', () => {
  test('a JavaScript error after rows were written rolls back, never commits, and reaches the caller', async () => {
    applyWriting({ throwAfterWrites: 3 });
    const client = fakeClient();
    await expect(runApply(command(client, false), quietIo())).rejects.toThrow(INDUCED);

    const list = statements(client);
    expect(count(list, INSERT)).toBe(3);
    expect(count(list, COMMIT)).toBe(0);
    const begin = list.findIndex((sql) => WRITE_BEGIN.test(sql));
    expect(list[list.length - 1]).toBe('ROLLBACK');
    expect(list.lastIndexOf('ROLLBACK')).toBeGreaterThan(begin);
  });

  test('the caller gets the original error, not the ROLLBACK failure, when the connection is gone', async () => {
    applyWriting({ throwAfterWrites: 1 });
    const client = fakeClient({ rollbackFails: true });
    await expect(runApply(command(client, false), quietIo())).rejects.toThrow(INDUCED);
    expect(count(statements(client), COMMIT)).toBe(0);
  });

  test('a dry run writes every row for real, then rolls back and never commits', async () => {
    applyWriting();
    const client = fakeClient();
    const io = quietIo();
    expect(await runApply(command(client, true), io)).toBe(0);

    const list = statements(client);
    const every = readDatasetFiles(SEED_DATA_DIR, datasetsFor('all'));
    // The apply really ran -- every write -- which is what proves the rows fit
    // the live schema; then it was undone.
    expect(count(list, INSERT)).toBe(Object.keys(every).length);
    expect(count(list, COMMIT)).toBe(0);
    expect(list[list.length - 1]).toBe('ROLLBACK');
    // A rolled-back import is not an event: no SHADOW mirror.
    expect(list.some((sql) => /shadow_events/.test(sql))).toBe(false);
    expect(io.lines.some((line) => line.startsWith('RESULT: DRY RUN -- applied inside the transaction and ROLLED BACK'))).toBe(true);
  });

  test('a plan with a blocking finding opens no write transaction and writes nothing', async () => {
    mockedPlan.mockImplementation(async (request) => fakePlan(request.files as Record<string, string>, 2));
    applyWriting();
    const client = fakeClient();
    const io = quietIo();
    expect(await runApply(command(client, false), io)).toBe(1);

    expect(mockedApply).not.toHaveBeenCalled();
    expect(statements(client)).toEqual(['BEGIN READ ONLY', 'ROLLBACK']);
    expect(io.lines).toContain('RESULT: BLOCKED -- 2 blocking problem(s); nothing was written.');
  });

  test('one dataset is one transaction too', async () => {
    applyWriting();
    const client = fakeClient();
    expect(await runApply(command(client, false, datasetsFor('competence-levels,cohort-definitions')), quietIo())).toBe(0);
    expect(Object.keys(mockedApply.mock.calls[0][0].files).sort()).toEqual([
      'competence-cohorts/seed_cohort_definitions.csv',
      'competence-cohorts/seed_competence_levels.csv',
    ]);
    const list = statements(client);
    expect([count(list, WRITE_BEGIN), count(list, COMMIT)]).toEqual([1, 1]);
  });
});
