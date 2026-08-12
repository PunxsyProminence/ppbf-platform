/**
 * The platform-wide SHADOW evidence baseline.
 *
 * The Library is tenant-scoped in every column, which is right for a gym's own
 * floor observations and wrong for peer-reviewed material that is true for
 * everybody. The baseline lives in a reserved organization instead of behind a
 * `scope` flag: see the header of
 * infra/azure/pilot_slice_postgres_platform_library_scope_migration.sql for why
 * the three obvious alternatives were rejected.
 *
 * This module is the only place the reserved id is written in TypeScript.
 * platformLibraryScope.test.ts reads the migration SQL and asserts the two
 * agree, so a change in one and not the other fails the suite rather than
 * quietly splitting the corpus in half.
 */

export const PLATFORM_LIBRARY_ORGANIZATION_ID = '__platform__';

/**
 * The organizations a reader may retrieve evidence from: their own, plus the
 * baseline.
 *
 * Returns an array because every retrieval query passes it as a single
 * `= any($1::text[])` parameter. That shape matters -- the alternative,
 * interpolating an OR branch per organization, is how a query ends up with the
 * platform predicate on the chunk but not on the joined document, and a source
 * from one tenant paired with a document from another is precisely the failure
 * the composite joins exist to prevent.
 *
 * Callers pass the actor's organization_id. When that IS the reserved
 * organization -- only reachable by an operator running the importer, since no
 * account may exist there -- the array collapses to one entry rather than
 * listing it twice.
 */
export function libraryRetrievalOrganizationIds(organizationId: string): string[] {
  return organizationId === PLATFORM_LIBRARY_ORGANIZATION_ID
    ? [PLATFORM_LIBRARY_ORGANIZATION_ID]
    : [organizationId, PLATFORM_LIBRARY_ORGANIZATION_ID];
}

/**
 * True for the reserved organization.
 *
 * Used by the organization enumerations -- the Omega admin list, the platform
 * overview, gear catalogue defaults, the orphan checker -- which count
 * organizations to mean "gyms". The baseline shelf has no floor, no members and
 * no sessions, so including it would inflate every one of those figures.
 */
export function isPlatformLibraryOrganization(organizationId: string | null | undefined): boolean {
  return organizationId === PLATFORM_LIBRARY_ORGANIZATION_ID;
}

/**
 * A SQL predicate excluding the reserved organization, for the queries that
 * enumerate organizations meaning "gyms".
 *
 * A function returning SQL rather than a bare string constant because the call
 * sites differ in whether the table is aliased, and `organization_id` against
 * an aliased join is ambiguous. Interpolating a module constant, never input.
 *
 * The per-organization seeding migrations carry this predicate as a literal
 * instead -- they are SQL files and cannot import it. platformLibraryScope.test.ts
 * asserts that every migration seeding from pilot.organizations has it, so the
 * duplication cannot drift silently.
 */
export function excludePlatformLibraryOrganizationSql(tableAlias?: string): string {
  const column = tableAlias ? `${tableAlias}.organization_id` : 'organization_id';
  return `${column} <> '${PLATFORM_LIBRARY_ORGANIZATION_ID}'`;
}
