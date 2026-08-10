/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import ChalkboardPage from './page';

/**
 * The staff side of the boards.
 *
 * The board hangs on dashboards that are role-gated to the people who READ them
 * -- an athlete workspace is athlete-only, a parent hub is parent-only -- so a
 * coach would never encounter the chalk. This page is the reason the composer
 * is not dead code, so it is tested as the thing that makes writing reachable.
 */

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

jest.mock('@/components/usePilotSession', () => ({
  usePilotSession: () => ({
    role: 'coach',
    organizationId: 'org-1',
    authProvider: 'microsoft',
    accountId: 'coach-1',
    mustChangePin: false,
    loading: false,
  }),
}));

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

function stubFetch(posted: Array<Record<string, unknown>>) {
  const mock = jest.fn(async (url: unknown, init?: RequestInit) => {
    const href = String(url);
    if (href.includes('/api/pilot/announcements/post')) {
      posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    return { ok: true, json: async () => ({ ok: true, announcements: [] }) } as Response;
  });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

async function renderDesk(posted: Array<Record<string, unknown>> = []) {
  const mock = stubFetch(posted);
  let container!: HTMLElement;
  await act(async () => {
    container = render(<ChalkboardPage />).container;
  });
  return { container, mock };
}

describe('the boards, from behind the desk', () => {
  it('shows every board a dashboard draws, and one composer each', async () => {
    const { container } = await renderDesk();

    expect(container.querySelectorAll('.chalkboard')).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: /write on the board/i })).toHaveLength(3);

    expect(screen.getByText('Everywhere')).toBeTruthy();
    expect(screen.getByText('The athletes’ board')).toBeTruthy();
    expect(screen.getByText('The coaches’ board')).toBeTruthy();
  });

  it('reads each board from its own placement', async () => {
    const { mock } = await renderDesk();

    const placements = (mock.mock.calls as unknown as Array<[string, RequestInit]>)
      .filter((args) => String(args[0]).includes('/api/pilot/announcements/get'))
      .map((args) => (JSON.parse(String(args[1]?.body)) as { placement: string }).placement);

    expect(placements.sort()).toEqual(['athlete_workspace', 'coach_workspace', 'everywhere']);
  });

  it('writes one line, as motivation, to the board it was written on', async () => {
    const posted: Array<Record<string, unknown>> = [];
    await renderDesk(posted);

    act(() => {
      fireEvent.click(screen.getAllByRole('button', { name: /write on the board/i })[1]);
    });

    act(() => {
      fireEvent.change(screen.getByLabelText(/what the board should say/i), {
        target: { value: 'Rope before bags tonight.' },
      });
      fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: 'Coach Jason' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /put it up/i }));
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      message: 'Rope before bags tonight.',
      author_name: 'Coach Jason',
      kind: 'motivation',
      placement: 'athlete_workspace',
    });
    // No schedule window, no placement picker, no kind picker. A board is one
    // field and a name.
    expect(Object.keys(posted[0]).sort()).toEqual(['author_name', 'kind', 'message', 'placement']);
  });

  it('refuses to post a line with no name against it', async () => {
    const posted: Array<Record<string, unknown>> = [];
    await renderDesk(posted);

    act(() => {
      fireEvent.click(screen.getAllByRole('button', { name: /write on the board/i })[0]);
    });
    act(() => {
      fireEvent.change(screen.getByLabelText(/what the board should say/i), {
        target: { value: 'Anonymous line' },
      });
    });

    // The gym's own voice is a person's voice. An unsigned board is a notice.
    expect(screen.getByRole('button', { name: /put it up/i }).hasAttribute('disabled')).toBe(true);
    expect(posted).toHaveLength(0);
  });

  it('points at the full record rather than pretending to be it', async () => {
    const { container } = await renderDesk();
    const hrefs = [...container.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'));
    expect(hrefs).toContain('/notices');
  });
});
