import { BlobServiceClient } from '@azure/storage-blob';

import { getAzureStorageConnectionString, getPilotShadowContainerName } from './env';

let blobClient: BlobServiceClient | null = null;

function getBlobServiceClient(): BlobServiceClient {
  blobClient ??= BlobServiceClient.fromConnectionString(getAzureStorageConnectionString());
  return blobClient;
}

export async function uploadPilotShadowFile(path: string, file: File): Promise<void> {
  const serviceClient = getBlobServiceClient();
  const containerName = getPilotShadowContainerName();

  const containerClient = serviceClient.getContainerClient(containerName);
  await containerClient.createIfNotExists();

  const blockBlobClient = containerClient.getBlockBlobClient(path);
  const bytes = Buffer.from(await file.arrayBuffer());

  await blockBlobClient.uploadData(bytes, {
    blobHTTPHeaders: {
      blobContentType: file.type || 'application/octet-stream',
    },
  });
}
