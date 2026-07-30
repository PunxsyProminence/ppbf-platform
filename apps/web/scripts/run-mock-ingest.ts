import { Buffer } from 'node:buffer'

import PDFDocument from 'pdfkit'
import { NextRequest } from 'next/server'

import { POST } from '../app/api/document-ingest/route'
import { PILOT_SESSION_COOKIE } from '../src/server/pilot/env'

function createMockPdfBuffer(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 36 })
    const chunks: Buffer[] = []

    doc.on('data', (chunk: Buffer | Uint8Array) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })

    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    doc.fontSize(18).text('PPBF Mock Intake Packet')
    doc.moveDown()
    doc.fontSize(12).text('coach safety training incident response checklist')
    doc.text('athlete session development route assignment progress entry')
    doc.text('board governance policy review and capability approval')

    doc.end()
  })
}

function requireSessionToken(): string {
  const token = process.env.PPBF_MOCK_INGEST_SESSION_TOKEN?.trim()
  if (!token) {
    throw new Error('PPBF_MOCK_INGEST_SESSION_TOKEN must contain an active organization-admin session token')
  }
  return token
}

async function main() {
  process.env.PPBF_INGEST_MOCK_MODE = 'true'

  const pdfBuffer = await createMockPdfBuffer()
  const file = new File([new Uint8Array(pdfBuffer)], 'mock-intake.pdf', { type: 'application/pdf' })

  const formData = new FormData()
  formData.append('file', file)
  formData.append('source', 'Mock Audit Runner')

  const request = new NextRequest('http://localhost/api/document-ingest', {
    method: 'POST',
    headers: {
      cookie: `${PILOT_SESSION_COOKIE}=${encodeURIComponent(requireSessionToken())}`,
      'content-length': String(pdfBuffer.length + 1024),
    },
    body: formData,
  })

  const response = await POST(request)
  const payload = (await response.json()) as Record<string, unknown>

  if (!response.ok) {
    throw new Error(`Mock ingest failed: ${JSON.stringify(payload)}`)
  }

  const requiredKeys = ['status', 'classification', 'dataverse', 'sharepoint', 'googleDrive']
  for (const key of requiredKeys) {
    if (!(key in payload)) {
      throw new Error(`Missing expected key in response: ${key}`)
    }
  }

  console.log('Mock ingest completed successfully.')
  console.log(JSON.stringify(payload, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
