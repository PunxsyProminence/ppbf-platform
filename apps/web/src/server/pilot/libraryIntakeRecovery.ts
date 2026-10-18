// Retries of Library writes (L54; audit 2026-10-17 items 2 and 3).
//
// A curator's save is several requests: register a source, then one document,
// then its chunks in order. Any answer can be lost after the row it reports was
// written. These are the reads that let a retry tell "already done, with the
// same content" from "something different is already here", so a retry never
// files the same work twice and never reports different stored text as saved.
//
// Scoped to one organization (the shelf the route resolved), like every
// Library write.

import { queryOne } from './db';

// A request id is a client-made token (a UUID in practice). Bounded so it
// cannot carry anything else into metadata.
export const LIBRARY_REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,100}$/;

/** The body's request_id: null when absent, undefined when present but not a valid id. */
export function readLibraryRequestId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && LIBRARY_REQUEST_ID_PATTERN.test(value.trim()) ? value.trim() : undefined;
}

/** The source that already holds this URL on this shelf, named so the curator can pick it. */
export async function findLibrarySourceByUrl(
  organizationId: string,
  url: string,
): Promise<{ source_id: string; title: string } | null> {
  return queryOne<{ source_id: string; title: string }>(
    `select source_id, title from pilot.shadow_library_sources
      where organization_id = $1 and url = $2`,
    [organizationId, url.trim()],
  );
}

export interface StoredLibraryChunk {
  chunk_id: string;
  document_id: string;
  source_id: string;
  ordinal: number;
  text_content: string;
  excerpt_locator: string | null;
  text_kind: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/**
 * The chunk already stored at this ordinal of this document, if any. A
 * document the retention purge held is skipped (F-086): it takes no chunk, so
 * the write goes on to be refused as not found.
 */
export async function findStoredLibraryChunk(
  organizationId: string,
  documentId: string,
  ordinal: number,
): Promise<StoredLibraryChunk | null> {
  return queryOne<StoredLibraryChunk>(
    `select c.chunk_id, c.document_id, c.source_id, c.ordinal, c.text_content, c.excerpt_locator,
            c.text_kind, c.metadata, c.created_at
       from pilot.shadow_library_chunks c
       join pilot.shadow_library_documents d
         on d.document_id = c.document_id and d.organization_id = c.organization_id
      where c.organization_id = $1 and c.document_id = $2 and c.ordinal = $3
        and not (d.metadata ? 'subject_purged_at')`,
    [organizationId, documentId, ordinal],
  );
}

function joinBeforeOf(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const value = (metadata as Record<string, unknown>).join_before;
  return typeof value === 'string' ? value : null;
}

/**
 * True only when the stored chunk is this write: the same text (stored
 * trimmed), the same locator, and the same separator before it, so the stored
 * parts still rejoin into the submitted text. Anything else is a conflict.
 */
export function isSameLibraryChunk(
  stored: Pick<StoredLibraryChunk, 'text_content' | 'excerpt_locator' | 'metadata'>,
  attempt: { textContent: string; excerptLocator: string | null; metadata?: Record<string, unknown> },
): boolean {
  return stored.text_content === attempt.textContent.trim()
    && (stored.excerpt_locator ?? null) === (attempt.excerptLocator?.trim() || null)
    && joinBeforeOf(stored.metadata) === joinBeforeOf(attempt.metadata);
}
