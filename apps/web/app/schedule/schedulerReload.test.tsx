/**
 * @jest-environment jsdom
 */

// The loader's identity is the whole guarantee here: while it depended on the
// current class/athlete selection, picking a different class tore the page down
// to "Loading scheduler..." and refetched the session, the scheduler, and the
// athlete list on every dropdown change.

import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { readonly href: string; readonly children: ReactNode }) => <a href={href}>{children}</a>,
}));

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

import SchedulerPage from './page';

const classes = [
  {
    class_id: 'class-1',
    title: 'Morning Fundamentals',
    start_at: '2026-08-03T13:00:00.000Z',
    end_at: '2026-08-03T14:00:00.000Z',
    location: 'Main Floor',
    capacity: 16,
    coach_account_id: 'account-coach',
    status: 'open',
    registered_count: 2,
  },
  {
    class_id: 'class-2',
    title: 'Evening Sparring',
    start_at: '2026-08-03T23:00:00.000Z',
    end_at: '2026-08-04T00:00:00.000Z',
    location: 'Ring',
    capacity: 12,
    coach_account_id: 'account-coach',
    status: 'open',
    registered_count: 4,
  },
];

const athletes = [
  { athlete_id: 'athlete-1', full_name: 'First Athlete' },
  { athlete_id: 'athlete-2', full_name: 'Second Athlete' },
];

function jsonResponse(payload: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
}

function installFetchMock(): jest.Mock {
  const fetchMock = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);

    if (url.endsWith('/api/pilot/auth/session')) {
      return jsonResponse({ authenticated: true, role: 'coach', athlete_id: null });
    }

    if (url.endsWith('/api/pilot/scheduler')) {
      return jsonResponse({
        ok: true,
        role: 'coach',
        classes,
        registrations: [],
        coaching_requests: [],
        attendance: [],
      });
    }

    if (url.endsWith('/api/pilot/athletes/list')) {
      return jsonResponse({ items: athletes });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  });

  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function findSelectContaining(optionValue: string): HTMLSelectElement {
  const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
  const match = selects.find((element) => Array.from(element.options).some((option) => option.value === optionValue));
  if (!match) {
    throw new Error(`No select rendered an option for ${optionValue}`);
  }

  return match;
}

describe('scheduler page load', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('defaults the class and athlete selections from the first load', async () => {
    installFetchMock();

    render(<SchedulerPage />);

    await screen.findByText('Class Schedule');

    expect(findSelectContaining('class-2').value).toBe('class-1');
    expect(findSelectContaining('athlete-2').value).toBe('athlete-1');
  });

  test('changing the class selection does not refetch or re-enter the loading state', async () => {
    const fetchMock = installFetchMock();

    render(<SchedulerPage />);

    await screen.findByText('Class Schedule');
    const callsAfterLoad = fetchMock.mock.calls.length;

    const classSelect = findSelectContaining('class-2');
    fireEvent.change(classSelect, { target: { value: 'class-2' } });

    await waitFor(() => expect(classSelect.value).toBe('class-2'));

    expect(fetchMock.mock.calls.length).toBe(callsAfterLoad);
    expect(screen.queryByText('Loading scheduler...')).toBeNull();
  });

  test('changing the athlete selection does not refetch', async () => {
    const fetchMock = installFetchMock();

    render(<SchedulerPage />);

    await screen.findByText('Class Schedule');
    const callsAfterLoad = fetchMock.mock.calls.length;

    const athleteSelect = findSelectContaining('athlete-2');
    fireEvent.change(athleteSelect, { target: { value: 'athlete-2' } });

    await waitFor(() => expect(athleteSelect.value).toBe('athlete-2'));

    expect(fetchMock.mock.calls.length).toBe(callsAfterLoad);
  });
});
