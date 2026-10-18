/**
 * Lane L31: the sign-in email's production dependencies carry the gym's
 * stored profile. A test of the email with the profile passed in by hand
 * cannot see this wiring dropped, and the email would quietly lose the gym's
 * name.
 */

const mockGymProfile = jest.fn();
jest.mock('./organizationProfileStore', () => ({
  getOperatingOrganizationProfileOrNull: (...args: unknown[]) => mockGymProfile(...args),
}));
jest.mock('./db', () => ({ query: jest.fn(), queryOne: jest.fn(), withTransaction: jest.fn() }));

import { magicLinkDependencies } from './magicLinkStore';
import { PPBF_PROFILE } from '@/src/testing/organizationProfileFixtures';

test('magicLinkDependencies reads the operating gym’s stored profile for the email', async () => {
  const previous = process.env.PPBF_APP_ORIGIN;
  process.env.PPBF_APP_ORIGIN = 'https://www.punxsyprominence.org';
  try {
    mockGymProfile.mockResolvedValue(PPBF_PROFILE);
    const deps = magicLinkDependencies();
    expect(deps.gymProfile).toBeDefined();
    await expect(deps.gymProfile?.()).resolves.toBe(PPBF_PROFILE);
    expect(mockGymProfile).toHaveBeenCalledTimes(1);
  } finally {
    if (previous === undefined) delete process.env.PPBF_APP_ORIGIN;
    else process.env.PPBF_APP_ORIGIN = previous;
  }
});
