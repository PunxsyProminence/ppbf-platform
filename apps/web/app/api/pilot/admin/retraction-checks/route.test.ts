// Retraction checks are read and disposed of against the caller's own gym's
// sources, so this is gym work: the gym's admin may, the platform owner may
// not, on both verbs (OD-2026-10-08-003 R2 and PLAN-3). The domain functions'
// own reviewer check (requireEvidenceReviewer) still admits platform_owner for
// evidence review elsewhere; these tests show the route's narrower list is the
// one that decides here, before any domain function runs.

import { NextRequest } from 'next/server';

import { GET, PATCH } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  getSourceRetractionStatus,
  getSourcesNeedingRetractionCheck,
  listSourceRetractionChecks,
  recordRetractionDisposition,
  suppressSource,
  unsuppressSource,
} from '@/src/server/pilot/sourceRetractionChecks';

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));
jest.mock('@/src/server/pilot/sourceRetractionChecks', () => ({
  getSourceRetractionStatus: jest.fn(),
  getSourcesNeedingRetractionCheck: jest.fn(),
  listSourceRetractionChecks: jest.fn(),
  recordRetractionDisposition: jest.fn(),
  suppressSource: jest.fn(),
  unsuppressSource: jest.fn(),
}));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockAudit = jest.mocked(writePilotAuditEvent);
const mockStatus = jest.mocked(getSourceRetractionStatus);
const mockQueue = jest.mocked(getSourcesNeedingRetractionCheck);
const mockChecks = jest.mocked(listSourceRetractionChecks);
const mockDisposition = jest.mocked(recordRetractionDisposition);
const mockSuppress = jest.mocked(suppressSource);
const mockUnsuppress = jest.mocked(unsuppressSource);

const URL_BASE = 'http://localhost/api/pilot/admin/retraction-checks';

const READS: Array<[string, string]> = [
  ['the status view', URL_BASE],
  ['the recheck queue', `${URL_BASE}?view=queue`],
  ['one source\'s checks', `${URL_BASE}?source_id=src-1`],
];

const WRITES: Array<[string, Record<string, unknown>]> = [
  ['a disposition', {
    action: 'disposition',
    retraction_check_id: 'rc-1',
    disposition: 'keep_with_caveat',
    disposition_note: 'Correction only; the claim stands.',
  }],
  ['a suppression', { action: 'suppress', source_id: 'src-1', reason: 'Retracted.' }],
  ['an unsuppression', { action: 'unsuppress', source_id: 'src-1' }],
];

function as(role: string) {
  mockPrincipal.mockResolvedValue({
    accountId: `${role}-1`, organizationId: 'org-1', role,
  } as never);
}

function patch(body: Record<string, unknown>) {
  return new NextRequest(URL_BASE, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function expectNoDomainCall() {
  for (const mock of [mockStatus, mockQueue, mockChecks, mockDisposition, mockSuppress, mockUnsuppress]) {
    expect(mock).not.toHaveBeenCalled();
  }
  expect(mockAudit).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStatus.mockResolvedValue([] as never);
  mockQueue.mockResolvedValue([] as never);
  mockChecks.mockResolvedValue([] as never);
  mockDisposition.mockResolvedValue({
    retraction_check_id: 'rc-1', disposition: 'keep_with_caveat', source_id: 'src-1', status: 'correction',
  } as never);
  mockSuppress.mockResolvedValue(undefined as never);
  mockUnsuppress.mockResolvedValue(undefined as never);
  mockAudit.mockResolvedValue(undefined as never);
});

describe('platform owner is kept off a gym\'s retraction checks', () => {
  test.each(READS)('GET %s is refused before anything is read', async (_name, url) => {
    as('platform_owner');

    const response = await GET(new NextRequest(url));

    expect(response.status).toBe(403);
    expectNoDomainCall();
  });

  test.each(WRITES)('PATCH %s is refused before anything is written or audited', async (_name, body) => {
    as('platform_owner');

    const response = await PATCH(patch(body));

    expect(response.status).toBe(403);
    expectNoDomainCall();
  });
});

describe.each(['organization_admin', 'admin'])('the gym admin (%s) works them', (role) => {
  test.each(READS)('GET %s answers 200 for the caller\'s own gym', async (_name, url) => {
    as(role);

    const response = await GET(new NextRequest(url));

    expect(response.status).toBe(200);
    const calls = [...mockStatus.mock.calls, ...mockQueue.mock.calls, ...mockChecks.mock.calls];
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('org-1');
  });

  test('PATCH records a disposition and audits it', async () => {
    as(role);

    const response = await PATCH(patch(WRITES[0][1]));

    expect(response.status).toBe(200);
    expect(mockDisposition).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1', retractionCheckId: 'rc-1', actorRole: role,
    }));
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      organization_id: 'org-1', entity_type: 'source_retraction_check', entity_id: 'rc-1',
    }));
  });

  test('PATCH suppresses and unsuppresses a source and audits both', async () => {
    as(role);

    const suppressed = await PATCH(patch(WRITES[1][1]));
    const unsuppressed = await PATCH(patch(WRITES[2][1]));

    expect(suppressed.status).toBe(200);
    expect(unsuppressed.status).toBe(200);
    expect(mockSuppress).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1', sourceId: 'src-1', actorRole: role,
    }));
    expect(mockUnsuppress).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1', sourceId: 'src-1', actorRole: role,
    }));
    expect(mockAudit).toHaveBeenCalledTimes(2);
  });
});

// Unchanged by this lane: a coach was never on this list.
test.each(['coach', 'athlete', 'parent'])('role %s is refused on both verbs', async (role) => {
  as(role);

  expect((await GET(new NextRequest(URL_BASE))).status).toBe(403);
  expect((await PATCH(patch(WRITES[1][1]))).status).toBe(403);
  expectNoDomainCall();
});
