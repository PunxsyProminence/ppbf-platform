import type { NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import {
  getAnnotationSet,
  listAnnotationEvents,
  submitAnnotationSet,
} from '@/src/server/pilot/calibration/annotations';
import { requirePrincipal } from '@/src/server/pilot/http';

import { POST } from './route';

/**
 * The one-way door.
 *
 * Two of these tests describe things that must NOT happen: a second submission
 * must not re-stamp submitted_at (which would move a set's position in the
 * submission order a blinding audit reads), and an empty set must not be
 * refused (which would teach annotators to invent an event to get past the
 * gate -- the single worst thing that could happen to this dataset).
 */

jest.mock('@/src/server/pilot/calibration/annotations', () => ({
  getAnnotationSet: jest.fn(),
  listAnnotationSetsForClip: jest.fn(),
  listAnnotationEvents: jest.fn(),
  submitAnnotationSet: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

const mockPrincipal = requirePrincipal as jest.Mock;
const mockGetSet = getAnnotationSet as jest.Mock;
const mockSubmit = submitAnnotationSet as jest.Mock;
const mockListEvents = listAnnotationEvents as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

const COACH = { accountId: 'coach-1', role: 'coach', organizationId: 'org-1' };

const OPEN_SET = {
  annotation_set_id: 'set-1',
  calibration_clip_id: 'clip-1',
  annotator_account_id: 'coach-1',
  ontology_version: 'boxing-ontology-0.1',
  status: 'in_progress',
  submitted_at: null,
};

function post(body: unknown): NextRequest {
  return new Request('http://localhost/api/pilot/calibration/annotation-set/submit', {
    method: 'POST',
    body: JSON.stringify(body),
  }) as NextRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAudit.mockResolvedValue(undefined);
});

test('submitting closes the pass and audits it without mirroring to SHADOW', async () => {
  mockPrincipal.mockResolvedValue(COACH);
  mockGetSet.mockResolvedValue(OPEN_SET);
  mockSubmit.mockResolvedValue({ ...OPEN_SET, status: 'submitted', submitted_at: '2026-08-27T10:00:00.000Z' });
  mockListEvents.mockResolvedValue([{ event_id: 'e1' }, { event_id: 'e2' }]);

  const response = await POST(post({ annotation_set_id: 'set-1' }));
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.set.status).toBe('submitted');
  expect(body.event_count).toBe(2);
  expect(mockSubmit).toHaveBeenCalledWith('org-1', 'set-1');
  expect(mockAudit.mock.calls[0][0]).toMatchObject({
    event_type: 'update',
    entity_type: 'calibration_annotation_set',
    entity_id: 'set-1',
    shadow_mirror: false,
  });
  expect(mockAudit.mock.calls[0][0].details).toMatchObject({ action: 'submit', event_count: 2 });
});

test('an empty set is a real reading and may be submitted', async () => {
  mockPrincipal.mockResolvedValue(COACH);
  mockGetSet.mockResolvedValue(OPEN_SET);
  mockSubmit.mockResolvedValue({ ...OPEN_SET, status: 'submitted', submitted_at: '2026-08-27T10:00:00.000Z' });
  mockListEvents.mockResolvedValue([]);

  const response = await POST(post({ annotation_set_id: 'set-1' }));
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.event_count).toBe(0);
});

test('a set that is already submitted is refused without touching submitted_at', async () => {
  mockPrincipal.mockResolvedValue(COACH);
  mockGetSet.mockResolvedValue({ ...OPEN_SET, status: 'submitted', submitted_at: '2026-08-01T00:00:00.000Z' });

  const response = await POST(post({ annotation_set_id: 'set-1' }));
  const body = await response.json();

  expect(response.status).toBe(403);
  expect(body.error).toContain('submitted');
  expect(mockSubmit).not.toHaveBeenCalled();
  expect(mockAudit).not.toHaveBeenCalled();
});

test('a double-click that races the update is refused rather than re-stamped', async () => {
  mockPrincipal.mockResolvedValue(COACH);
  mockGetSet.mockResolvedValue(OPEN_SET);
  // The module scopes its UPDATE to status='in_progress', so the second
  // request updates no row and returns null.
  mockSubmit.mockResolvedValue(null);

  const response = await POST(post({ annotation_set_id: 'set-1' }));

  expect(response.status).toBe(403);
  expect(mockAudit).not.toHaveBeenCalled();
});

test('one annotator cannot close another annotator\'s pass', async () => {
  mockPrincipal.mockResolvedValue(COACH);
  mockGetSet.mockResolvedValue({ ...OPEN_SET, annotator_account_id: 'coach-2' });

  const response = await POST(post({ annotation_set_id: 'set-1' }));
  const body = await response.json();

  expect(response.status).toBe(404);
  expect(body.error).not.toContain('Forbidden');
  expect(mockSubmit).not.toHaveBeenCalled();
});

test('a set in another organization is not there', async () => {
  mockPrincipal.mockResolvedValue(COACH);
  mockGetSet.mockResolvedValue(null);

  const response = await POST(post({ annotation_set_id: 'set-elsewhere' }));

  expect(response.status).toBe(404);
  expect(mockGetSet).toHaveBeenCalledWith('org-1', 'set-elsewhere');
  expect(mockSubmit).not.toHaveBeenCalled();
});

test.each(['athlete', 'parent', 'board', 'platform_owner', 'volunteer', 'staff'])(
  'a %s cannot submit anything',
  async (role) => {
    mockPrincipal.mockResolvedValue({ ...COACH, role });

    const response = await POST(post({ annotation_set_id: 'set-1' }));

    expect(response.status).toBe(403);
    expect(mockGetSet).not.toHaveBeenCalled();
  },
);

test('a missing set id is a 400 naming it', async () => {
  mockPrincipal.mockResolvedValue(COACH);

  const response = await POST(post({}));
  const body = await response.json();

  expect(response.status).toBe(400);
  expect(body.error).toContain('annotation_set_id');
});
