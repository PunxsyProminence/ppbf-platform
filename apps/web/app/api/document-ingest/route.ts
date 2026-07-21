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
import { jsonError, requirePrincipal } from '@/src/server/pilot/http'

export const runtime = 'nodejs'

const MAX_PDF_BYTES = 10 * 1024 * 1024
const MAX_MULTIPART_BYTES = MAX_PDF_BYTES + 1024 * 1024

function isMockModeEnabled(): boolean {
  return process.env.PPBF_INGEST_MOCK_MODE === 'true'
}

function getSource(formData: FormData): string {
  const source = formData.get('source')
  if (typeof source === 'string' && source.trim()) {
    return source.trim().slice(0, 200)
  }
  return 'Admin Upload'
}

function hasPdfSignature(rawBuffer: Buffer): boolean {
  return rawBuffer.length >= 5 && rawBuffer.subarray(0, 5).toString('ascii') === '%PDF-'
}

async function extractPdfText(rawBuffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: rawBuffer })
  try {
    const result = await parser.getText()
    return (result.text || '').trim()
  } finally {
    await parser.destroy()
  }
}

export async function POST(request: NextRequest) {
  let principal
  try {
    principal = await requirePrincipal(request)
    requireRole(principal, ['organization_admin', 'admin'])
  } catch (error) {
    return jsonError(error)
  }

  const contentLength = Number.parseInt(request.headers.get('content-length') || '0', 10)
  if (Number.isFinite(contentLength) && contentLength > MAX_MULTIPART_BYTES) {
    return NextResponse.json({ error: 'Uploaded PDF exceeds the 10 MB limit' }, { status: 413 })
  }

  try {
    const formData = await request.formData()
    const uploaded = formData.get('file')

    if (!(uploaded instanceof File)) {
      return NextResponse.json({ error: 'Missing file in form payload' }, { status: 400 })
    }

    if (uploaded.type !== 'application/pdf') {
      return NextResponse.json({ error: 'Only application/pdf uploads are accepted' }, { status: 400 })
    }

    if (uploaded.size <= 0) {
      return NextResponse.json({ error: 'Uploaded PDF is empty' }, { status: 400 })
    }

    if (uploaded.size > MAX_PDF_BYTES) {
      return NextResponse.json({ error: 'Uploaded PDF exceeds the 10 MB limit' }, { status: 413 })
    }

    const source = getSource(formData)
    const rawBuffer = Buffer.from(await uploaded.arrayBuffer())

    if (!hasPdfSignature(rawBuffer)) {
      return NextResponse.json({ error: 'Uploaded file is not a valid PDF' }, { status: 400 })
    }

    const extractedText = await extractPdfText(rawBuffer)
    const classification = classifyPdfText(extractedText)
    const fileName = safePdfFileName(uploaded.name)

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

    const dataverse = isMockModeEnabled()
      ? {
          tableName: 'annotations',
          recordId: `mock-dv-${Date.now()}`,
        }
      : await writeDataverseRecord(getPipelineConfig().dataverse, payload, pdfBase64)

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
          uploadToSharePoint(getPipelineConfig().sharepoint, fileName, rawBuffer),
          uploadToGoogleDrive(getPipelineConfig().googleDrive, fileName, rawBuffer),
        ])

    const result: DocumentIngestResult = {
      status: 'ok',
      fileName,
      classification,
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
        dataverseRecordId: dataverse.recordId,
        sharePointItemId: sharepoint.itemId,
        googleDriveFileId: googleDrive.fileId,
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
