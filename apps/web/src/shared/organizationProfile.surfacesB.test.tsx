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
import { PPBF_TRACES, SECOND_GYM_PROFILE } from '@/src/testing/organizationProfileFixtures';

jest.mock('@/src/server/pilot/organizationProfileStore', () => ({
  getOperatingOrganizationProfileOrNull: jest.fn(async () => jest.requireActual('@/src/testing/organizationProfileFixtures').SECOND_GYM_PROFILE),
}));


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

test('the entrance photo names the second gym’s street; without a street, or a profile, it names no address', async () => {
  const { GYM_PHOTO_SLOTS, gymPhotoSlotText } = await import('./gymPhotos');
  const entrance = GYM_PHOTO_SLOTS.find((slot) => slot.key === 'entrance')!;
  const text = gymPhotoSlotText(entrance, SECOND_GYM_PROFILE);
  expect(text.caption).toBe('9 Kiln Road. What you are looking for when you pull up the first time.');
  expect(text.alt).toBe('Illustration of the entrance to the gym at 9 Kiln Road, Ridgeway — a placeholder until the real photograph is taken.');
  expectNoPpbfTrace(`${text.caption} ${text.alt}`);

  const streetless = gymPhotoSlotText(entrance, { ...SECOND_GYM_PROFILE, physical: { street: '', city: '', region: '', postalCode: '' } });
  const none = gymPhotoSlotText(entrance, null);
  for (const plain of [streetless, none]) {
    expect(plain.caption).toBe('What you are looking for when you pull up the first time.');
    expect(plain.alt).toBe('Illustration of the entrance to the gym — a placeholder until the real photograph is taken.');
  }

  const { default: PhotoSlot } = await import('@/components/PhotoSlot');
  const { container } = render(withGym(<PhotoSlot slot={entrance} />));
  expect(container.textContent).toContain('9 Kiln Road. What you are looking for');
});

test('with no profile, a print sheet and the interest form name no gym and no address', async () => {
  const { default: PrintSheet } = await import('@/components/PrintSheet');
  const sheet = render(
    <OrganizationProfileProvider profile={null}><PrintSheet eyebrow="Certificate" title="Ten rounds" footNote="Printed today">body</PrintSheet></OrganizationProfileProvider>,
  ).container;
  expect(sheet.querySelector('.print-sheet-gym')).toBeNull();
  expect(sheet.querySelector('.print-sheet-address')).toBeNull();

  const { act, fireEvent } = await import('@testing-library/react');
  const { default: PublicInterestForm } = await import('@/components/PublicInterestForm');
  global.fetch = jest.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
  const form = render(<OrganizationProfileProvider profile={null}><PublicInterestForm /></OrganizationProfileProvider>).container;
  fireEvent.change(form.querySelector('input[type="text"], input:not([type])') as HTMLInputElement, { target: { value: 'Sam Rivera' } });
  const email = form.querySelector('input[type="email"]') as HTMLInputElement | null;
  if (email) fireEvent.change(email, { target: { value: 'sam@example.com' } });
  await act(async () => {
    fireEvent.submit(form.querySelector('form') as HTMLFormElement);
  });
  expect(form.textContent).toContain('The connection dropped and this was not sent. Try again.');
  expect(form.textContent).not.toContain('come by');
});

test('a partial address prints only the parts the profile gives', async () => {
  const { physicalAddressLine } = await import('./organizationProfile');
  expect(physicalAddressLine({ ...SECOND_GYM_PROFILE, physical: { street: '9 Kiln Road', city: '', region: '', postalCode: '' } })).toBe('9 Kiln Road');
  expect(physicalAddressLine({ ...SECOND_GYM_PROFILE, physical: { street: '9 Kiln Road', city: 'Ridgeway', region: 'PA', postalCode: '' } })).toBe('9 Kiln Road, Ridgeway, PA');
  expect(physicalAddressLine(SECOND_GYM_PROFILE)).toBe('9 Kiln Road, Ridgeway, PA 15853');
});

test('the registered-office line (sparring page) names the second gym, its name alone without a street, and nothing without a profile', async () => {
  const { GymRegisteredOfficeLine } = await import('@/components/PrintSheet');
  expect(render(withGym(<GymRegisteredOfficeLine />)).container.textContent).toBe('Ridgeway Lantern Boxing & Fitness, Registered Office: 9 Kiln Road, Ridgeway, PA 15853');
  const streetless = { ...SECOND_GYM_PROFILE, physical: { street: '', city: '', region: '', postalCode: '' } };
  expect(render(withGym(<GymRegisteredOfficeLine />, streetless)).container.textContent).toBe('Ridgeway Lantern Boxing & Fitness');
  expect(render(<OrganizationProfileProvider profile={null}><GymRegisteredOfficeLine /></OrganizationProfileProvider>).container.innerHTML).toBe('');
});
