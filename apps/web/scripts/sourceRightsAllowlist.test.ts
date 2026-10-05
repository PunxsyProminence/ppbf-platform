// Holds the source-rights migration's ppbf_owned backfill to the importer.
//
// The backfill raises sources to ppbf_owned by EXACT source id only: the 21
// internal_policy sources of the 2026-08-07 seed and the importer's one copy
// (policyCopyId of the programme source). It used to also match
// metadata.copied_from_source_id, which a curator can write through the
// sources route, and the file re-runs on every apply-migrations dispatch, so a
// curator's source could claim to be a copy and be raised (#1238 review, P1).
//
// An exact list can drift from the importer silently: a new seed policy source
// or a changed copy id would stay unknown and its full text would be refused.
// This test reads both and fails on any difference.
//
// The importer is real ESM (.mjs) and the default jest runner has no ESM
// loader, so, as in researchImportScope.test.ts, it is evaluated in one real
// `node` child process.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MODULE_URL = pathToFileURL(path.resolve(__dirname, 'import-shadow-research.mjs')).href;
const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../../infra/azure/pilot_slice_postgres_source_rights_migration.sql',
);

function sqlWithoutComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

let importerIds: { policy: string[]; programme: string; copies: string[] };
let migrationSql: string;

beforeAll(() => {
  const script = `
    import * as importer from ${JSON.stringify(MODULE_URL)};
    const whole = await importer.loadSeedPackage({ organizationId: 'org-a', accountId: 'acct' });
    const scoped = await importer.loadSeedPackage({ organizationId: 'org-a', accountId: 'acct', scope: 'ppbf_policy' });
    process.stdout.write(JSON.stringify({
      policy: [...importer.policySourceIds(whole.sources)],
      programme: importer.RESEARCH_PROGRAMME_SOURCE_ID,
      copies: scoped.sources.filter((row) => row.metadata?.copied_from_source_id).map((row) => row.source_id),
    }));
  `;
  importerIds = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
  migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');
});

function backfillIds(): string[] {
  const code = sqlWithoutComments(migrationSql);
  const match = /set rights_status = 'ppbf_owned'\s+from \(select '\{([^}]*)\}'::text\[\] as ids\) seed/.exec(code);
  if (!match) throw new Error('ppbf_owned backfill not found in the migration');
  return match[1].split(',');
}

describe('source-rights ppbf_owned backfill', () => {
  test('lists exactly the importer\'s PPBF sources and its copies, nothing else', () => {
    const expected = [...importerIds.policy, importerIds.programme, ...importerIds.copies].sort();
    expect(importerIds.policy).toHaveLength(20);
    expect(importerIds.copies).toEqual(['src_ppbfpol_6563c68e39047128']);
    expect(backfillIds().sort()).toEqual(expected);
    expect(new Set(backfillIds()).size).toBe(backfillIds().length);
  });

  test('matches by source id only and reads no metadata', () => {
    const code = sqlWithoutComments(migrationSql);
    const backfill = code.slice(code.indexOf("set rights_status = 'ppbf_owned'"));
    const statement = backfill.slice(0, backfill.indexOf(';'));
    expect(statement).not.toMatch(/metadata/);
    expect(statement).toMatch(/where s\.rights_status = 'unknown'\s+and s\.source_id = any\(seed\.ids\)$/);
    expect(code).not.toMatch(/copied_from/);
  });

  test('no allowlisted id has the shape the sources route mints', () => {
    // createShadowLibrarySource names every source `source_<uuid>`; none of
    // these can be created, or claimed, through the route.
    for (const id of backfillIds()) expect(id).toMatch(/^src_/);
  });
});
