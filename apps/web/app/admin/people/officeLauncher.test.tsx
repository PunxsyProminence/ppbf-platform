/**
 * @jest-environment jsdom
 */

// Lane AS-10, PR AS10-2b (app scrub OFF-05; plan #2018 Q4 A).
//
// The office pages that the Capabilities header used to launch are on Gym
// Office, grouped by the admin's job sections (AS-4, components/jobBars.ts), in
// the bar's order. Each link says its door's label, which is the title of the
// page it opens. The names and the order are read from JOB_BARS and BUILDING,
// never retyped here, so a renamed section or door turns this suite red.
//
// Gym Setup is not repeated: Gym Office's header already links it (AS10-1).
// Video Analysis, Drill Library, Waivers & Consent and System sit in no admin
// section; where they go is Overwatch's Q19 on #2018, so they stay on
// Capabilities until it is answered.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';

import PeopleConsolePage from './page';
import { BUILDING } from '@/components/buildingMap';
import { JOB_BARS } from '@/components/jobBars';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

const mockIsOrganizationAdmin = jest.fn(() => true);
jest.mock('@/components/usePilotSession', () => ({
  usePilotSession: () => ({ loading: false, role: 'organization_admin', accountId: 'admin-1', authProvider: 'microsoft' }),
  isOrganizationAdminSessionRole: () => mockIsOrganizationAdmin(),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, className }: { readonly children: ReactNode; readonly href: string; readonly className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  mockIsOrganizationAdmin.mockReturnValue(true);
});

function quietFetch() {
  return jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, items: [], members: [], guardian_links: [] }) }) as Response);
}

/** The launcher links that moved (Capabilities' header, main 9dde6e5, :1519-:1605), by href. */
const MOVED = [
  '/admin/athletes', '/admin/export', '/admin/import', '/admin/gear', '/admin/customize', '/operations', '/admin/compliance-center',
];

/** What the admin's bar says: each section holding a moved page, with those pages in the bar's order. */
const EXPECTED = (JOB_BARS.admin?.sections ?? [])
  .map((section) => ({
    label: section.label,
    links: section.items
      .filter((item) => MOVED.includes(item.href))
      .map((item) => ({ href: item.href, label: BUILDING.find((door) => door.href === item.href)?.label })),
  }))
  .filter((group) => group.links.length > 0);

const APP = path.resolve(__dirname, '..', '..');

/** Each <h1> on a page, tags dropped, &amp; read as &. */
function titles(href: string): string[] {
  const source = readFileSync(path.join(APP, ...href.split('/').filter(Boolean), 'page.tsx'), 'utf8');
  return [...source.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim());
}

test('every moved page sits in an admin job section and has a door label', () => {
  expect(EXPECTED.flatMap((group) => group.links.map((link) => link.href)).sort()).toEqual([...MOVED].sort());
  for (const group of EXPECTED) for (const link of group.links) expect(link.label).toBeTruthy();
  expect(EXPECTED.map((group) => group.label)).toEqual(['Members & staff', 'Safety', 'Classes & floor', 'Office']);
});

test.each(MOVED)("the label for %s is a title on that page", (href) => {
  const label = BUILDING.find((door) => door.href === href)?.label;
  expect(titles(href)).toContain(label);
});

test('Gym Office lists the office pages under the admin job sections, in the bar order', async () => {
  global.fetch = quietFetch() as never;
  render(<PeopleConsolePage />);
  const nav = await screen.findByRole('navigation', { name: 'Office pages' });

  const groups = within(nav).getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
  expect(groups).toEqual(EXPECTED.map((group) => group.label));

  const links = within(nav).getAllByRole('link').map((link) => ({ href: link.getAttribute('href'), label: link.textContent }));
  expect(links).toEqual(EXPECTED.flatMap((group) => group.links));
});

test('each link sits under its own section heading', async () => {
  global.fetch = quietFetch() as never;
  render(<PeopleConsolePage />);
  const nav = await screen.findByRole('navigation', { name: 'Office pages' });
  for (const group of EXPECTED) {
    const section = within(nav).getByRole('group', { name: group.label });
    expect(within(section).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(group.links.map((link) => link.href));
  }
});

test('Gym Setup is linked once, from the header, not repeated in the office pages', async () => {
  global.fetch = quietFetch() as never;
  render(<PeopleConsolePage />);
  const nav = await screen.findByRole('navigation', { name: 'Office pages' });
  expect(within(nav).queryByRole('link', { name: 'Gym Setup' })).toBeNull();
  expect(document.querySelectorAll('a[href="/admin/setup"]')).toHaveLength(1);
});

test('a platform owner, who is shown the wrong-role notice on Gym Office, gets no office pages', async () => {
  mockIsOrganizationAdmin.mockReturnValue(false);
  global.fetch = quietFetch() as never;
  render(<PeopleConsolePage />);
  await screen.findByRole('heading', { level: 1 });
  expect(screen.queryByRole('navigation', { name: 'Office pages' })).toBeNull();
  for (const href of MOVED) expect(document.querySelectorAll(`a[href="${href}"]`)).toHaveLength(0);
});
