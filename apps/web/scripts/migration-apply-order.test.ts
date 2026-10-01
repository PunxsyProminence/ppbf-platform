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

import { execFileSync, spawnSync } from 'node:child_process';
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
    import { migrationApplyOrder, migrationApplySlugs, parseAllList, slugFor, SLUG_OVERRIDES }
      from ${JSON.stringify(orderModuleUrl)};
    import { expectedObjectsFrom } from ${JSON.stringify(verifyModuleUrl)};
    void migrationApplyOrder; void migrationApplySlugs; void parseAllList; void slugFor;
    void SLUG_OVERRIDES;
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

// A release applies the routine migrations by slug, and it must apply the set
// the schema gate verifies against, in that order. migrationApplySlugs() is the
// same validated read as migrationApplyOrder(), so the cases below are the
// refusals above seen through the interface a workflow consumes -- plus the one
// property only a command line has: what a caller capturing stdout is left
// holding when the read refuses.
describe('the slugs a release applies come through the same read', () => {
  const THREE = {
    'pilot_slice_postgres.sql': BASE,
    'pilot_slice_postgres_aaa_first_migration.sql': ADD,
    'pilot_slice_postgres_mmm_second_migration.sql': ADD,
    'pilot_slice_postgres_zzz_third_migration.sql': ADD,
  };

  function slugsFor(fx: { infraDir: string; workflowPath: string }): string {
    return `return migrationApplySlugs(${JSON.stringify({
      infraDir: fx.infraDir,
      workflowPath: fx.workflowPath,
    })});`;
  }

  test('the slugs are the `all` list in its own order, and a reordered list reorders them', () => {
    const forward = fixture(THREE, 'aaa-first mmm-second zzz-third');
    const reordered = fixture(THREE, 'zzz-third aaa-first mmm-second');
    try {
      expect(value(slugsFor(forward))).toEqual(['aaa-first', 'mmm-second', 'zzz-third']);
      // Same files on disk; only the list moved. An interface that sorted, or
      // walked the directory, would return the first answer twice.
      expect(value(slugsFor(reordered))).toEqual(['zzz-third', 'aaa-first', 'mmm-second']);
    } finally {
      forward.cleanup();
      reordered.cleanup();
    }
  });

  test('on the real tree they are the files of migrationApplyOrder(), slug for slug', () => {
    // Not a second parse of the workflow: the file order is mapped back through
    // slugFor, so this fails if the two exports ever stop being one read.
    const { slugs, fromFiles } = value(`
      const fromFiles = migrationApplyOrder().slice(1).map((f) => slugFor(f.split(/[\\\\/]/).pop()));
      return { slugs: migrationApplySlugs(), fromFiles };
    `) as { slugs: string[]; fromFiles: string[] };

    expect(slugs.length).toBeGreaterThan(20);
    expect(slugs).toEqual(fromFiles);
  });

  test('a SQL migration omitted from `all` refuses instead of returning the rest', () => {
    const fx = fixture(THREE, 'aaa-first zzz-third');
    try {
      const message = thrownMessage(slugsFor(fx));
      expect(message).toMatch(/not named in the `all` list/);
      expect(message).toContain('pilot_slice_postgres_mmm_second_migration.sql');
    } finally {
      fx.cleanup();
    }
  });

  test('a slug with no SQL file refuses', () => {
    const fx = fixture(THREE, 'aaa-first mmm-second zzz-third ghost-migration');
    try {
      expect(thrownMessage(slugsFor(fx))).toMatch(/no SQL file/);
    } finally {
      fx.cleanup();
    }
  });

  test('a missing `all` declaration refuses', () => {
    const fx = fixture(THREE, null);
    try {
      expect(thrownMessage(slugsFor(fx))).toMatch(/could not find the `all` list/);
    } finally {
      fx.cleanup();
    }
  });

  test.each([
    'for m in aaa-first MMM-second zzz-third; do',
    'for m in aaa-first "mmm-second" zzz-third; do',
    'for m in aaa-first mmm-second zzz-third',
  ])('a malformed `all` declaration refuses: %s', (line) => {
    // An uppercase slug, a stray quote, a missing `; do`: none of them match
    // the one shape the reader accepts, and none may be read as a shorter list.
    const fx = fixture(THREE, 'aaa-first mmm-second zzz-third');
    try {
      fs.writeFileSync(fx.workflowPath, `            all)\n              ${line}\n`);
      expect(thrownMessage(slugsFor(fx))).toMatch(/could not find the `all` list/);
    } finally {
      fx.cleanup();
    }
  });

  test('two `all` declarations refuse, even when each is complete on its own', () => {
    const fx = fixture(THREE, 'aaa-first mmm-second zzz-third');
    try {
      fs.appendFileSync(
        fx.workflowPath,
        '              for m in aaa-first mmm-second zzz-third; do\n                run_one "$m"\n              done\n',
      );
      expect(thrownMessage(slugsFor(fx))).toMatch(/found 2 `all` lists/);
    } finally {
      fx.cleanup();
    }
  });
});

describe('the --slugs command line never hands over part of a list', () => {
  // The module resolves the workflow and infra/azure relative to ITSELF, so a
  // copy placed at the same depth in a disposable tree runs the real command
  // line against a fixture, with no path option that exists only for tests.
  function tree(allLines: string[]): { script: string; cleanup: () => void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-apply-order-cli-'));
    const scripts = path.join(root, 'apps/web/scripts');
    const infra = path.join(root, 'infra/azure');
    const workflows = path.join(root, '.github/workflows');
    for (const dir of [scripts, infra, workflows]) fs.mkdirSync(dir, { recursive: true });

    fs.copyFileSync(
      path.join(scriptsDir, 'migration-apply-order.mjs'),
      path.join(scripts, 'migration-apply-order.mjs'),
    );
    fs.writeFileSync(path.join(infra, 'pilot_slice_postgres.sql'), BASE);
    fs.writeFileSync(path.join(infra, 'pilot_slice_postgres_aaa_first_migration.sql'), ADD);
    fs.writeFileSync(path.join(infra, 'pilot_slice_postgres_zzz_second_migration.sql'), ADD);
    fs.writeFileSync(path.join(workflows, 'apply-migrations.yml'), `${allLines.join('\n')}\n`);

    return {
      script: path.join(scripts, 'migration-apply-order.mjs'),
      cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  }

  function cli(script: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  test('a good tree prints every slug, one per line, in order', () => {
    const fx = tree(['for m in zzz-second aaa-first; do']);
    try {
      expect(cli(fx.script, ['--slugs'])).toEqual({
        status: 0,
        stdout: 'zzz-second\naaa-first\n',
        stderr: '',
      });
    } finally {
      fx.cleanup();
    }
  });

  test.each<[string, string[], RegExp]>([
    ['a SQL migration omitted from `all`', ['for m in aaa-first; do'], /not named in the `all` list/],
    ['a slug with no SQL file', ['for m in aaa-first zzz-second ghost; do'], /no SQL file/],
    ['no `all` declaration', ['# the list has gone'], /could not find the `all` list/],
    [
      'two `all` declarations',
      ['for m in aaa-first zzz-second; do', 'for m in aaa-first zzz-second; do'],
      /found 2 `all` lists/,
    ],
  ])('%s exits non-zero with EMPTY stdout', (_label, allLines, reason) => {
    const fx = tree(allLines);
    try {
      const result = cli(fx.script, ['--slugs']);
      // Empty, not "shorter": a shell capturing this with $(...) must be left
      // with nothing to loop over, and a status that stops it first.
      expect({ status: result.status, stdout: result.stdout }).toEqual({ status: 1, stdout: '' });
      expect(result.stderr).toMatch(reason);
    } finally {
      fx.cleanup();
    }
  });

  test.each<[string[]]>([[[]], [['--files']], [['--slugs', '--extra']]])(
    'arguments %j are refused with nothing on stdout',
    (args) => {
      const fx = tree(['for m in aaa-first zzz-second; do']);
      try {
        const result = cli(fx.script, args);
        expect({ status: result.status, stdout: result.stdout }).toEqual({ status: 2, stdout: '' });
        expect(result.stderr).toMatch(/usage:/);
      } finally {
        fx.cleanup();
      }
    },
  );

  test('the real tree prints exactly what migrationApplySlugs() returns', () => {
    const result = cli(path.join(scriptsDir, 'migration-apply-order.mjs'), ['--slugs']);
    expect(result.status).toBe(0);
    expect(result.stdout.trimEnd().split('\n')).toEqual(value('return migrationApplySlugs();'));
  });

  test('reached through a linked directory it still prints the list', () => {
    // Node resolves the main module through links and leaves argv[1] as typed.
    // A guard comparing the two as written is FALSE here, and what that looks
    // like is the dangerous part: no output, exit 0 -- an empty list and a
    // success, handed to a loop that then applies nothing.
    const fx = tree(['for m in zzz-second aaa-first; do']);
    const link = path.join(path.dirname(path.dirname(path.dirname(path.dirname(fx.script)))), 'linked-scripts');
    try {
      // 'junction' needs no privilege on Windows and is ignored elsewhere,
      // where this is an ordinary directory symlink.
      fs.symlinkSync(path.dirname(fx.script), link, 'junction');
      expect(cli(path.join(link, 'migration-apply-order.mjs'), ['--slugs'])).toEqual({
        status: 0,
        stdout: 'zzz-second\naaa-first\n',
        stderr: '',
      });
    } finally {
      // Unlink first: removing the tree through a live link is how a link's
      // target gets deleted. A symlink goes with unlink, a junction with rmdir;
      // neither follows the link.
      try {
        fs.unlinkSync(link);
      } catch {
        try { fs.rmdirSync(link); } catch { /* never created */ }
      }
      fx.cleanup();
    }
  });

  test('importing the module prints nothing, whether or not another script is running', () => {
    // pilot-verify-schema.mjs and full-schema.mjs import it. A command line
    // that ran on import would write a migration list into their output.
    const bare = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(orderModuleUrl)});`],
      { encoding: 'utf8' },
    );
    expect({ status: bare.status, stdout: bare.stdout }).toEqual({ status: 0, stdout: '' });

    // The case that matters: argv[1] IS set, to the importing script. `-e`
    // leaves it undefined, which only exercises the guard's first half.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-apply-order-import-'));
    const importer = path.join(root, 'importer.mjs');
    try {
      fs.writeFileSync(
        importer,
        `import { migrationApplySlugs } from ${JSON.stringify(orderModuleUrl)};\n`
        + 'process.stdout.write(typeof migrationApplySlugs);\n',
      );
      // `--slugs` is passed on purpose: an import that mistook itself for the
      // script would act on it.
      const imported = spawnSync(process.execPath, [importer, '--slugs'], { encoding: 'utf8' });
      expect({ status: imported.status, stdout: imported.stdout })
        .toEqual({ status: 0, stdout: 'function' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
