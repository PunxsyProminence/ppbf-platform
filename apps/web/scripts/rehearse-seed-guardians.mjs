// Rehearsal for the guardian half of the roster import, against a disposable local Postgres.
//
// Runs the REAL seed-data.ts, with real CSVs, against a real PostgreSQL. A dry run proves the CSV
// parses and the dedupe arithmetic is right; only this proves the WRITES land and -- the reason this
// exists -- what a SECOND run does to the first run's rows.
//
// THE CASE THIS IS FOR. pilot.parents.account_id is attached later, when a family is actually
// invited. If a re-seed cleared it, every invited parent would silently lose access to their
// children: the account still signs in, the People list still looks healthy, and the child list goes
// empty, with nothing anywhere reporting a fault. That is the exact silent failure the guardian
// linking work exists to prevent, so re-running must be proven not to cause it rather than argued
// not to.
//
// Disposable and local-only. Never reads a remote connection string.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { Client } from 'pg';

const WEB = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(WEB, '../..');
const INFRA = path.join(REPO, 'infra/azure');
const SERVER = path.join(WEB, 'scripts/test-embedded-pg-server.mjs');
const DATA_DIR = path.join(os.tmpdir(), `ppbf-guardian-rehearsal-${Date.now()}`);
const WORK = path.join(os.tmpdir(), `ppbf-guardian-fixtures-${Date.now()}`);
const DB = 'ppbf_guardian_rehearsal';
const ORG = 'ppbf-rehearsal-org';
const COACH = 'EXAMPLE-COACH-1';

const HEADER = 'athlete_id,full_name,dob,weight_class,gym_status,emergency_contact,active_flag,coach_id'
  + ',guardian_full_name,guardian_phone,guardian_email,guardian_relationship';

// Two siblings sharing one guardian, plus a third child with their own.
//
// THE EMAILS MATTER. These are the two addresses that collided under the previous parent_id scheme
// (base64 of the dedupe key truncated to 24 chars = 18 bytes; they diverge at byte 22). The first
// version of this harness used alpha@/beta@, which diverge at byte 7 -- inside the window -- so it
// passed while the bug shipped in the example roster. Fixtures that cannot reach the defect prove
// nothing, so these are deliberately the hard pair.
const ROWS = [
  'ATH-1,Athlete One,2010-01-01,middleweight,active,contact-1,true,EXAMPLE-COACH-1,Guardian One,000-0001,example.guardian1@example.invalid,mother',
  'ATH-2,Athlete Two,2011-02-02,heavyweight,active,contact-2,true,EXAMPLE-COACH-1,Guardian One,000-0001,example.guardian1@example.invalid,mother',
  'ATH-3,Athlete Three,2012-03-03,light-heavyweight,active,contact-3,true,EXAMPLE-COACH-1,Guardian Two,000-0002,example.guardian2@example.invalid,father',
];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function startPg(port) {
  const proc = spawn(process.execPath, [SERVER, DATA_DIR, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c.toString(); });
  await new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: proc.stdout });
    const t = setTimeout(() => { rl.close(); reject(new Error(`pg not ready\n${stderr}`)); }, 120_000);
    rl.on('line', (l) => { if (l.includes('EMBEDDED_PG_READY')) { clearTimeout(t); rl.close(); resolve(); } });
    proc.once('exit', (c) => { clearTimeout(t); reject(new Error(`pg exited ${c}\n${stderr}`)); });
  });
  return proc;
}

const step = (n, m) => console.log(`\n[${n}] ${m}`);
let ok = true;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) ok = false;
  console.log(`    ${pass ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${pass ? '' : ` (expected ${JSON.stringify(expected)})`}`);
}

async function runSeed(env, csvName, label) {
  const cfg = path.join(WORK, `${csvName}.config.mjs`);
  await fs.writeFile(cfg, `export default ${JSON.stringify({
    organizationId: ORG, dataDir: WORK, files: { athletes: `${csvName}.csv` }, options: {},
  }, null, 2)};\n`);
  const code = await new Promise((resolve) => {
    // seed-data.ts lives at the REPO ROOT scripts/, not apps/web/scripts/ -- the root
    // package.json runs it as `tsx scripts/seed-data.ts` from there.
    const p = spawn('npx', ['tsx', 'scripts/seed-data.ts', '--config', cfg,
      '--i-understand-overwrite'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c) => { out += c.toString(); });
    p.stderr.on('data', (c) => { out += c.toString(); });
    p.on('exit', (c) => {
      const line = out.split('\n').find((l) => l.includes('Guardian links')) || '(no guardian line)';
      console.log(`    ${label}: exit ${c} | ${line.trim()}`);
      // A harness that hides the seeder's own error turns a diagnosable failure into a mystery.
      if (c !== 0) {
        ok = false;
        console.log(`    --- ${label} output ---`);
        console.log(out.trim().split('\n').slice(-12).map((l) => `    ${l}`).join('\n'));
      }
      resolve(c);
    });
  });
  return code;
}

async function main() {
  await fs.mkdir(WORK, { recursive: true });
  const port = await freePort();
  step(1, `disposable Postgres on ${port}`);
  const pg = await startPg(port);
  const conn = (db) => `postgres://postgres:postgres@localhost:${port}/${db}`;

  try {
    const admin = new Client({ connectionString: conn('postgres') });
    await admin.connect();
    await admin.query(`drop database if exists ${DB}`);
    await admin.query(`create database ${DB}`);
    await admin.end();

    step(2, 'applying base schema');
    const c = new Client({ connectionString: conn(DB) });
    await c.connect();
    await c.query(await fs.readFile(path.join(INFRA, 'pilot_slice_postgres.sql'), 'utf8'));
    await c.query(`insert into pilot.organizations (organization_id, organization_name, status)
                   values ($1,$1,'active') on conflict do nothing`, [ORG]);
    await c.query(`insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag)
                   values ($1,'coach',$2,'microsoft',true) on conflict do nothing`, [COACH, ORG]);
    await c.end();

    const env = {
      ...process.env,
      NODE_ENV: 'test',
      PPBF_POSTGRES_DISABLE_SSL: 'true',
      AZURE_POSTGRES_CONNECTION_STRING: conn(DB),
      PPBF_ALLOW_DESTRUCTIVE_SEED: 'true',
    };

    step(3, 'FIRST RUN — two siblings sharing a guardian, plus one more');
    await fs.writeFile(path.join(WORK, 'roster.csv'), `${HEADER}\n${ROWS.join('\n')}\n`);
    await runSeed(env, 'roster', 'first run');

    const v = new Client({ connectionString: conn(DB) });
    await v.connect();
    const counts = async () => ({
      parents: (await v.query('select count(*)::int n from pilot.parents where organization_id=$1', [ORG])).rows[0].n,
      links: (await v.query('select count(*)::int n from pilot.guardian_links where organization_id=$1', [ORG])).rows[0].n,
    });
    // 3 children, 2 distinct guardians -> 2 parent rows, 3 links.
    check('parents / links after first run', await counts(), { parents: 2, links: 3 });

    const alpha = await v.query(
      `select p.parent_id, p.account_id, count(l.athlete_id)::int as children
         from pilot.parents p
         join pilot.guardian_links l on l.parent_id = p.parent_id and l.organization_id = p.organization_id
        where p.organization_id=$1 and p.email='example.guardian1@example.invalid'
        group by 1,2`, [ORG]);
    check('the shared guardian has 2 children on ONE row', alpha.rows.length === 1 ? alpha.rows[0].children : alpha.rows.length, 2);
    // Row existence is checked separately from the value: `?? 'NO ROW'` would coalesce the
    // CORRECT null into a string and fail an assertion the code actually satisfies.
    check('a guardian row exists to inspect', alpha.rows.length, 1);
    check('account_id starts null (no login was created)',
      alpha.rows.length ? alpha.rows[0].account_id : 'NO ROW', null);
    if (!alpha.rows.length) {
      await v.end();
      throw new Error('first run wrote no guardian -- later steps would test nothing');
    }

    step(4, 'inviting that guardian, the way staffProvisioning would');
    await v.query(`insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag)
                   values ('acct-guardian-alpha','parent',$1,'microsoft',true) on conflict do nothing`, [ORG]);
    await v.query(`update pilot.parents set account_id='acct-guardian-alpha'
                    where organization_id=$1 and email='example.guardian1@example.invalid'`, [ORG]);
    const invited = await v.query(
      `select account_id from pilot.parents where organization_id=$1 and email='example.guardian1@example.invalid'`, [ORG]);
    check('guardian is now linked to a login', invited.rows[0].account_id, 'acct-guardian-alpha');
    await v.end();

    step(5, 'SECOND RUN — the same roster again, after the invite');
    await runSeed(env, 'roster', 'second run');

    const v2 = new Client({ connectionString: conn(DB) });
    await v2.connect();
    check('parents / links unchanged (no duplicates)', await (async () => ({
      parents: (await v2.query('select count(*)::int n from pilot.parents where organization_id=$1', [ORG])).rows[0].n,
      links: (await v2.query('select count(*)::int n from pilot.guardian_links where organization_id=$1', [ORG])).rows[0].n,
    }))(), { parents: 2, links: 3 });

    // THE POINT OF THIS REHEARSAL.
    const after = await v2.query(
      `select account_id from pilot.parents where organization_id=$1 and email='example.guardian1@example.invalid'`, [ORG]);
    check('re-seeding did NOT detach the invited guardian', after.rows[0].account_id, 'acct-guardian-alpha');

    step(6, 'CORRECTIONS — an edited phone number must reach the existing row');
    await fs.writeFile(path.join(WORK, 'edited.csv'),
      `${HEADER}\n${ROWS[0].replace('000-0001', '000-9999')}\n`);
    await v2.end();
    await runSeed(env, 'edited', 'edited run');
    const v3 = new Client({ connectionString: conn(DB) });
    await v3.connect();
    const edited = await v3.query(
      `select phone, account_id from pilot.parents where organization_id=$1 and email='example.guardian1@example.invalid'`, [ORG]);
    check('phone updated on the existing row', edited.rows[0].phone, '000-9999');
    check('and the login survived the correction', edited.rows[0].account_id, 'acct-guardian-alpha');

    step(7, 'OLD-FORMAT ROSTER — eight columns must write no guardian rows');
    await v3.query('delete from pilot.guardian_links where organization_id=$1', [ORG]);
    await v3.query('delete from pilot.parents where organization_id=$1', [ORG]);
    await fs.writeFile(path.join(WORK, 'old.csv'),
      `${HEADER.split(',').slice(0, 8).join(',')}\n${ROWS[0].split(',').slice(0, 8).join(',')}\n`);
    await v3.end();
    await runSeed(env, 'old', 'old-format run');
    const v4 = new Client({ connectionString: conn(DB) });
    await v4.connect();
    check('no guardian rows written from an old-format file', await (async () => ({
      parents: (await v4.query('select count(*)::int n from pilot.parents where organization_id=$1', [ORG])).rows[0].n,
      links: (await v4.query('select count(*)::int n from pilot.guardian_links where organization_id=$1', [ORG])).rows[0].n,
    }))(), { parents: 0, links: 0 });

    step(8, 'PARTIAL DATA — a named guardian with no relationship must be refused');
    await fs.writeFile(path.join(WORK, 'partial.csv'),
      `${HEADER}\nATH-9,Athlete Nine,2013-04-04,middleweight,active,c9,true,EXAMPLE-COACH-1,Nameless Relation,,,\n`);
    await v4.end();
    await runSeed(env, 'partial', 'partial run');
    const v5 = new Client({ connectionString: conn(DB) });
    await v5.connect();
    check('no guardian row written from incomplete data', (await v5.query(
      'select count(*)::int n from pilot.parents where organization_id=$1', [ORG])).rows[0].n, 0);
    await v5.end();

    console.log(`\n${'='.repeat(66)}`);
    console.log(ok ? 'REHEARSAL PASS — guardians import, dedupe, and survive a re-seed'
                   : 'REHEARSAL FAIL — see the FAIL lines above');
    console.log('='.repeat(66));
    process.exitCode = ok ? 0 : 1;
  } finally {
    pg.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1500));
    await fs.rm(DATA_DIR, { recursive: true, force: true });
    await fs.rm(WORK, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error('\nREHEARSAL ERROR:', e.message); process.exitCode = 1; });
