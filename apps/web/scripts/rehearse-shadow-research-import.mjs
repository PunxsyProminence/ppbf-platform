// Full rehearsal of the SHADOW research corpus import against a disposable local Postgres.
//
// The point is to run the REAL importer, with --apply, over the REAL corpus, against a real
// PostgreSQL with the real schema -- so that when it is pointed at staging the only thing that
// differs is the connection string. A dry run proves the CSVs parse; only this proves the writes
// land, the foreign keys hold, and the review gate stays closed.
//
// Disposable and local-only. It never reads a production connection string; the write-target guard
// is satisfied with localhost, which is exactly what that guard is for.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { Client } from 'pg';

const REPO = path.resolve(import.meta.dirname, '../../..');
const WEB = path.join(REPO, 'apps/web');
const INFRA = path.join(REPO, 'infra/azure');
const SERVER = path.join(WEB, 'scripts/test-embedded-pg-server.mjs');
const DATA_DIR = path.join(os.tmpdir(), `ppbf-corpus-rehearsal-${Date.now()}`);
const DB = 'ppbf_corpus_rehearsal';
const ORG = 'ppbf-rehearsal-org';
const ACCOUNT = 'acct-rehearsal-admin';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startPg(port) {
  const proc = spawn(process.execPath, [SERVER, DATA_DIR, String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c.toString(); });
  await new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: proc.stdout });
    const t = setTimeout(() => { rl.close(); reject(new Error(`pg not ready\n${stderr}`)); }, 120_000);
    rl.on('line', (l) => {
      if (l.includes('EMBEDDED_PG_READY')) { clearTimeout(t); rl.close(); resolve(); }
    });
    proc.once('exit', (c) => { clearTimeout(t); reject(new Error(`pg exited ${c}\n${stderr}`)); });
  });
  return proc;
}

const step = (n, m) => console.log(`\n[${n}] ${m}`);

async function main() {
  const port = await freePort();
  step(1, `starting disposable Postgres on ${port}`);
  const pg = await startPg(port);
  const conn = (db) => `postgres://postgres:postgres@localhost:${port}/${db}`;

  try {
    step(2, `creating database ${DB}`);
    const admin = new Client({ connectionString: conn('postgres') });
    await admin.connect();
    await admin.query(`drop database if exists ${DB}`);
    await admin.query(`create database ${DB}`);
    await admin.end();

    const client = new Client({ connectionString: conn(DB) });
    await client.connect();

    step(3, 'applying base schema + shadow evidence migration');
    for (const f of [
      'pilot_slice_postgres.sql',
      'pilot_slice_postgres_shadow_evidence_migration.sql',
    ]) {
      await client.query(await fs.readFile(path.join(INFRA, f), 'utf8'));
      console.log(`    applied ${f}`);
    }

    // The importer's own guard: approval_state + verification_state must exist on both tables.
    const gate = await client.query(
      `select count(*)::int as n from information_schema.columns
        where table_schema='pilot' and table_name in ('shadow_library_sources','shadow_library_documents')
          and column_name in ('approval_state','verification_state')`,
    );
    console.log(`    review-gate columns present: ${gate.rows[0].n}/4`);

    step(4, 'seeding the organization and a privileged actor');
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1,$1,'active') on conflict do nothing`, [ORG],
    );
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag)
       values ($1,'organization_admin',$2,'microsoft',true) on conflict do nothing`, [ACCOUNT, ORG],
    );

    step(5, 'BASELINE — the five tables before the import');
    const tables = ['shadow_library_sources', 'shadow_library_documents', 'shadow_library_chunks',
      'shadow_library_capability_map', 'shadow_research_requirements'];
    for (const t of tables) {
      const r = await client.query(`select count(*)::int as n from pilot.${t}`);
      console.log(`    ${t.padEnd(32)} ${r.rows[0].n}`);
    }
    await client.end();

    step(6, 'running the REAL importer with --apply against this database');
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      PPBF_POSTGRES_DISABLE_SSL: 'true',
      PPBF_ORG_ID: ORG,
      SEED_ACCOUNT_ID: ACCOUNT,
      AZURE_POSTGRES_CONNECTION_STRING: conn(DB),
      PPBF_EXPECTED_POSTGRES_HOSTNAME: 'localhost',
      PPBF_EXPECTED_POSTGRES_DATABASE: DB,
    };
    const code = await new Promise((resolve) => {
      const p = spawn(process.execPath, ['scripts/import-shadow-research.mjs', '--apply'],
        { cwd: WEB, env, stdio: 'inherit' });
      p.on('exit', resolve);
    });
    console.log(`    importer exit code: ${code}`);
    if (code !== 0) throw new Error('IMPORTER_FAILED');

    step(7, 'VERIFYING what actually landed');
    const v = new Client({ connectionString: conn(DB) });
    await v.connect();
    const expected = { shadow_library_sources: 1214, shadow_library_documents: 14,
      shadow_library_chunks: 1193, shadow_library_capability_map: 30,
      shadow_research_requirements: 229 };
    let allOk = true;
    for (const [t, e] of Object.entries(expected)) {
      const r = await v.query(`select count(*)::int as n from pilot.${t} where organization_id = $1`, [ORG]);
      const ok = r.rows[0].n === e;
      if (!ok) allOk = false;
      console.log(`    ${t.padEnd(32)} ${String(r.rows[0].n).padStart(5)} / ${String(e).padStart(5)}  ${ok ? 'MATCH' : 'MISMATCH'}`);
    }

    step(8, 'REVIEW GATE — nothing may be citable yet');
    for (const t of ['shadow_library_sources', 'shadow_library_documents']) {
      const r = await v.query(
        `select approval_state, verification_state, count(*)::int as n
           from pilot.${t} where organization_id = $1
          group by 1,2 order by 3 desc`, [ORG],
      );
      for (const row of r.rows) {
        console.log(`    ${t.padEnd(32)} ${row.approval_state} / ${row.verification_state}  n=${row.n}`);
      }
      const leaked = r.rows.filter((x) => x.approval_state !== 'pending_review');
      if (leaked.length) { allOk = false; console.log('    !! something is not pending_review'); }
    }

    step(9, 'REFERENTIAL INTEGRITY — orphans the FKs might not cover');
    const orphanChunks = await v.query(
      `select count(*)::int as n from pilot.shadow_library_chunks c
        where c.organization_id = $1
          and not exists (select 1 from pilot.shadow_library_documents d
                          where d.document_id = c.document_id and d.organization_id = c.organization_id)`, [ORG]);
    const orphanBySource = await v.query(
      `select count(*)::int as n from pilot.shadow_library_chunks c
        where c.organization_id = $1
          and not exists (select 1 from pilot.shadow_library_sources s
                          where s.source_id = c.source_id and s.organization_id = c.organization_id)`, [ORG]);
    console.log(`    chunks with no parent document: ${orphanChunks.rows[0].n}`);
    console.log(`    chunks with no parent source:   ${orphanBySource.rows[0].n}`);
    if (orphanChunks.rows[0].n || orphanBySource.rows[0].n) allOk = false;

    step(10, 'TEXT LANDED INTACT — not truncated by a column type');
    const txt = await v.query(
      `select count(*)::int as n, sum(length(text_content))::bigint as chars,
              max(length(text_content))::int as longest
         from pilot.shadow_library_chunks where organization_id = $1`, [ORG]);
    console.log(`    chunks ${txt.rows[0].n} | ${Number(txt.rows[0].chars).toLocaleString()} chars | longest ${txt.rows[0].longest}`);
    if (Number(txt.rows[0].chars) < 1_400_000) { allOk = false; console.log('    !! text shorter than the source files'); }

    step(11, 'EMBEDDINGS — must be absent, so retrieval cannot use them yet');
    const emb = await v.query(
      `select count(*)::int as total,
              count(embedding)::int as with_embedding
         from pilot.shadow_library_chunks where organization_id = $1`, [ORG]).catch(() => null);
    if (emb) console.log(`    ${emb.rows[0].with_embedding} of ${emb.rows[0].total} chunks have an embedding`);
    else console.log('    (no embedding column at this schema level -- backfill migration not applied)');

    step(12, 'IDEMPOTENCE — running it a second time must not duplicate');
    await v.end();
    const code2 = await new Promise((resolve) => {
      const p = spawn(process.execPath, ['scripts/import-shadow-research.mjs', '--apply'],
        { cwd: WEB, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', (c) => { out += c.toString(); });
      p.stderr.on('data', (c) => { out += c.toString(); });
      p.on('exit', (c) => { console.log(`    second run exit ${c}: ${out.trim().split('\n').pop()}`); resolve(c); });
    });
    const v2 = new Client({ connectionString: conn(DB) });
    await v2.connect();
    let dupes = false;
    for (const [t, e] of Object.entries(expected)) {
      const r = await v2.query(`select count(*)::int as n from pilot.${t} where organization_id = $1`, [ORG]);
      if (r.rows[0].n !== e) { dupes = true; console.log(`    ${t}: ${r.rows[0].n} (expected still ${e}) DUPLICATED`); }
    }
    console.log(dupes ? '    !! second run changed row counts' : `    row counts unchanged after second run (exit ${code2})`);
    if (dupes) allOk = false;
    await v2.end();

    console.log(`\n${'='.repeat(64)}`);
    console.log(allOk ? 'REHEARSAL PASS — the corpus imports cleanly and stays review-gated'
                      : 'REHEARSAL FAIL — see the mismatches above');
    console.log('='.repeat(64));
    process.exitCode = allOk ? 0 : 1;
  } finally {
    pg.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1500));
    await fs.rm(DATA_DIR, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error('\nREHEARSAL ERROR:', e.message); process.exitCode = 1; });
