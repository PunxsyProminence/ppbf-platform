import fs from 'node:fs';
import path from 'node:path';

import {
  INJURY_BODY_AREAS,
  INJURY_CONTEXTS,
  INJURY_REPORTED_BY,
  INJURY_TYPES,
} from './athleteInjuries';

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const read = (relative: string) => fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');

const moduleSource = read('apps/web/src/server/pilot/athleteInjuries.ts');
const migration = read('infra/azure/pilot_slice_postgres_athlete_injuries_migration.sql');
const runner = read('apps/web/scripts/pilot-apply-athlete-injuries-migration.mjs');
const workflow = read('.github/workflows/apply-migrations.yml');
const painReportAlert = read('apps/web/src/server/pilot/formulas/painReportAlert.ts');
const packageJson = JSON.parse(read('apps/web/package.json'));

const code = moduleSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

function checkList(constraint: string): string[] {
  const match = migration.match(new RegExp(`${constraint} check \\([a-z_]+ in \\(([^)]*)\\)\\)`));
  return [...(match?.[1].matchAll(/'([a-z_]+)'/g) ?? [])].map((m) => m[1]);
}

describe('athlete injuries schema ownership', () => {
  test('the module issues no DDL and never deletes a row', () => {
    expect(code).not.toMatch(/create\s+table|create\s+index|alter\s+table|drop\s+table/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
  });

  test('every statement against the table is scoped by organization_id', () => {
    const statements = code.match(/`[^`]*pilot\.athlete_injuries[^`]*`/g) ?? [];
    expect(statements.length).toBeGreaterThanOrEqual(3);
    for (const statement of statements) {
      expect(statement).toMatch(
        /organization_id\s*=\s*\$1|insert into pilot\.athlete_injuries\s*\(\s*organization_id|^`pilot\.athlete_injuries i\s/,
      );
    }
  });

  test('every read and the error mark filter out deleted athletes', () => {
    const reads = code.match(/`select \$\{COLUMNS\} from \$\{FROM\}[^`]*`/g) ?? [];
    expect(reads.length).toBeGreaterThanOrEqual(3);
    for (const statement of reads) {
      expect(statement).toContain("${athleteNotDeletedSql('i')}");
    }
    expect(code).toMatch(/set entered_in_error = true[^`]*athleteNotDeletedSql\('i'\)/);
  });

  test('the module vocabularies are exactly the migration check lists', () => {
    expect(checkList('pilot_athlete_injuries_body_area_check')).toEqual([...INJURY_BODY_AREAS]);
    expect(checkList('pilot_athlete_injuries_type_check')).toEqual([...INJURY_TYPES]);
    expect(checkList('pilot_athlete_injuries_context_check')).toEqual([...INJURY_CONTEXTS]);
    expect(checkList('pilot_athlete_injuries_reported_by_check')).toEqual([...INJURY_REPORTED_BY]);
  });

  test('the pain-report marker the link check reads is the one pain reports are written with', () => {
    expect(painReportAlert).toContain("const PAIN_REPORT_TRIGGER = 'athlete_pain_report';");
    expect(code).toContain("metadata->>'trigger' = 'athlete_pain_report'");
  });

  test('the migration ties rows to the athlete with a cascade and owns its guards', () => {
    expect(migration).toMatch(/create table if not exists pilot\.athlete_injuries/i);
    expect(migration).toMatch(
      /pilot_athlete_injuries_athlete_fk foreign key \(organization_id, athlete_id\)\s+references pilot\.athletes\(organization_id, athlete_id\) on delete cascade/,
    );
    expect(migration).toContain('pilot_athlete_injuries_one_return_source');
    expect(migration).toContain('pilot_athlete_injuries_return_after_injury');
    expect(migration).toMatch(/create index if not exists idx_athlete_injuries_athlete/i);
  });

  test('the migration carries no transaction boundary, because this runner opens one', () => {
    expect(migration).not.toMatch(/^\s*begin\s*;/im);
    expect(migration).not.toMatch(/^\s*commit\s*;/im);
    expect(runner).toContain("client.query('BEGIN')");
    expect(runner).toContain("client.query('COMMIT')");
    expect(runner).toContain("client.query('ROLLBACK')");
  });

  test('the runner reads this migration and verifies readiness before committing', () => {
    expect(runner).toContain('pilot_slice_postgres_athlete_injuries_migration.sql');
    expect(runner).toContain('ATHLETE_INJURIES_TABLE_NOT_READY');
    expect(runner).toContain('idx_athlete_injuries_athlete');
    expect(runner).toContain('pilot_athlete_injuries_athlete_fk');
    expect(runner).toContain('POSTGRES_TARGET_MISMATCH');
    expect(runner).toContain('rejectUnauthorized: true');
  });

  test('the migration is dispatchable, in every hand-maintained list, and has an embedded-pg suite', () => {
    expect(packageJson.scripts['pilot:apply-athlete-injuries']).toBe(
      'node scripts/pilot-apply-athlete-injuries-migration.mjs',
    );
    expect(packageJson.scripts['test:migrations:athlete-injuries']).toContain(
      'src/server/pilot/athleteInjuries.pg.test.ts',
    );

    expect(workflow).toMatch(/^\s+- athlete-injuries$/m);
    const allList = workflow.match(/for m in ([a-z0-9 -]+); do/);
    expect(allList?.[1]).toContain('athlete-injuries');
    // After the three migrations whose tables it references.
    const order = allList?.[1].split(' ') ?? [];
    for (const dependency of ['shadow-decision-loop', 'training-holds', 'safety-flags']) {
      expect(order.indexOf(dependency)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(dependency)).toBeLessThan(order.indexOf('athlete-injuries'));
    }
    const listCheck = workflow.match(/case " ([a-z0-9 -]+) " in/);
    expect(listCheck?.[1]).toContain('athlete-injuries');
  });
});
