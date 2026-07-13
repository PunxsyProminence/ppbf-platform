import { Buffer } from 'node:buffer'

import { PDFParse } from 'pdf-parse'
import { NextResponse } from 'next/server'

import { appendIngestAudit } from '@/src/server/document-intake/audit'
import { classifyPdfText } from '@/src/server/document-intake/classifier'
import { getPipelineConfig } from '@/src/server/document-intake/config'
import { writeDataverseRecord } from '@/src/server/document-intake/dataverse'
import { uploadToGoogleDrive } from '@/src/server/document-intake/googleDrive'
import { safePdfFileName } from '@/src/server/document-intake/sanitize'
import { uploadToSharePoint } from '@/src/server/document-intake/sharepoint'
import type { DocumentIngestResult, ProcessedPdfPayload } from '@/src/server/document-intake/types'

export const runtime = 'nodejs'

function isMockModeEnabled(): boolean {
  return process.env.PPBF_INGEST_MOCK_MODE === 'true'
}

function getSource(formData: FormData): string {
  const source = formData.get('source')
  if (typeof source === 'string' && source.trim()) {
    return source.trim()
  }
  return 'Admin Upload'
}

async function extractPdfText(rawBuffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: rawBuffer })
  const result = await parser.getText()
  await parser.destroy()
  return (result.text || '').trim()
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData()
    const uploaded = formData.get('file')

    if (!(uploaded instanceof File)) {
      return NextResponse.json({ error: 'Missing file in form payload' }, { status: 400 })
    }

    if (!uploaded.name.toLowerCase().endsWith('.pdf')) {
      return NextResponse.json({ error: 'Only PDF files are accepted' }, { status: 400 })
    }

    const source = getSource(formData)
    const rawBuffer = Buffer.from(await uploaded.arrayBuffer())
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
    })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
