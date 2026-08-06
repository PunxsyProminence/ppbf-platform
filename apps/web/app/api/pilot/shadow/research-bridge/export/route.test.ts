import { NextRequest } from 'next/server';

import { GET } from './route';
import {
  requireResearchBridgeAccess,
  ResearchBridgeAccessError,
} from '@/src/server/pilot/researchBridgeAuth';
import { buildResearchBridgeExport } from '@/src/server/pilot/researchBridgeExport';

jest.mock('@/src/server/pilot/researchBridgeAuth', () => {
  const actual = jest.requireActual('@/src/server/pilot/researchBridgeAuth');
  return { ...actual, requireResearchBridgeAccess: jest.fn() };
});

jest.mock('@/src/server/pilot/researchBridgeExport', () => ({
  buildResearchBridgeExport: jest.fn(),
}));

const mockAccess = requireResearchBridgeAccess as jest.MockedFunction<typeof requireResearchBridgeAccess>;
const mockBuild = buildResearchBridgeExport as jest.MockedFunction<typeof buildResearchBridgeExport>;

function request() {
  return new NextRequest('https://app-ppbf-staging.example.test/api/pilot/shadow/research-bridge/export');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAccess.mockResolvedValue({ organizationId: 'org-configured' });
  mockBuild.mockResolvedValue({
    schema_version: '1',
    classification: 'sanitized-staging-only',
    generated_at: '2026-08-06T20:00:00.000Z',
    research_needs: [],
    approved_evidence: [],
  });
});

test('uses the organization established by the managed-identity token gate', async () => {
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(mockBuild).toHaveBeenCalledWith('org-configured');
  expect(response.headers.get('cache-control')).toContain('no-store');
});

test('stays hidden when the staging guard is inactive', async () => {
  mockAccess.mockRejectedValueOnce(new ResearchBridgeAccessError(404, 'Research bridge export is unavailable'));
  const response = await GET(request());
  expect(response.status).toBe(404);
  expect(mockBuild).not.toHaveBeenCalled();
});
