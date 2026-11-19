import fs from 'node:fs';
import path from 'node:path';

import { COACH_ALLOWED_AUDIT_ENTITY_TYPES, FAMILY_ALLOWED_AUDIT_ENTITY_TYPES } from './auditReadAllowlist';

// Static guards on the rest/away mark (lane R6-b1, OD-2026-11-17-004: "no
// health reason asked for minors"). The database half is restMarks.pg.test.ts.

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const read = (relative: string) => fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');

const moduleSource = read('apps/web/src/server/pilot/restMarks.ts');
const migration = read('infra/azure/pilot_slice_postgres_athlete_rest_marks_migration.sql');
const runner = read('apps/web/scripts/pilot-apply-athlete-rest-marks-migration.mjs');
const workflow = read('.github/workflows/apply-migrations.yml');
const packageJson = JSON.parse(read('apps/web/package.json'));

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/^\s*--.*$/gm, '');
}

const COLUMNS = [
  'organization_id',
  'mark_id',
  'athlete_id',
  'kind',
  'first_day',
  'last_day',
  'marked_by_account_id',
  'marked_by_role',
  'marked_at',
  'cleared_at',
  'cleared_by_account_id',
];

describe('athlete rest marks schema ownership', () => {
  test('the table has exactly these columns: nowhere to type a reason', () => {
    const body = code(migration);
    const create = body.match(/create table if not exists pilot\.athlete_rest_marks \(([\s\S]*?)\n\);/);
    expect(create).not.toBeNull();
    const columns = create![1]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[a-z_]+\s+(text|uuid|date|timestamptz)\b/.test(line))
      .map((line) => line.split(/\s+/)[0]);
    expect(columns).toEqual(COLUMNS);
    // The runner's readiness check pins the same list in the live database.
    const pinned = runner.match(/EXPECTED_COLUMNS = \[([\s\S]*?)\];/);
    expect(pinned![1].match(/'([a-z_]+)'/g)!.map((name) => name.replace(/'/g, ''))).toEqual(COLUMNS);
    for (const word of ['reason', 'note', 'comment', 'health', 'injur', 'ill']) {
      expect(columns.join(' ')).not.toContain(word);
    }
  });

  test('the module issues no DDL, never hard-deletes, and scopes every statement by organization', () => {
    const body = code(moduleSource);
    expect(body).not.toMatch(/create\s+table|create\s+index|alter\s+table|drop\s+table/i);
    expect(body).not.toMatch(/delete\s+from/i);
    const statements = body.match(/`[^`]*pilot\.athlete_rest_marks[^`]*`/g) ?? [];
    expect(statements.length).toBe(4);
    for (const statement of statements) {
      expect(statement).toMatch(
        /where organization_id = \$1 and athlete_id = (?:\$2|any\(\$2::text\[\]\))|insert into pilot\.athlete_rest_marks\s*\(\s*organization_id/,
      );
    }
    // The one UPDATE is the clear, and it only ever moves a live mark.
    const updates = statements.filter((s) => /update pilot\.athlete_rest_marks/.test(s));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(/set cleared_at = clock_timestamp\(\), cleared_by_account_id = \$4/);
    expect(updates[0]).toMatch(/and cleared_at is null/);
  });

  test('a rest-mark audit row is never mirrored and is not on a coach or family audit read', () => {
    const writes = code(moduleSource).match(/writePilotAuditEvent\(\{[\s\S]*?\}, client\)/g) ?? [];
    expect(writes).toHaveLength(2);
    for (const write of writes) {
      expect(write).toContain("entity_type: 'athlete_rest_mark'");
      expect(write).toContain('shadow_mirror: false');
      expect(write).not.toMatch(/reason|note/i);
    }
    expect(COACH_ALLOWED_AUDIT_ENTITY_TYPES.has('athlete_rest_mark')).toBe(false);
    expect(FAMILY_ALLOWED_AUDIT_ENTITY_TYPES.has('athlete_rest_mark')).toBe(false);
  });

  test('the migration runs last-listed through the workflow, with its runner and test scripts', () => {
    expect(packageJson.scripts['pilot:apply-athlete-rest-marks']).toBe(
      'node scripts/pilot-apply-athlete-rest-marks-migration.mjs',
    );
    expect(packageJson.scripts['test:migrations:athlete-rest-marks']).toMatch(/restMarks\.pg\.test\.ts/);
    expect(workflow).toMatch(/^\s+- athlete-rest-marks$/m);
    const allList = workflow.match(/for m in ([^;]+); do/);
    expect(allList![1].trim().split(/\s+/)).toContain('athlete-rest-marks');
  });
});
