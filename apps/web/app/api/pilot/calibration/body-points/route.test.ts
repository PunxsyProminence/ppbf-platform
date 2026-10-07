import type { NextRequest } from 'next/server';

import { getAnnotationSet } from '@/src/server/pilot/calibration/annotations';
import { listBodyDataForSet, listMissingBodyData } from '@/src/server/pilot/calibration/bodyPoints';
import { requirePrincipal } from '@/src/server/pilot/http';

import { GET } from './route';

/**
 * The read of one annotator's own marks. The one thing that matters here is
 * that the set reaching the module is the CALLER'S: another annotator's set is
 * reported absent and the module is never asked about it.
 */

jest.mock('@/src/server/pilot/calibration/annotations', () => ({
  getAnnotationSet: jest.fn(),
  listAnnotationSetsForClip: jest.fn(),
}));

jest.mock('@/src/server/pilot/calibration/bodyPoints', () => ({
  listBodyDataForSet: jest.fn(),
  listMissingBodyData: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

const mockPrincipal = requirePrincipal as jest.Mock;
const mockGetSet = getAnnotationSet as jest.Mock;
const mockList = listBodyDataForSet as jest.Mock;
const mockMissing = listMissingBodyData as jest.Mock;

const COACH = { accountId: 'coach-1', role: 'coach', organizationId: 'org-1' };
const OWN_SET = {
  organization_id: 'org-1',
  annotation_set_id: 'set-1',
  calibration_clip_id: 'clip-1',
  annotator_account_id: 'coach-1',
  ontology_version: 'boxing-ontology-0.4',
  status: 'in_progress',
  submitted_at: null,
};

function get(setId?: string): NextRequest {
  const url = setId === undefined
    ? 'http://localhost/api/pilot/calibration/body-points'
    : `http://localhost/api/pilot/calibration/body-points?annotation_set_id=${setId}`;
  return new Request(url) as NextRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockList.mockResolvedValue({ expected_points: ['nose'], moments: [{ body_moment_id: 'm1', points: [] }], stance_labels: [] });
  mockMissing.mockResolvedValue(['evt-1: stance type']);
});

test('the caller\'s own set, submitted or not, reads with its marks and what is still missing', async () => {
  mockPrincipal.mockResolvedValue(COACH);
  mockGetSet.mockResolvedValue({ ...OWN_SET, status: 'submitted' });

  const response = await GET(get('set-1'));
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.expected_points).toEqual(['nose']);
  expect(body.moments).toHaveLength(1);
  expect(body.missing).toEqual(['evt-1: stance type']);
  expect(mockList).toHaveBeenCalledWith('org-1', 'set-1');
  expect(response.headers.get('cache-control')).toContain('no-store');
});

test('another annotator\'s set is absent, and the module is never asked', async () => {
  mockPrincipal.mockResolvedValue(COACH);
  mockGetSet.mockResolvedValue({ ...OWN_SET, annotator_account_id: 'coach-2' });

  const response = await GET(get('set-1'));
  const body = await response.json();

  expect(response.status).toBe(404);
  expect(body.error).not.toContain('Forbidden');
  expect(mockList).not.toHaveBeenCalled();
  expect(mockMissing).not.toHaveBeenCalled();
});

test('a set in another organization is absent', async () => {
  mockPrincipal.mockResolvedValue(COACH);
  mockGetSet.mockResolvedValue(null);

  const response = await GET(get('set-elsewhere'));

  expect(response.status).toBe(404);
  expect(mockGetSet).toHaveBeenCalledWith('org-1', 'set-elsewhere');
  expect(mockList).not.toHaveBeenCalled();
});

test.each(['athlete', 'parent', 'board', 'platform_owner', 'volunteer', 'staff'])('a %s cannot read any marks', async (role) => {
  mockPrincipal.mockResolvedValue({ ...COACH, role });

  const response = await GET(get('set-1'));

  expect(response.status).toBe(403);
  expect(mockGetSet).not.toHaveBeenCalled();
});

test('an organization admin reads their own set', async () => {
  mockPrincipal.mockResolvedValue({ ...COACH, role: 'organization_admin' });
  mockGetSet.mockResolvedValue(OWN_SET);

  const response = await GET(get('set-1'));

  expect(response.status).toBe(200);
});

test('no session is a 401', async () => {
  mockPrincipal.mockRejectedValue(new Error('Unauthorized'));

  const response = await GET(get('set-1'));

  expect(response.status).toBe(401);
});

test('a missing set id is a 400 naming it', async () => {
  mockPrincipal.mockResolvedValue(COACH);

  const response = await GET(get());
  const body = await response.json();

  expect(response.status).toBe(400);
  expect(body.error).toContain('annotation_set_id');
});
