import fs from 'node:fs';
import path from 'node:path';

import { GYM_SAYINGS } from '../../../components/gymSayings';

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const read = (relative: string) => fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');

const moduleSource = read('apps/web/src/server/pilot/orgQuotes.ts');
const migration = read('infra/azure/pilot_slice_postgres_org_quotes_migration.sql');
const runner = read('apps/web/scripts/pilot-apply-org-quotes-migration.mjs');
const workflow = read('.github/workflows/apply-migrations.yml');
const packageJson = JSON.parse(read('apps/web/package.json'));

describe('org quotes schema ownership', () => {
  test('the module issues no DDL and every query is scoped by organization_id', () => {
    const code = moduleSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');

    expect(code).not.toMatch(/create\s+table|create\s+index|alter\s+table|drop\s+table/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);

    // Every statement against the table names organization_id in its WHERE
    // (the insert carries it as a column). A new query that forgets it fails here.
    const statements = code.match(/`[^`]*pilot\.org_quotes[^`]*`/g) ?? [];
    expect(statements.length).toBeGreaterThanOrEqual(4);
    for (const statement of statements) {
      expect(statement).toMatch(/organization_id/);
    }
  });

  test('the migration owns the table, its guards and both indexes', () => {
    expect(migration).toMatch(/create table if not exists pilot\.org_quotes/i);
    expect(migration).toMatch(/references pilot\.organizations\(organization_id\)/i);
    expect(migration).toMatch(/primary key \(organization_id, quote_id\)/i);
    expect(migration).toContain('pilot_org_quotes_type_check');
    expect(migration).toContain('pilot_org_quotes_shown_check');
    expect(migration).toMatch(/create unique index if not exists idx_org_quotes_unique_text/i);
    expect(migration).toMatch(/create index if not exists idx_org_quotes_org_active/i);
  });

  test('the migration seeds exactly the existing gymSayings, and only for the club organization', () => {
    expect(migration).toContain("where o.organization_id = 'punxsy_prominence'");
    expect(migration).toMatch(/on conflict do nothing/i);
    for (const saying of GYM_SAYINGS) {
      expect(migration).toContain(`('${saying.line.replace(/'/g, "''")}', '${saying.said_by}'`);
    }
    // One values row per saying, no extras.
    const valueRows = migration.match(/^\s+\('[^\n]*array\['[a-z-]+'\]::text\[\]\),?$/gm) ?? [];
    expect(valueRows).toHaveLength(GYM_SAYINGS.length);
  });

  test('the migration carries no transaction boundary, because this runner opens one', () => {
    expect(migration).not.toMatch(/^\s*begin\s*;/im);
    expect(migration).not.toMatch(/^\s*commit\s*;/im);
    expect(runner).toContain("client.query('BEGIN')");
    expect(runner).toContain("client.query('COMMIT')");
    expect(runner).toContain("client.query('ROLLBACK')");
  });

  test('the runner reads this migration and verifies readiness before committing', () => {
    expect(runner).toContain('pilot_slice_postgres_org_quotes_migration.sql');
    expect(runner).toContain('ORG_QUOTES_TABLE_NOT_READY');
    expect(runner).toContain('idx_org_quotes_unique_text');
    expect(runner).toContain('idx_org_quotes_org_active');
    expect(runner).toContain('POSTGRES_TARGET_MISMATCH');
    expect(runner).toContain('rejectUnauthorized: true');
  });

  test('the migration is dispatchable, in every hand-maintained list, and has an embedded-pg suite', () => {
    expect(packageJson.scripts['pilot:apply-org-quotes']).toBe(
      'node scripts/pilot-apply-org-quotes-migration.mjs',
    );
    expect(packageJson.scripts['test:migrations:org-quotes']).toContain('src/server/pilot/orgQuotes.pg.test.ts');

    expect(workflow).toMatch(/^\s+- org-quotes$/m);
    const allList = workflow.match(/for m in ([a-z0-9 -]+); do/);
    expect(allList?.[1]).toContain('org-quotes');
    const listCheck = workflow.match(/case " ([a-z0-9 -]+) " in/);
    expect(listCheck?.[1]).toContain('org-quotes');
  });
});
