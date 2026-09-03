import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_CLEARANCE_TYPES, clearanceTypeSeedId } from './clearanceTypeSeeds';

const repositoryRoot = path.resolve(__dirname, '../../../../..');

const migrationPath = path.join(
  repositoryRoot,
  'infra/azure/pilot_slice_postgres_clearance_type_seeds_migration.sql',
);
const runnerPath = path.join(
  repositoryRoot,
  'apps/web/scripts/pilot-apply-clearance-type-seeds-migration.mjs',
);
const workflowPath = path.join(repositoryRoot, '.github/workflows/apply-migrations.yml');
const packageJsonPath = path.join(repositoryRoot, 'apps/web/package.json');

const DEFAULT_TYPE_NAMES = [
  'SafeSport Training',
  'USA Boxing Coach Certification',
  'Background Check',
  'CPR/First Aid',
];

/** Migration text with `--` comment lines dropped, so counts see SQL only. */
function statementsOnly(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

describe('clearance type seeds ownership', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const statements = statementsOnly(migration);
  const runner = fs.readFileSync(runnerPath, 'utf8');
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  test('all four platform defaults are seeded', () => {
    for (const name of DEFAULT_TYPE_NAMES) {
      expect(statements).toContain(`'${name}'`);
    }
    expect(statements.match(/insert into pilot\.clearance_types/gi)).toHaveLength(
      DEFAULT_TYPE_NAMES.length,
    );
  });

  // The three guards that make a re-run safe. Losing any one is invisible until
  // the workflow next runs `all` against production: without the name check an
  // archived or edited type is switched back to its default; without ON CONFLICT
  // a renamed type raises a duplicate-key error that aborts the whole migration;
  // and without the reserved-organization exclusion the runner's readiness query
  // -- which asserts that EVERY organization holds all four defaults -- reports
  // NOT READY forever, because the platform evidence baseline is a shelf with no
  // staff to credential.
  test('each seed carries all three idempotence guards', () => {
    expect(
      statements.match(
        /and organization_id not in \(select organization_id from pilot\.clearance_types where name = /gi,
      ),
    ).toHaveLength(DEFAULT_TYPE_NAMES.length);
    expect(statements.match(/on conflict do nothing/gi)).toHaveLength(DEFAULT_TYPE_NAMES.length);
    expect(statements.match(/where organization_id <> '__platform__'/gi))
      .toHaveLength(DEFAULT_TYPE_NAMES.length);
  });

  // The exclusion is only load-bearing if the runner agrees with it. These are
  // separate files with no shared constant, so the readiness query can silently
  // start demanding what the seeds deliberately skip.
  test('the runner does not assert the reserved organization was seeded', () => {
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
    expect(runner).toContain('pilot_slice_postgres_clearance_type_seeds_migration.sql');
    expect(runner).toContain('CLEARANCE_TYPE_SEEDS_NOT_READY');
    expect(runner).toContain('rejectUnauthorized: true');
  });

  test('the migration is dispatchable and covered by every hand-maintained list', () => {
    expect(packageJson.scripts['pilot:apply-clearance-type-seeds']).toBe(
      'node scripts/pilot-apply-clearance-type-seeds-migration.mjs',
    );
    // `test:migrations` no longer names suites: it delegates to
    // scripts/run-migration-suites.mjs, which discovers every
    // `test:migrations:*` script. So the thing to assert is that the SCRIPT
    // exists -- under discovery, existing IS being run, and there is no
    // longer a list it can be absent from.
    expect(packageJson.scripts['test:migrations:clearance-type-seeds']).toBeDefined();
    expect(packageJson.scripts['test:migrations']).toBe('node scripts/run-migration-suites.mjs');

    expect(workflow).toMatch(/^\s+- clearance-type-seeds$/m);

    const allList = workflow.match(/for m in ([a-z0-9 -]+); do/);
    expect(allList?.[1]).toContain('clearance-type-seeds');

    const listCheck = workflow.match(/case " ([a-z0-9 -]+) " in/);
    expect(listCheck?.[1]).toContain('clearance-type-seeds');
  });

  // pilot.clearance_types is created by the clearance-register migration, so
  // the seeds must run after it in the only list that fixes an order.
  test('the `all` list orders the seeds after the clearance register migration', () => {
    const allList = workflow.match(/for m in ([a-z0-9 -]+); do/)?.[1].split(' ') ?? [];
    expect(allList.indexOf('clearance-type-seeds')).toBeGreaterThan(allList.indexOf('clearance-register'));
  });

  // Same reason as complianceRuleSeedsOwnership/safetyGateSeedsOwnership: the
  // seed exists in SQL and in TypeScript because it has two jobs -- the
  // migration reaches organizations that already exist, createOrganization
  // reaches one being created now -- and neither can do the other's job. A
  // type added, renamed, or re-scoped in one place and not the other fails
  // here rather than leaving one set of gyms with a staff-credentials
  // register the other set does not have.
  describe('the TypeScript seeds match the migration', () => {
    test('same four types, same order', () => {
      expect(DEFAULT_CLEARANCE_TYPES.map((type) => type.name)).toEqual(DEFAULT_TYPE_NAMES);
    });

    test('every field of every type matches the SQL', () => {
      for (const type of DEFAULT_CLEARANCE_TYPES) {
        // The migration builds each row as a single `select` of literals, so the
        // whole tuple can be matched at once -- catching a validity/grace period
        // that changed on one side without touching the type name.
        const tuple = new RegExp(
          [
            'organization_id',
            `'${type.idPrefix}'\\s*\\|\\|\\s*organization_id`,
            `'${type.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`,
            `'${type.issuingAuthority.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`,
            `'${type.authorityKind}'`,
            `${type.validityMonths}`,
            `${type.renewalGraceDays}`,
          ].join(',\\s*'),
          'i',
        );
        expect(statements).toMatch(tuple);
      }
    });

    test('both paths build the same deterministic clearance-type id', () => {
      expect(clearanceTypeSeedId(DEFAULT_CLEARANCE_TYPES[0], 'ppbf-default-org'))
        .toBe('ct_safesport_ppbf-default-org');
    });
  });
});
