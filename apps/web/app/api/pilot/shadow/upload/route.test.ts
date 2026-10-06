// POST /api/pilot/shadow/upload: athlete intake files stay out of research.
//
// OD-2026-10-02-015 D4: "Athlete intake files stay out of research." Every
// document type this route accepts is athlete intake (shadowUploadPolicy.ts:
// registration, emergency contact, medical form, waiver, assessment, general
// intake). Until this test existed the route wrote a row to
// pilot.shadow_research_requirements for EVERY upload, with the uploaded
// file's name in its text ("Review medical_form (<file name>) and validate
// routing to ..."), and that table is listed on /research to every
// organization role -- athlete, parent, volunteer included -- because the
// row names no subject for the subject gate to narrow on. The file name is
// whatever the admin typed when saving the form, which is very often the
// child's name.
//
// So: no document type creates a research requirement, and nothing the route
// still writes beyond the intake tables carries the file name to a research
// surface. The intake records themselves (intake_cases, intake_documents,
// shadow_intake) keep the file name; that is where it belongs.
//
// Every collaborator is mocked: this is a test of what the route calls, not
// of the database. The route's own refusals (role, transport, content) are
// exercised far enough to prove the fixture reaches the write path.

import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { uploadPilotShadowFile } from '@/src/server/pilot/blob';
import { query, queryOne } from '@/src/server/pilot/db';
import { assertActorCanAccessIntakeCase, createIntakeCase, createIntakeDocument } from '@/src/server/pilot/intake';
import { emitShadowEvent } from '@/src/server/pilot/shadowEvents';
import { createShadowResearchRequirement } from '@/src/server/pilot/shadowResearch';
import { writeShadowTelemetryEvent } from '@/src/server/pilot/shadowTelemetry';
import { SHADOW_INTAKE_DOCUMENT_TYPES } from '@/src/server/pilot/shadowUploadPolicy';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/shadowReadiness', () => ({ assertShadowRuntimeReadiness: jest.fn() }));
jest.mock('@/src/server/pilot/shadowRateLimit', () => {
  const actual = jest.requireActual('@/src/server/pilot/shadowRateLimit');
  return { ...actual, enforceShadowRateLimit: jest.fn() };
});
jest.mock('@/src/server/pilot/shadowAuthority', () => {
  const actual = jest.requireActual('@/src/server/pilot/shadowAuthority');
  return { ...actual, assertShadowAuthority: jest.fn() };
});
jest.mock('@/src/server/pilot/blob', () => ({ uploadPilotShadowFile: jest.fn() }));
jest.mock('@/src/server/pilot/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('@/src/server/pilot/intake', () => {
  const actual = jest.requireActual('@/src/server/pilot/intake');
  return {
    ...actual,
    assertActorCanAccessIntakeCase: jest.fn(),
    createIntakeCase: jest.fn(),
    createIntakeDocument: jest.fn(),
  };
});
jest.mock('@/src/server/pilot/shadowEvents', () => ({ emitShadowEvent: jest.fn() }));
jest.mock('@/src/server/pilot/shadowTelemetry', () => ({ writeShadowTelemetryEvent: jest.fn() }));
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));
jest.mock('@/src/server/pilot/shadowResearch', () => ({ createShadowResearchRequirement: jest.fn() }));

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockQuery = query as jest.MockedFunction<typeof query>;
const mockQueryOne = queryOne as jest.MockedFunction<typeof queryOne>;
const mockCaseGate = assertActorCanAccessIntakeCase as jest.MockedFunction<typeof assertActorCanAccessIntakeCase>;
const mockCreateCase = createIntakeCase as jest.MockedFunction<typeof createIntakeCase>;
const mockCreateDocument = createIntakeDocument as jest.MockedFunction<typeof createIntakeDocument>;
const mockUpload = uploadPilotShadowFile as jest.MockedFunction<typeof uploadPilotShadowFile>;
const mockEmit = emitShadowEvent as jest.MockedFunction<typeof emitShadowEvent>;
const mockAudit = writePilotAuditEvent as jest.MockedFunction<typeof writePilotAuditEvent>;
const mockTelemetry = writeShadowTelemetryEvent as jest.MockedFunction<typeof writeShadowTelemetryEvent>;
const mockRequirement = createShadowResearchRequirement as jest.MockedFunction<typeof createShadowResearchRequirement>;

// A file name of the kind an admin saves a scanned form under.
const FILE_NAME = 'Jane Doe medical form.pdf';

function principal(role: PilotPrincipal['role'] = 'organization_admin'): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role,
    organizationId: 'org-real',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

// %PDF- header: validateShadowUploadContent checks the signature.
function pdfBytes(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);
}

function uploadRequest(fields: Record<string, string | Blob>, contentLength = 4096) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value);
  }
  return new NextRequest('http://localhost/api/pilot/shadow/upload', {
    method: 'POST',
    body: formData,
    headers: { 'content-length': String(contentLength) },
  });
}

function pdfUpload(documentType?: string) {
  const file = new File([pdfBytes()], FILE_NAME, { type: 'application/pdf' });
  return uploadRequest(documentType ? { file, document_type: documentType } : { file });
}

/** Every string anywhere in a value, so a name hidden in nested metadata is found too. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockUpload.mockResolvedValue(undefined as never);
  mockQuery.mockResolvedValue([] as never);
  mockCreateCase.mockResolvedValue('case-1' as never);
  mockCreateDocument.mockResolvedValue('doc-1' as never);
  mockEmit.mockResolvedValue(undefined as never);
  mockAudit.mockResolvedValue(undefined as never);
  mockTelemetry.mockResolvedValue(undefined as never);
  mockRequirement.mockResolvedValue(99 as never);
  mockCaseGate.mockResolvedValue({ found: true, submittedByAccountId: 'acct-1', subjectAthleteIds: [] });
  mockQueryOne.mockResolvedValue({ status: 'pending_review' } as never);
});

describe('POST /api/pilot/shadow/upload', () => {
  test('rejects an unauthenticated caller before any write', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));

    const response = await POST(pdfUpload());

    expect(response.status).toBe(401);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockRequirement).not.toHaveBeenCalled();
  });

  test.each(['platform_owner', 'athlete', 'parent'] as const)('refuses %s', async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal(role));

    const response = await POST(pdfUpload());

    expect(response.status).toBe(403);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  test('the fixture reaches the write path: an accepted upload lands in the intake tables', async () => {
    const response = await POST(pdfUpload('medical_form'));

    expect(response.status).toBe(202);
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockCreateCase).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-real' }));
    expect(mockCreateDocument).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-real', documentType: 'medical_form', fileName: FILE_NAME }),
    );
  });

  // OD-2026-10-02-015 D4. One case per accepted document type, so a type
  // added to the policy later is covered the day it is added.
  test.each([...SHADOW_INTAKE_DOCUMENT_TYPES])(
    'a %s upload opens no research requirement',
    async (documentType) => {
      const response = await POST(pdfUpload(documentType));

      expect(response.status).toBe(202);
      expect(mockRequirement).not.toHaveBeenCalled();
    },
  );

  test('the default document type (none named) opens no research requirement either', async () => {
    const response = await POST(pdfUpload());

    expect(response.status).toBe(202);
    expect(mockRequirement).not.toHaveBeenCalled();
  });

  test('no audit row claims a research requirement was opened', async () => {
    await POST(pdfUpload('waiver_consent'));

    const eventTypes = mockAudit.mock.calls.map(([event]) => event.event_type);
    expect(eventTypes).not.toContain('shadow_research_upload_requirement');
    expect(eventTypes).toEqual(expect.arrayContaining(['shadow_classification', 'shadow_routing']));
  });

  // The telemetry dimensions are read by metrics; they never carried the file
  // name and must not start to.
  test('telemetry carries the document type, not the file name', async () => {
    await POST(pdfUpload('athlete_registration'));

    expect(mockTelemetry).toHaveBeenCalledTimes(1);
    const [event] = mockTelemetry.mock.calls[0];
    expect(event.dimensions).toMatchObject({ document_type: 'athlete_registration' });
    expect(strings(event.dimensions).some((text) => text.includes('Jane Doe'))).toBe(false);
  });

  test('the file name still reaches the intake record and the SHADOW event, which are intake surfaces', async () => {
    await POST(pdfUpload('general_intake'));

    expect(mockCreateDocument).toHaveBeenCalledWith(expect.objectContaining({ fileName: FILE_NAME }));
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: 'SHADOW_UPLOAD_CLASSIFIED_AND_ROUTED' }),
    );
  });

  // CL-A9 / CL-C18: a caller-supplied intake_case_id used to be inserted as
  // is. Any coach could file a document onto any case in the gym -- another
  // coach's athlete, or a case already approved or promoted -- and an id that
  // named no case in this gym failed at the foreign key as a 500 AFTER the
  // file was already in blob storage. The case is now checked first, with the
  // same gate every intake-case read uses, and the blob is written only after.
  describe('attaching to an existing intake case (CL-A9, CL-C18)', () => {
    const CASE_ID = '11111111-1111-4111-8111-111111111111';

    function attachUpload() {
      const file = new File([pdfBytes()], FILE_NAME, { type: 'application/pdf' });
      return uploadRequest({ file, intake_case_id: CASE_ID });
    }

    test('refuses a case about an athlete the coach cannot reach, before the blob is written', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
      mockCaseGate.mockRejectedValueOnce(new Error('Forbidden: coach not assigned to athlete'));

      const response = await POST(attachUpload());

      expect(response.status).toBe(403);
      expect(mockCaseGate).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 'acct-1', role: 'coach' }),
        'org-real',
        CASE_ID,
      );
      expect(mockUpload).not.toHaveBeenCalled();
      expect(mockCreateDocument).not.toHaveBeenCalled();
    });

    test('a case id that names no case in this organization is a 404, before the blob is written', async () => {
      mockCaseGate.mockResolvedValueOnce({ found: false, submittedByAccountId: null, subjectAthleteIds: [] });

      const response = await POST(attachUpload());

      expect(response.status).toBe(404);
      expect(mockUpload).not.toHaveBeenCalled();
      expect(mockCreateDocument).not.toHaveBeenCalled();
    });

    test.each(['approved', 'rejected', 'promoted'])(
      'refuses a case already %s, before the blob is written',
      async (status) => {
        mockQueryOne.mockResolvedValueOnce({ status } as never);

        const response = await POST(attachUpload());

        expect(response.status).toBe(409);
        expect(mockUpload).not.toHaveBeenCalled();
        expect(mockCreateDocument).not.toHaveBeenCalled();
      },
    );

    test('a reachable pending case takes the document and no new case is opened', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

      const response = await POST(attachUpload());

      expect(response.status).toBe(202);
      expect(mockUpload).toHaveBeenCalledTimes(1);
      expect(mockCreateCase).not.toHaveBeenCalled();
      expect(mockCreateDocument).toHaveBeenCalledWith(expect.objectContaining({ intakeCaseId: CASE_ID }));
    });

    test('an upload that names no case opens its own and runs no case gate', async () => {
      const response = await POST(pdfUpload('general_intake'));

      expect(response.status).toBe(202);
      expect(mockCaseGate).not.toHaveBeenCalled();
      expect(mockCreateCase).toHaveBeenCalledTimes(1);
    });
  });
});
