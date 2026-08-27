import fs from 'node:fs';
import path from 'node:path';

import { ANNOUNCEMENT_PLACEMENTS } from './announcements';

const repositoryRoot = path.resolve(__dirname, '../../../../..');

const migrationPath = path.join(
  repositoryRoot,
  'infra/azure/pilot_slice_postgres_parent_hub_placement_migration.sql',
);
const runnerPath = path.join(
  repositoryRoot,
  'apps/web/scripts/pilot-apply-parent-hub-placement-migration.mjs',
);
const workflowPath = path.join(
  repositoryRoot,
  '.github/workflows/apply-migrations.yml',
);
const packageJsonPath = path.join(repositoryRoot, 'apps/web/package.json');

describe('parent hub placement schema ownership', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const runner = fs.readFileSync(runnerPath, 'utf8');
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  test('the constraint is replaced under its original name, DROP IF EXISTS first', () => {
    // Re-creating under the SAME name is what keeps the original placements
    // migration a no-op on replay: its ADD is catalog-guarded by conname, so a
    // different name here would let every `all` dispatch downgrade the
    // vocabulary back to four values.
    expect(migration).toMatch(
      /drop constraint if exists pilot_announcements_placement_check/i,
    );
    expect(migration).toMatch(
      /add constraint pilot_announcements_placement_check/i,
    );
  });

  test('the widened vocabulary is exactly the server vocabulary', () => {
    // One closed set, three declarations: the server module, the client
    // module (announcementBanner.test.tsx pins those two together), and this
    // check clause. This assertion ties the SQL to the server module so a
    // value added to one cannot silently miss the other.
    const expectedClause = ANNOUNCEMENT_PLACEMENTS.map((p) => `'${p}'`).join(', ');
    expect(migration).toContain(`check (placement in (${expectedClause}))`);
    expect(ANNOUNCEMENT_PLACEMENTS).toContain('parent_hub');
  });

  // The two runner families take OPPOSITE conventions: a file that carries its
  // own boundaries breaks the runners that open the transaction themselves.
  test('the migration carries no transaction boundary, because this runner opens one', () => {
    expect(migration).not.toMatch(/^\s*begin\s*;/im);
    expect(migration).not.toMatch(/^\s*commit\s*;/im);
    expect(runner).toContain("client.query('BEGIN')");
    expect(runner).toContain("client.query('COMMIT')");
    expect(runner).toContain("client.query('ROLLBACK')");
  });

  test('the runner reads this migration and verifies readiness before committing', () => {
    expect(runner).toContain('pilot_slice_postgres_parent_hub_placement_migration.sql');
    expect(runner).toContain('PARENT_HUB_PLACEMENT_NOT_READY');
    expect(runner).toContain('pilot_announcements_placement_check');
    expect(runner).toContain('parent_hub');
    expect(runner).toContain('POSTGRES_TARGET_MISMATCH');
    expect(runner).toContain('rejectUnauthorized: true');
  });

  // A migration nobody can dispatch is not in the migration path. Registration
  // takes three separate edits to one workflow, and the `all` list and the
  // list-check allowlist are both hand-maintained.
  test('the migration is dispatchable and covered by every hand-maintained list', () => {
    expect(packageJson.scripts['pilot:apply-parent-hub-placement']).toBe(
      'node scripts/pilot-apply-parent-hub-placement-migration.mjs',
    );
    // `test:migrations` no longer names suites: it delegates to
    // scripts/run-migration-suites.mjs, which discovers every
    // `test:migrations:*` script. So the thing to assert is that the SCRIPT
    // exists -- under discovery, existing IS being run, and there is no
    // longer a list it can be absent from.
    expect(packageJson.scripts['test:migrations:parent-hub-placement']).toBeDefined();
    expect(packageJson.scripts['test:migrations']).toBe('node scripts/run-migration-suites.mjs');
    expect(packageJson.scripts['test:migrations:parent-hub-placement']).toContain(
      'src/server/pilot/announcementParentHubPlacement.pg.test.ts',
    );

    expect(workflow).toMatch(/^\s+- parent-hub-placement$/m);

    const allList = workflow.match(/for m in ([a-z0-9 -]+); do/)?.[1].split(' ');
    expect(allList).toContain('parent-hub-placement');

    const listCheck = workflow.match(/case " ([a-z0-9 -]+) " in/)?.[1].split(' ');
    expect(listCheck).toContain('parent-hub-placement');

    // This file only replaces a constraint the placements migration creates,
    // so that migration has to run first.
    expect(allList!.indexOf('announcement-placements')).toBeLessThan(
      allList!.indexOf('parent-hub-placement'),
    );
  });
});
