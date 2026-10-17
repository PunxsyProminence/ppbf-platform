// Real PostgreSQL contract test for pilot_slice_postgres_parent_resources_migration.sql (PH-10,
// issue #1593: a gym's curated guides, checklists, videos and policies for families).
//
// What needs a real database to prove: that a resource points at an app path or an https
// address and nothing else; that its program is its own gym's and cannot be deleted from under
// it; that published carries its first time and keeps it; that its gym and writer never change
// by hand and a change names its editor; that it is never deleted by hand, stays when its
// writer's account goes and goes with its gym; that re-applying is a no-op; that the file holds
// nothing destructive; and that the runner's readiness refuses a result it did not produce.
// Spins up the disposable local embedded Postgres the other migration suites use. It never
// connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-parent-resources-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-parent-resources-migration.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const MIGRATION_FILE = 'pilot_slice_postgres_parent_resources_migration.sql';

const ORG = 'org-res';
const OTHER_ORG = 'org-res-other';
// Home gym of the coaches who are not this gym's own; the other gym keeps no
// home accounts, so it can be removed whole in the cascade test.
const THIRD_ORG = 'org-res-third';
const COACH = 'acct-res-coach';
const ADMIN = 'acct-res-admin';
const OTHER_COACH = 'acct-res-other-coach';
const VISITING_COACH = 'acct-res-visiting-coach';
const PROGRAM = 'junior-boxing';
const OTHER_PROGRAM = 'other-gym-program';

type Apply = (client: Client, sql: string) => Promise<void>;

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let applyRunner: Apply;
let migrationSql: string;

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
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function freshDatabase(name: string, schema: 'full' | 'none' = 'full'): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  if (schema === 'none') return client;

  // The whole schema in the `all` order, which now includes this migration.
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  for (const org of [ORG, OTHER_ORG, THIRD_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [org],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $3, 'microsoft'), ($2, 'organization_admin', $3, 'microsoft'),
            ($4, 'coach', $5, 'microsoft'), ($6, 'coach', $5, 'microsoft')`,
    [COACH, ADMIN, ORG, OTHER_COACH, THIRD_ORG, VISITING_COACH],
  );
  // Authority comes from an active seat in the gym, as sign-in grants it (auth.ts): each home
  // account holds its home seat; a coach whose home gym is the other one also coaches here.
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role)
     values ($1, $5, 'coach'), ($2, $5, 'organization_admin'), ($3, $6, 'coach'), ($4, $5, 'coach')`,
    [COACH, ADMIN, OTHER_COACH, VISITING_COACH, ORG, THIRD_ORG],
  );
  for (const [org, programId, name] of [[ORG, PROGRAM, 'Junior Boxing'], [OTHER_ORG, OTHER_PROGRAM, 'Other Gym Program']] as const) {
    await client.query(
      `insert into pilot.programs (organization_id, program_id, program_name, created_by_account_id) values ($1, $2, $3, $4)`,
      [org, programId, name, COACH],
    );
  }
  return client;
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

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
  applyRunner = (await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href)).applyMigrationTransaction as Apply;
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
});

afterAll(async () => {
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
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

function resource(
  client: Client,
  values: {
    org?: string;
    title?: string;
    summary?: string;
    type?: string;
    kind?: string;
    destination?: string;
    program?: string | null;
    state?: string;
    publishedAt?: string | null;
    creator?: string | null;
    role?: string;
  } = {},
) {
  return client.query(
    `insert into pilot.parent_resources
       (organization_id, title, summary, resource_type, destination_kind, destination, program_id, state, published_at,
        created_by_account_id, created_by_role)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10, $11)
     returning resource_id::text as resource_id`,
    [
      values.org ?? ORG,
      values.title ?? 'Hydration for young boxers',
      values.summary ?? 'What to drink before, during and after training.',
      values.type ?? 'guide',
      values.kind ?? 'internal',
      values.destination ?? '/help/parent-guide',
      values.program === undefined ? null : values.program,
      values.state ?? 'draft',
      values.publishedAt === undefined ? null : values.publishedAt,
      values.creator === undefined ? COACH : values.creator,
      values.role ?? 'coach',
    ],
  );
}

const EDITOR = (account = COACH) =>
  `updated_by_account_id = '${account}', updated_by_role = '${account === ADMIN ? 'organization_admin' : 'coach'}'`;

describe('parent resources migration (PH-10)', () => {
  test('a gym-wide and a program resource are stored and read back, and re-applying is a no-op', async () => {
    const client = await freshDatabase('pres_store');
    try {
      await resource(client);
      await resource(client, {
        title: 'Junior sparring policy', type: 'policy', kind: 'external', destination: 'https://example.org/policy.pdf',
        program: PROGRAM, state: 'published', publishedAt: '2026-10-15T12:00:00Z', creator: ADMIN, role: 'organization_admin',
      });
      await applyRunner(client, migrationSql);
      await applyRunner(client, migrationSql);

      const rows = await client.query(
        `select title, resource_type, destination_kind, destination, program_id, state, published_at is not null as published, created_by_role
           from pilot.parent_resources order by title`,
      );
      expect(rows.rows).toEqual([
        { title: 'Hydration for young boxers', resource_type: 'guide', destination_kind: 'internal', destination: '/help/parent-guide', program_id: null, state: 'draft', published: false, created_by_role: 'coach' },
        { title: 'Junior sparring policy', resource_type: 'policy', destination_kind: 'external', destination: 'https://example.org/policy.pdf', program_id: PROGRAM, state: 'published', published: true, created_by_role: 'organization_admin' },
      ]);
    } finally {
      await client.end();
    }
  });

  test('a destination is an app path or an https address, nothing else', async () => {
    const client = await freshDatabase('pres_destination');
    try {
      for (const [kind, destination] of [
        ['internal', '/drills/jab-basics'],
        ['internal', '/help/parent-guide?tab=resources'],
        ['external', 'https://www.usaboxing.org/safesport'],
        ['external', 'https://Example.ORG:8443'],
      ] as const) {
        await resource(client, { kind, destination });
      }
      for (const [kind, destination] of [
        ['internal', '//evil.example/x'],
        ['internal', 'help/parent-guide'],
        ['internal', 'https://example.org'],
        ['external', 'http://example.org'],
        ['external', 'javascript:alert(1)'],
        ['external', '/help/parent-guide'],
        ['external', 'https://'],
        ['internal', '/has a space'],
        ['elsewhere', '/help'],
        ['external', `https://example.org/${'x'.repeat(2000)}`],
        // Browsers read a backslash as a slash in a link: these would leave the app.
        ['internal', '/\\evil.example'],
        ['internal', '/\\/evil.example'],
        ['external', 'https://example.org\\@evil.example'],
        // The host is what follows the last '@'.
        ['external', 'https://usaboxing.org@evil.example'],
        ['external', 'https://usaboxing.org:pw@evil.example/x'],
        // No real host.
        ['external', 'https://:'],
        ['external', 'https://:443/x'],
        ['external', 'https://localhost/x'],
        ['external', 'https://-bad.example/x'],
        ['external', 'https://example.123/x'],
      ] as const) {
        await expect(resource(client, { kind, destination })).rejects.toMatchObject({
          code: '23514', constraint: 'pilot_parent_resources_destination_check',
        });
      }
    } finally {
      await client.end();
    }
  });

  test('a blank title or summary, an unknown type or state, a family writer and no author at all are refused', async () => {
    const client = await freshDatabase('pres_checks');
    try {
      await expect(resource(client, { creator: null })).rejects.toMatchObject({ code: '23514', constraint: 'pilot_parent_resources_author_named' });
      await expect(resource(client, { title: '  ' })).rejects.toMatchObject({ code: '23514', constraint: 'pilot_parent_resources_title_check' });
      await expect(resource(client, { summary: '' })).rejects.toMatchObject({ code: '23514', constraint: 'pilot_parent_resources_summary_check' });
      await expect(resource(client, { type: 'podcast' })).rejects.toMatchObject({ code: '23514', constraint: 'pilot_parent_resources_type_check' });
      await expect(resource(client, { state: 'live', publishedAt: '2026-10-15T12:00:00Z' })).rejects.toMatchObject({ code: '23514', constraint: 'pilot_parent_resources_state_check' });
      for (const role of ['parent', 'athlete', 'board']) {
        await expect(resource(client, { role })).rejects.toMatchObject({ code: '23514', constraint: 'pilot_parent_resources_created_by_role_check' });
      }
    } finally {
      await client.end();
    }
  });

  test('published carries its first time: a draft has none, and the first time is kept through archive and re-publish', async () => {
    const client = await freshDatabase('pres_published');
    try {
      // A draft can be archived without ever being published.
      const { rows: [{ resource_id: abandoned }] } = await resource(client, { title: 'Abandoned draft' });
      await client.query(`update pilot.parent_resources set state = 'archived', ${EDITOR()} where resource_id = $1::uuid`, [abandoned]);
      const archived = await client.query('select state, published_at from pilot.parent_resources where resource_id = $1::uuid', [abandoned]);
      expect(archived.rows).toEqual([{ state: 'archived', published_at: null }]);

      await expect(resource(client, { state: 'published' })).rejects.toMatchObject({ code: '23514', constraint: 'pilot_parent_resources_published_check' });
      await expect(resource(client, { publishedAt: '2026-10-15T12:00:00Z' })).rejects.toMatchObject({ code: '23514', constraint: 'pilot_parent_resources_published_on_publish' });
      // Never published: neither arriving archived with a time, nor archived with one later.
      await expect(resource(client, { state: 'archived', publishedAt: '2026-10-15T12:00:00Z' })).rejects.toMatchObject({
        code: '23514', constraint: 'pilot_parent_resources_published_on_publish',
      });
      const { rows: [{ resource_id: neverPublished }] } = await resource(client, { title: 'Never published' });
      await expect(
        client.query(`update pilot.parent_resources set state = 'archived', published_at = now(), ${EDITOR()} where resource_id = $1::uuid`, [neverPublished]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'pilot_parent_resources_published_on_publish' });

      const { rows: [{ resource_id: id }] } = await resource(client);
      await client.query(`update pilot.parent_resources set state = 'published', published_at = '2026-10-15T12:00:00Z', ${EDITOR()} where resource_id = $1::uuid`, [id]);
      // The time is the database's: what the writer sent is replaced by now().
      const first = await client.query('select published_at from pilot.parent_resources where resource_id = $1::uuid', [id]);
      expect(first.rows[0].published_at.toISOString()).not.toBe('2026-10-15T12:00:00.000Z');
      await client.query(`update pilot.parent_resources set state = 'archived', ${EDITOR(ADMIN)} where resource_id = $1::uuid`, [id]);
      await client.query(`update pilot.parent_resources set state = 'published', ${EDITOR()} where resource_id = $1::uuid`, [id]);
      await expect(
        client.query(`update pilot.parent_resources set published_at = now(), ${EDITOR()} where resource_id = $1::uuid`, [id]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'pilot_parent_resources_published_kept' });
      await expect(
        client.query(`update pilot.parent_resources set state = 'draft', published_at = null, ${EDITOR()} where resource_id = $1::uuid`, [id]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'pilot_parent_resources_published_kept' });
      const row = await client.query('select state, published_at from pilot.parent_resources where resource_id = $1::uuid', [id]);
      expect(row.rows[0].state).toBe('published');
      expect(row.rows[0].published_at.toISOString()).toBe(first.rows[0].published_at.toISOString());
    } finally {
      await client.end();
    }
  });

  test("an author or editor holds that role in this gym through an active seat, never another gym's", async () => {
    const client = await freshDatabase('pres_gym_writer');
    try {
      await expect(resource(client, { creator: OTHER_COACH })).rejects.toMatchObject({
        code: '23514', constraint: 'pilot_parent_resources_writer_of_this_gym',
      });
      // The right gym but not the role written.
      await expect(resource(client, { creator: COACH, role: 'organization_admin' })).rejects.toMatchObject({
        code: '23514', constraint: 'pilot_parent_resources_writer_of_this_gym',
      });
      // A member of this gym through an organization membership.
      const { rows: [{ resource_id: id }] } = await resource(client, { creator: VISITING_COACH });
      await expect(
        client.query(`update pilot.parent_resources set title = 'x', updated_by_account_id = $2, updated_by_role = 'coach' where resource_id = $1::uuid`, [id, OTHER_COACH]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'pilot_parent_resources_writer_of_this_gym' });
      await client.query(`update pilot.parent_resources set title = 'x', ${EDITOR(ADMIN)} where resource_id = $1::uuid`, [id]);
      // A membership switched off no longer counts.
      await client.query(`update pilot.organization_memberships set active_flag = false where account_id = $1`, [VISITING_COACH]);
      await expect(resource(client, { creator: VISITING_COACH })).rejects.toMatchObject({
        code: '23514', constraint: 'pilot_parent_resources_writer_of_this_gym',
      });
    } finally {
      await client.end();
    }
  });

  test('a writer needs an active seat on a live account; the home role alone is not one', async () => {
    const client = await freshDatabase('pres_seat');
    try {
      const HOME_ONLY = 'acct-pres-home-only';
      await client.query(`insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, 'coach', $2, 'microsoft')`, [HOME_ONLY, ORG]);
      const refused = { code: '23514', constraint: 'pilot_parent_resources_writer_of_this_gym' };
      await expect(resource(client, { creator: HOME_ONLY })).rejects.toMatchObject(refused);

      await resource(client);
      await client.query('update pilot.accounts set active_flag = false where account_id = $1', [COACH]);
      await expect(resource(client)).rejects.toMatchObject(refused);
      await client.query('update pilot.accounts set active_flag = true, deleted_at = now() where account_id = $1', [COACH]);
      await expect(resource(client)).rejects.toMatchObject(refused);
    } finally {
      await client.end();
    }
  });

  test('a resource is born unedited, with the times the database gives it', async () => {
    const client = await freshDatabase('pres_born');
    try {
      await expect(client.query(
        `insert into pilot.parent_resources (organization_id, title, summary, resource_type, destination_kind, destination,
                                             created_by_account_id, created_by_role, updated_by_account_id, updated_by_role)
         values ($1, 'T', 'S', 'guide', 'internal', '/help', $2, 'coach', $2, 'coach')`,
        [ORG, COACH],
      )).rejects.toMatchObject({ code: '23514', constraint: 'pilot_parent_resources_born_unedited' });
      await client.query(
        `insert into pilot.parent_resources (organization_id, title, summary, resource_type, destination_kind, destination,
                                             state, published_at, created_by_account_id, created_by_role, created_at, updated_at)
         values ($1, 'T', 'S', 'guide', 'internal', '/help', 'published', '2020-01-01', $2, 'coach', '2020-01-01', '2020-01-01')`,
        [ORG, COACH],
      );
      const row = await client.query(
        `select created_at > now() - interval '5 minutes' as created_now, updated_at > now() - interval '5 minutes' as updated_now,
                published_at > now() - interval '5 minutes' as published_now
           from pilot.parent_resources`,
      );
      expect(row.rows[0]).toEqual({ created_now: true, updated_now: true, published_now: true });
    } finally {
      await client.end();
    }
  });

  test('an update from inside another trigger may only detach a writer', async () => {
    const client = await freshDatabase('pres_depth');
    try {
      await resource(client);
      await client.query(`
        create function pilot.test_rewrite_parent_resource() returns trigger language plpgsql as $f$
        begin
          update pilot.parent_resources set state = 'published', published_at = now() where organization_id = new.organization_id;
          return new;
        end;
        $f$`);
      await client.query(`create trigger trg_test_rewrite after update on pilot.organizations
                          for each row execute function pilot.test_rewrite_parent_resource()`);
      await expect(client.query(`update pilot.organizations set organization_name = 'Renamed' where organization_id = $1`, [ORG]))
        .rejects.toMatchObject({ code: '23514', constraint: 'pilot_parent_resources_cascade_detaches_only' });
      const row = await client.query('select state from pilot.parent_resources');
      expect(row.rows[0].state).toBe('draft');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a same-named writer-role check that admits more roles than Q-E', async () => {
    const client = await freshDatabase('pres_wide_roles');
    try {
      await client.query('alter table pilot.parent_resources drop constraint pilot_parent_resources_created_by_role_check');
      await client.query(`alter table pilot.parent_resources add constraint pilot_parent_resources_created_by_role_check
                            check (created_by_role in ('coach', 'organization_admin', 'admin', 'volunteer'))`);
      await expect(applyRunner(client, migrationSql)).rejects.toThrow('PARENT_RESOURCES_NOT_READY: checks_ready');
    } finally {
      await client.end();
    }
  });

  // The same three quoted roles, widened by an OR: the guard skips its seat check for a role
  // outside its list, so either check would admit a writer the gym never gave a staff seat.
  test.each([
    ['pilot_parent_resources_created_by_role_check', 'created_by_role', ''],
    ['pilot_parent_resources_updated_by_role_check', 'updated_by_role', 'updated_by_role is null or '],
  ] as const)('the runner refuses a same-named %s that names the Q-E roles but admits more', async (name, column, nullPart) => {
    const client = await freshDatabase(`pres_or_${column}`);
    try {
      await client.query(`alter table pilot.parent_resources drop constraint ${name}`);
      await client.query(`alter table pilot.parent_resources add constraint ${name}
                            check (${nullPart}${column} in ('coach', 'organization_admin', 'admin') or ${column} = current_user)`);
      await expect(applyRunner(client, migrationSql)).rejects.toThrow('PARENT_RESOURCES_NOT_READY: checks_ready');
    } finally {
      await client.end();
    }
  });

  test("a program is this gym's own, and a program with resources is not deleted out from under them", async () => {
    const client = await freshDatabase('pres_program');
    try {
      await expect(resource(client, { program: 'no-such-program' })).rejects.toMatchObject({ code: '23503', constraint: 'pilot_parent_resources_program_fk' });
      await expect(resource(client, { program: OTHER_PROGRAM })).rejects.toMatchObject({ code: '23503', constraint: 'pilot_parent_resources_program_fk' });

      await resource(client, { program: PROGRAM });
      await expect(
        client.query('delete from pilot.programs where organization_id = $1 and program_id = $2', [ORG, PROGRAM]),
      ).rejects.toMatchObject({ code: '23503', constraint: 'pilot_parent_resources_program_fk' });
      const row = await client.query('select program_id from pilot.parent_resources');
      expect(row.rows).toEqual([{ program_id: PROGRAM }]);
    } finally {
      await client.end();
    }
  });

  test('the gym and the writer never change; a change names its editor', async () => {
    const client = await freshDatabase('pres_fixed');
    try {
      await resource(client);
      for (const change of [`organization_id = '${OTHER_ORG}'`, 'resource_id = gen_random_uuid()']) {
        await expect(client.query(`update pilot.parent_resources set ${change}, ${EDITOR()}`)).rejects.toMatchObject({
          code: '23514', constraint: 'pilot_parent_resources_fixed_gym',
        });
      }
      for (const change of [`created_by_account_id = '${ADMIN}'`, 'created_by_account_id = null', "created_by_role = 'admin'", "created_at = now() - interval '1 day'"]) {
        await expect(client.query(`update pilot.parent_resources set ${change}, ${EDITOR()}`)).rejects.toMatchObject({
          code: '23514', constraint: 'pilot_parent_resources_fixed_writer',
        });
      }
      await expect(client.query(`update pilot.parent_resources set title = 'New title'`)).rejects.toMatchObject({
        code: '23514', constraint: 'pilot_parent_resources_editor_named',
      });
      await expect(client.query(`update pilot.parent_resources set title = 'New title', updated_by_account_id = '${COACH}', updated_by_role = 'parent'`))
        .rejects.toMatchObject({ code: '23514', constraint: 'pilot_parent_resources_updated_by_role_check' });
      await client.query(`update pilot.parent_resources set title = 'New title', ${EDITOR(ADMIN)}`);
      const row = await client.query('select title, updated_by_account_id, updated_at > created_at as touched from pilot.parent_resources');
      expect(row.rows).toEqual([{ title: 'New title', updated_by_account_id: ADMIN, touched: true }]);
    } finally {
      await client.end();
    }
  });

  test('a resource is not deleted by hand; it stays when its writer account goes, and goes with its gym and program together', async () => {
    const client = await freshDatabase('pres_cascade');
    try {
      const { rows: [{ resource_id: id }] } = await resource(client, { creator: ADMIN, role: 'organization_admin', program: PROGRAM });
      await client.query(`update pilot.parent_resources set summary = 'Updated.', updated_by_account_id = $2, updated_by_role = 'organization_admin' where resource_id = $1::uuid`, [id, ADMIN]);
      await expect(client.query('delete from pilot.parent_resources')).rejects.toMatchObject({
        code: '23514', constraint: 'pilot_parent_resources_no_delete',
      });

      await client.query('delete from pilot.accounts where account_id = $1', [ADMIN]);
      const kept = await client.query('select created_by_account_id, updated_by_account_id, created_by_role, summary from pilot.parent_resources');
      expect(kept.rows).toEqual([{ created_by_account_id: null, updated_by_account_id: null, created_by_role: 'organization_admin', summary: 'Updated.' }]);

      // A gym going (here the one with no accounts) takes its programs and its resources in one
      // cascade: the program key is checked at the end of the statement, so this goes through.
      await client.query(`insert into pilot.organization_memberships (account_id, organization_id, role) values ($1, $2, 'coach')`, [COACH, OTHER_ORG]);
      await resource(client, { org: OTHER_ORG, program: OTHER_PROGRAM });
      await client.query('delete from pilot.organizations where organization_id = $1', [OTHER_ORG]);
      const left = await client.query('select organization_id from pilot.parent_resources');
      expect(left.rows).toEqual([{ organization_id: ORG }]);
    } finally {
      await client.end();
    }
  });

  test('the file holds nothing destructive', async () => {
    const sql = migrationSql.toLowerCase().replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bdrop\s+(table|column|index|schema|function)\b/);
    expect(sql).not.toMatch(/\btruncate\b/);
    expect(sql).not.toMatch(/\bdelete\s+from\b/);
    expect(sql).not.toMatch(/\balter\s+table\b/);
  });

  test('the runner refuses a guard that is there by name but disabled, or replica-only', async () => {
    const client = await freshDatabase('pres_guard_disabled');
    try {
      await expect(
        applyRunner(client, 'alter table pilot.parent_resources disable trigger trg_parent_resources_guard'),
      ).rejects.toThrow('PARENT_RESOURCES_NOT_READY: guard_ready');
      await expect(
        applyRunner(client, 'alter table pilot.parent_resources enable replica trigger trg_parent_resources_guard'),
      ).rejects.toThrow('PARENT_RESOURCES_NOT_READY: guard_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a program key that cascades, and a same-named index over other columns', async () => {
    const client = await freshDatabase('pres_shape');
    try {
      await client.query('alter table pilot.parent_resources drop constraint pilot_parent_resources_program_fk');
      await client.query(`alter table pilot.parent_resources add constraint pilot_parent_resources_program_fk
        foreign key (organization_id, program_id) references pilot.programs(organization_id, program_id) on delete cascade`);
      await client.query('drop index pilot.idx_parent_resources_catalog');
      await client.query('create index idx_parent_resources_catalog on pilot.parent_resources(organization_id, program_id)');

      await expect(applyRunner(client, migrationSql)).rejects.toThrow(
        'PARENT_RESOURCES_NOT_READY: program_fk_no_action, catalog_index_ready',
      );
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a same-named check that does not say what the real one says', async () => {
    const client = await freshDatabase('pres_weak_check');
    try {
      await client.query('alter table pilot.parent_resources drop constraint pilot_parent_resources_destination_check');
      await client.query('alter table pilot.parent_resources add constraint pilot_parent_resources_destination_check check (true)');
      await expect(applyRunner(client, migrationSql)).rejects.toThrow('PARENT_RESOURCES_NOT_READY: checks_ready');
    } finally {
      await client.end();
    }
  });

  test('the runner refuses a result it did not produce', async () => {
    const client = await freshDatabase('pres_not_ready', 'none');
    try {
      await expect(applyRunner(client, 'select 1')).rejects.toThrow('PARENT_RESOURCES_NOT_READY');
    } finally {
      await client.end();
    }
  });
});
