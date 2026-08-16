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

/**
 * The three destinations are independently optional, so each result is null
 * when that destination is switched off.
 *
 * `null` rather than an absent key, deliberately: the key stays present so a
 * caller cannot tell "this destination is off" apart from "this build predates
 * the field" by shape alone, and `writtenTo` states the answer positively so
 * nobody has to infer it from three null checks.
 */
export interface DocumentIngestResult {
  status: 'ok'
  fileName: string
  classification: IntakeClassification
  /**
   * Destinations this document was actually written to.
   *
   * Never empty on a returned result: getPipelineConfig() refuses a pipeline
   * with no ready destination, so the request fails before any destination
   * write is attempted. Note the route reads and parses the PDF first, so the
   * refusal happens after the upload is read, not before it.
   */
  writtenTo: string[]
  dataverse: DataverseWriteResult | null
  sharepoint: SharePointWriteResult | null
  googleDrive: GoogleDriveWriteResult | null
}
