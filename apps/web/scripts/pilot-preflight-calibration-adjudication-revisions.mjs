import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import {
  assertExpectedTarget,
  countBackfillTies,
  parseConnectionTarget,
  required,
  resolveSslConfig,
} from './pilot-apply-calibration-adjudication-revisions-migration.mjs';

// READ-ONLY. Reports what the calibration-adjudication-revisions migration
// would refuse, without applying anything: the number of disagreements that
// hold two or more existing adjudications with the same adjudicated_at.
//
// There is no apply path in this file, on purpose. It imports the count from
// the runner and nothing that writes; the count itself runs in a read-only
// transaction and rolls back. The same target discipline as the runner applies: the
// operator states the host and database they believe they are pointing at,
// and a mismatch refuses before connecting.
//
// Exit codes: 0 no ties (the migration's tie check will pass), 2 ties found
// (the migration would stop and hold back every migration after it in an
// `all` dispatch), 1 the check itself failed.
//
// A tie is resolved by a person deciding which of the tied answers stands.
// Nothing here, and nothing in the migration, makes that choice.

export async function run() {
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');
  const expectedHostname = required('PPBF_EXPECTED_POSTGRES_HOSTNAME');
  const expectedDatabase = required('PPBF_EXPECTED_POSTGRES_DATABASE');

  const target = parseConnectionTarget(connectionString);
  assertExpectedTarget(target, expectedHostname, expectedDatabase);

  const client = new Client({ connectionString, ssl: resolveSslConfig() });
  await client.connect();
  let report;
  try {
    report = await countBackfillTies(client);
  } finally {
    await client.end();
  }

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log(JSON.stringify({ event: 'calibration_adjudication_revisions.preflight', ...report }));
  if (report.tied_disagreements === 0) {
    console.log('PILOT CALIBRATION ADJUDICATION REVISIONS PREFLIGHT PASS (read-only; nothing applied)');
    return 0;
  }
  console.log('PILOT CALIBRATION ADJUDICATION REVISIONS PREFLIGHT TIES FOUND (read-only; nothing applied)');
  return 2;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    process.exitCode = await run();
  } catch (error) {
    console.error('PILOT CALIBRATION ADJUDICATION REVISIONS PREFLIGHT FAIL (read-only; nothing applied)');
    console.error(String(error));
    process.exit(1);
  }
}
