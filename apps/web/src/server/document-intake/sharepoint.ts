import { getClientCredentialToken } from './auth'
import type { SharePointWriteResult } from './types'

// A file upload (PDF bytes), not a metadata call, so this needs more
// headroom than the token fetches; 30s bounds a stall without being tight
// enough to trip on an ordinary-sized document.
const SHAREPOINT_UPLOAD_TIMEOUT_MS = 30_000

export interface SharePointConfig {
  tenantId: string
  clientId: string
  clientSecret: string
  siteId: string
  driveId: string
  folderPath: string
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replaceAll('%2F', '/')
}

function trimSlashes(value: string): string {
  let output = value
  while (output.startsWith('/')) {
    output = output.slice(1)
  }
  while (output.endsWith('/')) {
    output = output.slice(0, -1)
  }
  return output
}

export async function uploadToSharePoint(
  config: SharePointConfig,
  fileName: string,
  fileBuffer: Buffer,
  contentType = 'application/pdf',
): Promise<SharePointWriteResult> {
  const token = await getClientCredentialToken(
    {
      tenantId: config.tenantId,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    },
    'https://graph.microsoft.com/.default',
  )

  const fullPath = `${trimSlashes(config.folderPath)}/${fileName}`

  const endpoint = `https://graph.microsoft.com/v1.0/sites/${config.siteId}/drives/${config.driveId}/root:/${encodePathSegment(fullPath)}:/content`

  const response = await fetch(endpoint, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': contentType,
    },
    body: new Uint8Array(fileBuffer),
    signal: AbortSignal.timeout(SHAREPOINT_UPLOAD_TIMEOUT_MS),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`SharePoint upload failed (${response.status}): ${detail}`)
  }

  const payload = (await response.json()) as { id?: string; webUrl?: string }

  if (!payload.id) {
    throw new Error('SharePoint upload succeeded but response did not include file id')
  }

  return {
    itemId: payload.id,
    webUrl: payload.webUrl,
  }
}
