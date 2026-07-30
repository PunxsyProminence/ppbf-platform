export type IntakeDestination =
  | 'Athlete Workspace'
  | 'Coach Workspace'
  | 'Parent Hub'
  | 'Admin Hub'
  | 'Board Hub'
  | 'Capability Registry'
  | 'Evidence Library'
  | 'Incident / Safety Log'
  | 'SHADOW Local State'

export interface IntakeClassification {
  detectedType: string
  confidence: 'Low' | 'Medium' | 'High'
  destination: IntakeDestination
  destinationRoute: string
  reason: string
}

export interface ProcessedPdfPayload {
  fileName: string
  mimeType: string
  byteLength: number
  extractedText: string
  classification: IntakeClassification
  source: string
  uploadedAt: string
}

export interface DataverseWriteResult {
  recordId: string
  tableName: string
}

export interface SharePointWriteResult {
  itemId: string
  webUrl?: string
}

export interface GoogleDriveWriteResult {
  fileId: string
  webViewLink?: string
}

export interface DocumentIngestResult {
  status: 'ok'
  fileName: string
  classification: IntakeClassification
  dataverse: DataverseWriteResult
  sharepoint: SharePointWriteResult
  googleDrive: GoogleDriveWriteResult
}
