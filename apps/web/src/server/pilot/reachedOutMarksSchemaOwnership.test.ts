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
  'mark_id',
  'athlete_id',
  'marked_by_account_id',
  'marked_by_role',
  'marked_at',
  'cleared_at',
  'cleared_by_account_id',
];
const COLUMN_ITEM = /^([a-z_]+)\s+(text|uuid|timestamptz)\s+(not )?null\b/;
const CONSTRAINT_ITEM = /^(constraint [a-z_]+ (check|foreign key) \(|primary key \()/;

/** The table body split on its top-level commas: one item per column or table constraint. */
function items(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  out.push(current);
  return out.map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

describe('athlete reached-out marks schema ownership', () => {
  test('the table has exactly these columns: who and when, nowhere to type a note', () => {
    const create = code(migration).match(/create table if not exists pilot\.athlete_reached_out_marks \(([\s\S]*?)\n\);/);
    expect(create).not.toBeNull();
    const all = items(create![1]);
    // Every item is a column of a known type or a table constraint: a column of any other type
    // (varchar, json, bytea, ...), even on the line of another item, is one this test does not know.
    const unknown = all.filter((item) => !COLUMN_ITEM.test(item) && !CONSTRAINT_ITEM.test(item));
    expect(unknown).toEqual([]);
    const columns = all.map((item) => item.match(COLUMN_ITEM)?.[1]).filter(Boolean);
    expect(columns).toEqual(COLUMNS);
    // The runner's readiness check pins the same list in the live database.
    const pinned = runner.match(/EXPECTED_COLUMNS = \[([\s\S]*?)\];/);
    expect(pinned![1].match(/'([a-z_]+)'/g)!.map((name) => name.replace(/'/g, ''))).toEqual(COLUMNS);
  });

  test('one current mark per athlete, every take-back kept, and only staff roles may hold one', () => {
    expect(code(migration)).toMatch(/primary key \(organization_id, mark_id\)/);
    expect(code(migration)).toMatch(
      /create unique index if not exists uq_athlete_reached_out_marks_current\s+on pilot\.athlete_reached_out_marks\(organization_id, athlete_id\)\s+where cleared_at is null;/,
    );
    expect(code(migration)).toMatch(/check \(marked_by_role in \('coach', 'organization_admin', 'admin'\)\)/);
  });

  test('the guard trigger runs before every insert, update and delete, row by row', () => {
    expect(code(migration)).toMatch(
      /create trigger trg_athlete_reached_out_marks_guard\s+before insert or update or delete on pilot\.athlete_reached_out_marks\s+for each row execute function pilot\.athlete_reached_out_marks_guard\(\);/,
    );
  });

  test('an account\'s delete clears its id from the marks (a staff account id is often an email address)', () => {
    for (const column of ['marked_by_account_id', 'cleared_by_account_id']) {
      expect(code(migration)).toMatch(
        new RegExp(`foreign key \\(${column}\\)\\s+references pilot\\.accounts\\(account_id\\)\\s+on delete set null`),
      );
    }
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

  test('a public surface may never read it, and the retention table names it and what a purge does to it', () => {
    expect(PUBLIC_SURFACE_FORBIDDEN_TABLES).toContain('pilot.athlete_reached_out_marks');
    const row = retention.split('\n').find((line) => line.includes('`pilot.athlete_reached_out_marks`'));
    expect(row).toMatch(/\| Period not yet ruled \| -- \| Not yet ruled \|$/);
    expect(row).toContain('by cascade when the purge deletes it');
    expect(row).toContain('when the purge deletes an account, its id is cleared from the marks');
  });
});
