/**
 * @jest-environment jsdom
 */

// Staff and volunteers have no PIN fallback, so this page is the only way an
// invited one of them can reach anything at all. The links on it are therefore
// load-bearing: a link to a surface their role cannot open is a dead end with
// no way back.

import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';

import WorkspacePage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('@/components/ShadowChatButton', () => ({
  __esModule: true,
  default: () => <span>shadow chat button</span>,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn() }),
}));

// Surfaces whose API allowlists exclude 'staff' and 'volunteer'. Linking any
// of these would hand an invited volunteer a 403.
const FORBIDDEN_HREF_PREFIXES = [
  '/admin',
  '/board',
  '/coach',
  '/athlete',
  '/parent',
  '/schedule',
  '/guardian',
  '/evidence',
  '/audit',
  '/source-control',
];

const originalFetch = global.fetch;

function fetchMock(notices: unknown[] = []) {
  return jest.fn(async (url: string) => {
    if (url.includes('/api/pilot/auth/session')) {
      return {
        ok: true,
        json: async () => ({
          authenticated: true,
          role: 'volunteer',
          account_id: 'vol@example.com',
          organization_id: 'ppbf-default-org',
          auth_provider: 'microsoft',
          must_change_pin: false,
        }),
      } as Response;
    }

    if (url.includes('/api/pilot/announcements/get')) {
      return { ok: true, json: async () => ({ ok: true, announcements: notices }) } as Response;
    }

    throw new Error(`unexpected request: ${url}`);
  });
}

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

it('shows the signed-in identity and organization from the server session', async () => {
  global.fetch = fetchMock() as unknown as typeof fetch;

  render(<WorkspacePage />);

  await waitFor(() => expect(screen.getByText('vol@example.com')).toBeTruthy());
  expect(screen.getByText('ppbf-default-org')).toBeTruthy();
  expect(screen.getAllByText('Volunteer').length).toBeGreaterThan(0);
});

it('lists the organization gym notices the role can read', async () => {
  global.fetch = fetchMock([
    {
      announcement_id: 'a-1',
      message: 'Open gym moves to 6pm on Thursday.',
      author_name: 'Coach Rivera',
      author_role: 'coach',
      created_at: '2026-07-30T12:00:00.000Z',
    },
  ]) as unknown as typeof fetch;

  render(<WorkspacePage />);

  await waitFor(() => expect(screen.getByText('Open gym moves to 6pm on Thursday.')).toBeTruthy());
});

it('says so plainly when notices cannot be loaded instead of showing an empty gym', async () => {
  global.fetch = jest.fn(async (url: string) => {
    if (url.includes('/api/pilot/auth/session')) {
      return { ok: true, json: async () => ({ authenticated: true, role: 'staff' }) } as Response;
    }
    return { ok: false, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;

  render(<WorkspacePage />);

  await waitFor(() => expect(screen.getByText('Gym notices are temporarily unavailable.')).toBeTruthy());
});

it('links only to surfaces a staff or volunteer session is authorized for', async () => {
  global.fetch = fetchMock() as unknown as typeof fetch;

  const { container } = render(<WorkspacePage />);
  await waitFor(() => expect(screen.getByText('vol@example.com')).toBeTruthy());

  const hrefs = [...container.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href') ?? '');

  expect(hrefs).toContain('/shadow');
  expect(hrefs.length).toBeGreaterThan(0);
  for (const href of hrefs) {
    for (const prefix of FORBIDDEN_HREF_PREFIXES) {
      expect(href.startsWith(prefix)).toBe(false);
    }
  }
});
