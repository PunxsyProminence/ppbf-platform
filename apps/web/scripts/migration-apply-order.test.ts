// The apply order the pre-deploy schema gate reads, and the ways it must
// refuse rather than shrink.
//
// pilot-verify-schema.mjs derives the schema this commit expects by walking the
// migration SQL and accumulating the objects each file adds, minus the ones a
// later file drops. That subtraction only means anything if the files are
// walked in the order they RUN. They used to be walked in filename order, and
// on 2026-08-28 that produced a false failure on a correctly migrated database:
//
//   pilot_slice_postgres_drill_library_check_drop_migration.sql   <- the DROP
//   pilot_slice_postgres_drill_library_v3_migration.sql           <- the ADD
//
// sort with the drop first, so the drop was read as a no-op and the constraint
// it removes was expected to exist. The gate runs before a deploy, so a false
// failure there blocks releases.
//
// The half that matters more is the other one. If the workflow parse ever came
// back empty or partial, the expected set would shrink or empty and the gate
// would PASS EVERYTHING while reporting green -- a pre-deploy check that has
// stopped checking and does not say so. Every case below that ends in a throw
// is that failure being refused out loud.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const scriptsDir = __dirname;
const repositoryRoot = path.resolve(__dirname, '../../..');
const infraDir = path.join(repositoryRoot, 'infra/azure');

const orderModuleUrl = pathToFileURL(path.join(scriptsDir, 'migration-apply-order.mjs')).href;
const verifyModuleUrl = pathToFileURL(path.join(scriptsDir, 'pilot-verify-schema.mjs')).href;

// Both modules are real ESM consumed by workflow steps, and the default jest
// runner has no ESM loader (`npm test` does not pass --experimental-vm-modules).
// As in check-migration-declaration.test.ts, every expression is evaluated in
// one real `node` child process. Importing the verifier runs its main() unless
// PPBF_SCHEMA_VERIFY_SKIP_MAIN is set, so it is set for every child.
function run(body: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const script = `
    import { migrationApplyOrder, parseAllList, slugFor, SLUG_OVERRIDES }
      from ${JSON.stringify(orderModuleUrl)};
    import { expectedObjectsFrom } from ${JSON.stringify(verifyModuleUrl)};
    void migrationApplyOrder; void parseAllList; void slugFor; void SLUG_OVERRIDES;
    void expectedObjectsFrom;
    try {
      const value = await (async () => { ${body} })();
      process.stdout.write(JSON.stringify({ ok: true, value: value ?? null }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PPBF_SCHEMA_VERIFY_SKIP_MAIN: 'true' },
  }));
}

/** The value, or a failure that names the thrown message rather than `undefined`. */
function value(body: string): unknown {
  const result = run(body);
  if (!result.ok) throw new Error(`Expected a value, got a throw: ${result.message}`);
  return result.value;
}

/** The thrown message, or a failure saying nothing was thrown. */
function thrownMessage(body: string): string {
  const result = run(body);
  if (result.ok) {
    throw new Error(`Expected a throw, got a value: ${JSON.stringify(result.value)}`);
  }
  return result.message;
}

/**
 * A disposable infra directory plus a workflow carrying one `all` list.
 *
 * `files` maps filename -> SQL body. `allList` is written into the same
 * `for m in ...; do` shape the real workflow uses, so the real parser is under
 * test rather than a stand-in for it.
 */
function fixture(
  files: Record<string, string>,
  allList: string | null,
): { infraDir: string; workflowPath: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-apply-order-'));
  const fixtureInfra = path.join(root, 'infra/azure');
  fs.mkdirSync(fixtureInfra, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(fixtureInfra, name), body);
  }

  const workflowPath = path.join(root, 'apply-migrations.yml');
  fs.writeFileSync(
    workflowPath,
    allList === null
      ? '            all)\n              # the list has gone\n              :\n'
      : `            all)\n              for m in ${allList}; do\n                run_one "$m"\n              done\n`,
  );

  return {
    infraDir: fixtureInfra,
    workflowPath,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const BASE = 'create table pilot.thing (id int);';
const ADD = 'alter table pilot.thing add constraint thing_check check (id > 0);';
const DROP = 'alter table pilot.thing drop constraint thing_check;';

/** The constraint names expected from a fixture, walked in apply order. */
function constraintsFor(fx: { infraDir: string; workflowPath: string }): string[] {
  return value(`
    const files = migrationApplyOrder(${JSON.stringify({
    infraDir: fx.infraDir,
    workflowPath: fx.workflowPath,
  })});
    return [...expectedObjectsFrom(files).constraints];
  `) as string[];
}

describe('the order is read from the workflow, not from filenames', () => {
  test('a constraint dropped by a LATER migration whose filename sorts EARLIER is not expected', () => {
    // The drill-library shape exactly: the drop's filename sorts first, the add
    // runs first. A filename walk reads the drop as a no-op and expects the
    // constraint; the apply order reads add-then-drop and does not.
    const fx = fixture(
      {
        'pilot_slice_postgres.sql': BASE,
        'pilot_slice_postgres_aaa_drop_migration.sql': DROP,
        'pilot_slice_postgres_zzz_add_migration.sql': ADD,
      },
      'zzz-add aaa-drop',
    );
    try {
      expect(constraintsFor(fx)).not.toContain('thing_check');
    } finally {
      fx.cleanup();
    }
  });

  test('a constraint dropped and then re-added by a still-later migration IS expected', () => {
    // The mirror case, and the one that proves the order is being read rather
    // than the drop simply being trusted: by filename the re-add sorts FIRST
    // and the drop LAST, so a filename walk ends with the constraint absent.
    // In apply order it is added, dropped, and added back.
    const fx = fixture(
      {
        'pilot_slice_postgres.sql': BASE,
        'pilot_slice_postgres_aaa_readd_migration.sql': ADD,
        'pilot_slice_postgres_mmm_add_migration.sql': ADD,
        'pilot_slice_postgres_zzz_drop_migration.sql': DROP,
      },
      'mmm-add zzz-drop aaa-readd',
    );
    try {
      expect(constraintsFor(fx)).toContain('thing_check');
    } finally {
      fx.cleanup();
    }
  });

  test('the base schema is applied first and the `all` list follows it in order', () => {
    const names = (value(`
      return migrationApplyOrder().map((f) => f.split(/[\\\\/]/).pop());
    `) as string[]);

    expect(names[0]).toBe('pilot_slice_postgres.sql');
    // drill-library-check-drop is last in `all`; drill-library-v3 is mid-list.
    // Their filenames sort the other way round, which is the whole bug.
    const drop = names.indexOf('pilot_slice_postgres_drill_library_check_drop_migration.sql');
    const v3 = names.indexOf('pilot_slice_postgres_drill_library_v3_migration.sql');
    expect(drop).toBeGreaterThan(v3);
    expect([...names].sort().indexOf('pilot_slice_postgres_drill_library_check_drop_migration.sql'))
      .toBeLessThan([...names].sort().indexOf('pilot_slice_postgres_drill_library_v3_migration.sql'));
  });

  test('every migration SQL file on disk is in the order exactly once', () => {
    // The gate's expectations are built from this list. A file missing from it
    // is a set of objects the gate stops asking about.
    const onDisk = fs.readdirSync(infraDir).filter((n) => /^pilot_slice_postgres.*\.sql$/.test(n));
    const names = value(`
      return migrationApplyOrder().map((f) => f.split(/[\\\\/]/).pop());
    `) as string[];

    expect(names.length).toBe(onDisk.length);
    expect([...names].sort()).toEqual([...onDisk].sort());
  });

  test('the real tree no longer expects the constraint drill-library-check-drop removes', () => {
    // The exact false failure. pilot_drill_library_discipline_check is created
    // by drill-library-v3 and dropped by drill-library-check-drop, which runs
    // last; a correctly migrated database does not have it.
    const constraints = value(`
      return [...expectedObjectsFrom(migrationApplyOrder()).constraints];
    `) as string[];

    expect(constraints).not.toContain('pilot_drill_library_discipline_check');
    // The authority the drop hands the column over to is still expected, so
    // this is not the gate simply forgetting about the column.
    expect(constraints).toContain('pilot_drill_library_discipline_fk');
    // And the pre-existing supersession behaviour is unchanged.
    expect(constraints).not.toContain('pilot_film_study_proposals_correction_check');
    expect(constraints).toContain('pilot_film_study_proposals_correction_check_v2');
  });
});

describe('a parse it cannot trust is refused, never degraded', () => {
  test('no `all` list at all throws instead of returning nothing', () => {
    const fx = fixture({ 'pilot_slice_postgres.sql': BASE }, null);
    try {
      expect(thrownMessage(`
        return migrationApplyOrder(${JSON.stringify({
        infraDir: fx.infraDir,
        workflowPath: fx.workflowPath,
      })});
      `)).toMatch(/could not find the `all` list/);
    } finally {
      fx.cleanup();
    }
  });

  test('an empty `all` list throws instead of yielding an empty expected schema', () => {
    // parseAllList is exercised directly here: a `for m in ; do` line does not
    // match the workflow regex at all, so the empty-list branch is only
    // reachable by handing the parser text whose capture is blank.
    expect(thrownMessage('return parseAllList("for m in  ; do");'))
      .toMatch(/could not find the `all` list|parsed as empty/);
    expect(thrownMessage('return parseAllList("");'))
      .toMatch(/could not find the `all` list/);
  });

  test('more than one `all` list throws instead of silently taking the first', () => {
    // The failure this reproduces actually happened. Three pull requests each
    // appended to the `all` line and git merged them as adjacent insertions
    // with no conflict, so the workflow carried three lists holding different
    // subsets of the migrations. The parser took the first, and everything
    // downstream -- including the pre-deploy schema expectation -- was built
    // from a list missing four migrations, while still reporting green.
    expect(thrownMessage(
      'return parseAllList("for m in alpha beta; do\\nfor m in alpha gamma; do");',
    )).toMatch(/found 2 `all` lists|expected exactly one/);
  });

  test('a name in `all` with no SQL file throws', () => {
    const fx = fixture(
      {
        'pilot_slice_postgres.sql': BASE,
        'pilot_slice_postgres_zzz_add_migration.sql': ADD,
      },
      'zzz-add ghost-migration',
    );
    try {
      const message = thrownMessage(`
        return migrationApplyOrder(${JSON.stringify({
        infraDir: fx.infraDir,
        workflowPath: fx.workflowPath,
      })});
      `);
      expect(message).toMatch(/no SQL file/);
      expect(message).toContain('ghost-migration');
    } finally {
      fx.cleanup();
    }
  });

  test('a SQL file on disk that `all` does not name throws rather than being skipped', () => {
    // Skipping it is the quiet version of the failure: every object that file
    // creates leaves the expected set and the gate reports green against a
    // database that never ran it. migrationDispatchCoverage.test.ts already
    // forbids this state; this is the gate refusing to run inside it anyway.
    const fx = fixture(
      {
        'pilot_slice_postgres.sql': BASE,
        'pilot_slice_postgres_zzz_add_migration.sql': ADD,
        'pilot_slice_postgres_orphan_migration.sql': ADD,
      },
      'zzz-add',
    );
    try {
      const message = thrownMessage(`
        return migrationApplyOrder(${JSON.stringify({
        infraDir: fx.infraDir,
        workflowPath: fx.workflowPath,
      })});
      `);
      expect(message).toMatch(/not named in the `all` list/);
      expect(message).toContain('pilot_slice_postgres_orphan_migration.sql');
    } finally {
      fx.cleanup();
    }
  });

  test('a pilot_slice_postgres*.sql file that is neither base nor increment throws', () => {
    // The filename walk this replaced would have read it. Dropping it silently
    // would shrink the expected set with nothing to say so.
    const fx = fixture(
      {
        'pilot_slice_postgres.sql': BASE,
        'pilot_slice_postgres_zzz_add_migration.sql': ADD,
        'pilot_slice_postgres_scratch.sql': ADD,
      },
      'zzz-add',
    );
    try {
      const message = thrownMessage(`
        return migrationApplyOrder(${JSON.stringify({
        infraDir: fx.infraDir,
        workflowPath: fx.workflowPath,
      })});
      `);
      expect(message).toMatch(/neither the base schema nor a \*_migration\.sql/);
      expect(message).toContain('pilot_slice_postgres_scratch.sql');
    } finally {
      fx.cleanup();
    }
  });

  test('a missing base schema throws', () => {
    const fx = fixture({ 'pilot_slice_postgres_zzz_add_migration.sql': ADD }, 'zzz-add');
    try {
      expect(thrownMessage(`
        return migrationApplyOrder(${JSON.stringify({
        infraDir: fx.infraDir,
        workflowPath: fx.workflowPath,
      })});
      `)).toMatch(/base schema pilot_slice_postgres\.sql is missing/);
    } finally {
      fx.cleanup();
    }
  });

  test('an unreadable workflow file throws', () => {
    expect(thrownMessage(`
      return migrationApplyOrder({ workflowPath: ${JSON.stringify(
    path.join(os.tmpdir(), 'ppbf-no-such-workflow.yml'),
  )} });
    `)).toMatch(/cannot read/);
  });

  test('an unreadable migration directory throws', () => {
    expect(thrownMessage(`
      return migrationApplyOrder({ infraDir: ${JSON.stringify(
    path.join(os.tmpdir(), 'ppbf-no-such-infra'),
  )} });
    `)).toMatch(/cannot read the migration directory/);
  });
});

describe('the slug map has one copy', () => {
  test('the two filenames that do not derive mechanically are still mapped', () => {
    expect(value('return slugFor("pilot_slice_postgres_scheduler_registration_race_migration.sql");'))
      .toBe('scheduler-race');
    expect(value('return slugFor("pilot_slice_postgres_sparring_exposure_and_load_migration.sql");'))
      .toBe('sparring-exposure');
    expect(value('return slugFor("pilot_slice_postgres_drill_library_check_drop_migration.sql");'))
      .toBe('drill-library-check-drop');
  });

  test('migrationDispatchCoverage.test.ts holds no second copy of the override table', () => {
    // Two copies of this table is the divergence that produces a confidently
    // wrong mapping in one consumer and not the other.
    const coverage = fs.readFileSync(
      path.join(repositoryRoot, 'apps/web/src/server/pilot/migrationDispatchCoverage.test.ts'),
      'utf8',
    );
    expect(coverage).toContain('migration-apply-order.mjs');
    expect(coverage).not.toContain('scheduler-race');
    expect(coverage).not.toContain('sparring-exposure');
  });
});
