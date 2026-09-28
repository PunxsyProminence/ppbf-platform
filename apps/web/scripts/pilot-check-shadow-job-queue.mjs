import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/**
 * Refuse a production deploy while SHADOW background jobs are still waiting.
 *
 * WHY THIS EXISTS. A background job carries its own copy of the context the
 * model will answer from: `shadowHeavyBag.ts` slices the assembled context to
 * 12,000 characters and stores it in the job row, and `shadowJobProcessor.ts`
 * reads `payload.authorizedContext` at EXECUTION time, not at enqueue. Its
 * allowed-role set includes `athlete` and `parent`.
 *
 * So a change to what goes INTO that context does not reach a job that was
 * already queued. The job is answered from the payload written under the old
 * rules, and the answer is appended to that athlete's or parent's
 * conversation. Deploying a context change therefore has a window: as long as
 * the queue holds work enqueued before it, the old behaviour is still being
 * delivered, by design of the queue rather than by any bug.
 *
 * That window is what this closes. The owner's ruling, 2026-09-26:
 *
 *   "Nothing is real if anything is waiting"
 *
 * He was offered the option of recording the check as a note for whoever
 * deploys, and declined it. This is the enforced form: the deploy fails while
 * anything is pending or running, so the guarantee does not depend on a human
 * remembering to look.
 *
 * SCOPE, deliberately. This is not specific to the near-miss audience gate
 * that prompted it. Any deploy that changes what enters a job's stored context
 * has the same window, so the check is on the deploy, not on one release.
 *
 * NOT A MIGRATION GUARD. It says nothing about schema. `pilot-verify-schema`
 * already owns that and runs separately in the same workflow.
 *
 * Every statement runs inside an explicit READ ONLY transaction, so Postgres
 * itself refuses any write this file could attempt. It is safe against
 * production, which is the only place it is meant to run.
 */

// Statuses that mean work is still owed. 'completed', 'failed' and 'cancelled'
// are terminal -- their payloads are history and nothing will read them again.
// 'running' counts: a job already in flight is executing from its stored
// payload right now, which is precisely the case this guard is about.
const OPEN_STATUSES = ['pending', 'running'];

async function loadEnvLocal() {
  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env.local');

  let contents;
  try {
    contents = await fs.readFile(envPath, 'utf8');
  } catch {
    return; // No .env.local (CI, or a container). The env var must be set.
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;

    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(
      `Missing required environment variable: ${name}. `
      + 'Set it in apps/web/.env.local, or export it before running this script.',
    );
  }
  return value;
}

function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
}

/**
 * @param {{ query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> }} client
 */
export async function checkShadowJobQueue(client) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    const database = (await client.query('select current_database() as db')).rows[0].db;

    const presence = await client.query(
      'select to_regclass($1) is not null as present',
      ['pilot.shadow_jobs'],
    );

    // A database without the table has no queue, so nothing can be waiting.
    // That is a genuine pass, not a skip -- and it is the honest answer for an
    // environment where SHADOW's job system was never provisioned. Reporting
    // it distinctly keeps "no table" from being read later as "queue checked
    // and empty".
    if (!presence.rows[0].present) {
      return { database, tablePresent: false, open: [], openCount: 0 };
    }

    const open = await client.query(
      `select status, job_type, count(*)::int as n
         from pilot.shadow_jobs
        where status = any($1::text[])
        group by status, job_type
        order by status, job_type`,
      [OPEN_STATUSES],
    );

    const openCount = open.rows.reduce((total, row) => total + row.n, 0);
    return { database, tablePresent: true, open: open.rows, openCount };
  } finally {
    // The transaction is read-only, so the outcome of ending it cannot change
    // any data either way; rolling back keeps a failed read from leaving an
    // open transaction on the connection.
    await client.query('ROLLBACK');
  }
}

export async function run() {
  await loadEnvLocal();
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');
  const client = new Client({ connectionString, ssl: resolveSslConfig() });
  await client.connect();
  try {
    return await checkShadowJobQueue(client);
  } finally {
    await client.end();
  }
}

/**
 * @param {{ database: string, tablePresent: boolean, open: any[], openCount: number }} report
 */
export function describe(report) {
  const lines = [];
  if (!report.tablePresent) {
    lines.push(`SHADOW JOB QUEUE: NO QUEUE TABLE (${report.database})`);
    lines.push(
      'pilot.shadow_jobs does not exist in this database, so no job can be holding a '
      + 'pre-deploy context. This is a pass, but it is not the same fact as an empty queue.',
    );
    return lines;
  }

  if (report.openCount === 0) {
    lines.push(`SHADOW JOB QUEUE: EMPTY (${report.database})`);
    lines.push('Nothing pending or running. No job can answer from a context written before this deploy.');
    return lines;
  }

  lines.push(`SHADOW JOB QUEUE: ${report.openCount} JOB(S) STILL WAITING (${report.database})`);
  for (const row of report.open) {
    lines.push(`  ${row.status.padEnd(8)} ${row.job_type.padEnd(20)} ${row.n}`);
  }
  lines.push(
    'Each of these holds its own copy of the context it will be answered from, written '
    + 'under the rules in force when it was enqueued. Deploying now leaves them to deliver '
    + 'the old behaviour after the change is live. Let the worker drain, then re-run.',
  );
  return lines;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    const report = await run();
    for (const line of describe(report)) console.log(line);
    process.exit(report.openCount > 0 ? 1 : 0);
  } catch (error) {
    console.error('SHADOW JOB QUEUE CHECK FAILED TO RUN');
    console.error(String(error));
    // A check that cannot run has not passed. Failing closed is the point:
    // "nothing is real if anything is waiting" is not satisfied by not looking.
    process.exit(1);
  }
}
