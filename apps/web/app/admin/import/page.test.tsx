/**
 * @jest-environment jsdom
 */

// The screen that loads a gym's roster. The property under test throughout is
// that nothing is written until a person has seen what would happen: a preview
// they read, produced by the same server-side planner the commit then uses.

import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import RosterImportPage from './page';

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

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

const CSV = 'Athlete ID,Full name,Date of birth\nath-1,A Name,2012-03-14\n';

const PREVIEW = {
  ok: true,
  committed: false,
  rows: [
    { line: 1, athlete_id: 'ath-1', full_name: 'A Name', outcome: 'create', reason: '' },
    { line: 2, athlete_id: 'ath-2', full_name: 'Another Name', outcome: 'skip_exists', reason: 'Already on the roster. Left exactly as it is.' },
    { line: 3, athlete_id: '', full_name: 'No Id', outcome: 'reject', reason: 'No athlete id.' },
  ],
  counts: { create: 1, skip_exists: 1, reject: 1 },
};

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

function mockApi(preview: unknown = PREVIEW, committed?: unknown) {
  return jest.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.commit === true) {
      return jsonResponse(committed ?? { ...PREVIEW, committed: true });
    }
    return jsonResponse(preview);
  });
}

function typeCsv(text = CSV) {
  fireEvent.change(screen.getByLabelText('Roster CSV'), { target: { value: text } });
}

it('cannot add anything before the file has been checked', async () => {
  global.fetch = mockApi() as unknown as typeof fetch;
  render(<RosterImportPage />);
  typeCsv();

  // The file is present and readable, and Add is still refused: the only way
  // to reach it is through a preview somebody looked at.
  expect(screen.getByRole('button', { name: /check this file/i }).hasAttribute('disabled')).toBe(false);
  expect(screen.getByRole('button', { name: /add athletes/i }).hasAttribute('disabled')).toBe(true);
});

it('checking the file writes nothing and shows what would happen', async () => {
  const fetchMock = mockApi();
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<RosterImportPage />);
  typeCsv();

  fireEvent.click(screen.getByRole('button', { name: /check this file/i }));

  expect(await screen.findByText('What this would do')).toBeTruthy();
  // Every request so far was a dry run.
  expect(fetchMock.mock.calls.every(([, init]) => JSON.parse(String((init as RequestInit).body)).commit === false)).toBe(true);
  // And each row is reported by its line in the operator's own file.
  expect(screen.getByText('Row 1')).toBeTruthy();
  expect(screen.getByText('Row 3')).toBeTruthy();
  expect(screen.getByText('No athlete id.')).toBeTruthy();
});

it('names how many will be added, so the button is not a leap', async () => {
  global.fetch = mockApi() as unknown as typeof fetch;
  render(<RosterImportPage />);
  typeCsv();
  fireEvent.click(screen.getByRole('button', { name: /check this file/i }));

  expect(await screen.findByRole('button', { name: /add 1 athlete$/i })).toBeTruthy();
});

it('commits only after a preview, and reports what was loaded', async () => {
  const fetchMock = mockApi();
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<RosterImportPage />);
  typeCsv();

  fireEvent.click(screen.getByRole('button', { name: /check this file/i }));
  await screen.findByText('What this would do');
  fireEvent.click(screen.getByRole('button', { name: /add 1 athlete/i }));

  expect(await screen.findByText('What was loaded')).toBeTruthy();
  const committing = fetchMock.mock.calls.filter(([, init]) => JSON.parse(String((init as RequestInit).body)).commit === true);
  expect(committing).toHaveLength(1);
});

// Editing the file after a preview must invalidate it. Otherwise someone
// pastes a corrected roster, and Add is still armed against the plan for the
// file they replaced.
it('discards the preview when the file is edited', async () => {
  global.fetch = mockApi() as unknown as typeof fetch;
  render(<RosterImportPage />);
  typeCsv();
  fireEvent.click(screen.getByRole('button', { name: /check this file/i }));
  await screen.findByText('What this would do');

  typeCsv('Athlete ID,Full name,Date of birth\nath-9,Someone Else,2011-01-01\n');

  expect(screen.queryByText('What this would do')).toBeNull();
  expect(screen.getByRole('button', { name: /add athletes/i }).hasAttribute('disabled')).toBe(true);
});

it('refuses to arm the button when the file adds nobody', async () => {
  global.fetch = mockApi({
    ok: true,
    committed: false,
    rows: [{ line: 1, athlete_id: 'ath-1', full_name: 'A Name', outcome: 'skip_exists', reason: 'Already on the roster.' }],
    counts: { create: 0, skip_exists: 1, reject: 0 },
  }) as unknown as typeof fetch;
  render(<RosterImportPage />);
  typeCsv();
  fireEvent.click(screen.getByRole('button', { name: /check this file/i }));

  await screen.findByText('What this would do');
  expect(screen.getByRole('button', { name: /add 0 athletes/i }).hasAttribute('disabled')).toBe(true);
});

// A rejected file must not leave a stale plan on screen beside the error --
// that is a live Add button pointed at a plan that no longer describes
// anything.
it('clears the preview when a later check fails', async () => {
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.csv.includes('ath-1')) return jsonResponse(PREVIEW);
    return jsonResponse({ error: 'Unsupported file: it needs at least an athlete id column and a full name column.' }, false);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<RosterImportPage />);

  typeCsv();
  fireEvent.click(screen.getByRole('button', { name: /check this file/i }));
  await screen.findByText('What this would do');

  typeCsv('Weight class\nlightweight\n');
  fireEvent.click(screen.getByRole('button', { name: /check this file/i }));

  // Wait on the error arriving, not on the preview clearing -- the clear is
  // synchronous on edit, so waiting for it would pass before the request even
  // resolved and prove nothing.
  expect(await screen.findByText(/needs at least an athlete id column/i)).toBeTruthy();
  await waitFor(() => expect(screen.queryByText('What this would do')).toBeNull());
  expect(screen.getByRole('button', { name: /add athletes/i }).hasAttribute('disabled')).toBe(true);
});

// A partial load has to say so. Silence here reads as "all forty arrived".
it('says the rest was loaded when some rows failed', async () => {
  global.fetch = mockApi(PREVIEW, {
    ok: true,
    committed: true,
    rows: PREVIEW.rows,
    counts: { create: 1, skip_exists: 1, reject: 1 },
  }) as unknown as typeof fetch;
  render(<RosterImportPage />);
  typeCsv();

  fireEvent.click(screen.getByRole('button', { name: /check this file/i }));
  await screen.findByText('What this would do');
  fireEvent.click(screen.getByRole('button', { name: /add 1 athlete/i }));

  expect(await screen.findByText(/The rest of the file was loaded/i)).toBeTruthy();
  expect(screen.getByText(/reported as already on the roster rather than duplicated/i)).toBeTruthy();
});
