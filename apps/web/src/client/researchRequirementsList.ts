// The research requirements list arrives a page at a time (F-025). A screen
// that needs every row it may see -- the review queue, SHADOW's "filed as
// research" marks -- follows next_cursor here until the server says there is
// no more. The server decides which rows a reader gets; this only collects
// the pages.

import { apiBase } from '@/lib/apiBase';

/** The route's largest page. */
const PAGE_LIMIT = 200;
/** A guard against a server that never stops answering with a cursor. */
const MAX_PAGES = 500;

export async function fetchAllResearchRequirements<T>(init: { signal?: AbortSignal } = {}): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    const query: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
    const response = await fetch(`${apiBase()}/api/pilot/shadow/research-requirements?limit=${PAGE_LIMIT}${query}`, {
      credentials: 'include',
      signal: init.signal,
    });
    if (!response.ok) {
      throw new Error('Unable to load research requirements.');
    }
    const payload = (await response.json()) as { items?: T[]; next_cursor?: string | null };
    items.push(...(payload.items ?? []));
    cursor = payload.next_cursor ?? null;
    if (cursor === null) return items;
  }
  throw new Error('Unable to load research requirements.');
}
