/** @jest-environment jsdom */

/**
 * ISSUE #1469 (N9-01B): the wall, the names board, the sign-in email and
 * SHADOW's prompt name the gym from its one profile. A second gym's profile
 * replaces every one of them with no PPBF trace; PPBF's own text is pinned
 * unchanged in organizationProfile.ppbf.test.tsx and the existing suites.
 */

import { render } from '@testing-library/react';

import type { OrganizationProfile } from './organizationProfile';

const mockSecondGym: OrganizationProfile = {
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

jest.mock('./organizationProfile', () => {
  const actual = jest.requireActual('./organizationProfile');
  return { ...actual, currentOrganizationProfile: () => mockSecondGym };
});

const PPBF_TRACES = [/Punxsy/i, /PPBF/, /punxsyprominence/i, /Punxsutawney/i];

function expectNoPpbfTrace(text: string) {
  for (const trace of PPBF_TRACES) expect(text).not.toMatch(trace);
}

const realFetch = global.fetch;
beforeEach(() => {
  global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;
});
afterAll(() => {
  global.fetch = realFetch;
});

test('the wall names the second gym in its eyebrow and its standing crest', async () => {
  const { default: WallDisplay } = await import('@/components/WallDisplay');
  const { container } = render(<WallDisplay />);

  expect(container.textContent).toContain('Ridgeway Lantern Boxing & Fitness');
  expect(container.querySelector('.wall-standing-crest')?.textContent?.trim()).toBe('RLBF');
  expectNoPpbfTrace(container.innerHTML);
});

test('the names board names the second gym', async () => {
  const { default: WallOfNames } = await import('@/components/WallOfNames');
  const { container } = render(<WallOfNames />);

  expect(container.textContent).toContain('Ridgeway Lantern Boxing & Fitness');
  expectNoPpbfTrace(container.innerHTML);
});

test('the wall and names pages describe the second gym', async () => {
  const wall = await import('@/app/wall/page');
  const names = await import('@/app/names/page');

  expect(wall.metadata.description).toBe('Ridgeway Lantern Boxing and Fitness — the board on the gym floor.');
  expect(names.metadata.description).toBe('Everyone who has come through Ridgeway Lantern Boxing and Fitness.');
});
