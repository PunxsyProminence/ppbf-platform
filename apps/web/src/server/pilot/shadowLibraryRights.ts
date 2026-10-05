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

// Provenance keys only the research importer and pilot-rescope-library-baseline.mjs
// write: they say a row is the importer's copy of a seed row. A caller-supplied
// one could read as that provenance to a later backfill or script, so the
// curator routes refuse them (the source-rights migration itself no longer
// reads metadata; this keeps the claim off the rows too).
export const RESERVED_PROVENANCE_METADATA_KEYS = [
  'copied_from_source_id',
  'copied_from_document_id',
  'copied_for_scope',
] as const;

/** The first reserved provenance key present in caller metadata, or null. */
export function reservedProvenanceKey(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  return RESERVED_PROVENANCE_METADATA_KEYS.find((key) => Object.hasOwn(metadata, key)) ?? null;
}

export function reservedProvenanceMessage(key: string): string {
  return `metadata.${key} is set only by the research importer`;
}

export function rightsRefusalMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('SHADOW_LIBRARY_FULL_TEXT_NOT_PERMITTED')) return FULL_TEXT_NOT_PERMITTED_MESSAGE;
  if (message.startsWith('SHADOW_LIBRARY_RIGHTS_LOWERED_UNDER_FULL_TEXT')) return RIGHTS_LOWERED_UNDER_FULL_TEXT_MESSAGE;
  return null;
}
