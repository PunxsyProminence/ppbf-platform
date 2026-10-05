// Source rights for the SHADOW Library, kept apart from shadowLibrary.ts so the
// routes' validation and refusal wording carry no database import (and stay
// real under the route tests' mocks of shadowLibrary).

// What the Library may hold of a source (OD-2026-10-03-002 section 3;
// OD-2026-10-02-013 answer 4A). Full text only for the first two; any source
// may hold excerpts that name where they come from. The database enforces it
// (pilot_slice_postgres_source_rights_migration.sql), for every writer.
export const SHADOW_LIBRARY_RIGHTS_STATUSES = [
  'ppbf_owned',
  'open_licence',
  'licensed_excerpt_only',
  'unknown',
] as const;
export type ShadowLibraryRightsStatus = (typeof SHADOW_LIBRARY_RIGHTS_STATUSES)[number];

export function isShadowLibraryRightsStatus(value: unknown): value is ShadowLibraryRightsStatus {
  return typeof value === 'string' && (SHADOW_LIBRARY_RIGHTS_STATUSES as readonly string[]).includes(value);
}

// The database's refusals, raised by its rights triggers. A route turns these
// into a 422 with the plain sentence below rather than a 500.
export const FULL_TEXT_NOT_PERMITTED_MESSAGE =
  'This source is not marked PPBF-owned or open-licence, so the Library may hold only excerpts of it, each saying where in the source it comes from (a page, section or timestamp).';
export const RIGHTS_LOWERED_UNDER_FULL_TEXT_MESSAGE =
  'This source already holds full text, so its rights cannot be set below PPBF-owned or open-licence. Remove that text, or replace it with excerpts, first.';

export function rightsRefusalMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('SHADOW_LIBRARY_FULL_TEXT_NOT_PERMITTED')) return FULL_TEXT_NOT_PERMITTED_MESSAGE;
  if (message.startsWith('SHADOW_LIBRARY_RIGHTS_LOWERED_UNDER_FULL_TEXT')) return RIGHTS_LOWERED_UNDER_FULL_TEXT_MESSAGE;
  return null;
}
