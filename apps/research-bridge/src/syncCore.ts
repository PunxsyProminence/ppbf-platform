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

/**
 * Creates or updates the index definition, and nothing else.
 *
 * Deliberately takes no snapshot and touches no documents: the identity that
 * runs this holds Search Service Contributor and is not authorized against the
 * PPBF export at all, which is the point. An index-bootstrap run needs no
 * access to sanitized athlete data, so it is never given any.
 */
export async function ensureResearchIndex(input: {
  config: BridgeConfig;
  searchIndexClient: SearchIndexClient;
  onStage?: (stage: string) => void;
}): Promise<void> {
  input.onStage?.('research.search-create-index');
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
}

export async function synchronizeResearchIndex(input: {
  config: BridgeConfig;
  snapshot: ResearchExport;
  searchIndexClient: SearchIndexClient;
  searchClient: SearchClient<ResearchIndexDocument>;
  blobServiceClient: BlobServiceClient;
  onStage?: (stage: string) => void;
}): Promise<{ uploaded: number; deleted: number }> {
  // The index definition is not this job's business. The recurring sync holds
  // Search Index Data Contributor, which per Azure AI Search RBAC grants
  // document read/write and explicitly NOT object management -- so calling
  // createOrUpdateIndex here would 403. See ensureResearchIndex above.

  // Its own stage. This transform used to run while the marker still read
  // 'research.search-create-index', so a failure here was reported as a Search
  // failure -- pointing every investigation at RBAC and the SDK instead of the
  // data.
  input.onStage?.('research.build-documents');
  const documents = toIndexDocuments(input.snapshot);
  if (documents.length > 0) {
    input.onStage?.('research.search-write-documents');
    await input.searchClient.mergeOrUploadDocuments(documents);
  }

  const currentIds = new Set(documents.map((document) => document.id));
  const staleIds: string[] = [];
  input.onStage?.('research.search-read-existing');
  const existing = await input.searchClient.search('*', { select: ['id'] });
  for await (const result of existing.results) {
    if (!currentIds.has(result.document.id)) {
      staleIds.push(result.document.id);
    }
  }
  if (staleIds.length > 0) {
    input.onStage?.('research.search-delete-stale');
    await input.searchClient.deleteDocuments('id', staleIds);
  }

  input.onStage?.('research.blob-write-snapshots');
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
