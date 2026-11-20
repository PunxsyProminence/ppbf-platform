/**
 * @jest-environment jsdom
 */

// This route used to render fabricated safety escalations behind a live
// organization_admin guard, then a signpost to the real queue. Lane BT,
// BOA-23: it now redirects to /admin/escalations, after the same gate, and
// renders nothing of its own.

import { requirePageRole } from '@/src/server/pilot/pageGuard';
import { redirect } from 'next/navigation';

import DirectorDashboardPage from './page';

jest.mock('@/src/server/pilot/pageGuard', () => ({
  requirePageRole: jest.fn(async () => undefined),
}));

jest.mock('next/navigation', () => ({
  redirect: jest.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
}));

const mockRequirePageRole = jest.mocked(requirePageRole);
const mockRedirect = jest.mocked(redirect);

afterEach(() => {
  jest.clearAllMocks();
});

test('an organization admin is sent to the escalation queue, after the gate', async () => {
  await expect(DirectorDashboardPage()).rejects.toThrow('NEXT_REDIRECT');

  expect(mockRequirePageRole).toHaveBeenCalledWith(['organization_admin']);
  expect(mockRedirect).toHaveBeenCalledWith('/admin/escalations');
  expect(mockRequirePageRole.mock.invocationCallOrder[0]).toBeLessThan(mockRedirect.mock.invocationCallOrder[0]);
});

test('a refused visitor is stopped by the gate and never reaches the redirect', async () => {
  mockRequirePageRole.mockRejectedValueOnce(new Error('NEXT_REDIRECT /login'));

  await expect(DirectorDashboardPage()).rejects.toThrow('NEXT_REDIRECT /login');
  expect(mockRedirect).not.toHaveBeenCalled();
});
