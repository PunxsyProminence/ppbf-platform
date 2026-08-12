/**
 * The reserved organization id is written in three places that cannot import
 * each other: this module, the migration SQL, and the migration runner's
 * readiness query. A mismatch between any two of them does not fail loudly --
 * it splits the corpus, so retrieval looks in one organization while the
 * importer writes to another and SHADOW stays dark for a reason nothing reports.
 *
 * These tests are the join between them.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  PLATFORM_LIBRARY_ORGANIZATION_ID,
  isPlatformLibraryOrganization,
  libraryRetrievalOrganizationIds,
} from './platformLibraryScope';

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const migrationSql = fs.readFileSync(
  path.join(repositoryRoot, 'infra/azure/pilot_slice_postgres_platform_library_scope_migration.sql'),
  'utf8',
);
const runnerSource = fs.readFileSync(
  path.join(repositoryRoot, 'apps/web/scripts/pilot-apply-platform-library-scope-migration.mjs'),
  'utf8',
);

describe('the reserved organization id agrees everywhere it is written', () => {
  test('the migration inserts the id this module names', () => {
    expect(migrationSql).toContain(
      `values ('${PLATFORM_LIBRARY_ORGANIZATION_ID}', 'PPBF Platform Evidence Baseline', 'active')`,
    );
  });

  test('the runner asserts readiness against the same id', () => {
    expect(runnerSource).toContain(
      `const PLATFORM_ORGANIZATION_ID = '${PLATFORM_LIBRARY_ORGANIZATION_ID}';`,
    );
  });

  test('all three membership guards name the same id', () => {
    for (const constraint of [
      'pilot_accounts_not_platform_library_org',
      'pilot_org_memberships_not_platform_library_org',
      'pilot_athletes_not_platform_library_org',
    ]) {
      // The constraint and its predicate are on separate lines in the DO block,
      // so match the pair rather than the name alone -- a guard added against
      // some other literal would otherwise pass.
      const guard = new RegExp(
        `add constraint ${constraint}\\s+check \\(organization_id <> '${PLATFORM_LIBRARY_ORGANIZATION_ID}'\\)`,
      );
      expect(migrationSql).toMatch(guard);
    }
  });

  test('the evidence-item scope check admits the baseline and nothing else', () => {
    // Two branches, and only two. A third would be a tenant this check was
    // never meant to admit.
    expect(migrationSql).toMatch(
      /check \(\s*library_organization_id = organization_id\s*or library_organization_id = '__platform__'\s*\)/,
    );
  });

  test('the baseline cannot be scoped to an individual', () => {
    // The owner's requirement is that the baseline be "non athlete/user/
    // individual specific". subject_id has no foreign key on either table, so
    // this check is the only thing preventing a platform row from being seeded
    // with a real athlete's id and surfacing to exactly that athlete.
    for (const table of ['documents', 'chunks']) {
      const guard = new RegExp(
        `add constraint pilot_shadow_library_${table}_platform_unscoped_check\\s+`
        + `check \\(organization_id <> '${PLATFORM_LIBRARY_ORGANIZATION_ID}' or subject_id is null\\)`,
      );
      expect(migrationSql).toMatch(guard);
    }
  });

  test('the id cannot collide with an organization created through the app', () => {
    // createOrganization refuses this exact value, but the id is also shaped so
    // that a gym slug could not arrive at it by accident: no gym is named with
    // leading underscores.
    expect(PLATFORM_LIBRARY_ORGANIZATION_ID).toMatch(/^__[a-z]+__$/);
  });
});

describe('the readiness query matches what Postgres renders, not what the migration says', () => {
  /**
   * pg_get_constraintdef does not echo a migration's text back. It re-renders
   * the PARSED expression, and it renders operators and keywords in UPPER CASE:
   * the migration says `subject_id is null` and Postgres reports
   * `(subject_id IS NULL)`.
   *
   * A case-sensitive LIKE against the lower-case form therefore never matches,
   * and the assertion fails against a database where the constraint is present
   * and entirely correct. That is what happened on the first staging dispatch of
   * this migration: eleven of twelve assertions passed, platform_unscoped_ready
   * failed, and the transaction rolled back a migration that had applied fine.
   *
   * Identifiers are echoed verbatim, so `%library_organization_id%` and
   * `%__platform__%` are safe as LIKE. It is the KEYWORDS that get re-cased.
   */
  const RERENDERED_KEYWORDS = [
    'is null',
    'is not null',
    'foreign key',
    'references',
    'check',
    'unique',
    'primary key',
    'on delete',
    'and ',
    'or ',
    'not ',
  ];

  const constraintDefPatterns = [
    ...runnerSource.matchAll(/pg_get_constraintdef\(oid\)\s+(i?like)\s+'([^']*)'/g),
  ].map(([, operator, pattern]) => ({ operator, pattern }));

  test('the sweep finds the readiness patterns it is meant to guard', () => {
    // Guards the guard: if this regex stops matching, every case below is
    // vacuous and the bug it exists for walks straight back in.
    expect(constraintDefPatterns.length).toBeGreaterThanOrEqual(6);
  });

  test.each(constraintDefPatterns)(
    'pattern %p is either case-insensitive or free of re-rendered keywords',
    ({ operator, pattern }) => {
      if (operator === 'ilike') return;
      const offenders = RERENDERED_KEYWORDS.filter((keyword) => pattern.includes(keyword));
      expect(offenders).toEqual([]);
    },
  );
});

describe('nothing seeds per-gym rows for the reserved organization', () => {
  /**
   * The ratchet. Two migrations seed one row per organization -- default
   * compliance rules and the safety gate matrix -- and their runners then assert
   * that EVERY organization got seeded. Both would report NOT READY forever from
   * the first re-run after the baseline exists, and an operator would read that
   * as a broken database rather than as a shelf with no floor.
   *
   * Written as a sweep over infra/azure rather than as two named assertions so
   * that the NEXT per-organization seeder is caught when it is written, not when
   * a rebuild fails months later.
   */
  const infraDir = path.join(repositoryRoot, 'infra/azure');

  // Comments in these files discuss the very SQL being counted -- one header
  // says "Each statement selects `from pilot.organizations` at apply time" --
  // so counting raw text finds a seed statement that does not exist and demands
  // an exclusion for it.
  const executableSql = (fileName: string) => fs
    .readFileSync(path.join(infraDir, fileName), 'utf8')
    .replace(/--[^\n]*/g, '');

  const seedingMigrations = fs
    .readdirSync(infraDir)
    .filter((name) => /^pilot_slice_postgres_.+_migration\.sql$/.test(name))
    .filter((name) => {
      // An INSERT whose SELECT enumerates organizations: the shape that mints a
      // row per gym. A plain `references pilot.organizations` is a column
      // definition and is not this.
      return /insert\s+into\s+pilot\.[\s\S]{0,4000}?\bfrom\s+pilot\.organizations\b/i
        .test(executableSql(name));
    });

  test('the sweep finds the migrations it is meant to guard', () => {
    // Guards the guard: a regex that stopped matching would make the assertion
    // below vacuously true for every file.
    expect(seedingMigrations).toEqual(
      expect.arrayContaining([
        'pilot_slice_postgres_compliance_rule_seeds_migration.sql',
        'pilot_slice_postgres_safety_gate_matrix_migration.sql',
      ]),
    );
  });

  test.each(seedingMigrations)('%s excludes the reserved organization', (fileName) => {
    const sql = executableSql(fileName);
    const seedStatements = sql.match(/\bfrom\s+pilot\.organizations\b/gi) ?? [];
    const exclusions = sql.match(
      new RegExp(`organization_id <> '${PLATFORM_LIBRARY_ORGANIZATION_ID}'`, 'g'),
    ) ?? [];
    // One exclusion per enumeration. Counting rather than merely requiring the
    // predicate somewhere in the file is the point: a migration that grows a
    // sixth seed statement and carries five exclusions is exactly the case a
    // presence check would pass.
    expect(exclusions.length).toBeGreaterThanOrEqual(seedStatements.length);
  });
});

describe('libraryRetrievalOrganizationIds', () => {
  test('a gym reads its own shelf and the baseline', () => {
    expect(libraryRetrievalOrganizationIds('ppbf-default-org')).toEqual([
      'ppbf-default-org',
      PLATFORM_LIBRARY_ORGANIZATION_ID,
    ]);
  });

  test('two gyms never see each other', () => {
    const first = libraryRetrievalOrganizationIds('ppbf-default-org');
    const second = libraryRetrievalOrganizationIds('audit-test-gym3');
    expect(first).not.toContain('audit-test-gym3');
    expect(second).not.toContain('ppbf-default-org');
    // The baseline is the ONLY thing they share. If this ever grows a third
    // common entry, the containment argument above stops holding.
    expect(first.filter((id) => second.includes(id))).toEqual([
      PLATFORM_LIBRARY_ORGANIZATION_ID,
    ]);
  });

  test('the reserved organization does not list itself twice', () => {
    // Reachable only by an operator running the importer. Listing the id twice
    // would not change results, but it would make the `= any()` parameter a
    // misleading thing to read in a log.
    expect(libraryRetrievalOrganizationIds(PLATFORM_LIBRARY_ORGANIZATION_ID)).toEqual([
      PLATFORM_LIBRARY_ORGANIZATION_ID,
    ]);
  });
});

describe('isPlatformLibraryOrganization', () => {
  test('identifies the reserved organization and nothing else', () => {
    expect(isPlatformLibraryOrganization(PLATFORM_LIBRARY_ORGANIZATION_ID)).toBe(true);
    expect(isPlatformLibraryOrganization('ppbf-default-org')).toBe(false);
  });

  test('null and undefined are not the reserved organization', () => {
    // The enumeration call sites read organization_id off rows that may be
    // left-joined, so a nullish value must answer false rather than throw.
    expect(isPlatformLibraryOrganization(null)).toBe(false);
    expect(isPlatformLibraryOrganization(undefined)).toBe(false);
  });
});
