import { DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { SearchClient, SearchIndexClient } from '@azure/search-documents';
import { BlobServiceClient } from '@azure/storage-blob';

import type { BridgeConfig } from './config.js';
import type { ResearchIndexDocument } from './schemas.js';

export type BridgeCredential = DefaultAzureCredential | ManagedIdentityCredential;

export function createCredential(config: BridgeConfig): BridgeCredential {
  return config.managedIdentityClientId
    ? new ManagedIdentityCredential(config.managedIdentityClientId)
    : new DefaultAzureCredential();
}

export function createAzureClients(config: BridgeConfig, credential: BridgeCredential) {
  return {
    searchIndexClient: new SearchIndexClient(config.searchEndpoint, credential),
    searchClient: new SearchClient<ResearchIndexDocument>(config.searchEndpoint, config.searchIndexName, credential),
    blobServiceClient: new BlobServiceClient(config.storageAccountUrl, credential),
  };
}
