import type { SearchClient } from '@azure/search-documents';

import type { ResearchIndexDocument, SanitizedEvidence } from './schemas.js';

export type EvidenceSearchResult = SanitizedEvidence & { score: number };

export const DEFAULT_EVIDENCE_MAX_AGE_HOURS = 48;
// A sync time further ahead than clock skew explains is not believed: it would
// keep a document fresh past any window.
const MAX_FUTURE_SKEW_MS = 10 * 60_000;

/**
 * Serves only evidence a sync has confirmed within the last maxAgeHours.
 *
 * Every successful sync rewrites every document it keeps, with that run's
 * syncedAt, and deletes the rest. If syncs stop -- for any reason -- nothing
 * is deleted, so evidence the app has since withdrawn for retraction would
 * stay served indefinitely (CL-C11). Past the window it is not served at all.
 * Checked here rather than as an index filter: syncedAt is not a filterable
 * field, and changing that means rebuilding the index.
 */
export class EvidenceSearchService {
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(
    private readonly client: SearchClient<ResearchIndexDocument>,
    options: { maxAgeHours?: number; now?: () => number } = {},
  ) {
    this.maxAgeMs = (options.maxAgeHours ?? DEFAULT_EVIDENCE_MAX_AGE_HOURS) * 3_600_000;
    this.now = options.now ?? Date.now;
  }

  private isFresh(syncedAt: string | null | undefined): boolean {
    const syncedAtMs = typeof syncedAt === 'string' ? Date.parse(syncedAt) : Number.NaN;
    const ageMs = this.now() - syncedAtMs;
    return Number.isFinite(syncedAtMs) && ageMs <= this.maxAgeMs && ageMs >= -MAX_FUTURE_SKEW_MS;
  }

  async search(query: string, limit: number): Promise<EvidenceSearchResult[]> {
    const results = await this.client.search(query, {
      filter: "kind eq 'approved_evidence'",
      select: ['id', 'title', 'content', 'publisher', 'sourceType', 'authorityTier', 'url', 'publicationDate', 'syncedAt'],
      top: limit,
      queryType: 'simple',
      searchMode: 'all',
    });

    const matches: EvidenceSearchResult[] = [];
    for await (const result of results.results) {
      const document = result.document;
      if (!this.isFresh(document.syncedAt)) {
        continue;
      }
      if (!document.sourceType || document.authorityTier === null) {
        continue;
      }
      if (!['peer_reviewed', 'clinical_guideline', 'governing_body', 'textbook'].includes(document.sourceType)) {
        continue;
      }
      matches.push({
        id: document.id,
        title: document.title,
        publisher: document.publisher,
        source_type: document.sourceType as SanitizedEvidence['source_type'],
        authority_tier: document.authorityTier,
        url: document.url,
        publication_date: document.publicationDate,
        excerpt: document.content,
        score: result.score ?? 0,
      });
    }
    return matches;
  }
}
