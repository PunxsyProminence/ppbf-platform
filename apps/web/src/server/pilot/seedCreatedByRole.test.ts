// seed-drill-library.mjs and seed-workout-templates.mjs record the seed
// account's REAL role as created_by_role -- read from pilot.accounts -- not a
// value carried in the seed CSV.
//
// Until this was fixed both CSVs said platform_owner on all 119 + 12 rows and
// the loaders wrote it as given, so a gym seed run as an organization_admin
// (OD-2026-09-28-005, OD-2026-09-28-007) stamped every new row with a role its
// creator never held. Nothing failed; the rows were simply wrong.
//
// These run the loaders' real seedAll over the REAL seed files against a fake
// client, so they need no database: the fake answers the account lookup from a
// table the case supplies and records every statement. The role a case gives
// the account is deliberately not platform_owner, so the old behaviour cannot
// pass by coincidence. The same files are exercised against real Postgres by
// drillLibraryV3.pg.test.ts and workoutTemplates.pg.test.ts.
//
// The loaders are real ESM (.mjs) and `npm test` has no ESM loader, so -- as in
// postgresWriteTarget.test.ts -- every case runs in one real `node` child.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCRIPTS_DIR = path.resolve(__dirname, '../../../scripts');
const SEED_DATA_DIR = path.resolve(__dirname, '../../../seed-data');

const LOADERS = {
  drills: {
    module: pathToFileURL(path.join(SCRIPTS_DIR, 'seed-drill-library.mjs')).href,
    seedDir: path.join(SEED_DATA_DIR, 'drill-library'),
    table: 'drill_library',
    rows: 119,
  },
  templates: {
    module: pathToFileURL(path.join(SCRIPTS_DIR, 'seed-workout-templates.mjs')).href,
    seedDir: path.join(SEED_DATA_DIR, 'workout-templates'),
    table: 'workout_templates',
    rows: 12,
  },
} as const;

type LoaderKey = keyof typeof LOADERS;

const ORG = 'punxsy_prominence';

// account_id -> role, as pilot.accounts would answer. A missing key is a
// missing account.
const ACCOUNTS: Record<string, string | null> = {
  'acct-gym-admin': 'organization_admin',
  'acct-gym-coach': 'coach',
  'acct-blank-role': '   ',
  'acct-null-role': null,
};

interface CaseSpec {
  loader: LoaderKey;
  seedAccountId: string;
  dryRun: boolean;
}

const CASES: Record<string, CaseSpec> = {
  drills_org_admin: { loader: 'drills', seedAccountId: 'acct-gym-admin', dryRun: false },
  drills_coach: { loader: 'drills', seedAccountId: 'acct-gym-coach', dryRun: false },
  drills_missing: { loader: 'drills', seedAccountId: 'acct-nobody', dryRun: true },
  drills_blank_role: { loader: 'drills', seedAccountId: 'acct-blank-role', dryRun: true },
  drills_null_role: { loader: 'drills', seedAccountId: 'acct-null-role', dryRun: true },
  templates_org_admin: { loader: 'templates', seedAccountId: 'acct-gym-admin', dryRun: false },
  templates_coach: { loader: 'templates', seedAccountId: 'acct-gym-coach', dryRun: false },
  templates_missing: { loader: 'templates', seedAccountId: 'acct-nobody', dryRun: true },
  templates_blank_role: { loader: 'templates', seedAccountId: 'acct-blank-role', dryRun: true },
  templates_null_role: { loader: 'templates', seedAccountId: 'acct-null-role', dryRun: true },
};

interface Outcome {
  ok: boolean;
  message: string | null;
  /** Rows the loader tried to write into its parent table. */
  parentInserts: number;
  /** Distinct created_by_role values across those rows. */
  roles: (string | null)[];
  /** Distinct created_by_account_id values across those rows. */
  accounts: (string | null)[];
  /** Whether the account lookup ran before anything else. */
  lookupFirst: boolean;
  /** Any BEGIN or insert -- a refusal must reach neither. */
  wroteAnything: boolean;
}

let outcomes: Record<string, Outcome>;

beforeAll(() => {
  const script = `
    const loaders = ${JSON.stringify(LOADERS)};
    const accounts = ${JSON.stringify(ACCOUNTS)};
    const cases = ${JSON.stringify(CASES)};
    const modules = {};
    for (const [key, loader] of Object.entries(loaders)) modules[key] = await import(loader.module);

    // seedAll reports its counts on console.log; stdout is reserved for the result.
    console.log = () => {};

    function fakeClient() {
      const calls = [];
      return {
        calls,
        async query(sql, params = []) {
          calls.push({ sql, params });
          if (/from\\s+pilot\\.accounts/i.test(sql)) {
            const found = Object.prototype.hasOwnProperty.call(accounts, params[0]);
            const rows = found ? [{ role: accounts[params[0]] }] : [];
            return { rows, rowCount: rows.length };
          }
          if (/^\\s*insert/i.test(sql)) return { rows: [{ inserted: true }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        },
      };
    }

    // The column's position is read off the statement itself rather than
    // assumed, so a reordered column list cannot make this read the wrong value.
    function valuesOf(call, table, column) {
      const match = call.sql.match(new RegExp('insert into pilot\\\\.' + table + '\\\\s*\\\\(([^)]*)\\\\)', 'i'));
      if (!match) return undefined;
      const columns = match[1].split(',').map((name) => name.trim());
      const index = columns.indexOf(column);
      if (index === -1) throw new Error('no ' + column + ' column in the ' + table + ' insert');
      return call.params[index];
    }

    const out = {};
    for (const [name, spec] of Object.entries(cases)) {
      const loader = loaders[spec.loader];
      const client = fakeClient();
      let ok = true;
      let message = null;
      try {
        await modules[spec.loader].seedAll(
          client,
          loader.seedDir,
          { organizationId: ${JSON.stringify(ORG)}, seedAccountId: spec.seedAccountId },
          { dryRun: spec.dryRun },
        );
      } catch (error) {
        ok = false;
        message = error.message;
      }
      const parentInsert = new RegExp('insert into pilot\\\\.' + loader.table + '\\\\s*\\\\(', 'i');
      const parent = client.calls.filter((call) => parentInsert.test(call.sql));
      out[name] = {
        ok,
        message,
        parentInserts: parent.length,
        roles: [...new Set(parent.map((call) => valuesOf(call, loader.table, 'created_by_role')))],
        accounts: [...new Set(parent.map((call) => valuesOf(call, loader.table, 'created_by_account_id')))],
        lookupFirst: /from\\s+pilot\\.accounts/i.test(client.calls[0]?.sql ?? ''),
        wroteAnything: client.calls.some((call) => /^\\s*(begin|insert)/i.test(call.sql)),
      };
    }
    process.stdout.write(JSON.stringify(out));
  `;

  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  outcomes = JSON.parse(stdout);
});

describe.each([
  ['seed-drill-library.mjs', 'drills'],
  ['seed-workout-templates.mjs', 'templates'],
] as const)('%s created_by_role', (_file, key) => {
  const { rows } = LOADERS[key];

  test('records the seed account\'s own role on every row, not the platform_owner the CSV used to carry', () => {
    const outcome = outcomes[`${key}_org_admin`];
    expect(outcome.message).toBeNull();
    // Every row, not a sample: a loader that fell back to the file's value
    // for some rows would show a second value here.
    expect(outcome.parentInserts).toBe(rows);
    expect(outcome.roles).toEqual(['organization_admin']);
    expect(outcome.accounts).toEqual(['acct-gym-admin']);
  });

  test('follows the account, so a different account records a different role', () => {
    const outcome = outcomes[`${key}_coach`];
    expect(outcome.message).toBeNull();
    expect(outcome.parentInserts).toBe(rows);
    expect(outcome.roles).toEqual(['coach']);
  });

  test('looks the account up before anything else', () => {
    expect(outcomes[`${key}_org_admin`].lookupFirst).toBe(true);
  });

  test('refuses an account that does not exist, before writing anything -- in a dry run too', () => {
    const outcome = outcomes[`${key}_missing`];
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/^SEED_ACCOUNT_NOT_FOUND: .*'acct-nobody'/);
    expect(outcome.wroteAnything).toBe(false);
  });

  test.each(['blank', 'null'])('refuses an account with a %s role, before writing anything', (kind) => {
    const outcome = outcomes[`${key}_${kind}_role`];
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/^SEED_ACCOUNT_HAS_NO_ROLE: /);
    expect(outcome.wroteAnything).toBe(false);
  });
});
