import fs from 'node:fs';
import path from 'node:path';

const repositoryRoot = path.resolve(__dirname, '../../../../..');

const migrationPath = path.join(
  repositoryRoot,
  'infra/azure/pilot_slice_postgres_compliance_rule_seeds_migration.sql',
);
const runnerPath = path.join(
  repositoryRoot,
  'apps/web/scripts/pilot-apply-compliance-rule-seeds-migration.mjs',
);
const workflowPath = path.join(repositoryRoot, '.github/workflows/apply-migrations.yml');
const packageJsonPath = path.join(repositoryRoot, 'apps/web/package.json');

const DEFAULT_RULE_NAMES = [
  'Physical Injury Prevention',
  'Proper Technique & Form',
  'Training Protocol Compliance',
  'Medical Clearance Status',
  'Code of Conduct',
];

/** Migration text with `--` comment lines dropped, so counts see SQL only. */
function statementsOnly(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

describe('compliance rule seeds ownership', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const statements = statementsOnly(migration);
  const runner = fs.readFileSync(runnerPath, 'utf8');
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  test('all five platform defaults are seeded', () => {
    for (const ruleName of DEFAULT_RULE_NAMES) {
      expect(statements).toContain(`'${ruleName}'`);
    }
    expect(statements.match(/insert into pilot\.compliance_rules/gi)).toHaveLength(
      DEFAULT_RULE_NAMES.length,
    );
  });

  // The two guards that make a re-run safe. Losing either one is invisible
  // until the workflow next runs `all` against production: without the name
  // check an archived rule is switched back on, and without ON CONFLICT a
  // renamed rule raises a duplicate-key error that aborts the whole migration.
  test('each seed carries both idempotence guards', () => {
    expect(statements.match(/where organization_id not in \(select organization_id from pilot\.compliance_rules where rule_name = /gi))
      .toHaveLength(DEFAULT_RULE_NAMES.length);
    expect(statements.match(/on conflict do nothing/gi)).toHaveLength(DEFAULT_RULE_NAMES.length);
  });

  // The two runner families take opposite conventions, and getting this
  // backwards takes every migration in the set down with it.
  test('the migration carries no transaction boundary, because this runner opens one', () => {
    expect(statements).not.toMatch(/^\s*begin\s*;/im);
    expect(statements).not.toMatch(/^\s*commit\s*;/im);
    expect(runner).toContain("client.query('BEGIN')");
    expect(runner).toContain("client.query('COMMIT')");
    expect(runner).toContain("client.query('ROLLBACK')");
  });

  test('the runner reads this migration and verifies readiness before committing', () => {
    expect(runner).toContain('pilot_slice_postgres_compliance_rule_seeds_migration.sql');
    expect(runner).toContain('COMPLIANCE_RULE_SEEDS_NOT_READY');
    expect(runner).toContain('POSTGRES_TARGET_MISMATCH');
    expect(runner).toContain('rejectUnauthorized: true');
  });

  // A migration nobody can dispatch is not in the migration path. Registration
  // takes three separate edits to one workflow, and the `all` list and the
  // list-check allowlist are both hand-maintained.
  test('the migration is dispatchable and covered by every hand-maintained list', () => {
    expect(packageJson.scripts['pilot:apply-compliance-rule-seeds']).toBe(
      'node scripts/pilot-apply-compliance-rule-seeds-migration.mjs',
    );
    expect(packageJson.scripts['test:migrations']).toContain(
      'npm run test:migrations:compliance-rule-seeds',
    );

    expect(workflow).toMatch(/^\s+- compliance-rule-seeds$/m);

    const allList = workflow.match(/for m in ([a-z0-9 -]+); do/);
    expect(allList?.[1]).toContain('compliance-rule-seeds');

    const listCheck = workflow.match(/case " ([a-z0-9 -]+) " in/);
    expect(listCheck?.[1]).toContain('compliance-rule-seeds');
  });

  // compliance_rules is created by the compliance migration, so the seeds must
  // run after it in the only list that fixes an order.
  test('the `all` list orders the seeds after the compliance migration', () => {
    const allList = workflow.match(/for m in ([a-z0-9 -]+); do/)?.[1].split(' ') ?? [];
    expect(allList.indexOf('compliance-rule-seeds')).toBeGreaterThan(allList.indexOf('compliance'));
  });
});
