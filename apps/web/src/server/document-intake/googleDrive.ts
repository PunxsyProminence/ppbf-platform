import { Readable } from 'node:stream'

import { google } from 'googleapis'

import type { GoogleDriveWriteResult } from './types'

export interface GoogleDriveConfig {
  serviceAccountJson: string
  /**
   * REQUIRED, and not optional as it once was.
   *
   * With no folder id the create call passed `parents: undefined`, which does
   * not fail -- it uploads into the SERVICE ACCOUNT's own Drive. No human on
   * this project has access to that storage, so the request returned 200, the
   * audit row recorded a success, and the document was gone. config.ts refuses
   * to start without this value; the guard in uploadToGoogleDrive is a second
   * lock on the same door, because this config object can also be built by a
   * caller that never went through config.ts.
   */
  folderId: string
}

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
  const folderId = config.folderId?.trim()
  if (!folderId) {
    throw new Error(
      'GOOGLE_DRIVE_FOLDER_ID is required: without a destination folder the upload '
      + 'would land in the service account\'s own Drive, where nobody can retrieve it.',
    )
  }

  const account = parseServiceAccount(config.serviceAccountJson)

  const auth = new google.auth.JWT({
    email: account.client_email,
    key: account.private_key,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  })

  const drive = google.drive({ version: 'v3', auth })

  const createResponse = await drive.files.create({
    requestBody: {
      name: fileName,
      mimeType: 'application/pdf',
      parents: [folderId],
    },
    media: {
      mimeType: 'application/pdf',
      body: Readable.from(fileBuffer),
    },
    fields: 'id,webViewLink',
    supportsAllDrives: true,
  })

  if (!createResponse.data.id) {
    throw new Error('Google Drive upload succeeded but response did not include file id')
  }

  return {
    fileId: createResponse.data.id,
    webViewLink: createResponse.data.webViewLink ?? undefined,
  }
}
