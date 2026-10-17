/**
 * Test fixtures for the gym's stored profile (lane L31, #1469).
 *
 * PPBF_PROFILE is the operating gym's row exactly as the organization-profiles
 * migration seeds it, with the legal name from pilot.organizations. Tests that
 * pin PPBF's own text render from this, which is what the page shows once the
 * stored row is read. organizationProfilesMigration.pg.test.ts reads the seeded
 * row back through the real store and compares it with this field for field,
 * so the two cannot drift. A test fixture, never read at runtime.
 *
 * SECOND_GYM_PROFILE is a gym that shares nothing with PPBF, for leakage tests.
 */

import type { OrganizationProfile } from '@/src/shared/organizationProfile';

export const PPBF_PROFILE: OrganizationProfile = {
  brand: 'Punxsy Prominence Boxing & Fitness',
  legalName: 'Punxsy Prominence Boxing and Fitness',
  shortName: 'PPBF',
  commonName: 'Punxsy Prominence',
  ein: '99-2073622',
  url: 'https://www.punxsyprominence.org',
  domain: 'punxsyprominence.org',
  email: 'admin@punxsyprominence.org',
  donationsEmail: 'treasurer@punxsyprominence.org',
  grantsEmail: 'grants@punxsyprominence.org',
  established: '2024',
  town: 'Punxsutawney',
  serviceArea: 'Punxsutawney and surrounding rural western Pennsylvania communities',
  serviceAreaShort: 'Punxsutawney and surrounding rural Pennsylvania communities',
  physical: {
    street: '220 N Jefferson St',
    city: 'Punxsutawney',
    region: 'PA',
    postalCode: '15767',
  },
  mailing: 'PO Box 54, Big Run, PA 15715',
  headCoachName: 'Jason Neale',
};

export const SECOND_GYM_PROFILE: OrganizationProfile = {
  brand: 'Ridgeway Lantern Boxing & Fitness',
  legalName: 'Ridgeway Lantern Boxing and Fitness',
  shortName: 'RLBF',
  commonName: 'Ridgeway Lantern',
  ein: '12-3456789',
  url: 'https://www.ridgeway-lantern.example',
  domain: 'ridgeway-lantern.example',
  email: 'office@ridgeway-lantern.example',
  donationsEmail: 'give@ridgeway-lantern.example',
  grantsEmail: 'grants@ridgeway-lantern.example',
  established: '2031',
  town: 'Ridgeway',
  serviceArea: 'Ridgeway and the surrounding valley towns',
  serviceAreaShort: 'Ridgeway and nearby towns',
  physical: { street: '9 Kiln Road', city: 'Ridgeway', region: 'PA', postalCode: '15853' },
  mailing: 'PO Box 7, Ridgeway, PA 15853',
  headCoachName: 'Morgan Hale',
};
