/**
 * @jest-environment jsdom
 */

// Two failure modes this page shipped with, both invisible to the admin using
// it: a second click while the create request was still open wrote a second
// volunteer row, and a PATCH that matched no row still reported success.

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import VolunteerManagementPage from './page';

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

function postCalls(fetchMock: jest.Mock) {
  return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

async function renderPage(fetchMock: jest.Mock) {
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<VolunteerManagementPage />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
}

it('does not send a second create while the first one is still in flight', async () => {
  let releasePost: (value: Response) => void = () => {};
  const postSettled = new Promise<Response>((resolve) => {
    releasePost = resolve;
  });

  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return postSettled;
    }
    return jsonResponse({ items: [] });
  });

  await renderPage(fetchMock);

  fireEvent.change(screen.getByPlaceholderText('Full name'), { target: { value: 'Dana Ruiz' } });

  const createButton = screen.getByRole('button', { name: /create/i });
  fireEvent.click(createButton);
  fireEvent.click(createButton);

  expect(postCalls(fetchMock)).toHaveLength(1);

  await act(async () => {
    releasePost(jsonResponse({ ok: true, volunteer_id: 'vol-1' }));
    await postSettled;
  });

  await screen.findByText('Volunteer created.');
  expect(postCalls(fetchMock)).toHaveLength(1);
});

it('requires a full name before creating', async () => {
  const fetchMock = jest.fn(async () => jsonResponse({ items: [] }));

  await renderPage(fetchMock);

  fireEvent.change(screen.getByPlaceholderText('Full name'), { target: { value: '   ' } });

  const createButton = screen.getByRole('button', { name: /create/i }) as HTMLButtonElement;
  expect(createButton.disabled).toBe(true);

  fireEvent.click(createButton);
  expect(postCalls(fetchMock)).toHaveLength(0);
});

it('reports a failure when the server updated no volunteer row', async () => {
  const roster = [
    {
      volunteer_id: 'vol-1',
      full_name: 'Dana Ruiz',
      role_focus: 'General Support',
      availability: 'Weekdays',
      certification_status: 'Pending',
      background_check_status: 'Pending',
      status: 'pending',
      notes: null,
    },
  ];

  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      return jsonResponse({ ok: true, updated: false });
    }
    return jsonResponse({ items: roster });
  });

  await renderPage(fetchMock);

  await screen.findByText('Dana Ruiz');
  fireEvent.click(screen.getByRole('button', { name: 'active' }));

  await screen.findByText(/no longer on this roster/i);
  expect(screen.queryByText('Volunteer status updated to active.')).toBeNull();
  expect(screen.getByText('Status: pending')).toBeTruthy();
});
