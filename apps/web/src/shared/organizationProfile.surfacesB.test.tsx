/** @jest-environment jsdom */

/**
 * ISSUE #1469 (N9-01B; lane L31): the wall and the names board name the gym
 * from its stored profile, handed down by the root layout's provider, and
 * their pages describe it from the same row. A second gym's profile replaces
 * every one of them with no PPBF trace; with no profile they name no gym at
 * all. PPBF's own text is pinned in organizationProfile.ppbf.test.tsx.
 */

import { render } from '@testing-library/react';
import type { ReactNode } from 'react';

import { OrganizationProfileProvider } from '@/components/OrganizationProfileProvider';
import { SECOND_GYM_PROFILE } from '@/src/testing/organizationProfileFixtures';

jest.mock('@/src/server/pilot/organizationProfileStore', () => ({
  getOperatingOrganizationProfileOrNull: jest.fn(async () => jest.requireActual('@/src/testing/organizationProfileFixtures').SECOND_GYM_PROFILE),
}));

const PPBF_TRACES = [/Punxsy/i, /PPBF/, /punxsyprominence/i, /Punxsutawney/i, /Neale/i];

function expectNoPpbfTrace(text: string) {
  for (const trace of PPBF_TRACES) expect(text).not.toMatch(trace);
}

const withGym = (node: ReactNode, gym = SECOND_GYM_PROFILE) => (
  <OrganizationProfileProvider profile={gym}>{node}</OrganizationProfileProvider>
);

const realFetch = global.fetch;
beforeEach(() => {
  global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;
});
afterAll(() => {
  global.fetch = realFetch;
});

test('the wall names the second gym in its eyebrow and its standing crest', async () => {
  const { default: WallDisplay } = await import('@/components/WallDisplay');
  const { container } = render(withGym(<WallDisplay />));

  expect(container.textContent).toContain('Ridgeway Lantern Boxing & Fitness');
  expect(container.querySelector('.wall-standing-crest')?.textContent?.trim()).toBe('RLBF');
  expectNoPpbfTrace(container.innerHTML);
});

test('the names board names the second gym', async () => {
  const { default: WallOfNames } = await import('@/components/WallOfNames');
  const { container } = render(withGym(<WallOfNames />));

  expect(container.textContent).toContain('Ridgeway Lantern Boxing & Fitness');
  expectNoPpbfTrace(container.innerHTML);
});

test('with no readable profile, the wall and the names board name no gym', async () => {
  const { default: WallDisplay } = await import('@/components/WallDisplay');
  const { default: WallOfNames } = await import('@/components/WallOfNames');
  const wall = render(<OrganizationProfileProvider profile={null}><WallDisplay /></OrganizationProfileProvider>).container;
  expect(wall.querySelector('.wall-standing-crest')).toBeNull();
  expect(wall.querySelector('.wall-eyebrow')?.textContent?.trim()).toBe('');
  const names = render(<OrganizationProfileProvider profile={null}><WallOfNames /></OrganizationProfileProvider>).container;
  expect(names.querySelector('.wall-names-eyebrow')).toBeNull();
  expectNoPpbfTrace(wall.innerHTML + names.innerHTML);
});

test('the wall and names pages describe the second gym, and leave the description out without a profile', async () => {
  const wall = await import('@/app/wall/page');
  const names = await import('@/app/names/page');

  expect((await wall.generateMetadata()).description).toBe('Ridgeway Lantern Boxing and Fitness — the board on the gym floor.');
  expect((await names.generateMetadata()).description).toBe('Everyone who has come through Ridgeway Lantern Boxing and Fitness.');

  const store = jest.requireMock('@/src/server/pilot/organizationProfileStore') as { getOperatingOrganizationProfileOrNull: jest.Mock };
  store.getOperatingOrganizationProfileOrNull.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
  const bare = await wall.generateMetadata();
  expect(bare.title).toBe('The Wall');
  expect(bare).not.toHaveProperty('description');
  expect(await names.generateMetadata()).not.toHaveProperty('description');
});
