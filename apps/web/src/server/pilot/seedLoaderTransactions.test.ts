// Transaction control in the four seed loaders that used to COMMIT inside a
// `finally`: seed-disciplines.mjs, seed-drill-library.mjs,
// seed-transfer-claims.mjs and seed-workout-templates.mjs.
//
// `finally` runs on the throwing path too. A PostgreSQL error aborts the
// transaction, so its rows are gone whether or not a COMMIT follows -- which is
// why the old shape looked safe. A JavaScript error never reaches the server,
// leaves the transaction open and committable, and the `finally` COMMIT kept
// every row written before it while the run reported failure.
// seed-drill-secondary-skills.mjs:296-321 records the pg regression that
// measured that; its sibling loaders were fixed one at a time and these four
// were not.
//
// A real database cannot show the difference for an error the database itself
// raises, so these run each loader's real seedAll over its REAL seed files
// against a fake client that records every statement and, per case, throws a
// plain TypeError -- no SQLSTATE, nothing a server would have seen -- on a
// chosen insert AFTER earlier rows were written. The same loaders run against
// real Postgres in drillLibraryV3.pg.test.ts, workoutTemplates.pg.test.ts,
// multidiscipline.pg.test.ts and sessionScriptsTransfer.pg.test.ts.
//
// Two seed-drill-library.mjs fixes ride along because they are only visible
// through the same statements: grounding_claim_ids split on '|' (the separator
// 82 of the 119 supplied rows use), and the drill_cues count taken from
// RETURNING instead of one per CSV row.
//
// The loaders are real ESM (.mjs) and `npm test` has no ESM loader, so -- as in
// seedCreatedByRole.test.ts -- every case runs in one real `node` child.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCRIPTS_DIR = path.resolve(__dirname, '../../../scripts');
const SEED_DATA_DIR = path.resolve(__dirname, '../../../seed-data');

const ORG = 'punxsy_prominence';
const SEED_ACCOUNT = 'acct-gym-admin';
const INDUCED = 'INDUCED_NON_DATABASE_FAILURE';

interface ThrowOn {
  table: string;
  /** 1-based: the nth insert into `table` throws. */
  nth: number;
}

// throwOn is chosen so rows are already written when the error lands: the
// second row of a one-table loader, and the first row of the LAST table of a
// multi-table one, so every earlier table has been written.
const LOADERS = {
  disciplines: {
    module: pathToFileURL(path.join(SCRIPTS_DIR, 'seed-disciplines.mjs')).href,
    seedDir: path.join(SEED_DATA_DIR, 'multidiscipline'),
    tables: ['disciplines'],
    throwOn: { table: 'disciplines', nth: 2 },
  },
  drills: {
    module: pathToFileURL(path.join(SCRIPTS_DIR, 'seed-drill-library.mjs')).href,
    seedDir: path.join(SEED_DATA_DIR, 'drill-library'),
    tables: ['drill_library', 'drill_scale_levels', 'drill_stop_rules', 'drill_cues'],
    throwOn: { table: 'drill_cues', nth: 1 },
  },
  transferClaims: {
    module: pathToFileURL(path.join(SCRIPTS_DIR, 'seed-transfer-claims.mjs')).href,
    seedDir: path.join(SEED_DATA_DIR, 'transfer-claims'),
    tables: ['transfer_claims'],
    throwOn: { table: 'transfer_claims', nth: 2 },
  },
  templates: {
    module: pathToFileURL(path.join(SCRIPTS_DIR, 'seed-workout-templates.mjs')).href,
    seedDir: path.join(SEED_DATA_DIR, 'workout-templates'),
    tables: ['workout_templates', 'workout_template_items'],
    throwOn: { table: 'workout_template_items', nth: 1 },
  },
} as const;

type LoaderKey = keyof typeof LOADERS;

interface CaseSpec {
  loader: LoaderKey;
  dryRun: boolean;
  throwOn: ThrowOn | null;
  /** ROLLBACK throws too, as it does on a connection that died mid-run. */
  rollbackThrows: boolean;
  /** Every nth drill_cues insert returns no row, as ON CONFLICT DO NOTHING does for a cue already present. 0 = none. */
  cuePresentEvery: number;
}

const CASES: Record<string, CaseSpec> = {};
for (const key of Object.keys(LOADERS) as LoaderKey[]) {
  const base = { loader: key, dryRun: false, throwOn: null, rollbackThrows: false, cuePresentEvery: 0 };
  const { throwOn } = LOADERS[key];
  CASES[`${key}_apply`] = base;
  CASES[`${key}_dry_run`] = { ...base, dryRun: true };
  CASES[`${key}_throws`] = { ...base, throwOn };
  CASES[`${key}_throws_rollback_fails`] = { ...base, throwOn, rollbackThrows: true };
}
CASES.drills_cues_partly_present = {
  loader: 'drills', dryRun: false, throwOn: null, rollbackThrows: false, cuePresentEvery: 3,
};

interface Outcome {
  ok: boolean;
  message: string | null;
  errorName: string | null;
  /** BEGIN / COMMIT / ROLLBACK, in the order issued. */
  control: string[];
  /** The last statement issued: a control verb, or 'insert <table>'. */
  last: string | null;
  /** Inserts attempted per table, including one that threw. */
  inserts: Record<string, number>;
  /** drill_id -> the grounding_claim_ids array bound for it (drill-library cases only). */
  grounding: Record<string, string[]>;
  cues: { returned: number; present: number; total: number };
  logs: string[];
}

let outcomes: Record<string, Outcome>;

beforeAll(() => {
  // String.raw: the child's regular expressions are written exactly as they run.
  const script = String.raw`
    const loaders = ${JSON.stringify(LOADERS)};
    const cases = ${JSON.stringify(CASES)};
    const placeholders = ${JSON.stringify({ organizationId: ORG, seedAccountId: SEED_ACCOUNT })};
    const INDUCED = ${JSON.stringify(INDUCED)};
    const modules = {};
    for (const [key, loader] of Object.entries(loaders)) modules[key] = await import(loader.module);

    // The loaders report on console.log. Each case keeps its own lines, and
    // stdout is reserved for the result.
    let logs = [];
    console.log = (...args) => { logs.push(args.join(' ')); };

    // Read off the statement itself rather than assumed, so a reordered column
    // list cannot make this read the wrong parameter.
    function columnsOf(sql, table) {
      const match = sql.match(new RegExp('insert into pilot\\.' + table + '\\s*\\(([^)]*)\\)', 'i'));
      if (!match) throw new Error('no column list in the ' + table + ' insert');
      return match[1].split(',').map((name) => name.trim());
    }

    function fakeClient(spec) {
      const state = {
        control: [],
        last: null,
        inserts: {},
        grounding: {},
        cues: { returned: 0, present: 0, total: 0 },
      };
      return {
        state,
        async query(sql, params = []) {
          const text = String(sql).trim();
          if (/from\s+pilot\.accounts/i.test(text)) {
            state.last = 'select pilot.accounts';
            return { rows: [{ role: 'organization_admin' }], rowCount: 1 };
          }

          const insert = text.match(/^insert\s+into\s+pilot\.(\w+)/i);
          if (!insert) {
            const verb = text.split(/\s+/)[0].toUpperCase();
            state.control.push(verb);
            state.last = verb;
            if (verb === 'ROLLBACK' && spec.rollbackThrows) {
              throw new Error('ROLLBACK_ALSO_FAILED: connection gone');
            }
            return { rows: [], rowCount: 0 };
          }

          const table = insert[1];
          const nth = (state.inserts[table] ?? 0) + 1;
          state.inserts[table] = nth;
          state.last = 'insert ' + table;

          if (spec.throwOn && spec.throwOn.table === table && spec.throwOn.nth === nth) {
            // Not a PostgreSQL error: no SQLSTATE, and nothing a server saw --
            // so nothing that would have aborted the transaction.
            throw new TypeError(INDUCED);
          }

          if (table === 'drill_library') {
            const columns = columnsOf(text, table);
            state.grounding[params[columns.indexOf('drill_id')]] = params[columns.indexOf('grounding_claim_ids')];
          }

          const present = table === 'drill_cues' && spec.cuePresentEvery > 0 && nth % spec.cuePresentEvery === 0;
          // As pg does: rows come back only for a statement that asks for them,
          // and ON CONFLICT DO NOTHING on a present row returns none.
          const rows = !present && /\breturning\b/i.test(text) ? [{ returned: true }] : [];
          if (table === 'drill_cues') {
            state.cues.total += 1;
            if (present) state.cues.present += 1;
            if (rows.length > 0) state.cues.returned += 1;
          }
          return { rows, rowCount: present ? 0 : 1 };
        },
      };
    }

    const out = {};
    for (const [name, spec] of Object.entries(cases)) {
      const client = fakeClient(spec);
      logs = [];
      let ok = true;
      let message = null;
      let errorName = null;
      try {
        await modules[spec.loader].seedAll(client, loaders[spec.loader].seedDir, placeholders, { dryRun: spec.dryRun });
      } catch (error) {
        ok = false;
        message = error.message;
        errorName = error.name;
      }
      out[name] = { ok, message, errorName, ...client.state, logs };
    }
    process.stdout.write(JSON.stringify(out));
  `;

  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  outcomes = JSON.parse(stdout);
});

function totalInserts(outcome: Outcome): number {
  return Object.values(outcome.inserts).reduce((sum, n) => sum + n, 0);
}

describe.each([
  ['seed-disciplines.mjs', 'disciplines'],
  ['seed-drill-library.mjs', 'drills'],
  ['seed-transfer-claims.mjs', 'transferClaims'],
  ['seed-workout-templates.mjs', 'templates'],
] as const)('%s transaction control', (_file, key) => {
  const loader = LOADERS[key];

  test('an apply that succeeds commits exactly once, as its last statement, and never rolls back', () => {
    const outcome = outcomes[`${key}_apply`];
    expect(outcome.message).toBeNull();
    expect(outcome.control).toEqual(['BEGIN', 'COMMIT']);
    expect(outcome.last).toBe('COMMIT');
    // Every table the loader owns was written, so the COMMIT had rows to keep.
    for (const table of loader.tables) expect(outcome.inserts[table]).toBeGreaterThan(0);
  });

  test('a JavaScript error after rows were written rolls back, never commits, and reaches the caller', () => {
    const outcome = outcomes[`${key}_throws`];
    expect(outcome.ok).toBe(false);
    expect(outcome.errorName).toBe('TypeError');
    expect(outcome.message).toBe(INDUCED);
    // Rows really were written before the error, so a COMMIT here would have
    // kept them -- that is the failure being excluded, not an empty commit.
    expect(totalInserts(outcome)).toBeGreaterThan(1);
    expect(outcome.inserts[loader.throwOn.table]).toBe(loader.throwOn.nth);
    expect(outcome.control).toEqual(['BEGIN', 'ROLLBACK']);
    // Nothing after the rollback: the loader stopped at the error.
    expect(outcome.last).toBe('ROLLBACK');
  });

  test('the caller gets the original error, not the ROLLBACK failure, when the connection is gone', () => {
    const outcome = outcomes[`${key}_throws_rollback_fails`];
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe(INDUCED);
    expect(outcome.control).toEqual(['BEGIN', 'ROLLBACK']);
  });

  test('a dry run writes every row for real, then rolls back and never commits', () => {
    const outcome = outcomes[`${key}_dry_run`];
    expect(outcome.message).toBeNull();
    // The inserts still run: a dry run proves the rows fit the live schema by
    // making the database decide, then discards them.
    for (const table of loader.tables) expect(outcome.inserts[table]).toBeGreaterThan(0);
    expect(outcome.control).toEqual(['BEGIN', 'ROLLBACK']);
    expect(outcome.last).toBe('ROLLBACK');
  });
});

describe('seed-drill-library.mjs grounding_claim_ids', () => {
  test("splits on '|': 'A2-063|A2-068' loads as two claim ids, not one", () => {
    const { grounding } = outcomes.drills_apply;
    expect(grounding.drl_7f812fecacfee4).toEqual(['A2-063', 'A2-068']);
    expect(grounding.drl_2d0193a7c52e58).toEqual(['A3-032', 'A6-055', 'A8-052']);
  });

  test("no loaded element still carries a '|'", () => {
    const elements = Object.values(outcomes.drills_apply.grounding).flat();
    expect(elements.length).toBeGreaterThan(0);
    expect(elements.filter((element) => element.includes('|'))).toEqual([]);
  });
});

describe('seed-drill-library.mjs drill_cues count', () => {
  test('reports the rows the database returned, not one per CSV row', () => {
    const outcome = outcomes.drills_cues_partly_present;
    expect(outcome.message).toBeNull();
    // Some cues were answered as already present; without both kinds this
    // would measure nothing.
    expect(outcome.cues.present).toBeGreaterThan(0);
    expect(outcome.cues.present).toBeLessThan(outcome.cues.total);

    const line = outcome.logs.find((entry) => entry.startsWith('drill_cues:'));
    expect(line).toBe(
      `drill_cues: ${outcome.cues.returned} would-insert/inserted, `
      + `${outcome.cues.total - outcome.cues.returned} already present (skipped)`,
    );
    // And the rows returned are exactly the cues that were not present, which
    // only holds when the insert asks for RETURNING.
    expect(outcome.cues.returned).toBe(outcome.cues.total - outcome.cues.present);
  });
});
