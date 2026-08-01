/**
 * @jest-environment jsdom
 */

// The notes box answered every submission with a confirmation that the note
// had been captured and counted, and then dropped it. There is no notes table
// behind this panel and no write, so the confirmation has to say so.

import { act, fireEvent, render, screen } from '@testing-library/react';

import ResearchQAChatPage from './page';

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
