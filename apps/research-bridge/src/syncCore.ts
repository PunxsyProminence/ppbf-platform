import type { BlobServiceClient } from '@azure/storage-blob';
import type { SearchClient, SearchIndexClient } from '@azure/search-documents';

import type { BridgeConfig } from './config.js';
import type { ResearchExport, ResearchIndexDocument } from './schemas.js';

export function toIndexDocuments(snapshot: ResearchExport): ResearchIndexDocument[] {
  const syncedAt = snapshot.generated_at;
  const needs: ResearchIndexDocument[] = snapshot.research_needs.map((item) => ({
    id: item.id,
    kind: 'research_need',
    title: item.title,
    content: item.knowledge_gap,
    publisher: null,
    sourceType: null,
    authorityTier: null,
    url: null,
    publicationDate: null,
    status: item.status,
    syncedAt,
  }));
  const evidence: ResearchIndexDocument[] = snapshot.approved_evidence.map((item) => ({
    id: item.id,
    kind: 'approved_evidence',
    title: item.title,
    content: item.excerpt,
    publisher: item.publisher,
    sourceType: item.source_type,
    authorityTier: item.authority_tier,
    url: item.url,
    publicationDate: item.publication_date,
    status: 'approved_verified',
    syncedAt,
  }));
  return [...needs, ...evidence];
}

export async function synchronizeResearchIndex(input: {
  config: BridgeConfig;
  snapshot: ResearchExport;
  searchIndexClient: SearchIndexClient;
  searchClient: SearchClient<ResearchIndexDocument>;
  blobServiceClient: BlobServiceClient;
}): Promise<{ uploaded: number; deleted: number }> {
  await input.searchIndexClient.createOrUpdateIndex({
    name: input.config.searchIndexName,
    fields: [
      { name: 'id', type: 'Edm.String', key: true, filterable: true },
      { name: 'kind', type: 'Edm.String', searchable: false, filterable: true, facetable: true },
      { name: 'title', type: 'Edm.String', searchable: true },
      { name: 'content', type: 'Edm.String', searchable: true },
      { name: 'publisher', type: 'Edm.String', searchable: true, filterable: true },
      { name: 'sourceType', type: 'Edm.String', searchable: false, filterable: true, facetable: true },
      { name: 'authorityTier', type: 'Edm.Int32', searchable: false, filterable: true, sortable: true },
      { name: 'url', type: 'Edm.String', searchable: false },
      { name: 'publicationDate', type: 'Edm.String', searchable: false, filterable: true, sortable: true },
      { name: 'status', type: 'Edm.String', searchable: false, filterable: true, facetable: true },
      { name: 'syncedAt', type: 'Edm.String', searchable: false, sortable: true },
    ],
  });

  const documents = toIndexDocuments(input.snapshot);
  if (documents.length > 0) {
    await input.searchClient.mergeOrUploadDocuments(documents);
  }

  const currentIds = new Set(documents.map((document) => document.id));
  const staleIds: string[] = [];
  const existing = await input.searchClient.search('*', { select: ['id'] });
  for await (const result of existing.results) {
    if (!currentIds.has(result.document.id)) {
      staleIds.push(result.document.id);
    }
  }
  if (staleIds.length > 0) {
    await input.searchClient.deleteDocuments('id', staleIds);
  }

  const researchContainer = input.blobServiceClient.getContainerClient(input.config.researchContainerName);
  const evidenceContainer = input.blobServiceClient.getContainerClient(input.config.evidenceContainerName);
  await Promise.all([
    researchContainer.getBlockBlobClient('latest.json').uploadData(
      Buffer.from(JSON.stringify({
        schema_version: input.snapshot.schema_version,
        classification: input.snapshot.classification,
        generated_at: input.snapshot.generated_at,
        research_needs: input.snapshot.research_needs,
      })),
      { blobHTTPHeaders: { blobContentType: 'application/json' } },
    ),
    evidenceContainer.getBlockBlobClient('approved-index-source.json').uploadData(
      Buffer.from(JSON.stringify({
        schema_version: input.snapshot.schema_version,
        classification: input.snapshot.classification,
        generated_at: input.snapshot.generated_at,
        approved_evidence: input.snapshot.approved_evidence,
      })),
      { blobHTTPHeaders: { blobContentType: 'application/json' } },
    ),
  ]);

  return { uploaded: documents.length, deleted: staleIds.length };
}
