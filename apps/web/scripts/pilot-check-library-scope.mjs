import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { SCOPE_EXPECTED_COUNTS } from './import-shadow-research.mjs';

/**
 * Read-only diagnostic: where does the SHADOW research corpus actually live, and
 * is any of it retrievable?
 *
 * WHY THIS EXISTS
 *
 * The staging import of the platform baseline was refused on 2026-08-12 with
 * CROSS_TENANT_ID_COLLISION:shadow_library_sources:src_003ec55ec16f050a -- a
 * corpus source id that already existed under a DIFFERENT organization. That is
 * not a transient failure and not something a retry fixes:
 * shadow_library_sources.source_id is the primary key, so a corpus row can exist
 * in exactly one organization, ever. If the corpus has already been imported
 * into a gym's own shelf, importing it into the reserved platform organization
 * is impossible until those rows are moved or removed.
 *
 * Whether that is true, of which rows, and in which database, is a data question
 * -- and the answer decides between "import the baseline" and "re-scope what is
 * already there". Guessing at it against production is exactly the class of
 * mistake that put 361 orphaned rows in production on 2026-07-18, so this script
 * asks instead.
 *
 * SELECT statements only, inside an explicit READ ONLY transaction: there is no
 * code path in this file that can mutate anything, so it is safe to point at
 * production.
 */

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

const PLATFORM_ORGANIZATION_ID = '__platform__';

export async function checkLibraryScope(client) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    // Per organization: how much library material it holds, and how much of it
    // clears the retrieval gate. Sources and documents carry the gate; chunks
    // are counted because they are what retrieval actually returns.
    const byOrg = await client.query(
      `select o.organization_id,
              (select count(*)::int from pilot.shadow_library_sources s
                where s.organization_id = o.organization_id) as sources,
              (select count(*)::int from pilot.shadow_library_sources s
                where s.organization_id = o.organization_id
                  and s.approval_state = 'approved'
                  and s.verification_state = 'verified') as sources_approved,
              (select count(*)::int from pilot.shadow_library_documents d
                where d.organization_id = o.organization_id) as documents,
              (select count(*)::int from pilot.shadow_library_documents d
                where d.organization_id = o.organization_id
                  and d.approval_state = 'approved'
                  and d.verification_state = 'verified'
                  and d.ingest_state = 'indexed') as documents_ready,
              (select count(*)::int from pilot.shadow_library_chunks c
                where c.organization_id = o.organization_id) as chunks,
              (select count(*)::int from pilot.shadow_library_capability_map m
                where m.organization_id = o.organization_id) as capabilities,
              -- The evidence axis, and the reason this column is worth reporting:
              -- the corpus was imported into both databases before feeder_tracks
              -- existed, and re-scoping moves rows without backfilling columns
              -- that did not exist when they were written. So a capability map
              -- can be fully present and completely unusable, and nothing else
              -- here would show it.
              (select count(*)::int from pilot.shadow_library_capability_map m
                where m.organization_id = o.organization_id
                  and array_length(m.feeder_tracks, 1) > 0) as capabilities_with_tracks,
              (select count(distinct c.metadata->>'track')::int
                 from pilot.shadow_library_chunks c
                where c.organization_id = o.organization_id
                  and c.metadata->>'track' is not null) as distinct_chunk_tracks
         from pilot.organizations o
        order by (o.organization_id = $1) desc, o.organization_id`,
      [PLATFORM_ORGANIZATION_ID],
    );

    // The corpus is keyed `src_<hash>` by the seed files, while anything created
    // through the API is `source_<uuid>`. Splitting on the prefix answers "is
    // THIS corpus already loaded" rather than "is there any library content",
    // which are different questions with different remedies.
    const corpusByOrg = await client.query(
      `select organization_id, count(*)::int as corpus_sources
         from pilot.shadow_library_sources
        where source_id like 'src\\_%'
        group by organization_id
        order by corpus_sources desc`,
    );

    // Named explicitly: this is the row the failed import collided on, and the
    // next operator should be able to see where it sits without re-deriving it.
    const collision = await client.query(
      `select source_id, organization_id, source_type, approval_state, verification_state
         from pilot.shadow_library_sources
        where source_id = 'src_003ec55ec16f050a'`,
    );

    // internal_policy is the axis the platform/gym split turns on: 20 of these
    // are PPBF's own repo documents and belong to a gym, while one is the
    // structural programme row every document hangs off.
    const policy = await client.query(
      `select organization_id, count(*)::int as internal_policy_sources
         from pilot.shadow_library_sources
        where source_type = 'internal_policy'
        group by organization_id
        order by internal_policy_sources desc`,
    );

    return {
      byOrg: byOrg.rows,
      corpusByOrg: corpusByOrg.rows,
      collision: collision.rows,
      policy: policy.rows,
    };
  } finally {
    // Read-only transaction: nothing to commit, and rolling back is the honest
    // end for a diagnostic.
    await client.query('ROLLBACK').catch(() => {});
  }
}

function pad(value, width) {
  return String(value ?? '').padEnd(width);
}

export async function run() {
  await loadEnvLocal();
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');

  const client = new Client({ connectionString, ssl: resolveSslConfig() });
  await client.connect();
  let result;
  try {
    result = await checkLibraryScope(client);
  } finally {
    await client.end();
  }

  console.log('SHADOW library scope check');
  console.log('==========================');
  console.log('');
  console.log('PER ORGANIZATION');
  console.log(`  ${pad('organization_id', 24)}${pad('sources', 9)}${pad('approved', 10)}${pad('docs', 6)}${pad('ready', 7)}${pad('chunks', 8)}${pad('caps', 6)}${pad('caps+tracks', 13)}chunk_tracks`);
  for (const r of result.byOrg) {
    console.log(
      `  ${pad(r.organization_id, 24)}${pad(r.sources, 9)}${pad(r.sources_approved, 10)}`
      + `${pad(r.documents, 6)}${pad(r.documents_ready, 7)}${pad(r.chunks, 8)}${pad(r.capabilities, 6)}`
      + `${pad(r.capabilities_with_tracks, 13)}${r.distinct_chunk_tracks}`,
    );
  }

  console.log('');
  console.log("CORPUS ROWS (source_id like 'src_%' -- the seed files' own keys)");
  if (result.corpusByOrg.length === 0) {
    console.log('  none -- the research corpus has never been imported into this database');
  } else {
    for (const r of result.corpusByOrg) {
      console.log(`  ${pad(r.organization_id, 24)}${r.corpus_sources}`);
    }
  }

  console.log('');
  console.log('THE ROW THE STAGING IMPORT COLLIDED ON (src_003ec55ec16f050a)');
  if (result.collision.length === 0) {
    console.log('  absent -- this database has no such row');
  } else {
    for (const r of result.collision) {
      console.log(`  organization_id=${r.organization_id} type=${r.source_type} ${r.approval_state}/${r.verification_state}`);
    }
  }

  console.log('');
  console.log('internal_policy SOURCES BY ORGANIZATION');
  if (result.policy.length === 0) {
    console.log('  none');
  } else {
    for (const r of result.policy) {
      console.log(`  ${pad(r.organization_id, 24)}${r.internal_policy_sources}`);
    }
  }

  const platformRow = result.byOrg.find((r) => r.organization_id === PLATFORM_ORGANIZATION_ID);
  const platformCorpus = result.corpusByOrg
    .find((r) => r.organization_id === PLATFORM_ORGANIZATION_ID)?.corpus_sources ?? 0;
  const elsewhere = result.corpusByOrg.filter((r) => r.organization_id !== PLATFORM_ORGANIZATION_ID);
  // A gym legitimately keeps corpus rows AFTER a re-scope: its own policy sources
  // plus the copied programme source they hang off. So "corpus rows outside the
  // baseline" is only a problem when the baseline does not hold its own share --
  // the first version of this check called a correctly re-scoped database broken,
  // which is worse than not checking, because the next operator believes it.
  const expected = SCOPE_EXPECTED_COUNTS.platform_baseline.sources;
  const gymKeeps = SCOPE_EXPECTED_COUNTS.ppbf_policy.sources;
  const strays = elsewhere.filter((r) => r.corpus_sources > gymKeeps);

  console.log('');
  if (!platformRow) {
    console.log('PILOT LIBRARY SCOPE CHECK: NO RESERVED ORGANIZATION');
    console.log('  The platform library scope migration has not been applied to this database.');
  } else if (platformCorpus === 0 && elsewhere.length > 0) {
    console.log('PILOT LIBRARY SCOPE CHECK: CORPUS IS OUTSIDE THE BASELINE');
    console.log(
      '  Corpus rows are held by a gym organization and the baseline holds none. source_id is '
      + 'a primary key, so the baseline import CANNOT place the same rows in the reserved '
      + 'organization while these exist. Re-scope them (pilot:rescope-library-baseline) or '
      + 'remove them first -- an owner decision, not a retry.',
    );
  } else if (platformCorpus > 0 && platformCorpus !== expected) {
    console.log('PILOT LIBRARY SCOPE CHECK: BASELINE INCOMPLETE');
    console.log(`  The baseline holds ${platformCorpus} corpus source(s); the corpus assigns it ${expected}.`);
    if (strays.length > 0) {
      console.log(`  A gym holds more than the ${gymKeeps} it should keep: ${strays.map((r) => `${r.organization_id}=${r.corpus_sources}`).join(', ')}`);
    }
  } else if (platformCorpus === expected && platformRow.capabilities > 0
      && platformRow.capabilities_with_tracks === 0) {
    console.log('PILOT LIBRARY SCOPE CHECK: BASELINE PRESENT, EVIDENCE AXIS EMPTY');
    console.log(
      `  ${platformRow.capabilities} capability row(s), none carrying feeder_tracks. Coverage `
      + 'queries will return nothing. Backfill with the importer\'s capability_map_only mode '
      + '(tables: capability_map_only) -- safe on an approved baseline, unlike a full import.',
    );
  } else if (platformCorpus === expected) {
    console.log('PILOT LIBRARY SCOPE CHECK: BASELINE PRESENT AND CORRECTLY SPLIT');
    console.log(
      `  ${platformCorpus} corpus source(s) in the baseline, ${platformRow.sources_approved} approved, `
      + `${platformRow.capabilities_with_tracks}/${platformRow.capabilities} capabilities carrying feeder_tracks `
      + `over ${platformRow.distinct_chunk_tracks} chunk track(s). `
      + `Gyms keep their own policy material: ${elsewhere.map((r) => `${r.organization_id}=${r.corpus_sources}`).join(', ') || 'none'}.`,
    );
  } else if (platformRow.chunks === 0) {
    console.log('PILOT LIBRARY SCOPE CHECK: BASELINE EMPTY, NOTHING BLOCKING');
    console.log('  The reserved organization holds no corpus rows and no gym holds them either.');
  } else {
    console.log('PILOT LIBRARY SCOPE CHECK: BASELINE PRESENT');
    console.log(`  ${platformRow.chunks} chunk(s), ${platformRow.sources_approved} approved source(s).`);
  }

  return result;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
    // Always zero: this reports a state, it does not gate one. The states it can
    // report are all legitimate things for a database to be in, and a non-zero
    // exit would turn "tell me where the corpus is" into a failing check.
    process.exit(0);
  } catch (error) {
    console.error('PILOT LIBRARY SCOPE CHECK FAILED TO RUN');
    console.error(String(error));
    process.exit(1);
  }
}
