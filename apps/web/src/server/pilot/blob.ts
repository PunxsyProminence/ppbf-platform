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
