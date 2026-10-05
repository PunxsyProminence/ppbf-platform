import fs from 'node:fs';

import { closePool } from '../src/server/pilot/db';
import { runExcerptLoad } from '../src/server/pilot/licensedExcerptLoader';
import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Licensed-excerpt loader (OD-2026-10-03-002 section 2; OD-2026-10-05-009,
// -010). Run by .github/workflows/load-licensed-excerpts.yml, which downloads
// the private blob container into PPBF_EXCERPT_DIR first. Behaviour and
// reasoning live in src/server/pilot/licensedExcerptLoader.ts, where the tests
// reach it; this is the thin shell.
//
//   PPBF_EXCERPT_DIR            folder holding the downloaded excerpt files
//   PPBF_EXCERPT_ORG_ID         organization to load into (__platform__ = platform shelf)
//   PPBF_EXCERPT_ACTOR_ID       account recorded as the loader (checked by contentImport/actor.ts)
//   PPBF_EXCERPT_APPLY          'true' to write; anything else is a dry run
//   PPBF_EXCERPT_CONFIRM        apply only: LOAD EXCERPTS
//   PPBF_EXCERPT_EXPECT_FINGERPRINT  apply only: the dry run's plan_fingerprint
//
// It never reads a local env file: AZURE_POSTGRES_CONNECTION_STRING must come
// from the environment and must name the database declared in
// PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE (lib/postgres-write-target.mjs),
// in dry-run as well, so the plan an operator reviews is the target's plan.

async function main(): Promise<void> {
  const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING ?? '';
  const target = assertDeclaredWriteTargetFromEnv(connectionString);
  const dir = process.env.PPBF_EXCERPT_DIR?.trim() ?? '';
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error('PPBF_EXCERPT_DIR must name an existing folder');
  }

  // Printed before anything is read, so a wrong target is visible at once.
  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);

  await runExcerptLoad({
    organizationId: process.env.PPBF_EXCERPT_ORG_ID ?? '',
    actorAccountId: process.env.PPBF_EXCERPT_ACTOR_ID ?? '',
    dir,
    apply: process.env.PPBF_EXCERPT_APPLY === 'true',
    confirm: process.env.PPBF_EXCERPT_CONFIRM,
    expectedFingerprint: process.env.PPBF_EXCERPT_EXPECT_FINGERPRINT?.trim(),
    log: (line) => console.log(line),
  });
}

main()
  .catch((error: unknown) => {
    console.error(`load-licensed-excerpts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
