import fs from 'node:fs';
import path from 'node:path';

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const migrationPath = path.join(
  repositoryRoot,
  'infra/azure/pilot_slice_postgres_board_role_migration.sql',
);

describe('aggregate-only Board role migration contract', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');

  test('is transactional and idempotently replaces both role constraints', () => {
    expect(migration.trim()).toMatch(/^--[\s\S]*\nbegin;/i);
    expect(migration.trim()).toMatch(/commit;$/i);
    expect(migration).toContain("'pilot.accounts'::regclass");
    expect(migration).toContain("'pilot.organization_memberships'::regclass");
    expect(migration).toContain('accounts_role_check');
    expect(migration).toContain('organization_memberships_role_check');
    expect(migration.match(/'board'/g)).toHaveLength(2);
    expect(migration.match(/join pg_attribute a/g)).toHaveLength(2);
    expect(migration.match(/c\.conkey = array\[a\.attnum\]::smallint\[\]/g)).toHaveLength(2);
    expect(migration).toContain('format(');
  });

  test('does not rewrite account or membership data', () => {
    expect(migration).not.toMatch(/\bupdate\s+pilot\./i);
    expect(migration).not.toMatch(/\bdelete\s+from\s+pilot\./i);
    expect(migration).not.toMatch(/\bdrop\s+(table|column)\b/i);
  });
});
