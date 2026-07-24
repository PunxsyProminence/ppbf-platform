import fs from 'node:fs';
import path from 'node:path';

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const migrationPath = path.join(
  repositoryRoot,
  'infra/azure/pilot_slice_postgres_shadow_job_lease_migration.sql',
);

describe('SHADOW job lease migration contract', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');

  test('is an additive transaction with the required lease fields and indexes', () => {
    expect(migration.trim()).toMatch(/^--[\s\S]*\nbegin;/i);
    expect(migration.trim()).toMatch(/commit;$/i);
    expect(migration).toContain('add column if not exists lease_token uuid null');
    expect(migration).toContain('add column if not exists lease_expires_at timestamptz null');
    expect(migration).toContain('idx_shadow_jobs_lease_token');
    expect(migration).toContain('idx_shadow_jobs_running_lease');
    expect(migration).toContain('shadow_jobs_lease_pair_check');
    expect(migration).toContain('shadow_jobs_non_running_lease_check');
  });

  test('does not rewrite or delete existing job data', () => {
    expect(migration).not.toMatch(/\bupdate\s+pilot\.shadow_jobs/i);
    expect(migration).not.toMatch(/\bdelete\s+from\s+pilot\.shadow_jobs/i);
    expect(migration).not.toMatch(/\bdrop\s+(table|column)\b/i);
  });
});
