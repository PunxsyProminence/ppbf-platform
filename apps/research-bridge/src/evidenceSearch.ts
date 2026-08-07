import type { SearchClient } from '@azure/search-documents';

import type { ResearchIndexDocument, SanitizedEvidence } from './schemas.js';

export type EvidenceSearchResult = SanitizedEvidence & { score: number };

export class EvidenceSearchService {
  constructor(private readonly client: SearchClient<ResearchIndexDocument>) {}

  async search(query: string, limit: number): Promise<EvidenceSearchResult[]> {
    const results = await this.client.search(query, {
      filter: "kind eq 'approved_evidence'",
      select: ['id', 'title', 'content', 'publisher', 'sourceType', 'authorityTier', 'url', 'publicationDate'],
      top: limit,
      queryType: 'simple',
      searchMode: 'all',
    });

    const matches: EvidenceSearchResult[] = [];
    for await (const result of results.results) {
      const document = result.document;
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
