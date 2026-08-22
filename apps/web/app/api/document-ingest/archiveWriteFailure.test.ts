// The archive-write half of the research-archive gating contract.
//
// /api/document-ingest is the ONLY code path in this repository that writes an
// original into the governed Microsoft archive (uploadToSharePoint). Before
// this file it had no test of any kind, and neither did
// src/server/document-intake/sharepoint.ts -- so the behaviour of the whole
// route when the archive write FAILS was unpinned.
//
// The property under test: a failed archive write must not leave a completed
// record behind. Concretely, when uploadToSharePoint rejects, the route must
// refuse the request and record a FAILURE in the ingest audit. It must not
// return a success payload, and it must not write a success audit row naming
// destinations the document never reached -- which is what would make a
// document look custodied when it is not.
//
// WHAT THIS IS NOT. This does not prove anything about real SharePoint: the
// Graph call is mocked here, and this sandbox cannot reach an external service.
// It pins the ROUTE's fail-closed behaviour on the failure branch, which is the
// half that lives in this repository.
//
// SEPARATELY WORTH KNOWING, AND DELIBERATELY NOT "FIXED" HERE: the route writes
// Dataverse BEFORE it uploads to SharePoint, so a SharePoint failure leaves the
// earlier Dataverse annotation in place. That is a partial delivery, and the
// last test below states it as the current behaviour rather than asserting it
// is correct. Changing the ordering is a production-behaviour decision with an
// owner, not a thing to slip into a test file.

import { NextRequest } from 'next/server'

import { POST } from './route'
import { appendIngestAudit } from '@/src/server/document-intake/audit'
import { getPipelineConfig } from '@/src/server/document-intake/config'
import { writeDataverseRecord } from '@/src/server/document-intake/dataverse'
import { uploadToGoogleDrive } from '@/src/server/document-intake/googleDrive'
import { uploadToSharePoint } from '@/src/server/document-intake/sharepoint'
import { requirePrincipal } from '@/src/server/pilot/http'

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}))
jest.mock('@/src/server/pilot/access', () => ({
  ...jest.requireActual('@/src/server/pilot/access'),
  requireRole: jest.fn(),
}))
jest.mock('@/src/server/document-intake/audit', () => ({ appendIngestAudit: jest.fn() }))
jest.mock('@/src/server/document-intake/config', () => ({ getPipelineConfig: jest.fn() }))
jest.mock('@/src/server/document-intake/dataverse', () => ({ writeDataverseRecord: jest.fn() }))
jest.mock('@/src/server/document-intake/sharepoint', () => ({ uploadToSharePoint: jest.fn() }))
jest.mock('@/src/server/document-intake/googleDrive', () => ({ uploadToGoogleDrive: jest.fn() }))

// The real parser would need a genuinely well-formed PDF body; the route's own
// %PDF- signature check is what guards the bytes, and it runs before this.
jest.mock('pdf-parse', () => ({
  PDFParse: class {
    async getText() {
      return { text: 'Athlete registration form for the 2026 season.' }
    }

    async destroy() {
      /* no-op */
    }
  },
}))

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>
const mockAppendIngestAudit = appendIngestAudit as jest.MockedFunction<typeof appendIngestAudit>
const mockGetPipelineConfig = getPipelineConfig as jest.MockedFunction<typeof getPipelineConfig>
const mockWriteDataverseRecord = writeDataverseRecord as jest.MockedFunction<typeof writeDataverseRecord>
const mockUploadToSharePoint = uploadToSharePoint as jest.MockedFunction<typeof uploadToSharePoint>
const mockUploadToGoogleDrive = uploadToGoogleDrive as jest.MockedFunction<typeof uploadToGoogleDrive>

const PIPELINE = {
  dataverse: {
    tenantId: 't', clientId: 'c', clientSecret: 's',
    environmentUrl: 'https://example.crm.dynamics.com', tableName: 'annotations',
  },
  sharepoint: {
    tenantId: 't', clientId: 'c', clientSecret: 's',
    siteId: 'site', driveId: 'drive', folderPath: 'PPBF/Intake',
  },
  googleDrive: null,
} as unknown as ReturnType<typeof getPipelineConfig>

// The route requires a Content-Length header and refuses with 411 without one,
// BEFORE it reaches any archive write. Handing NextRequest a FormData object
// directly produces a streamed body with no such header, so the first draft of
// this file got a 411 on every call -- and both failure tests below still
// passed, because a 411 also returns non-200 and also writes a failure audit
// row. That is the exact false-green this file is supposed to be immune to, so
// the body is serialized here and its real length declared, and the failure
// tests additionally assert that the SharePoint call was actually reached.
async function ingestRequest(): Promise<NextRequest> {
  const formData = new FormData()
  // '%PDF-' signature so the route's own validation passes and execution
  // reaches the archive write, which is the thing under test.
  const pdfBytes = new Uint8Array(Buffer.from('%PDF-1.7\nminimal test document\n'))
  formData.append('file', new File([pdfBytes], 'registration.pdf', { type: 'application/pdf' }), 'registration.pdf')
  formData.append('source', 'Admin Upload')

  const encoded = new Request('http://localhost/api/document-ingest', { method: 'POST', body: formData })
  const body = Buffer.from(await encoded.arrayBuffer())

  return new NextRequest('http://localhost/api/document-ingest', {
    method: 'POST',
    headers: {
      'content-type': encoded.headers.get('content-type') as string,
      'content-length': String(body.byteLength),
    },
    body,
  })
}

/** Every audit row written during one call, in order. */
function auditRows(): Array<{ status: string; details?: Record<string, unknown> }> {
  return mockAppendIngestAudit.mock.calls.map(([row]) => row as { status: string; details?: Record<string, unknown> })
}

beforeEach(() => {
  jest.clearAllMocks()
  delete process.env.PPBF_INGEST_MOCK_MODE
  mockRequirePrincipal.mockResolvedValue({
    accountId: 'acct-admin',
    role: 'organization_admin',
    organizationId: 'org-archive',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  })
  mockGetPipelineConfig.mockReturnValue(PIPELINE)
  mockWriteDataverseRecord.mockResolvedValue({ tableName: 'annotations', recordId: 'dv-1' })
  mockUploadToGoogleDrive.mockResolvedValue(null as never)
})

describe('a failed archive write leaves no completed record', () => {
  test('a rejected SharePoint upload fails the request instead of reporting custody', async () => {
    mockUploadToSharePoint.mockRejectedValue(new Error('SharePoint upload failed (503): service unavailable'))

    const response = await POST(await ingestRequest())

    // Proves execution actually REACHED the archive write. Without this, an
    // early rejection (411, 400, 413) would satisfy the status assertion below
    // while the archive write never happened -- a test that passes for a
    // reason that has nothing to do with the behaviour it names.
    expect(mockUploadToSharePoint).toHaveBeenCalledTimes(1)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'Document ingestion failed' })
  })

  test('it records the attempt as a failure, and never as a success', async () => {
    mockUploadToSharePoint.mockRejectedValue(new Error('SharePoint upload failed (503): service unavailable'))

    await POST(await ingestRequest())

    expect(mockUploadToSharePoint).toHaveBeenCalledTimes(1)

    const rows = auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('failure')

    // The specific thing that must never happen: a success row claiming the
    // document reached destinations it did not reach.
    expect(rows.some((row) => row.status === 'success')).toBe(false)
    for (const row of rows) {
      expect(row.details?.writtenTo).toBeUndefined()
      expect(row.details?.sharePointItemId).toBeUndefined()
    }
  })

  // Positive control. Without it, a route that returned 500 unconditionally --
  // or an audit helper that only ever wrote 'failure' -- would satisfy both
  // tests above while being completely broken.
  test('a successful upload does report custody, so the two tests above are not vacuous', async () => {
    mockUploadToSharePoint.mockResolvedValue({ itemId: 'sp-item-1', webUrl: 'https://sharepoint.example/sp-item-1' })

    const response = await POST(await ingestRequest())
    expect(response.status).toBe(200)

    const payload = await response.json()
    expect(payload.status).toBe('ok')
    expect(payload.writtenTo).toContain('sharepoint')
    expect(payload.sharepoint).toEqual({ itemId: 'sp-item-1', webUrl: 'https://sharepoint.example/sp-item-1' })

    const rows = auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('success')
    expect(rows[0].details?.sharePointItemId).toBe('sp-item-1')
  })

  // Current behaviour, stated so a future reordering is a visible decision
  // rather than a silent change. Dataverse is written BEFORE the SharePoint
  // upload, so a SharePoint failure does not roll it back. Dataverse is not the
  // SHADOW Library source registry -- no source row is created by this route at
  // all -- so this is a partial delivery, not a citable record.
  test('the earlier Dataverse write is not rolled back when the archive write fails', async () => {
    mockUploadToSharePoint.mockRejectedValue(new Error('SharePoint upload failed (503): service unavailable'))

    await POST(await ingestRequest())

    expect(mockUploadToSharePoint).toHaveBeenCalledTimes(1)
    expect(mockWriteDataverseRecord).toHaveBeenCalledTimes(1)
    // Nothing in the route un-writes it, and nothing reports it to the caller
    // either: the response is the 500 asserted above.
  })
})
