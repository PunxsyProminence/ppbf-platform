// The content-import vocabularies against the LIVE schema.
//
// contentImport/vocabularies.ts copies every allowed-value list and numeric
// bound the validator checks from the database CHECK constraints, because the
// validator runs with no database (npm run content:validate on a hand-off
// folder). A copy drifts: a migration widens a CHECK (drill_vocabulary_widening
// added warmup_decay and literature_grounded_draft after v3 shipped) and the
// copy either refuses good content or waves through content the load then
// fails on. This suite builds the full migrated schema the way production
// applies it (scripts/lib/full-schema.mjs) and compares each copy with
// pg_get_constraintdef of the constraint it names, in both directions.
//
// Spins up the same disposable, local-only embedded Postgres the other pg
// suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import { DATASETS } from './contentImport/specs';
import type { ConstraintRef } from './contentImport/vocabularies';
import { BOUNDS, VOCABULARIES } from './contentImport/vocabularies';

jest.setTimeout(300_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-content-vocab-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

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

beforeAll(async () => {
  PG_PORT = await findFreePort();
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => { stderrOutput += chunk.toString(); });

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
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  const applyFullSchema = fullSchema.applyFullSchema as (c: Client, opts?: { infraDir?: string }) => Promise<unknown>;

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query('drop database if exists content_vocab');
  await admin.query('create database content_vocab');
  await admin.end();

  client = new Client({ connectionString: connectionStringFor('content_vocab') });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });
});

afterAll(async () => {
  await client?.end().catch(() => {});
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

async function constraintDef(ref: ConstraintRef): Promise<string> {
  const { rows } = await client.query<{ def: string }>(
    `select pg_get_constraintdef(c.oid) as def
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
       join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'pilot' and t.relname = $1 and c.conname = $2`,
    [ref.table, ref.constraint],
  );
  // Exactly one: a renamed or dropped constraint must fail here by name,
  // not leave the comparison below with nothing to compare.
  expect({ ...ref, found: rows.length }).toEqual({ ...ref, found: 1 });
  return rows[0].def;
}

/** Every 'literal'::text in a definition, which is how Postgres renders an IN list. */
function literals(definition: string): string[] {
  return [...definition.matchAll(/'((?:[^']|'')*)'::text/g)].map((match) => match[1].replace(/''/g, "'")).sort();
}

const vocabularyCases = Object.entries(VOCABULARIES).flatMap(([name, vocab]) =>
  vocab.mirrors.map((ref) => [name, ref.table, ref.constraint, [...vocab.values]] as const),
);

describe('each mirrored vocabulary equals the live CHECK', () => {
  it('has a plural set of cases, so an empty mirror list cannot pass vacuously', () => {
    expect(vocabularyCases.length).toBeGreaterThanOrEqual(20);
  });

  it.each(vocabularyCases)('%s = pilot.%s %s', async (_name, table, constraint, values) => {
    const definition = await constraintDef({ table, constraint });
    expect(literals(definition)).toEqual([...values].sort());
  });

  it('tenure_band equals the bands pilot.v_athlete_tenure derives', async () => {
    const { rows } = await client.query<{ def: string }>(`select pg_get_viewdef('pilot.v_athlete_tenure'::regclass, true) as def`);
    expect(literals(rows[0].def)).toEqual([...VOCABULARIES.tenure_band.values].sort());
  });
});

describe('each mirrored numeric bound equals the live CHECK', () => {
  const boundCases = Object.entries(BOUNDS).flatMap(([name, bound]) =>
    bound.mirrors.map((ref) => [name, ref.table, ref.constraint, ref.column, bound as { gt?: number; gte?: number; lte?: number }] as const),
  );

  it.each(boundCases)('%s = pilot.%s %s', async (_name, table, constraint, column, bound) => {
    const definition = await constraintDef({ table, constraint });
    // Postgres renders `x between 15 and 180` as `(x >= 15) AND (x <= 180)`,
    // and a numeric column's literal as `(0)::numeric`.
    const pattern = new RegExp(`\\(${column} (>=|<=|>|<) \\(?(-?\\d+(?:\\.\\d+)?)\\)?(?:::\\w+)?\\)`, 'g');
    const found = [...definition.matchAll(pattern)].map((match) => `${match[1]} ${Number(match[2])}`).sort();
    const expected = [
      bound.gt !== undefined ? `> ${bound.gt}` : null,
      bound.gte !== undefined ? `>= ${bound.gte}` : null,
      bound.lte !== undefined ? `<= ${bound.lte}` : null,
    ].filter((entry): entry is string => entry !== null).sort();
    expect(found).toEqual(expected);
  });
});

describe('every row rule that names a database constraint names one that exists', () => {
  const ruleCases = DATASETS.flatMap((dataset) => dataset.files).flatMap((spec) =>
    [...(spec.rowRules ?? []), ...(spec.groupRules ?? [])]
      .filter((rule) => rule.mirrors)
      .map((rule) => [spec.file, rule.mirrors?.table ?? '', rule.mirrors?.constraint ?? ''] as const),
  );

  it.each(ruleCases)('%s: pilot.%s %s', async (_file, table, constraint) => {
    await constraintDef({ table, constraint });
  });
});
