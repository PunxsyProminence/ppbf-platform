import { getClientCredentialToken } from './auth'
import type { DataverseWriteResult, ProcessedPdfPayload } from './types'

export interface DataverseConfig {
  orgUrl: string
  tableName: string
  tenantId: string
  clientId: string
  clientSecret: string
}

function parseEntityIdHeader(value: string | null): string {
  if (!value) {
    return ''
  }

  const openIndex = value.lastIndexOf('(')
  const closeIndex = value.lastIndexOf(')')

  if (openIndex === -1 || closeIndex === -1 || closeIndex <= openIndex + 1) {
    return ''
  }

  return value.slice(openIndex + 1, closeIndex)
}

function buildAnnotationNotetext(payload: ProcessedPdfPayload): string {
  const maxExtractLength = 6000
  const extract = payload.extractedText.slice(0, maxExtractLength)
  const data = {
    source: payload.source,
    uploadedAt: payload.uploadedAt,
    detectedType: payload.classification.detectedType,
    confidence: payload.classification.confidence,
    destination: payload.classification.destination,
    destinationRoute: payload.classification.destinationRoute,
    reason: payload.classification.reason,
    extractedTextPreview: extract,
  }

  return JSON.stringify(data, null, 2)
}

export async function writeDataverseRecord(
  config: DataverseConfig,
  payload: ProcessedPdfPayload,
  pdfBase64: string,
): Promise<DataverseWriteResult> {
  const token = await getClientCredentialToken(
    {
      tenantId: config.tenantId,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    },
    `${config.orgUrl}/.default`,
  )

  const tableName = config.tableName.trim().toLowerCase() || 'annotations'

  let body: Record<string, string>
  if (tableName === 'annotations') {
    body = {
      subject: `PPBF Intake: ${payload.fileName}`,
      notetext: buildAnnotationNotetext(payload),
      filename: payload.fileName,
      mimetype: payload.mimeType,
      documentbody: pdfBase64,
    }
  } else {
    body = {
      ppbf_name: payload.fileName,
      ppbf_source: payload.source,
      ppbf_detectedtype: payload.classification.detectedType,
      ppbf_confidence: payload.classification.confidence,
      ppbf_destination: payload.classification.destination,
      ppbf_destinationroute: payload.classification.destinationRoute,
      ppbf_reason: payload.classification.reason,
      ppbf_extractedpreview: payload.extractedText.slice(0, 2000),
    }
  }

  const response = await fetch(`${config.orgUrl}/api/data/v9.2/${tableName}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Dataverse write failed (${response.status}): ${detail}`)
  }

  const entityId = parseEntityIdHeader(response.headers.get('OData-EntityId'))
  const record = (await response.json().catch(() => ({}))) as Record<string, string>

  const recordId =
    entityId ||
    record.annotationid ||
    record[`${tableName}id`] ||
    record[`${tableName.slice(0, -1)}id`] ||
    ''

  return {
    tableName,
    recordId,
  }
}
