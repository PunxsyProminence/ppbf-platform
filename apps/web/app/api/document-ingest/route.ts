import { Buffer } from 'node:buffer'

import { PDFParse } from 'pdf-parse'
import { NextResponse, type NextRequest } from 'next/server'

import { requireRole } from '@/src/server/pilot/access'
import { appendIngestAudit } from '@/src/server/document-intake/audit'
import { classifyPdfText } from '@/src/server/document-intake/classifier'
import { getPipelineConfig } from '@/src/server/document-intake/config'
import { writeDataverseRecord } from '@/src/server/document-intake/dataverse'
import { uploadToGoogleDrive } from '@/src/server/document-intake/googleDrive'
import { safePdfFileName } from '@/src/server/document-intake/sanitize'
import { uploadToSharePoint } from '@/src/server/document-intake/sharepoint'
import type { DocumentIngestResult, ProcessedPdfPayload } from '@/src/server/document-intake/types'
import type { PilotPrincipal } from '@/src/server/pilot/auth'
import { requirePrincipal } from '@/src/server/pilot/http'

export const runtime = 'nodejs'

const MAX_PDF_BYTES = 10 * 1024 * 1024
const MAX_MULTIPART_BYTES = MAX_PDF_BYTES + 1024 * 1024
const PDF_PARSE_TIMEOUT_MS = 15_000

function isMockModeEnabled(): boolean {
  return process.env.PPBF_INGEST_MOCK_MODE === 'true'
}

function getSource(formData: FormData): string {
  const source = formData.get('source')
  if (typeof source === 'string' && source.trim()) {
    return source.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200)
  }
  return 'Admin Upload'
}

function hasPdfSignature(rawBuffer: Buffer): boolean {
  return rawBuffer.length >= 5 && rawBuffer.subarray(0, 5).toString('ascii') === '%PDF-'
}

async function appendRejectedAudit(input: {
  reason: string
  principal?: PilotPrincipal
  fileName?: string
}): Promise<void> {
  await appendIngestAudit({
    at: new Date().toISOString(),
    status: 'failure',
    fileName: input.fileName,
    message: input.reason,
    details: {
      organizationId: input.principal?.organizationId ?? null,
      uploadedByAccountId: input.principal?.accountId ?? null,
      rejected: true,
    },
  })
}

async function rejectRequest(input: {
  status: number
  error: string
  reason: string
  principal?: PilotPrincipal
  fileName?: string
}): Promise<NextResponse> {
  await appendRejectedAudit({
    reason: input.reason,
    principal: input.principal,
    fileName: input.fileName,
  })
  return NextResponse.json({ error: input.error }, { status: input.status })
}

async function extractPdfText(rawBuffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: rawBuffer })
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  try {
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('PDF extraction timed out')), PDF_PARSE_TIMEOUT_MS)
    })
    const result = await Promise.race([parser.getText(), timeout])
    return (result.text || '').trim()
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
    await parser.destroy()
  }
}

export async function POST(request: NextRequest) {
  let principal: PilotPrincipal
  try {
    principal = await requirePrincipal(request)
    requireRole(principal, ['organization_admin', 'admin'])
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message.startsWith('Unauthorized')) {
      return rejectRequest({
        status: 401,
        error: 'Unauthorized',
        reason: 'authentication_rejected',
      })
    }
    if (message.startsWith('Forbidden')) {
      return rejectRequest({
        status: 403,
        error: 'Forbidden',
        reason: 'role_rejected',
      })
    }

    await appendRejectedAudit({ reason: 'authentication_service_failure' })
    return NextResponse.json({ error: 'Authentication service unavailable' }, { status: 500 })
  }

  const contentLengthHeader = request.headers.get('content-length')
  if (!contentLengthHeader) {
    return rejectRequest({
      status: 411,
      error: 'Content-Length is required',
      reason: 'missing_content_length',
      principal,
    })
  }

  if (!/^\d+$/.test(contentLengthHeader)) {
    return rejectRequest({
      status: 400,
      error: 'Invalid Content-Length',
      reason: 'invalid_content_length',
      principal,
    })
  }

  const contentLength = Number(contentLengthHeader)
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    return rejectRequest({
      status: 400,
      error: 'Invalid Content-Length',
      reason: 'invalid_content_length',
      principal,
    })
  }

  if (contentLength > MAX_MULTIPART_BYTES) {
    return rejectRequest({
      status: 413,
      error: 'Uploaded PDF exceeds the 10 MB limit',
      reason: 'request_too_large',
      principal,
    })
  }

  try {
    const formData = await request.formData()
    const uploaded = formData.get('file')

    if (!(uploaded instanceof File)) {
      return rejectRequest({
        status: 400,
        error: 'Missing file in form payload',
        reason: 'missing_file',
        principal,
      })
    }

    const auditFileName = safePdfFileName(uploaded.name)

    if (uploaded.type !== 'application/pdf') {
      return rejectRequest({
        status: 400,
        error: 'Only application/pdf uploads are accepted',
        reason: 'invalid_mime_type',
        principal,
        fileName: auditFileName,
      })
    }

    if (uploaded.size <= 0) {
      return rejectRequest({
        status: 400,
        error: 'Uploaded PDF is empty',
        reason: 'empty_file',
        principal,
        fileName: auditFileName,
      })
    }

    if (uploaded.size > MAX_PDF_BYTES) {
      return rejectRequest({
        status: 413,
        error: 'Uploaded PDF exceeds the 10 MB limit',
        reason: 'file_too_large',
        principal,
        fileName: auditFileName,
      })
    }

    const source = getSource(formData)
    const rawBuffer = Buffer.from(await uploaded.arrayBuffer())

    if (!hasPdfSignature(rawBuffer)) {
      return rejectRequest({
        status: 400,
        error: 'Uploaded file is not a valid PDF',
        reason: 'invalid_pdf_signature',
        principal,
        fileName: auditFileName,
      })
    }

    const extractedText = await extractPdfText(rawBuffer)
    const classification = classifyPdfText(extractedText)
    const fileName = auditFileName

    const payload: ProcessedPdfPayload = {
      fileName,
      mimeType: 'application/pdf',
      byteLength: rawBuffer.byteLength,
      extractedText,
      classification,
      source,
      uploadedAt: new Date().toISOString(),
    }

    const pdfBase64 = rawBuffer.toString('base64')

    // Read ONCE, not three times as this used to. getPipelineConfig now throws
    // when a destination is configured-but-incomplete, and calling it per
    // destination meant that refusal could land after the first two writes had
    // already happened -- a partial delivery reported as a total failure.
    const pipeline = isMockModeEnabled() ? null : getPipelineConfig()

    const dataverse = isMockModeEnabled()
      ? {
          tableName: 'annotations',
          recordId: `mock-dv-${Date.now()}`,
        }
      : pipeline?.dataverse
        ? await writeDataverseRecord(pipeline.dataverse, payload, pdfBase64)
        : null

    const [sharepoint, googleDrive] = isMockModeEnabled()
      ? [
          {
            itemId: `mock-sp-${Date.now()}`,
            webUrl: `https://sharepoint.local/mock/${encodeURIComponent(fileName)}`,
          },
          {
            fileId: `mock-gd-${Date.now()}`,
            webViewLink: `https://drive.google.com/file/d/mock-${encodeURIComponent(fileName)}`,
          },
        ]
      : await Promise.all([
          pipeline?.sharepoint
            ? uploadToSharePoint(pipeline.sharepoint, fileName, rawBuffer)
            : Promise.resolve(null),
          pipeline?.googleDrive
            ? uploadToGoogleDrive(pipeline.googleDrive, fileName, rawBuffer)
            : Promise.resolve(null),
        ])

    // Named positively so the audit row and the response both state where the
    // document went, rather than leaving a reader to infer it from which
    // fields happen to be null.
    const writtenTo = [
      dataverse ? 'dataverse' : null,
      sharepoint ? 'sharepoint' : null,
      googleDrive ? 'googleDrive' : null,
    ].filter((name): name is string => name !== null)

    const result: DocumentIngestResult = {
      status: 'ok',
      fileName,
      classification,
      writtenTo,
      dataverse,
      sharepoint,
      googleDrive,
    }

    await appendIngestAudit({
      at: new Date().toISOString(),
      status: 'success',
      fileName,
      details: {
        organizationId: principal.organizationId,
        uploadedByAccountId: principal.accountId,
        destination: classification.destination,
        writtenTo,
        dataverseRecordId: dataverse?.recordId ?? null,
        sharePointItemId: sharepoint?.itemId ?? null,
        googleDriveFileId: googleDrive?.fileId ?? null,
        mockMode: isMockModeEnabled(),
      },
    })

    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown backend error'
    await appendIngestAudit({
      at: new Date().toISOString(),
      status: 'failure',
      message,
      details: {
        organizationId: principal.organizationId,
        uploadedByAccountId: principal.accountId,
      },
    })
    return NextResponse.json({ error: 'Document ingestion failed' }, { status: 500 })
  }
}
