import fs from 'node:fs';
import path from 'node:path';

import { CONTACT_STAGES } from './athleteContactCaps';

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const read = (relative: string) => fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');

const moduleSource = read('apps/web/src/server/pilot/athleteContactCaps.ts');
const routeSource = read('apps/web/app/api/pilot/coach/athlete-contact-caps/route.ts');
const migration = read('infra/azure/pilot_slice_postgres_athlete_contact_caps_migration.sql');
const runner = read('apps/web/scripts/pilot-apply-athlete-contact-caps-migration.mjs');
const workflow = read('.github/workflows/apply-migrations.yml');
const packageJson = JSON.parse(read('apps/web/package.json'));

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('athlete contact caps schema ownership', () => {
  test('the module issues no DDL, never updates or deletes a cap, and scopes every statement by organization', () => {
    const body = code(moduleSource);
    expect(body).not.toMatch(/create\s+table|create\s+index|alter\s+table|drop\s+table/i);
    // Append-only: a child's contact limit is never overwritten or erased.
    expect(body).not.toMatch(/update\s+pilot\.athlete_contact_caps/i);
    expect(body).not.toMatch(/delete\s+from/i);

    const statements = body.match(/`[^`]*pilot\.athlete_contact_caps[^`]*`/g) ?? [];
    expect(statements.length).toBe(3);
    for (const statement of statements) {
      expect(statement).toMatch(
        /where organization_id = \$1 and athlete_id = \$2|insert into pilot\.athlete_contact_caps\s*\(\s*organization_id/,
      );
    }
  });

  test('neither the module nor the route computes, defaults or recommends a limit', () => {
    // A cap is what a coach typed. These are the shapes an app-made number
    // would take; none may appear outside comments.
    for (const source of [code(moduleSource), code(routeSource)]) {
      expect(source).not.toMatch(/recommend|risk|score|default_?cap|suggest/i);
    }
  });

  test('the ladder in the migration is the same ladder, in the same order, as the module', () => {
    expect(CONTACT_STAGES).toEqual(['none', 'light_technical', 'conditioned', 'controlled_sparring', 'open_sparring']);
    expect(migration).toContain(`in (${CONTACT_STAGES.map((s) => `'${s}'`).join(', ')})`);
  });

  test('the migration owns the table, its guards and its index, with no transaction of its own', () => {
    expect(migration).toMatch(/create table if not exists pilot\.athlete_contact_caps/i);
    expect(migration).toMatch(/references pilot\.athletes\(organization_id, athlete_id\)/i);
    for (const name of [
      'pilot_athlete_contact_caps_stage_check',
      'pilot_athlete_contact_caps_sessions_check',
      'pilot_athlete_contact_caps_note_check',
      'pilot_athlete_contact_caps_role_check',
    ]) {
      expect(migration).toContain(name);
    }
    expect(migration).toMatch(/create index if not exists idx_athlete_contact_caps_athlete_set_at/i);
    expect(migration).not.toMatch(/^\s*begin\s*;/im);
    expect(migration).not.toMatch(/^\s*commit\s*;/im);
  });

  test('the runner reads this migration and checks readiness before committing', () => {
    expect(runner).toContain('pilot_slice_postgres_athlete_contact_caps_migration.sql');
    expect(runner).toContain('ATHLETE_CONTACT_CAPS_TABLE_NOT_READY');
    expect(runner).toContain('idx_athlete_contact_caps_athlete_set_at');
    expect(runner).toContain('pilot_athlete_contact_caps_stage_check');
    expect(runner).toContain('POSTGRES_TARGET_MISMATCH');
    expect(runner).toContain('rejectUnauthorized: true');
    expect(runner).toContain("client.query('BEGIN')");
    expect(runner).toContain("client.query('ROLLBACK')");
  });

  test('the migration is dispatchable, in every hand-maintained list, and has an embedded-pg suite', () => {
    expect(packageJson.scripts['pilot:apply-athlete-contact-caps']).toBe(
      'node scripts/pilot-apply-athlete-contact-caps-migration.mjs',
    );
    expect(packageJson.scripts['test:migrations:athlete-contact-caps']).toContain(
      'src/server/pilot/athleteContactCaps.pg.test.ts',
    );
    expect(workflow).toMatch(/^\s+- athlete-contact-caps$/m);
    expect(workflow.match(/for m in ([a-z0-9 -]+); do/)?.[1]).toContain('athlete-contact-caps');
    expect(workflow.match(/case " ([a-z0-9 -]+) " in/)?.[1]).toContain('athlete-contact-caps');
  });
});
