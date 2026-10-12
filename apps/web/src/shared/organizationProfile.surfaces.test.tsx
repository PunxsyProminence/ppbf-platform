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

const SECOND_GYM: OrganizationProfile = {
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
};

jest.mock('./organizationProfile', () => {
  const actual = jest.requireActual('./organizationProfile');
  return { ...actual, currentOrganizationProfile: () => SECOND_GYM };
});

jest.mock('next/link', () => ({ __esModule: true, default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

// PPBF's own identity, in every form the old copies wrote it.
const PPBF_TRACES = [/Punxsy/i, /PPBF/, /punxsyprominence/i, /Punxsutawney/i, /220 N Jefferson/i, /99-2073622/, /Big Run/i, /15767/];

function expectNoPpbfTrace(text: string) {
  for (const trace of PPBF_TRACES) expect(text).not.toMatch(trace);
}

test('the public homepage names the second gym everywhere, in the page and in its structured data', async () => {
  const { default: HomePage, metadata } = await import('@/app/page');
  const { container } = render(<HomePage />);
  const html = container.innerHTML;

  expect(html).toContain('Ridgeway Lantern Boxing &amp; Fitness');
  expect(html).toContain('9 Kiln Road, Ridgeway, PA 15853');
  expect(html).toContain('12-3456789');
  expect(html).toContain('mailto:give@ridgeway-lantern.example');
  expect(html).toContain('Support RLBF');
  expect(html).toContain('Ridgeway and the surrounding valley towns');
  expectNoPpbfTrace(html);
  expect(metadata.title).toBe('Ridgeway Lantern Boxing & Fitness');
  expectNoPpbfTrace(JSON.stringify(metadata));
});

test('a print sheet carries the second gym\'s name and address', async () => {
  const { default: PrintSheet } = await import('@/components/PrintSheet');
  const { container } = render(<PrintSheet eyebrow="Certificate" title="Ten rounds" footNote="Printed today">body</PrintSheet>);

  expect(container.textContent).toContain('Ridgeway Lantern Boxing & Fitness');
  expect(container.textContent).toContain('9 Kiln Road, Ridgeway, PA 15853');
  expectNoPpbfTrace(container.innerHTML);
});

test('the public interest form points a visitor at the second gym\'s address when sending fails', async () => {
  const { default: PublicInterestForm } = await import('@/components/PublicInterestForm');
  global.fetch = jest.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
  const { container } = render(<PublicInterestForm />);

  fireEvent.change(screen.getByLabelText(/name/i, { selector: 'input' }), { target: { value: 'Sam Rivera' } });
  const email = container.querySelector('input[type="email"]') as HTMLInputElement | null;
  if (email) fireEvent.change(email, { target: { value: 'sam@example.com' } });
  await act(async () => {
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
  });

  expect(container.textContent).toContain('9 Kiln Road, Ridgeway, PA 15853');
  expectNoPpbfTrace(container.innerHTML);
});
