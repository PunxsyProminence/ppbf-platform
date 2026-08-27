import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The real package.json, read the way the module under test reads it. */
function packageScripts(): Record<string, string> {
  return JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'),
  ).scripts;
}

// The module under test is real ESM consumed by a workflow step, and the
// default jest runner has no ESM loader (`npm test` does not pass
// --experimental-vm-modules). As in import-shadow-research.test.ts, every
// expression is evaluated in one real `node` child process.
const moduleUrl = pathToFileURL(
  path.resolve(__dirname, 'check-migration-declaration.mjs'),
).href;

function evaluate(expression: string) {
  const script = `
    import * as m from ${JSON.stringify(moduleUrl)};
    const value = await (${expression});
    process.stdout.write(JSON.stringify(value ?? null));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }));
}

/** One `git diff --name-status` line for a migration at the given status. */
function nameStatus(status: string, slug: string) {
  return `${status}\tinfra/azure/pilot_slice_postgres_${slug}_migration.sql`;
}

describe('detecting schema work in a diff', () => {
  it('separates added, modified and removed migrations', () => {
    const text = [
      nameStatus('A', 'calibration_gold'),
      nameStatus('M', 'drill_versioning'),
      nameStatus('D', 'dead_thing'),
      'M\tapps/web/package.json',
      'A\tdocs/README.md',
    ].join('\n');

    expect(evaluate(`m.detectMigrationChanges(${JSON.stringify(text)})`)).toEqual({
      added: ['calibration_gold'],
      modified: ['drill_versioning'],
      removed: ['dead_thing'],
    });
  });

  it('reads both sides of a rename, so a migration cannot slip through as one', () => {
    // `git diff --name-status` emits R100<TAB>old<TAB>new. Reading only the
    // first path would see the removal and miss the file that now needs
    // applying under a new name.
    const text = 'R100\tinfra/azure/pilot_slice_postgres_old_name_migration.sql'
      + '\tinfra/azure/pilot_slice_postgres_new_name_migration.sql';

    expect(evaluate(`m.detectMigrationChanges(${JSON.stringify(text)})`)).toEqual({
      added: ['new_name'],
      modified: [],
      removed: ['old_name'],
    });
  });

  it('ignores files that are not migrations', () => {
    const text = [
      'A\tinfra/azure/some_other_file.sql',
      'M\tapps/web/src/server/pilot/drills.ts',
      'A\t.github/workflows/ci.yml',
    ].join('\n');

    expect(evaluate(`m.detectMigrationChanges(${JSON.stringify(text)})`)).toEqual({
      added: [], modified: [], removed: [],
    });
  });
});

describe('reading the MIGRATIONS line', () => {
  it('reads NONE', () => {
    const body = 'LANE: x\nMIGRATIONS:  NONE\nSTACKED ON: NONE';
    expect(evaluate(`m.parseDeclaration(${JSON.stringify(body)})`)).toMatchObject({
      present: true, none: true, slugs: [],
    });
  });

  it('reads a slug list, and strips the pilot:apply- prefix if one is written', () => {
    const body = 'MIGRATIONS: calibration-projects, pilot:apply-calibration-gold';
    expect(evaluate(`m.parseDeclaration(${JSON.stringify(body)})`)).toMatchObject({
      present: true, none: false, slugs: ['calibration-gold', 'calibration-projects'],
    });
  });

  it('survives the kernel template, arrow annotation and code fence included', () => {
    // The header is written inside a fenced block and the kernel's own template
    // carries a trailing arrow. A parser that choked on either would report
    // "no declaration" on a correctly-written PR.
    const body = '```\nLANE:        some-lane\nMIGRATIONS:  NONE          <-- never omit\n```';
    expect(evaluate(`m.parseDeclaration(${JSON.stringify(body)})`)).toMatchObject({
      present: true, none: true,
    });
  });

  it('takes the FIRST declaration, not a template quoted later in the body', () => {
    // A PR that documents the header format would otherwise be graded against
    // its own example rather than its real declaration.
    const body = 'MIGRATIONS: calibration-gold\n\n## Format\n\nMIGRATIONS: NONE';
    expect(evaluate(`m.parseDeclaration(${JSON.stringify(body)})`)).toMatchObject({
      none: false, slugs: ['calibration-gold'],
    });
  });

  it('reports an absent line as absent, and an empty one as present-but-empty', () => {
    expect(evaluate(`m.parseDeclaration('no header here')`)).toMatchObject({ present: false });
    expect(evaluate(`m.parseDeclaration('MIGRATIONS:')`)).toMatchObject({
      present: true, none: false, slugs: [],
    });
  });
});

describe('the teeth: a declaration that does not match its diff', () => {
  const targets = "new Set(['calibration-gold','drill-versioning'])";

  function check(nameStatusText: string, body: string) {
    return evaluate(`m.evaluate({
      changes: m.detectMigrationChanges(${JSON.stringify(nameStatusText)}),
      declaration: m.parseDeclaration(${JSON.stringify(body)}),
      applyTargets: ${targets},
    })`);
  }

  it('FAILS a PR that adds a migration and declares NONE', () => {
    // The case with real consequences: the release lane reads NONE, applies
    // nothing, and the deploy meets a schema without the table.
    const result = check(nameStatus('A', 'calibration_gold'), 'MIGRATIONS: NONE');
    expect(result.ok).toBe(false);
    expect(result.failures.join(' ')).toContain('declares NONE');
  });

  it('FAILS a PR that adds a migration and writes no MIGRATIONS line at all', () => {
    const result = check(nameStatus('A', 'calibration_gold'), 'LANE: x\nSCOPE: y');
    expect(result.ok).toBe(false);
    expect(result.failures.join(' ')).toContain('no MIGRATIONS: line');
  });

  it('FAILS a PR that MODIFIES an existing migration and declares NONE', () => {
    // Editing applied SQL changes what a fresh environment gets. It is not a
    // no-op, so it is not NONE.
    const result = check(nameStatus('M', 'drill_versioning'), 'MIGRATIONS: NONE');
    expect(result.ok).toBe(false);
  });

  it('FAILS a slug the release lane could not run', () => {
    const result = check(nameStatus('A', 'calibration_gold'), 'MIGRATIONS: calibration-glod');
    expect(result.ok).toBe(false);
    expect(result.failures.join(' ')).toContain('pilot:apply-calibration-glod');
  });

  it('PASSES a correct declaration', () => {
    const result = check(nameStatus('A', 'calibration_gold'), 'MIGRATIONS: calibration-gold');
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('PASSES NONE on a diff with no migrations, and does not demand the line', () => {
    // Dependabot and every docs PR land here. A check that failed them would
    // be turned off, and a check that is off has no teeth at all.
    expect(check('M\tapps/web/package.json', 'MIGRATIONS: NONE').ok).toBe(true);
    expect(check('M\tapps/web/package.json', 'no header at all').ok).toBe(true);
  });

  it('PASSES a revert that only removes migrations, and says why', () => {
    const result = check(nameStatus('D', 'calibration_gold'), 'MIGRATIONS: NONE');
    expect(result.ok).toBe(true);
    expect(result.notes.join(' ')).toContain('nothing to apply');
  });

  it('PASSES over-declaration, because a stacked PR inherits its parent migration', () => {
    // Deliberate asymmetry. Under-declaring loses a migration; over-declaring
    // re-runs an idempotent one. Failing this would push lanes to declare less.
    const result = check('M\tapps/web/src/server/pilot/drills.ts', 'MIGRATIONS: calibration-gold');
    expect(result.ok).toBe(true);
    expect(result.notes.join(' ')).toContain('STACKED ON');
  });
});

describe('the check reads this repository, not a fixture of it', () => {
  it('finds the real pilot:apply- registrations in package.json', () => {
    const scripts = packageScripts();
    const targets = evaluate(`[...m.applyTargetsFrom(${JSON.stringify(scripts)})].sort()`);

    // A derivation that returned nothing would make every slug look invalid,
    // and a derivation that returned everything would make every slug look
    // valid. Both are silent failures, so the floor and a known member are
    // pinned.
    expect(targets.length).toBeGreaterThan(50);
    expect(targets).toContain('drill-versioning');
    expect(targets).not.toContain('');
  });

  it('agrees with the two migrations whose filename does not predict their slug', () => {
    // scheduler_registration_race registers as pilot:apply-scheduler-race, and
    // sparring_exposure_and_load as pilot:apply-sparring-exposure. A check that
    // derived the slug from the filename would reject a correct declaration
    // for either. This pins that the repository really is like that, so the
    // comment explaining the design cannot quietly go stale.
    const scripts = packageScripts();
    const targets = evaluate(`[...m.applyTargetsFrom(${JSON.stringify(scripts)})]`);

    expect(targets).toContain('scheduler-race');
    expect(targets).not.toContain('scheduler-registration-race');
    expect(targets).toContain('sparring-exposure');
    expect(targets).not.toContain('sparring-exposure-and-load');
  });
});
