// Real PostgreSQL-backed test for the pre-deploy schema verifier.
//
// The verifier replaces the one gate in this pipeline that nothing checks. Both
// deploy workflows ask an operator to attest `migrations_complete`, and both say
// in their own comments that it is an attestation rather than a check. It was
// attested ahead of the migration twice in two days, and on 2026-08-07 a
// production deploy went out that way -- the code shipped, the constraint it
// needed did not exist, and the only thing that prevented an incident was that
// the affected endpoint was already broken.
//
// A verifier that cannot actually detect a missing migration would be worse
// than the attestation, because it would look like a control. So the test that
// matters here is the negative one: drop something a migration created and
// confirm the verifier fails and names it.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-schema-verify-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const VERIFY_SCRIPT = path.resolve(__dirname, '../../../scripts/pilot-verify-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_schema_verify';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Could not determine a free port')));
      }
    });
  });
}

async function runVerifier(): Promise<{ code: number; result: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [VERIFY_SCRIPT],
      {
        maxBuffer: 10_000_000,
        env: {
          ...process.env,
          AZURE_POSTGRES_CONNECTION_STRING: connectionStringFor(TEST_DB_NAME),
          PPBF_POSTGRES_DISABLE_SSL: 'true',
          PPBF_SCHEMA_VERIFY_SKIP_MAIN: 'false',
        },
      },
      (error, stdout, stderr) => {
        const combined = `${stdout}${stderr}`;
        const start = combined.indexOf('{');
        if (start === -1) {
          reject(new Error(`No JSON output. stdout=${stdout} stderr=${stderr}`));
          return;
        }
        const code = error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as unknown as { code: number }).code
          : 0;
        resolve({ code, result: JSON.parse(combined.slice(start)) as Record<string, unknown> });
      },
    );
  });
}

async function applyEverything(): Promise<void> {
  const files = (await fs.readdir(INFRA_DIR))
    .filter((name) => /^pilot_slice_postgres.*\.sql$/.test(name))
    .sort();

  // Base schema first; the increments alter what it creates.
  await client.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));

  // Several increments depend on earlier ones, and a handful will fail on a
  // first pass because of it. Repeat until nothing new applies -- every
  // migration here is idempotent, which is the property the rebuild path
  // already relies on.
  let remaining = files.filter((name) => name !== 'pilot_slice_postgres.sql');
  for (let pass = 0; pass < 4 && remaining.length > 0; pass += 1) {
    const failed: string[] = [];
    for (const name of remaining) {
      try {
        await client.query(await fs.readFile(path.join(INFRA_DIR, name), 'utf8'));
      } catch {
        failed.push(name);
      }
    }
    if (failed.length === remaining.length) break;
    remaining = failed;
  }
}

beforeAll(async () => {
  PG_PORT = await findFreePort();

  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => {
    stderrOutput += chunk.toString();
  });

  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({ input: serverProcess.stdout });
    const timeout = setTimeout(() => {
      rl.close();
      reject(new Error(`Embedded Postgres did not become ready in time. stderr:\n${stderrOutput}`));
    }, 120_000);

    rl.on('line', (line) => {
      if (line.includes('EMBEDDED_PG_READY')) {
        clearTimeout(timeout);
        rl.close();
        resolve();
      }
    });

    serverProcess.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Embedded Postgres process exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  await applyEverything();
});

afterAll(async () => {
  if (client) await client.end();

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(safetyTimer);
      resolve();
    };
    const safetyTimer = setTimeout(finish, 15_000);
    safetyTimer.unref();
    serverProcess.once('exit', finish);
    serverProcess.kill('SIGTERM');
  });
});

describe('the pre-deploy schema verifier', () => {
  test('passes against a database with every migration applied', async () => {
    const { code, result } = await runVerifier();
    expect(result.event).toBe('schema.verify.ok');
    expect(code).toBe(0);
  });

  test('the check is not vacuous -- it asserts a real number of objects', async () => {
    const { result } = await runVerifier();
    const checked = result.checked as Record<string, number>;

    // THE STRONGEST CLAUSE HERE, and the reason the others are floors rather
    // than the whole test. Since 2026-08-28 the expected set is built by
    // walking the migrations in the order apply-migrations.yml applies them,
    // read out of that workflow's `all` list. A parse that came back partial
    // would shrink the expected set in proportion, and a pre-deploy gate whose
    // expectations have shrunk PASSES a database missing everything it stopped
    // asking about -- while reporting green. So the number of files the run
    // actually read is asserted against the files on disk, computed here rather
    // than written down, so it cannot drift into agreement with a smaller list.
    const onDisk = (await fs.readdir(INFRA_DIR))
      .filter((name) => /^pilot_slice_postgres.*\.sql$/.test(name));
    expect(onDisk.length).toBeGreaterThan(100);
    expect(checked.sqlFiles).toBe(onDisk.length);

    // MEASURED FLOORS, taken from this commit (175 tables, 157 columns, 250
    // indexes, 144 constraints, 12 views). They are floors, not targets: adding
    // migrations only raises them, and a floor left behind by growth is stale
    // rather than wrong. The previous values -- 30 / 20 / 20 / 0 -- were an
    // order of magnitude below the real counts, so the expected set could have
    // lost five sixths of itself and still passed this test.
    //
    // LOWERING ONE IS NOT A WAY TO MAKE A RED RUN GREEN. A migration that
    // genuinely removes objects has to move the floor in the same change, with
    // the reason written down, exactly as safetyCriticalSuites.json requires of
    // its own minimums.
    expect(checked.tables).toBeGreaterThanOrEqual(170);
    expect(checked.columns).toBeGreaterThanOrEqual(150);
    expect(checked.indexes).toBeGreaterThanOrEqual(240);
    expect(checked.constraints).toBeGreaterThanOrEqual(140);
    // Views were unchecked until the research-triage migration exposed it. A
    // zero here would mean the parser stopped recognising `create view` and the
    // gate had quietly gone back to passing regardless.
    expect(checked.views).toBeGreaterThanOrEqual(12);
  });

  test('fails and names the object when a migration has not been applied', async () => {
    // Exactly the production situation on 2026-08-07: the code was deployed and
    // the column it depended on was not there.
    await client.query(`alter table pilot.athletes drop column deleted_at`);
    try {
      const { code, result } = await runVerifier();
      expect(result.event).toBe('schema.verify.failed');
      expect(result.reason).toBe('MIGRATIONS_NOT_APPLIED');
      expect((result.missing as { columns: string[] }).columns).toContain('athletes.deleted_at');
      expect(code).not.toBe(0);
    } finally {
      // Restoring the column alone is NOT a restore. Dropping it cascaded to
      // idx_athletes_active_org, a partial index defined `where deleted_at is
      // null`, and re-adding the column does not bring the index back -- so
      // every test after this one ran against a permanently degraded schema.
      // Nothing caught it because no later test ran a full verifier pass
      // expecting OK, which is exactly the blind spot this suite exists to
      // close.
      await client.query(`alter table pilot.athletes add column deleted_at timestamptz null`);
      await client.query(
        `create index if not exists idx_athletes_active_org
           on pilot.athletes(organization_id, athlete_id)
           where deleted_at is null`,
      );
    }
  });

  test('fails when a view a migration created is missing', async () => {
    // On 2026-08-07 the research-triage migration created this repo's first
    // view, and the gate reported the identical object counts it reported
    // before the migration existed -- it would have passed against a database
    // that never ran it. This is that case, inverted into a test.
    await client.query(`drop view pilot.v_shadow_research_triage`);
    try {
      const { code, result } = await runVerifier();
      expect(result.event).toBe('schema.verify.failed');
      expect((result.missing as { views: string[] }).views)
        .toContain('v_shadow_research_triage');
      expect(code).not.toBe(0);
    } finally {
      await client.query(
        await fs.readFile(
          path.join(INFRA_DIR, 'pilot_slice_postgres_research_triage_view_migration.sql'),
          'utf8',
        ),
      );
    }
  });

  test('a superseded constraint is not expected, but its replacement is', async () => {
    // Widening a vocabulary means dropping a constraint and adding it back
    // under a new name, in its own migration -- how the readiness `method`
    // check, the film-study review_state check and the correction check were
    // each widened. The verifier used to expect EVERY name ever added,
    // including the ones deliberately replaced, so a correctly migrated
    // database reported the superseded name as missing. Because this gate runs
    // before a deploy, that is a false failure that would have blocked every
    // deploy after the next widening.
    const rows = await client.query(
      `select conname from pg_constraint
       where conrelid = 'pilot.shadow_film_study_proposals'::regclass
         and conname like 'pilot_film_study_proposals_correction_check%'`,
    );
    const names = rows.rows.map((row) => row.conname as string);

    // The old name is genuinely gone from the database...
    expect(names).not.toContain('pilot_film_study_proposals_correction_check');
    expect(names).toContain('pilot_film_study_proposals_correction_check_v2');
    // ...and the verifier passes anyway, because it read the drop.
    const { result } = await runVerifier();
    expect(result.event).toBe('schema.verify.ok');
  });

  test('dropping the REPLACEMENT still fails -- supersession did not blind the gate', async () => {
    // The dangerous half of the fix above: removing names from the expected set
    // could have made the verifier stop noticing a constraint that genuinely
    // should exist. A verifier that cannot detect a missing migration is worse
    // than the attestation it replaced, because it looks like a control.
    await client.query(
      `alter table pilot.shadow_film_study_proposals
       drop constraint pilot_film_study_proposals_correction_check_v2`,
    );
    try {
      const { code, result } = await runVerifier();
      expect(result.event).toBe('schema.verify.failed');
      expect((result.missing as { constraints: string[] }).constraints)
        .toContain('pilot_film_study_proposals_correction_check_v2');
      expect(code).not.toBe(0);
    } finally {
      await client.query(
        await fs.readFile(
          path.join(INFRA_DIR, 'pilot_slice_postgres_film_study_revisions_migration.sql'),
          'utf8',
        ),
      );
    }
  });

  test('a constraint dropped by a LATER migration is not expected, though its filename sorts FIRST', async () => {
    // The case that made this suite red on 2026-08-28, and the one supersession
    // alone could not answer. drill-library-v3 creates
    // pilot_drill_library_discipline_check; drill-library-check-drop removes it
    // and is LAST in the workflow's `all` list. Their filenames sort the other
    // way round:
    //
    //   pilot_slice_postgres_drill_library_check_drop_migration.sql   <- DROP
    //   pilot_slice_postgres_drill_library_v3_migration.sql           <- ADD
    //
    // Walked by filename the drop came first, hit nothing, and the add that
    // followed put the constraint into the expected set -- so the gate demanded
    // a constraint a correctly migrated database does not have, and every
    // deploy after this migration would have been blocked by it. The verifier
    // now walks the order apply-migrations.yml actually applies.
    const rows = await client.query(
      `select conname, contype from pg_constraint
       where conrelid = 'pilot.drill_library'::regclass
         and conname like 'pilot_drill_library_discipline%'`,
    );
    const names = rows.rows.map((row) => row.conname as string);

    // The check is genuinely gone from the database, and the registry key the
    // drop hands the column over to is genuinely there -- so this is a real
    // migrated state, not an unmigrated one the gate is being asked to excuse.
    expect(names).not.toContain('pilot_drill_library_discipline_check');
    expect(names).toContain('pilot_drill_library_discipline_fk');

    const { code, result } = await runVerifier();
    expect(result.event).toBe('schema.verify.ok');
    expect(code).toBe(0);
  });

  test('dropping the FK the check was retired in favour of still fails', async () => {
    // The dangerous half, the same shape as the supersession pair above:
    // teaching the verifier the apply order removes names from the expected
    // set, and could have removed the replacement's name with them. The column
    // is governed by exactly one authority now, and the gate has to notice when
    // that authority is missing.
    await client.query(
      `alter table pilot.drill_library drop constraint pilot_drill_library_discipline_fk`,
    );
    try {
      const { code, result } = await runVerifier();
      expect(result.event).toBe('schema.verify.failed');
      expect((result.missing as { constraints: string[] }).constraints)
        .toContain('pilot_drill_library_discipline_fk');
      expect(code).not.toBe(0);
    } finally {
      await client.query(
        await fs.readFile(
          path.join(INFRA_DIR, 'pilot_slice_postgres_drill_library_discipline_fk_migration.sql'),
          'utf8',
        ),
      );
    }
  });

  test('refuses out loud when a migration file is not in the workflow order', async () => {
    // The failure that would be worse than the one this change fixes. If the
    // order came back short, the verifier could carry on with a smaller
    // expected set -- a pre-deploy gate that has stopped checking, reporting
    // green. It refuses instead, and this is that refusal end to end: a real
    // migration file on disk that the `all` list does not name.
    const stray = path.join(
      INFRA_DIR,
      'pilot_slice_postgres_zzz_schema_verify_test_stray_migration.sql',
    );
    await fs.writeFile(stray, '-- temporary fixture; removed by the test that wrote it\n');
    try {
      const { code, result } = await runVerifier();
      expect(result.event).toBe('schema.verify.failed');
      expect(result.reason).toBe('MIGRATION_ORDER_UNREADABLE');
      expect(String(result.detail)).toContain(
        'pilot_slice_postgres_zzz_schema_verify_test_stray_migration.sql',
      );
      expect(code).not.toBe(0);
    } finally {
      await fs.rm(stray, { force: true });
    }

    // And the gate is working again once the tree is consistent, so the fixture
    // cannot leave the rest of the suite verifying nothing.
    const { code, result } = await runVerifier();
    expect(result.event).toBe('schema.verify.ok');
    expect(code).toBe(0);
  });

  test('fails when a constraint the code writes against is missing', async () => {
    // The audit vocabulary case: the deploy went out, the widened constraint had
    // not been applied, and every write of the new event type failed.
    await client.query(`alter table pilot.audit_events drop constraint audit_events_event_type_check`);
    try {
      const { code, result } = await runVerifier();
      expect((result.missing as { constraints: string[] }).constraints)
        .toContain('audit_events_event_type_check');
      expect(code).not.toBe(0);
    } finally {
      await client.query(
        `alter table pilot.audit_events add constraint audit_events_event_type_check
           check (event_type in ('create','update','login','logout','shadow_classification',
             'shadow_routing','shadow_research_upload_requirement','data_deletion_initiated','data_purged'))`,
      );
    }
  });
});
