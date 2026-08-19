/**
 * @jest-environment jsdom
 */

// The notes box answered every submission with a confirmation that the note
// had been captured and counted, and then dropped it. There is no notes table
// behind this panel and no write, so the confirmation has to say so.

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import ResearchQAChatPage from './page';

// The Library is gated now (it was reachable signed-out). The note tests below
// are about the transcript, not the gate, so the shell is stubbed for them --
// the same stub /research/review's suite uses. The last test flips it off and
// runs the real shell, because a stubbed shell cannot prove a gate.
let mockBypassShell = true;

jest.mock('@/components/RoleStandaloneView', () => {
  const React = jest.requireActual('react');
  const actual = jest.requireActual('@/components/RoleStandaloneView');
  return {
    __esModule: true,
    default: (props: { readonly children: ReactNode }) =>
      mockBypassShell
        ? React.createElement('div', null, props.children)
        : React.createElement(actual.default, props),
  };
});

const mockReplace = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: React.ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const originalFetch = global.fetch;

beforeEach(() => {
  // jsdom implements no layout, so the transcript's auto-scroll has nothing to
  // call. The page depends on it existing, not on it doing anything.
  Element.prototype.scrollIntoView = jest.fn();
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ items: [] }) } as Response)) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  mockBypassShell = true;
  mockReplace.mockReset();
  jest.clearAllMocks();
});

async function renderPage() {
  await act(async () => {
    render(<ResearchQAChatPage />);
  });
}

test('a note is confirmed as session-local, not as stored', async () => {
  await renderPage();

  fireEvent.change(screen.getByPlaceholderText('Write your findings...'), {
    target: { value: 'Southpaw drill worked better after the footwork block.' },
  });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add Note To Transcript' }));
  });

  expect(screen.getByText(/stays in this browser session only/i)).toBeTruthy();
  expect(screen.getByText(/It is not stored anywhere/i)).toBeTruthy();
  expect(screen.queryByText(/Research note captured/i)).toBeNull();
  expect(screen.queryByText(/characters logged/i)).toBeNull();
});

test('the note itself is kept in the transcript it claims to live in', async () => {
  await renderPage();

  fireEvent.change(screen.getByPlaceholderText('Write your findings...'), {
    target: { value: 'Southpaw drill worked better after the footwork block.' },
  });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add Note To Transcript' }));
  });

  expect(screen.getByText(/Note: Southpaw drill worked better after the footwork block\./)).toBeTruthy();
  expect((screen.getByPlaceholderText('Write your findings...') as HTMLTextAreaElement).value).toBe('');
});

test('an empty note produces no confirmation at all', async () => {
  await renderPage();

  fireEvent.change(screen.getByPlaceholderText('Write your findings...'), { target: { value: '   ' } });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add Note To Transcript' }));
  });

  expect(screen.queryByText(/stays in this browser session only/i)).toBeNull();
});


// The guard. /research/chat shipped with no gate: an unauthenticated visitor
// got the whole Library surface -- transcript, ask box and note box -- even
// though library/claims answers 401. A chat surface rendering to an anonymous
// visitor is worse than an inert shell, so this is pinned here too.
test('an unauthenticated visitor gets no Library surface, only the bounce', async () => {
  mockBypassShell = false;

  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/pilot/auth/session')) {
      return { ok: false, status: 401, json: async () => ({ authenticated: false }) } as Response;
    }
    return { ok: false, status: 401, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;

  await act(async () => {
    render(<ResearchQAChatPage />);
  });

  expect(screen.queryByRole('heading', { name: 'The Library' })).toBeNull();
  expect(screen.queryByPlaceholderText('Write your findings...')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add Note To Transcript' })).toBeNull();
  expect(screen.queryByRole('log')).toBeNull();

  expect(screen.getByText('Checking access')).toBeTruthy();
  expect(mockReplace).toHaveBeenCalledWith('/login');
});
