/**
 * @jest-environment jsdom
 */

// Staff and volunteers have no PIN fallback, so this page is the only way an
// invited one of them can reach anything at all. The links on it are therefore
// load-bearing: a link to a surface their role cannot open is a dead end with
// no way back.

import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';

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
  // Administration since 2026-08-26 (operationsAccess.ts). Staff and
  // volunteers are refused the hub, so a link here would be a 403 with extra
  // steps -- exactly what this list exists to stop.
  '/operations',
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

const FLOOR_CLASSES = {
  ok: true,
  read_at: '2026-11-25T23:12:00.000Z',
  classes: [{ title: 'Bag work', start_at: '2026-11-25T23:00:00.000Z', end_at: '2026-11-26T00:00:00.000Z', room: 'Ring 1', count: 3 }],
  rounds: [],
};

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

    // What is running on the floor now (lane W4-3, FN-4b): one class, with how many are here.
    if (url.includes('/api/pilot/on-the-floor/classes')) {
      return { ok: true, json: async () => FLOOR_CLASSES } as Response;
    }

    throw new Error(`unexpected request: ${url}`);
  });
}

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

/** The session has been read: the heading names the role. */
async function sessionRead() {
  await screen.findByRole('heading', { level: 1, name: 'Volunteer Workspace' });
}

/*
 * Lane AS-10, AS10-6a (app scrub OFF-18; Overwatch Q14 A on #2018): the page
 * showed the raw account id and organization id. It now shows the role in
 * words and no id, anywhere in the page (text or attribute). No server change:
 * the session route still sends both ids; the page does not print them.
 */
it('shows the role in words and neither raw id from the session', async () => {
  global.fetch = fetchMock() as unknown as typeof fetch;

  const { container } = render(<WorkspacePage />);
  await sessionRead();

  const account = screen.getByRole('heading', { level: 2, name: 'Your Account' }).closest('section') as HTMLElement;
  expect(account.querySelector('dt')?.textContent).toBe('Role');
  expect(account.querySelector('dd')?.textContent).toBe('Volunteer');
  expect(container.innerHTML).not.toContain('vol@example.com');
  expect(container.innerHTML).not.toContain('ppbf-default-org');
  expect(screen.queryByText('Signed in as')).toBeNull();
  expect(screen.queryByText('Organization')).toBeNull();
});

/*
 * The two named removals (Q14 A): the page's own "SHADOW Chat" card (the
 * SHADOW chat button in the header stays) and its own Sign out (the site
 * header's Logout stays, GlobalRoleHeader).
 */
it('has no SHADOW Chat card and no Sign out of its own; the SHADOW chat button stays', async () => {
  global.fetch = fetchMock() as unknown as typeof fetch;

  const { container } = render(<WorkspacePage />);
  await sessionRead();

  expect(screen.queryByRole('heading', { level: 3, name: 'SHADOW Chat' })).toBeNull();
  expect(container.querySelector('a[href="/shadow"]')).toBeNull();
  expect(screen.getByText('shadow chat button')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull();
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
  await sessionRead();

  const hrefs = [...container.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href') ?? '');

  expect(hrefs).toContain('/research/chat');
  expect(hrefs.length).toBeGreaterThan(0);
  for (const href of hrefs.filter((h) => !ADMITS_STAFF.includes(h))) {
    for (const prefix of FORBIDDEN_HREF_PREFIXES) {
      expect(href.startsWith(prefix)).toBe(false);
    }
  }
});

/* Lane U2 (audit UX-A A-16): two pages under /coach admit staff and
   volunteers, and their doors offer them, so the workspace links them. The
   prefix rule above is a proxy; for these two the page's own gate decides. */
const ADMITS_STAFF = ['/coach/credentials', '/coach/development'];

it.each(ADMITS_STAFF)('links %s, whose own gate admits staff and volunteers', async (href) => {
  global.fetch = fetchMock() as unknown as typeof fetch;
  const { container } = render(<WorkspacePage />);
  await sessionRead();
  expect(container.querySelector(`a[href="${href}"]`)).toBeTruthy();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  const page = fs.readFileSync(path.resolve(__dirname, '..', href.slice(1), 'page.tsx'), 'utf8');
  const gate = page.match(/allowedRoles=\{\[([^\]]*)\]\}/);
  expect(gate?.[1]).toMatch(/'staff'/);
  expect(gate?.[1]).toMatch(/'volunteer'/);
});

// Lane W4-3, FN-4b (GO on #2192, 7206014991; QH): the classes running now, and how many are here, under
// the header; and the sentence that said attendance is no part of this role, reworded as QH gives it.
describe('what is running on the floor now (lane W4-3, FN-4b)', () => {
  it('sits directly under the header, read once, with each class\'s count', async () => {
    global.fetch = fetchMock() as unknown as typeof fetch;
    render(<WorkspacePage />);
    await sessionRead();
    const line = screen.getByRole('region', { name: 'What is running on the floor' });
    expect(await within(line).findByText(/^Running now: Bag work, .+ to .+, Ring 1, 3 here$/)).toBeTruthy();
    expect(line.previousElementSibling?.tagName).toBe('HEADER');
    const reads = (global.fetch as jest.Mock).mock.calls.filter(([url]) => String(url).includes('/api/pilot/on-the-floor/classes'));
    expect(reads).toHaveLength(1);
  });

  it('says what the line above shows, in QH\'s words, and no longer that attendance is out of reach', async () => {
    global.fetch = fetchMock() as unknown as typeof fetch;
    render(<WorkspacePage />);
    await sessionRead();
    const heading = screen.getByRole('heading', { name: 'What Your Sign-In Does Not Open' });
    const text = (heading.nextElementSibling?.textContent ?? '').replace(/\s+/g, ' ').trim();
    expect(text).toBe(
      'Athlete records, the class schedule and attendance records, video, intake review, and the admin and board '
      + 'consoles are not part of staff or volunteer access. The line above shows only the classes running now and '
      + 'how many are here. If your work needs one of them, ask an organization admin to change your role rather '
      + 'than opening a page that will refuse you.',
    );
  });
});
