import fs from 'node:fs';
import path from 'node:path';

import { PUBLIC_SURFACE_FORBIDDEN_TABLES } from './privacyTiers';

// Static guards on the "reached out" mark (lane W4-6, SC-3a-1; OW27-33 B;
// Overwatch W4-6 Q4 A: "who and when only, no free text"). The database half is
// reachedOutMarksMigration.pg.test.ts.

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const read = (relative: string) => fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');

const migration = read('infra/azure/pilot_slice_postgres_athlete_reached_out_marks_migration.sql');
const runner = read('apps/web/scripts/pilot-apply-athlete-reached-out-marks-migration.mjs');
const workflow = read('.github/workflows/apply-migrations.yml');
const retention = read('docs/DATA_RETENTION.md');
const packageJson = JSON.parse(read('apps/web/package.json')) as { scripts: Record<string, string> };

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/^\s*--.*$/gm, '');
}

const COLUMNS = [
  'organization_id',
  'athlete_id',
  'marked_by_account_id',
  'marked_by_role',
  'marked_at',
  'cleared_at',
  'cleared_by_account_id',
];

describe('athlete reached-out marks schema ownership', () => {
  test('the table has exactly these columns: who and when, nowhere to type a note', () => {
    const create = code(migration).match(/create table if not exists pilot\.athlete_reached_out_marks \(([\s\S]*?)\n\);/);
    expect(create).not.toBeNull();
    const columns = create![1]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[a-z_]+\s+(text|uuid|date|timestamptz|integer|boolean|jsonb)\b/.test(line))
      .map((line) => line.split(/\s+/)[0]);
    expect(columns).toEqual(COLUMNS);
    // The runner's readiness check pins the same list in the live database.
    const pinned = runner.match(/EXPECTED_COLUMNS = \[([\s\S]*?)\];/);
    expect(pinned![1].match(/'([a-z_]+)'/g)!.map((name) => name.replace(/'/g, ''))).toEqual(COLUMNS);
    for (const word of ['note', 'reason', 'comment', 'message', 'channel', 'text_', 'detail', 'health']) {
      expect(columns.join(' ')).not.toContain(word);
    }
  });

  test('one current mark per athlete, and only staff roles may hold one', () => {
    expect(code(migration)).toMatch(/primary key \(organization_id, athlete_id\)/);
    expect(code(migration)).toMatch(/check \(marked_by_role in \('coach', 'organization_admin', 'admin'\)\)/);
  });

  test('registered as every migration is: package scripts and all three places in the workflow', () => {
    expect(packageJson.scripts['pilot:apply-athlete-reached-out-marks'])
      .toBe('node scripts/pilot-apply-athlete-reached-out-marks-migration.mjs');
    expect(packageJson.scripts['test:migrations:athlete-reached-out-marks'])
      .toContain('src/server/pilot/reachedOutMarksMigration.pg.test.ts');
    expect(workflow).toMatch(/^ {10}- athlete-reached-out-marks$/m);
    expect(workflow).toMatch(/for m in [a-z0-9 -]* athlete-reached-out-marks[ ;]/);
    expect(workflow).toMatch(/case " [a-z0-9 -]* athlete-reached-out-marks /);
  });

  test('a public surface may never read it, and the retention table names it', () => {
    expect(PUBLIC_SURFACE_FORBIDDEN_TABLES).toContain('pilot.athlete_reached_out_marks');
    expect(retention).toMatch(/`pilot\.athlete_reached_out_marks`[^|]*\| Period not yet ruled/);
  });
});
