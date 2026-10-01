import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// READ-ONLY. Reports what the calibration-adjudication-revisions migration
// would refuse, without applying anything: the number of disagreements that
// hold two or more existing adjudications with the same adjudicated_at.
//
// WHY IT EXISTS. That migration makes the latest existing answer to a
// disagreement the current one, and stops -- changing nothing -- when two
// answers to one disagreement share a timestamp, because which of them came
// second cannot be read from the data. In an `all` dispatch of
// apply-migrations that stop also holds back every migration listed after it.
// This is how to know before dispatching.
//
// IT IS MEANT TO BE RUN BEFORE THE MIGRATION, when the `revision` column does
// not exist yet: every existing row is then un-numbered, and all of them are
// examined. After the migration there is nothing left to backfill -- every row
// carries a revision and new ones are numbered as they are written -- so the
// answer is 0 and `already_applied` says why. The column is looked up first
// and the count query is chosen from that, because a statement naming a column
// that does not exist fails to parse.
//
// THERE IS NO APPLY PATH IN THIS FILE, on purpose. It is not a flag on the
// apply script: `npm run <script> --flag` without the `--` separator hands the
// flag to npm instead of the script, and an apply entry point that falls
// through to applying when its "read-only" flag goes missing is how a look
// turns into a migration. Every statement runs inside one read-only
// transaction that is rolled back, so PostgreSQL itself refuses a write.
//
// The grouping is the migration's own (its step 2): the two readings, the two
// marks -- with "no mark" grouping with "no mark" -- and the timestamp.
//
// Exit codes: 0 no ties, 2 ties found (somebody needs to look), 1 the check
// itself failed. Counts only: no ids, names or account ids are printed.
//
// A tie is resolved by a person deciding which of the tied answers stands.
// Nothing here, and nothing in the migration, makes that choice.

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

// Same reasoning as db.ts's resolveSslConfig and the migration runners:
// production/staging always require TLS.
function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
}

export async function countBackfillTies(client) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    const table = await client.query(
      `select to_regclass('pilot.calibration_adjudications') is not null as present`,
    );
    if (table.rows[0]?.present !== true) {
      throw new Error('CALIBRATION_ADJUDICATIONS_TABLE_MISSING');
    }
    const column = await client.query(
      `select exists (
         select 1 from information_schema.columns
         where table_schema = 'pilot'
           and table_name = 'calibration_adjudications'
           and column_name = 'revision'
       ) as present`,
    );
    const alreadyApplied = column.rows[0]?.present === true;
    const counted = await client.query(
      `select
         (select count(*)::int from pilot.calibration_adjudications) as existing_adjudications,
         (select count(*)::int from (
            select 1
              from pilot.calibration_adjudications
             ${alreadyApplied ? 'where revision is null' : ''}
             group by organization_id, calibration_clip_id,
                      annotation_set_id_a, annotation_set_id_b,
                      source_event_id_a, source_event_id_b,
                      adjudicated_at
            having count(*) > 1
          ) tied) as tied_disagreements`,
    );
    return {
      already_applied: alreadyApplied,
      existing_adjudications: counted.rows[0].existing_adjudications,
      tied_disagreements: counted.rows[0].tied_disagreements,
    };
  } finally {
    await client.query('ROLLBACK').catch(() => {});
  }
}

export async function run() {
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');
  const client = new Client({ connectionString, ssl: resolveSslConfig() });
  await client.connect();
  let report;
  try {
    report = await countBackfillTies(client);
  } finally {
    await client.end();
  }

  console.log(JSON.stringify({ event: 'calibration_adjudication_ties.checked', ...report }));
  if (report.tied_disagreements === 0) {
    console.log(
      report.already_applied
        ? 'PILOT CALIBRATION ADJUDICATION TIES CHECK PASS: the revisions migration is already applied here, so there is nothing left to backfill (read-only; nothing changed)'
        : 'PILOT CALIBRATION ADJUDICATION TIES CHECK PASS: no tied disagreements; the revisions migration will not stop on a tie (read-only; nothing changed)',
    );
    return 0;
  }
  console.log(
    `PILOT CALIBRATION ADJUDICATION TIES CHECK REPORTED: ${report.tied_disagreements} disagreement(s) hold two or more adjudications with the same adjudicated_at. The revisions migration will stop on them until a person decides which answer stands (read-only; nothing changed)`,
  );
  return 2;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    process.exitCode = await run();
  } catch (error) {
    console.error('PILOT CALIBRATION ADJUDICATION TIES CHECK FAIL (read-only; nothing changed)');
    console.error(String(error));
    process.exit(1);
  }
}
