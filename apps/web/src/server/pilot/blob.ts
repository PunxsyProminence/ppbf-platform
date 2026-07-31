import { BlobServiceClient, StorageSharedKeyCredential, generateBlobSASQueryParameters, BlobSASPermissions } from '@azure/storage-blob';

import { getAzureStorageConnectionString, getPilotShadowContainerName, getPilotVideoContainerName } from './env';

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

export async function uploadPilotVideoFile(path: string, file: File): Promise<void> {
  const serviceClient = getBlobServiceClient();
  const containerName = getPilotVideoContainerName();
  const containerClient = serviceClient.getContainerClient(containerName);
  await containerClient.createIfNotExists();
  const blockBlobClient = containerClient.getBlockBlobClient(path);
  const bytes = Buffer.from(await file.arrayBuffer());
  await blockBlobClient.uploadData(bytes, {
    blobHTTPHeaders: { blobContentType: file.type || 'video/mp4' },
  });
}

/**
 * Read one video blob into memory, server-side.
 *
 * Film Study's executor runs inside the worker with no browser and no user
 * session, so it reads the bytes directly rather than minting a SAS URL and
 * fetching it back over the network -- one fewer credential in flight, and no
 * signed URL for a minor's video existing even briefly.
 *
 * Capped because the caller is a background job holding a lease: an
 * unbounded read of an arbitrarily large upload would blow the container's
 * memory and lose the lease with it.
 */
export async function downloadPilotVideoFile(
  blobPath: string,
  maxBytes = 512 * 1024 * 1024,
): Promise<Buffer> {
  const serviceClient = getBlobServiceClient();
  const containerClient = serviceClient.getContainerClient(getPilotVideoContainerName());
  const blobClientForPath = containerClient.getBlockBlobClient(blobPath);

  const properties = await blobClientForPath.getProperties();
  if (typeof properties.contentLength === 'number' && properties.contentLength > maxBytes) {
    throw new Error('SHADOW_FILM_VIDEO_TOO_LARGE');
  }

  return blobClientForPath.downloadToBuffer(0, undefined, {
    maxRetryRequestsPerBlock: 2,
  });
}

function getReadOnlySasUrl(containerName: string, blobPath: string, expiryMinutes: number): string {
  const connStr = getAzureStorageConnectionString();
  const accountNameMatch = /AccountName=([^;]+)/.exec(connStr);
  const accountKeyMatch = /AccountKey=([^;]+)/.exec(connStr);
  if (!accountNameMatch || !accountKeyMatch) {
    throw new Error('Cannot parse storage account credentials for SAS generation');
  }
  const accountName = accountNameMatch[1];
  const accountKey = accountKeyMatch[1];
  const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
  const startsOn = new Date();
  const expiresOn = new Date(startsOn.getTime() + expiryMinutes * 60 * 1000);
  const sasToken = generateBlobSASQueryParameters(
    { containerName, blobName: blobPath, permissions: BlobSASPermissions.parse('r'), startsOn, expiresOn },
    sharedKeyCredential,
  ).toString();
  return `https://${accountName}.blob.core.windows.net/${containerName}/${blobPath}?${sasToken}`;
}

export function getPilotVideoSasUrl(blobPath: string, expiryMinutes = 60): string {
  return getReadOnlySasUrl(getPilotVideoContainerName(), blobPath, expiryMinutes);
}

// Short default expiry: the link exists so a reviewer can open one quarantined
// document while looking at the review screen, not to be stored or shared.
export function getPilotShadowSasUrl(blobPath: string, expiryMinutes = 15): string {
  return getReadOnlySasUrl(getPilotShadowContainerName(), blobPath, expiryMinutes);
}
