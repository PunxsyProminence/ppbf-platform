import { readFileSync } from 'node:fs';
import path from 'node:path';

import { AUTH_PROVIDERS, isAuthProvider } from './authProviders';
import { requiredCredentialFor } from './credentialPolicy';

/**
 * The auth_provider vocabulary is declared in TypeScript and in SQL. These read
 * the actual SQL files rather than a copy of their contents, so they fail if
 * either side gains a value the other lacks.
 *
 * Written before magic_link was added anywhere, deliberately. The audit
 * vocabulary drifted precisely because a value reached TypeScript and the route
 * that wrote it while the check constraint stayed behind -- and nothing failed
 * until production. Adding the guard first means that cannot repeat here.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const BASE_SCHEMA = path.join(REPO_ROOT, 'infra/azure/pilot_slice_postgres.sql');
const MULTIORG_MIGRATION = path.join(
  REPO_ROOT,
  'infra/azure/pilot_slice_postgres_multiorg_migration.sql',
);
const MAGIC_LINK_MIGRATION = path.join(
  REPO_ROOT,
  'infra/azure/pilot_slice_postgres_magic_link_migration.sql',
);

/**
 * Pulls the values out of the LAST `auth_provider in ( ... )` list in a file.
 *
 * Last, not first: the multiorg migration drops the constraint and re-adds it,
 * so its file mentions auth_provider more than once and the meaningful list is
 * the one it ends up with. Reading the first match there would assert against a
 * constraint that no longer exists.
 */
function authProvidersDeclaredIn(sqlPath: string): string[] {
  const sql = readFileSync(sqlPath, 'utf8');
  const matches = [...sql.matchAll(/auth_provider\s+in\s*\(([^)]*)\)/gi)];
  if (matches.length === 0) {
    throw new Error(`No "auth_provider in (...)" constraint found in ${sqlPath}`);
  }
  const last = matches[matches.length - 1];
  return [...last[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('auth_provider vocabulary stays in step across TypeScript and SQL', () => {
  test('the base schema declares exactly the canonical vocabulary', () => {
    expect(authProvidersDeclaredIn(BASE_SCHEMA).sort()).toEqual([...AUTH_PROVIDERS].sort());
  });

  test('the multiorg migration declares exactly the canonical vocabulary', () => {
    expect(authProvidersDeclaredIn(MULTIORG_MIGRATION).sort()).toEqual([...AUTH_PROVIDERS].sort());
  });

  test('the magic-link migration declares exactly the canonical vocabulary', () => {
    expect(authProvidersDeclaredIn(MAGIC_LINK_MIGRATION).sort()).toEqual([...AUTH_PROVIDERS].sort());
  });

  test('the reader is not vacuous -- it finds a real, non-empty list', () => {
    // A parser that silently returned [] would make every assertion above pass
    // by comparing nothing to nothing.
    for (const file of [BASE_SCHEMA, MULTIORG_MIGRATION, MAGIC_LINK_MIGRATION]) {
      expect(authProvidersDeclaredIn(file).length).toBeGreaterThanOrEqual(3);
    }
  });

  test('every canonical value is recognised, and nothing else is', () => {
    for (const provider of AUTH_PROVIDERS) {
      expect(isAuthProvider(provider)).toBe(true);
    }
    expect(isAuthProvider('google')).toBe(false);
    expect(isAuthProvider('')).toBe(false);
    expect(isAuthProvider(undefined)).toBe(false);
  });

  test('ppbf_local stays athlete-only, whatever else joins the vocabulary', () => {
    // Guards the property the whole credential model rests on: adding a
    // provider must never quietly turn ppbf_local into a general-purpose login.
    expect(requiredCredentialFor({ role: 'athlete' })).toBe('pin');
    expect(requiredCredentialFor({ role: 'coach' })).toBe('magic_link');
  });
});
