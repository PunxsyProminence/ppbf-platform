/** @jest-environment jsdom */

/**
 * ISSUE #1469 (N9-01A): production parity. Every string this PR moved onto
 * the one profile is pinned here exactly as main rendered it for PPBF, so the
 * move cannot change what the gym's own homepage, print sheets or interest
 * form say -- and a later edit to a profile field cannot either, unseen.
 * (Review 1 #3: the older tests pin the registry facts but only spot-check
 * the copy.)
 */

import { act, fireEvent, render } from '@testing-library/react';
import type { ReactNode } from 'react';

import HomePage, { generateMetadata } from '@/app/page';
import { OrganizationProfileProvider } from '@/components/OrganizationProfileProvider';
import PrintSheet from '@/components/PrintSheet';
import PublicInterestForm from '@/components/PublicInterestForm';
import { PPBF_PROFILE } from '@/src/testing/organizationProfileFixtures';
import { GYM_PHOTO_SLOTS, gymPhotoSlotText } from './gymPhotos';

// Browser components read the stored row through the root layout's provider (lane L31).
const withGym = (node: ReactNode) => <OrganizationProfileProvider profile={PPBF_PROFILE}>{node}</OrganizationProfileProvider>;

jest.mock('@/src/server/pilot/organizationProfileStore', () => ({
  getOperatingOrganizationProfile: async () => jest.requireActual('@/src/testing/organizationProfileFixtures').PPBF_PROFILE,
  getOperatingOrganizationProfileOrNull: async () => jest.requireActual('@/src/testing/organizationProfileFixtures').PPBF_PROFILE,
}));
jest.mock('next/link', () => ({ __esModule: true, default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

async function homeText(): Promise<{ text: string; ld: Record<string, unknown> }> {
  const { container } = render(await HomePage());
  const script = container.querySelector('script[type="application/ld+json"]');
  const ld = JSON.parse(script?.innerHTML ?? '{}') as Record<string, unknown>;
  const visible = container.cloneNode(true) as HTMLElement;
  visible.querySelectorAll('script').forEach((node) => node.remove());
  return { text: (visible.textContent ?? '').replace(/\s+/g, ' '), ld };
}

test('the homepage metadata reads as it did', async () => {
  const metadata = await generateMetadata();
  expect(metadata.title).toBe('Punxsy Prominence Boxing & Fitness');
  expect(metadata.description).toBe(
    'Punxsy Prominence Boxing and Fitness is an IRS-recognized 501(c)(3) nonprofit using structured boxing and athlete-development programming to serve youth in Punxsutawney and surrounding rural western Pennsylvania communities. Youth participate at no charge.',
  );
});

test('the homepage copy and structured data read as they did', async () => {
  const { text, ld } = await homeText();

  for (const sentence of [
    'Punxsy Prominence Boxing & Fitness is a veteran-led, IRS-recognized 501(c)(3) nonprofit serving youth in Punxsutawney and surrounding rural western Pennsylvania communities.',
    'Punxsy Prominence uses structured boxing and athlete-development programming to help young people build',
    'One building in Punxsutawney, supported by donations.',
    'Punxsy Prominence was established in 2024 and serves the Punxsutawney community with',
    'Punxsy Prominence is developing the SHADOW application',
    'Jason Neale is head coach. PPBF is a veteran-led, IRS-recognized 501(c)(3) nonprofit.',
    'Support PPBF',
    'Punxsutawney and surrounding rural Pennsylvania communities',
  ]) {
    expect(text).toContain(sentence);
  }
  expect(ld.alternateName).toBe('PPBF');
  expect((ld.areaServed as { name: string }).name).toBe('Punxsutawney and surrounding rural Pennsylvania communities');
});

test('the print sheet names and addresses the gym as it did', () => {
  const { container } = render(withGym(<PrintSheet eyebrow="Certificate" title="Ten rounds" footNote="Printed today">body</PrintSheet>));
  expect(container.querySelector('.print-sheet-gym')?.textContent).toBe('Punxsy Prominence Boxing & Fitness');
  expect(container.querySelector('.print-sheet-address')?.textContent).toBe('220 N Jefferson St, Punxsutawney, PA 15767');
  expect(container.textContent).toContain('Punxsy Prominence Boxing & Fitness');
  expect(container.textContent).toContain('220 N Jefferson St, Punxsutawney, PA 15767');
});

test('the entrance photo caption and alt text read as they did', () => {
  const entrance = GYM_PHOTO_SLOTS.find((slot) => slot.key === 'entrance');
  expect(entrance).toBeDefined();
  const text = gymPhotoSlotText(entrance!, PPBF_PROFILE);
  expect(text.caption).toBe('220 N Jefferson St. What you are looking for when you pull up the first time.');
  expect(text.alt).toBe('Illustration of the entrance to the gym at 220 N Jefferson St, Punxsutawney — a placeholder until the real photograph is taken.');
});

test('the interest form points a visitor at the gym as it did when sending fails', async () => {
  global.fetch = jest.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
  const { container } = render(withGym(<PublicInterestForm />));
  fireEvent.change(container.querySelector('input[type="text"], input:not([type])') as HTMLInputElement, { target: { value: 'Sam Rivera' } });
  const email = container.querySelector('input[type="email"]') as HTMLInputElement | null;
  if (email) fireEvent.change(email, { target: { value: 'sam@example.com' } });
  await act(async () => {
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
  });

  expect(container.textContent).toContain('The connection dropped and this was not sent. Try again, or just come by: 220 N Jefferson St, Punxsutawney, PA 15767.');
});

// N9-01B surfaces, pinned as main rendered them for PPBF.
test('the wall and the names board name PPBF as they did', async () => {
  const realFetch = global.fetch;
  global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;
  try {
    const { default: WallDisplay } = await import('@/components/WallDisplay');
    const { default: WallOfNames } = await import('@/components/WallOfNames');
    const wall = render(withGym(<WallDisplay />)).container;
    expect(wall.querySelector('.wall-eyebrow')?.textContent).toBe('Punxsy Prominence Boxing & Fitness');
    expect(wall.querySelector('.wall-standing-crest')?.textContent).toBe('PPBF');
    const names = render(withGym(<WallOfNames />)).container;
    expect(names.querySelector('.wall-names-eyebrow')?.textContent).toBe('Punxsy Prominence Boxing & Fitness');

    const wallPage = await import('@/app/wall/page');
    const namesPage = await import('@/app/names/page');
    expect((await wallPage.generateMetadata()).description).toBe('Punxsy Prominence Boxing and Fitness — the board on the gym floor.');
    expect((await namesPage.generateMetadata()).description).toBe('Everyone who has come through Punxsy Prominence Boxing and Fitness.');
  } finally {
    global.fetch = realFetch;
  }
});
