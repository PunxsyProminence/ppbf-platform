import { BlobServiceClient, StorageSharedKeyCredential, generateBlobSASQueryParameters, BlobSASPermissions } from '@azure/storage-blob';

import {
  getAzureStorageConnectionString,
  getPilotProfileContainerName,
  getPilotShadowContainerName,
  getPilotVideoContainerName,
} from './env';

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

/**
 * Read one video blob's index tags.
 *
 * This is how the malware verdict reaches the platform (#49). Microsoft
 * Defender for Storage, when malware scanning is enabled on the account,
 * writes its result back onto the blob as an index tag after the upload lands.
 * Nothing here performs a scan -- it reads a verdict a real scanner produced,
 * which is the whole point: the platform must never be the thing that decides
 * a file is clean.
 *
 * Returns an empty map rather than throwing when tags cannot be read, because
 * the caller distinguishes "no verdict yet" from "clean" and treats both
 * non-verdicts as grounds to keep the video quarantined. A throw here would
 * turn a storage hiccup into a failed job; an empty map turns it into a retry.
 */
export async function getPilotVideoBlobTags(blobPath: string): Promise<Record<string, string>> {
  const serviceClient = getBlobServiceClient();
  const containerClient = serviceClient.getContainerClient(getPilotVideoContainerName());
  const blobClientForPath = containerClient.getBlockBlobClient(blobPath);
  try {
    const response = await blobClientForPath.getTags();
    return response.tags ?? {};
  } catch {
    return {};
  }
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

/* --------------------------------------------------------------- PORTRAITS --
 * Member portraits. Bytes in, bytes out, and no signed URL at any point.
 *
 * The other two containers mint read-only SAS links so a browser can fetch
 * directly from storage. That is right for a board packet and defensible for a
 * reviewer's one-off look at a quarantined document. It is not right for a
 * child's face: a SAS URL is a bearer capability with no idea who is holding
 * it, it survives being pasted into a chat window, and it outlives the session
 * that minted it. downloadPilotVideoFile already refuses to mint one for a
 * minor's footage for exactly this reason; portraits take the same stance.
 *
 * So the read path here returns a Buffer to the route, the route re-checks who
 * is asking (profileVisibility.ts), and the bytes go out over the authenticated
 * request with Cache-Control: private, no-store. There is no URL for a child's
 * photograph that works without a session.
 */

export async function uploadPilotProfilePhoto(
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  const serviceClient = getBlobServiceClient();
  const containerClient = serviceClient.getContainerClient(getPilotProfileContainerName());
  // 'container' access is never requested. The default is private, and a
  // portrait container that is publicly listable would defeat every check in
  // profileVisibility.ts in one line.
  await containerClient.createIfNotExists();
  const blockBlobClient = containerClient.getBlockBlobClient(path);
  await blockBlobClient.uploadData(Buffer.from(bytes), {
    blobHTTPHeaders: {
      blobContentType: contentType,
      // Storage must not tell a CDN or a proxy that this is shareable.
      blobCacheControl: 'private, no-store',
    },
  });
}

/**
 * Read one portrait, server-side. Capped an order of magnitude above the upload
 * limit rather than at it: the cap is here to stop an unbounded read into a
 * request handler's memory, not to re-litigate the upload policy, and a blob
 * that somehow exceeds it is a fault to surface rather than a photo to serve.
 */
export async function downloadPilotProfilePhoto(
  blobPath: string,
  maxBytes = 4 * 1024 * 1024,
): Promise<Buffer> {
  const serviceClient = getBlobServiceClient();
  const containerClient = serviceClient.getContainerClient(getPilotProfileContainerName());
  const blobClientForPath = containerClient.getBlockBlobClient(blobPath);

  const properties = await blobClientForPath.getProperties();
  if (typeof properties.contentLength === 'number' && properties.contentLength > maxBytes) {
    throw new Error('PROFILE_PHOTO_TOO_LARGE');
  }

  return blobClientForPath.downloadToBuffer(0, undefined, { maxRetryRequestsPerBlock: 2 });
}

/**
 * Delete a portrait outright.
 *
 * A member removing their own photo, or staff taking one down, has to mean the
 * bytes are gone -- not that a flag flipped while the file sits in a container
 * anyone with the storage key can list. Missing is success: a delete that finds
 * nothing has achieved what it was asked to achieve.
 */
export async function deletePilotProfilePhoto(blobPath: string): Promise<void> {
  const serviceClient = getBlobServiceClient();
  const containerClient = serviceClient.getContainerClient(getPilotProfileContainerName());
  await containerClient.getBlockBlobClient(blobPath).deleteIfExists();
}
