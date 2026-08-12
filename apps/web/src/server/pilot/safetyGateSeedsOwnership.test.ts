import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_SAFETY_GATES, safetyGateSeedId } from './safetyGateSeeds';

const repositoryRoot = path.resolve(__dirname, '../../../../..');

const migrationPath = path.join(
  repositoryRoot,
  'infra/azure/pilot_slice_postgres_safety_gate_matrix_migration.sql',
);
const runnerPath = path.join(
  repositoryRoot,
  'apps/web/scripts/pilot-apply-safety-gate-matrix-migration.mjs',
);
const workflowPath = path.join(repositoryRoot, '.github/workflows/apply-migrations.yml');
const packageJsonPath = path.join(repositoryRoot, 'apps/web/package.json');

const DEFAULT_GATE_KEYS = ['contact_medical_clearance', 'training_hold'];

/** Migration text with `--` comment lines dropped, so counts see SQL only. */
function statementsOnly(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

describe('safety gate seeds ownership', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const statements = statementsOnly(migration);
  const runner = fs.readFileSync(runnerPath, 'utf8');
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  test('every default gate is seeded', () => {
    for (const gateKey of DEFAULT_GATE_KEYS) {
      expect(statements).toContain(`'${gateKey}'`);
    }
    expect(statements.match(/insert into pilot\.safety_gates/gi)).toHaveLength(DEFAULT_GATE_KEYS.length);
  });

  // The three guards that make a re-run safe. Losing any one is invisible until
  // the workflow next runs `all` against production: without the
  // organization_id-not-in check a deactivated gate is switched back on; without
  // ON CONFLICT a renamed gate raises a duplicate-key error that aborts the whole
  // migration; and without the reserved-organization exclusion the runner's
  // readiness query -- which asserts that EVERY organization holds the
  // contact_medical_clearance gate -- reports NOT READY forever, because the
  // platform evidence baseline is a shelf with no athletes to clear.
  test('the seed carries all three idempotence guards', () => {
    expect(statements).toMatch(/and organization_id not in\s*\(\s*select organization_id from pilot\.safety_gates where gate_key = /i);
    expect(statements.match(/on conflict do nothing/gi)?.length ?? 0).toBeGreaterThanOrEqual(DEFAULT_GATE_KEYS.length);
    expect(statements.match(/where organization_id <> '__platform__'/gi))
      .toHaveLength(DEFAULT_GATE_KEYS.length);
  });

  // The exclusion is only load-bearing if the runner agrees with it. These are
  // separate files with no shared constant, so the readiness query can silently
  // start demanding what the seeds deliberately skip.
  test('the runner does not assert the reserved organization was gated', () => {
    expect(runner).toContain("o.organization_id <> '__platform__'");
  });

  test('the migration carries no transaction boundary, because this runner opens one', () => {
    expect(statements).not.toMatch(/^\s*begin\s*;/im);
    expect(statements).not.toMatch(/^\s*commit\s*;/im);
    expect(runner).toContain("client.query('BEGIN')");
    expect(runner).toContain("client.query('COMMIT')");
    expect(runner).toContain("client.query('ROLLBACK')");
  });

  test('the runner reads this migration and verifies readiness before committing', () => {
    expect(runner).toContain('pilot_slice_postgres_safety_gate_matrix_migration.sql');
    expect(runner).toContain('SAFETY_GATE_MATRIX_NOT_READY');
    expect(runner).toContain('POSTGRES_TARGET_MISMATCH');
    expect(runner).toContain('rejectUnauthorized: true');
  });

  test('the migration is dispatchable and covered by every hand-maintained list', () => {
    expect(packageJson.scripts['pilot:apply-safety-gate-matrix']).toBe(
      'node scripts/pilot-apply-safety-gate-matrix-migration.mjs',
    );
    expect(packageJson.scripts['test:migrations']).toContain('npm run test:migrations:safety-gate-matrix');

    expect(workflow).toMatch(/^\s+- safety-gate-matrix$/m);

    const allList = workflow.match(/for m in ([a-z0-9 -]+); do/);
    expect(allList?.[1]).toContain('safety-gate-matrix');

    const listCheck = workflow.match(/case " ([a-z0-9 -]+) " in/);
    expect(listCheck?.[1]).toContain('safety-gate-matrix');
  });

  // Same reason as complianceRuleSeedsOwnership: the seed exists in SQL and
  // in TypeScript because it has two jobs -- the migration reaches
  // organizations that already exist, createOrganization reaches one being
  // created now -- and neither can do the other's job. A gate added,
  // renamed, or re-enforced in one place and not the other fails here
  // rather than leaving one set of gyms flagging contact the other set does
  // not.
  describe('the TypeScript seeds match the migration', () => {
    test('same gates, same order', () => {
      expect(DEFAULT_SAFETY_GATES.map((gate) => gate.gateKey)).toEqual(DEFAULT_GATE_KEYS);
    });

    test('every field of the default gate matches the SQL', () => {
      for (const gate of DEFAULT_SAFETY_GATES) {
        const tuple = new RegExp(
          [
            'organization_id',
            `'gate_'\\s*\\|\\|\\s*organization_id\\s*\\|\\|\\s*'_${gate.gateKey}'`,
            `'${gate.gateKey}'`,
            `'${gate.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`,
            `'${gate.category}'`,
            `'${gate.enforcement}'`,
          ].join(',\\s*'),
          'i',
        );
        expect(statements).toMatch(tuple);
        // The requirement_text is long and contains a doubled single-quote
        // (the SQL-escaped apostrophe in "'cleared'"), so it is checked
        // separately rather than folded into the tuple regex above.
        expect(statements).toContain(gate.requirementText.replace(/'/g, "''"));
      }
    });

    test('both paths build the same deterministic gate id', () => {
      expect(safetyGateSeedId(DEFAULT_SAFETY_GATES[0], 'ppbf-default-org'))
        .toBe('gate_ppbf-default-org_contact_medical_clearance');
    });
  });
});
