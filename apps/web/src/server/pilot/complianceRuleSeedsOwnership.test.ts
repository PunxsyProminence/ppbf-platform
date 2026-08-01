import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_COMPLIANCE_RULES, complianceRuleSeedId } from './complianceRuleSeeds';

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

  // The seeds exist in SQL and in TypeScript, because they have two jobs: the
  // migration reaches organizations that already exist, and createOrganization
  // reaches one being created now. Neither can do the other's job, so the
  // duplication stays -- and this is what stops it drifting. A rule added,
  // renamed, or re-graded in one place and not the other fails here rather than
  // leaving one set of gyms monitoring something the other set does not.
  describe('the TypeScript seeds match the migration', () => {
    test('same five rules, same order', () => {
      expect(DEFAULT_COMPLIANCE_RULES.map((rule) => rule.name)).toEqual(DEFAULT_RULE_NAMES);
    });

    test('every field of every rule matches the SQL', () => {
      for (const rule of DEFAULT_COMPLIANCE_RULES) {
        // The migration builds each row as a single `select` of literals, so the
        // whole tuple can be matched at once -- catching a severity or escalation
        // level that changed on one side without touching the rule name.
        const tuple = new RegExp(
          [
            `'${rule.idPrefix}'\\s*\\|\\|\\s*organization_id\\s*\\|\\|\\s*'${rule.idSuffix}'`,
            'organization_id',
            `'${rule.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`,
            `'${rule.category}'`,
            `'${rule.description}'`,
            `'${rule.detectionLogic}'`,
            `'${rule.severity}'`,
            `'${rule.escalationLevel}'`,
          ].join(',\\s*'),
          'i',
        );
        expect(statements).toMatch(tuple);
      }
    });

    test('both paths build the same deterministic rule id', () => {
      // Same gym, either path, same row -- not a duplicate.
      expect(complianceRuleSeedId(DEFAULT_COMPLIANCE_RULES[0], 'ppbf-default-org'))
        .toBe('rule_safety_ppbf-default-org_physical_injury');
    });
  });
});
