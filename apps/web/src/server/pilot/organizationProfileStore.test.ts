/**
 * The gym's profile store (lane L31, #1469): one read, of the operating gym's
 * row, mapped field for field; held 60 seconds; the last good row outlives a
 * failed read; and with no row, production refuses while every other
 * environment gets the labelled development profile -- never PPBF's facts.
 */

const mockQueryOne = jest.fn();
jest.mock('@/src/server/pilot/db', () => ({ queryOne: (...args: unknown[]) => mockQueryOne(...args) }));

import {
  clearOrganizationProfileCache,
  DEVELOPMENT_PROFILE,
  getOperatingOrganizationProfile,
  getOrganizationProfile,
  OPERATING_ORGANIZATION_ID,
  OrganizationProfileUnavailableError,
} from './organizationProfileStore';
import { PPBF_PROFILE } from '@/src/testing/organizationProfileFixtures';

const PPBF_ROW = {
  organization_name: 'Punxsy Prominence Boxing and Fitness',
  brand: 'Punxsy Prominence Boxing & Fitness',
  short_name: 'PPBF',
  common_name: 'Punxsy Prominence',
  website_url: 'https://www.punxsyprominence.org',
  domain: 'punxsyprominence.org',
  ein: '99-2073622',
  contact_email: 'admin@punxsyprominence.org',
  donations_email: 'treasurer@punxsyprominence.org',
  grants_email: 'grants@punxsyprominence.org',
  established: '2024',
  town: 'Punxsutawney',
  service_area: 'Punxsutawney and surrounding rural western Pennsylvania communities',
  service_area_short: 'Punxsutawney and surrounding rural Pennsylvania communities',
  physical_street: '220 N Jefferson St',
  physical_city: 'Punxsutawney',
  physical_region: 'PA',
  physical_postal_code: '15767',
  mailing_address: 'PO Box 54, Big Run, PA 15715',
  head_coach_name: 'Jason Neale',
};

beforeEach(() => {
  mockQueryOne.mockReset();
  clearOrganizationProfileCache();
});

test('the operating gym is punxsy_prominence, named once (OD-2026-09-28-007)', async () => {
  mockQueryOne.mockResolvedValue(PPBF_ROW);
  await getOperatingOrganizationProfile();
  expect(OPERATING_ORGANIZATION_ID).toBe('punxsy_prominence');
  expect(mockQueryOne).toHaveBeenCalledWith(expect.stringContaining('from pilot.organization_profiles p'), ['punxsy_prominence']);
});

test('the row maps field for field, with the legal name from the organization record', async () => {
  mockQueryOne.mockResolvedValue(PPBF_ROW);
  await expect(getOrganizationProfile('punxsy_prominence', { production: true })).resolves.toEqual(PPBF_PROFILE);
  const [sql] = mockQueryOne.mock.calls[0] as [string];
  expect(sql).toMatch(/join pilot\.organizations o on o\.organization_id = p\.organization_id/);
  expect(sql).toMatch(/select o\.organization_name/);
});

test('a row is held for 60 seconds, then read again', async () => {
  let clock = 1_000_000;
  const now = () => clock;
  mockQueryOne.mockResolvedValue(PPBF_ROW);
  await getOrganizationProfile('punxsy_prominence', { now, production: true });
  clock += 59_999;
  await getOrganizationProfile('punxsy_prominence', { now, production: true });
  expect(mockQueryOne).toHaveBeenCalledTimes(1);

  mockQueryOne.mockResolvedValue({ ...PPBF_ROW, contact_email: 'office@example.org' });
  clock += 2;
  const reread = await getOrganizationProfile('punxsy_prominence', { now, production: true });
  expect(mockQueryOne).toHaveBeenCalledTimes(2);
  expect(reread.email).toBe('office@example.org');
});

test('the last good row outlives a failed read', async () => {
  let clock = 0;
  const now = () => clock;
  mockQueryOne.mockResolvedValueOnce(PPBF_ROW);
  await getOrganizationProfile('punxsy_prominence', { now, production: true });
  clock += 120_000;
  mockQueryOne.mockRejectedValueOnce(new Error('connection reset'));
  await expect(getOrganizationProfile('punxsy_prominence', { now, production: true })).resolves.toEqual(PPBF_PROFILE);
});

test('production with no row, or no database, refuses with a named error', async () => {
  mockQueryOne.mockResolvedValue(null);
  await expect(getOrganizationProfile('punxsy_prominence', { production: true })).rejects.toBeInstanceOf(
    OrganizationProfileUnavailableError,
  );
  mockQueryOne.mockRejectedValue(new Error('MISSING_ENV:AZURE_POSTGRES_CONNECTION_STRING'));
  await expect(getOrganizationProfile('punxsy_prominence', { production: true })).rejects.toThrow(
    /ORGANIZATION_PROFILE_UNAVAILABLE/,
  );
});

test('outside production, no row or no database gives the development profile, which is not PPBF', async () => {
  mockQueryOne.mockResolvedValue(null);
  await expect(getOrganizationProfile('ppbf-offline-demo', { production: false })).resolves.toBe(DEVELOPMENT_PROFILE);
  mockQueryOne.mockRejectedValue(new Error('MISSING_ENV:AZURE_POSTGRES_CONNECTION_STRING'));
  await expect(getOrganizationProfile('punxsy_prominence', { production: false })).resolves.toBe(DEVELOPMENT_PROFILE);

  const text = JSON.stringify(DEVELOPMENT_PROFILE);
  for (const trace of [/Punxsy/i, /PPBF/, /punxsyprominence/i, /Punxsutawney/i, /Jefferson/i, /99-2073622/, /Big Run/i, /Neale/i]) {
    expect(text).not.toMatch(trace);
  }
  // The development profile is never cached as if it were the gym's row.
  mockQueryOne.mockResolvedValue(PPBF_ROW);
  await expect(getOrganizationProfile('punxsy_prominence', { production: false })).resolves.toEqual(PPBF_PROFILE);
});

test('the development profile still satisfies the stored rules a page depends on', () => {
  expect(DEVELOPMENT_PROFILE.url).toMatch(/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/i);
  expect(() => new URL(DEVELOPMENT_PROFILE.url)).not.toThrow();
  expect(DEVELOPMENT_PROFILE.domain).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i);
});
