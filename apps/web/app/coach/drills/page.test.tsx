/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import CoachDrillLibraryPage from './page';

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

jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

const authored = {
  drill_id: 'authored-1',
  name: 'Corner exit',
  category: 'Footwork',
  focus: 'Leave the ropes safely.',
  difficulty: 'beginner',
  cues: ['Turn first'],
};

const reference = {
  drill_id: 'reference-1',
  name: 'Seeded jab return',
  discipline: 'boxing',
  category: 'striking',
  difficulty: 'fundamentals',
  purpose: 'Return the hand to guard.',
  standard_setup: 'Partners at technical distance.',
  requires_coach_authorization: true,
};

beforeEach(() => {
  jest.clearAllMocks();
});

it('shows seeded reference drills separately from assignable gym-authored drills', async () => {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => String(input).endsWith('/drill-library')
    ? jsonResponse({ drills: [reference] })
    : jsonResponse({ items: [authored] })) as unknown as typeof fetch;

  render(<CoachDrillLibraryPage />);

  expect(await screen.findByText('Seeded jab return')).toBeInTheDocument();
  expect(screen.getByText('Corner exit')).toBeInTheDocument();
  expect(screen.getByText(/reference drills are read-only/i)).toBeInTheDocument();
  expect(screen.getByText('Coach authorization required')).toBeInTheDocument();
});

it('keeps drill creation on the assignable gym-authored endpoint', async () => {
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') return jsonResponse({ item: authored }, true, 201);
    return url.endsWith('/drill-library')
      ? jsonResponse({ drills: [reference] })
      : jsonResponse({ items: [authored] });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<CoachDrillLibraryPage />);
  await screen.findByText('Seeded jab return');

  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Slip line' } });
  fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Defense' } });
  fireEvent.change(screen.getByLabelText('What it is for'), { target: { value: 'Head movement' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add drill' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/pilot/drills', expect.objectContaining({ method: 'POST' })));
  expect(fetchMock).not.toHaveBeenCalledWith('/api/pilot/drill-library', expect.objectContaining({ method: 'POST' }));
});

it('reports a malformed successful response instead of calling it empty', async () => {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => String(input).endsWith('/drill-library')
    ? jsonResponse({ items: [] })
    : jsonResponse({ items: [] })) as unknown as typeof fetch;

  render(<CoachDrillLibraryPage />);

  expect(await screen.findByText(/reference drill library returned an invalid response/i)).toBeInTheDocument();
  expect(screen.getByText(/not an empty reference library/i)).toBeInTheDocument();
});

it('lets the gym-authored library load even when the reference endpoint fails', async () => {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => String(input).endsWith('/drill-library')
    ? jsonResponse({}, false, 500)
    : jsonResponse({ items: [authored] })) as unknown as typeof fetch;

  render(<CoachDrillLibraryPage />);

  expect(await screen.findByText('Corner exit')).toBeInTheDocument();
  expect(screen.getByText(/reference drill library could not be loaded/i)).toBeInTheDocument();
});
