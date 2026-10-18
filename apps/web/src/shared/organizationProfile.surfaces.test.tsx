/** @jest-environment jsdom */

/**
 * ISSUE #1469 (N9-01A): every surface in this PR names the gym from its one
 * profile. Swapping the profile for a second gym's must change each of them,
 * and leave no trace of PPBF's own identity behind -- the leak a hard-coded
 * copy would cause. The existing page, print and form tests still pin PPBF's
 * facts unchanged, which is the proof that production renders as before.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

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

import { OrganizationProfileProvider } from '@/components/OrganizationProfileProvider';
import { PPBF_TRACES } from '@/src/testing/organizationProfileFixtures';

// Server pages read the stored profile (lane L31); browser components get it from the layout's
// provider, rendered around them below.
jest.mock('@/src/server/pilot/organizationProfileStore', () => ({
  getOperatingOrganizationProfile: async () => mockSecondGym,
  // The real module loads pg, which jsdom cannot; the layout only needs the class to compare with.
  OrganizationProfileUnavailableError: class OrganizationProfileUnavailableError extends Error {},
}));

// The root layout's own imports, so its metadata can be read here.
jest.mock('@/app/globals.css', () => ({}));
jest.mock('next/font/local', () => () => ({ variable: '' }));
jest.mock('@/components/GlobalRoleHeader', () => function GlobalRoleHeader() { return null; });
jest.mock('@/components/PlateVariantGround', () => function PlateVariantGround({ children }: { children: ReactNode }) { return <>{children}</>; });
jest.mock('@/components/ThemeProvider', () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));

jest.mock('next/link', () => ({ __esModule: true, default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

// PPBF's own identity, in every form the old copies wrote it.

function expectNoPpbfTrace(text: string) {
  for (const trace of PPBF_TRACES) expect(text).not.toMatch(trace);
}

test('the public homepage names the second gym everywhere, in the page and in its structured data', async () => {
  const { default: HomePage, generateMetadata } = await import('@/app/page');
  const metadata = await generateMetadata();
  const { container } = render(await HomePage());
  const html = container.innerHTML;

  expect(html).toContain('Ridgeway Lantern Boxing &amp; Fitness');
  expect(html).toContain('9 Kiln Road, Ridgeway, PA 15853');
  expect(html).toContain('12-3456789');
  expect(html).toContain('mailto:give@ridgeway-lantern.example');
  expect(html).toContain('Support RLBF');
  expect(html).toContain('Morgan Hale is head coach.');
  const ld = JSON.parse(container.querySelector('script[type="application/ld+json"]')?.innerHTML ?? '{}');
  expect(ld.founder.name).toBe('Morgan Hale');
  const headCoachCard = Array.from(container.querySelectorAll('dt')).find((dt) => /Head Coach/.test(dt.textContent ?? ''));
  expect(headCoachCard?.nextElementSibling?.textContent).toBe('Morgan Hale');
  expect(html).toContain('Ridgeway and the surrounding valley towns');
  expectNoPpbfTrace(html);
  expect(metadata.title).toBe('Ridgeway Lantern Boxing & Fitness');
  expectNoPpbfTrace(JSON.stringify(metadata));
});

test('a print sheet carries the second gym\'s name and address', async () => {
  const { default: PrintSheet } = await import('@/components/PrintSheet');
  const { container } = render(<OrganizationProfileProvider profile={mockSecondGym}><PrintSheet eyebrow="Certificate" title="Ten rounds" footNote="Printed today">body</PrintSheet></OrganizationProfileProvider>);

  expect(container.textContent).toContain('Ridgeway Lantern Boxing & Fitness');
  expect(container.textContent).toContain('9 Kiln Road, Ridgeway, PA 15853');
  expectNoPpbfTrace(container.innerHTML);
});

test('the public interest form points a visitor at the second gym\'s address when sending fails', async () => {
  const { default: PublicInterestForm } = await import('@/components/PublicInterestForm');
  global.fetch = jest.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
  const { container } = render(<OrganizationProfileProvider profile={mockSecondGym}><PublicInterestForm /></OrganizationProfileProvider>);

  fireEvent.change(screen.getByLabelText(/name/i, { selector: 'input' }), { target: { value: 'Sam Rivera' } });
  const email = container.querySelector('input[type="email"]') as HTMLInputElement | null;
  if (email) fireEvent.change(email, { target: { value: 'sam@example.com' } });
  await act(async () => {
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
  });

  expect(container.textContent).toContain('9 Kiln Road, Ridgeway, PA 15853');
  expectNoPpbfTrace(container.innerHTML);
});

test('the privacy page, the site metadata, robots and the sitemap name the second gym (lane L31)', async () => {
  const { default: PrivacyPage, generateMetadata: privacyMetadata } = await import('@/app/privacy/page');
  const { container } = render(await PrivacyPage());
  const text = (container.textContent ?? '').replace(/\s+/g, ' ');
  expect(text).toContain('Ridgeway Lantern Boxing and Fitness (EIN 12-3456789) runs this website, ridgeway-lantern.example.');
  expect(text).toContain('RLBF staff who handle new members.');
  expect(text).toContain('Ridgeway Lantern Boxing and Fitness, PO Box 7, Ridgeway, PA 15853 · office@ridgeway-lantern.example');
  expectNoPpbfTrace(container.innerHTML);
  const privacy = await privacyMetadata();
  expect(privacy.alternates?.canonical).toBe('https://www.ridgeway-lantern.example/privacy');
  expectNoPpbfTrace(JSON.stringify(privacy));

  const { generateMetadata: rootMetadata } = await import('@/app/layout');
  const root = await rootMetadata();
  expect(String(root.metadataBase)).toBe('https://www.ridgeway-lantern.example/');
  expect(root.title).toEqual({ default: 'RLBF Platform', template: '%s | RLBF Platform' });
  expectNoPpbfTrace(JSON.stringify(root));

  const { default: robots } = await import('@/app/robots');
  const { default: sitemap } = await import('@/app/sitemap');
  expect((await robots()).sitemap).toBe('https://www.ridgeway-lantern.example/sitemap.xml');
  expect(await sitemap()).toEqual([
    { url: 'https://www.ridgeway-lantern.example/' },
    { url: 'https://www.ridgeway-lantern.example/privacy' },
  ]);
});
