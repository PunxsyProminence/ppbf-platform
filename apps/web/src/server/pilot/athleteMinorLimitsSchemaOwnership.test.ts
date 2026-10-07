import fs from 'node:fs';
import path from 'node:path';

import { MINOR_LIMIT_TYPES, MINOR_LIMIT_UNITS } from './athleteMinorLimits';

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const read = (relative: string) => fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');

const moduleSource = read('apps/web/src/server/pilot/athleteMinorLimits.ts');
const routeSource = read('apps/web/app/api/pilot/coach/athlete-minor-limits/route.ts');
const migration = read('infra/azure/pilot_slice_postgres_athlete_minor_limits_migration.sql');
const runner = read('apps/web/scripts/pilot-apply-athlete-minor-limits-migration.mjs');
const workflow = read('.github/workflows/apply-migrations.yml');
const packageJson = JSON.parse(read('apps/web/package.json'));

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('athlete minor limits schema ownership', () => {
  test('the module issues no DDL, never updates or deletes a limit, and scopes every statement by organization', () => {
    const body = code(moduleSource);
    expect(body).not.toMatch(/create\s+table|create\s+index|alter\s+table|drop\s+table/i);
    // Append-only: a child's limit is never overwritten or erased.
    expect(body).not.toMatch(/update\s+pilot\.athlete_minor_limits/i);
    expect(body).not.toMatch(/delete\s+from/i);

    const statements = body.match(/`[^`]*pilot\.athlete_minor_limits[^`]*`/g) ?? [];
    expect(statements.length).toBe(4);
    for (const statement of statements) {
      expect(statement).toMatch(
        /where organization_id = \$1 and athlete_id = \$2|insert into pilot\.athlete_minor_limits\s*\(\s*organization_id/,
      );
    }
  });

  test('neither the module nor the route computes, defaults or recommends a limit', () => {
    // A limit is what a coach typed. These are the shapes an app-made number
    // would take; none may appear outside comments.
    for (const source of [code(moduleSource), code(routeSource)]) {
      expect(source).not.toMatch(/recommend|risk|score|default_?limit|suggest/i);
    }
  });

  test('contact level is not a type here: it lives in athlete_contact_caps', () => {
    expect(MINOR_LIMIT_TYPES).toEqual([
      'heat_exposure_minutes_per_session',
      'weight_cut_max_percent_body_weight',
      'supervision',
    ]);
    expect(MINOR_LIMIT_TYPES as readonly string[]).not.toContain('contact_level');
    expect(migration).toContain('pilot.athlete_contact_caps');
  });

  test('the migration carries the same types and units, in the same pairing, as the module', () => {
    expect(migration).toContain(`limit_type in (${MINOR_LIMIT_TYPES.map((t) => `'${t}'`).join(', ')})`);
    for (const type of MINOR_LIMIT_TYPES) {
      expect(migration).toMatch(new RegExp(`limit_type = '${type}'\\s*\\n\\s*and unit = '${MINOR_LIMIT_UNITS[type]}'`));
    }
  });

  test('the migration owns the table, its guards and its index, with no transaction of its own', () => {
    expect(migration).toMatch(/create table if not exists pilot\.athlete_minor_limits/i);
    expect(migration).toMatch(/references pilot\.athletes\(organization_id, athlete_id\)/i);
    for (const name of [
      'pilot_athlete_minor_limits_type_check',
      'pilot_athlete_minor_limits_number_check',
      'pilot_athlete_minor_limits_text_check',
      'pilot_athlete_minor_limits_unit_check',
      'pilot_athlete_minor_limits_note_check',
      'pilot_athlete_minor_limits_role_check',
      'pilot_athlete_minor_limits_athlete_fk',
      'pilot_athlete_minor_limits_shape_check',
    ]) {
      expect(migration).toContain(name);
      expect(runner).toContain(name);
    }
    expect(migration).toMatch(/create index if not exists idx_athlete_minor_limits_athlete_type_seq/i);
    expect(migration).not.toMatch(/^\s*begin\s*;/im);
    expect(migration).not.toMatch(/^\s*commit\s*;/im);
  });

  test('the runner reads this migration and checks readiness before committing', () => {
    expect(runner).toContain('pilot_slice_postgres_athlete_minor_limits_migration.sql');
    expect(runner).toContain('ATHLETE_MINOR_LIMITS_TABLE_NOT_READY');
    expect(runner).toContain('idx_athlete_minor_limits_athlete_type_seq');
    expect(runner).toContain('assertDeclaredWriteTargetFromEnv');
    expect(runner).toContain('rejectUnauthorized: true');
    expect(runner).toContain("client.query('BEGIN')");
    expect(runner).toContain("client.query('ROLLBACK')");
  });

  test('the migration is dispatchable, in every hand-maintained list, and has an embedded-pg suite', () => {
    expect(packageJson.scripts['pilot:apply-athlete-minor-limits']).toBe(
      'node scripts/pilot-apply-athlete-minor-limits-migration.mjs',
    );
    expect(packageJson.scripts['test:migrations:athlete-minor-limits']).toContain(
      'src/server/pilot/athleteMinorLimits.pg.test.ts',
    );
    expect(workflow).toMatch(/^\s+- athlete-minor-limits$/m);
    expect(workflow.match(/for m in ([a-z0-9 -]+); do/)?.[1]).toContain('athlete-minor-limits');
    expect(workflow.match(/case " ([a-z0-9 -]+) " in/)?.[1]).toContain('athlete-minor-limits');
  });
});
