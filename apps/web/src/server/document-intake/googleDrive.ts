import { Readable } from 'node:stream'

import { google } from 'googleapis'

import type { GoogleDriveWriteResult } from './types'

export interface GoogleDriveConfig {
  serviceAccountJson: string
  folderId?: string
}

// A file upload (PDF bytes), not a metadata call; 30s matches the SharePoint
// upload bound for the same reason -- generous enough for an ordinary
// document, still bounding a stall instead of leaving it unbounded like the
// other three external calls in this module before this pass.
const GOOGLE_DRIVE_UPLOAD_TIMEOUT_MS = 30_000

interface ServiceAccount {
  client_email: string
  private_key: string
}

function parseServiceAccount(json: string): ServiceAccount {
  const parsed = JSON.parse(json) as ServiceAccount
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key')
  }
  return parsed
}

export async function uploadToGoogleDrive(
  config: GoogleDriveConfig,
  fileName: string,
  fileBuffer: Buffer,
): Promise<GoogleDriveWriteResult> {
  const account = parseServiceAccount(config.serviceAccountJson)

  const auth = new google.auth.JWT({
    email: account.client_email,
    key: account.private_key,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  })

  const drive = google.drive({ version: 'v3', auth })

  const createResponse = await drive.files.create(
    {
      requestBody: {
        name: fileName,
        mimeType: 'application/pdf',
        parents: config.folderId ? [config.folderId] : undefined,
      },
      media: {
        mimeType: 'application/pdf',
        body: Readable.from(fileBuffer),
      },
      fields: 'id,webViewLink',
      supportsAllDrives: true,
    },
    { timeout: GOOGLE_DRIVE_UPLOAD_TIMEOUT_MS },
  )

  if (!createResponse.data.id) {
    throw new Error('Google Drive upload succeeded but response did not include file id')
  }

  return {
    fileId: createResponse.data.id,
    webViewLink: createResponse.data.webViewLink ?? undefined,
  }
}
