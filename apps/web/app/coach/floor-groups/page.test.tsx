/**
 * @jest-environment jsdom
 */

// Today's floor page. What these pin: the day is labelled from what is
// actually there (stations = circuit, none = small groups) rather than
// assuming one shape; placing an athlete posts a session-scoped placement;
// and already-placed athletes are marked so a coach does not lose track of
// who is standing where.

import { act, fireEvent, render, screen } from '@testing-library/react';

import FloorGroupsPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const PLANS = [{ plan_id: 'p-1', plan_on: '2026-08-16', title: 'Tuesday night', rotation_minutes: 6, notes: '' }];

const SMALL_GROUPS = [
  { group_id: 'g-1', group_name: 'Beginners', station_name: null, focus: 'stance', rotation_order: null,
    members: [{ athlete_id: 'ath-1', athlete_name: 'Jordan P.' }] },
];

const CIRCUIT_GROUPS = [
  { group_id: 'g-bags', group_name: 'Group A', station_name: 'Bags', focus: '', rotation_order: 1, members: [] },
  { group_id: 'g-pads', group_name: 'Group B', station_name: 'Pads', focus: '', rotation_order: 2, members: [] },
];

function mockFetch(options: { groups: unknown[]; capture?: { posts: unknown[] } }) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      options.capture?.posts.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ item: { plan_id: 'p-new' }, groups: options.groups }) } as Response;
    }
    if (url.includes('plan_id=')) {
      return { ok: true, json: async () => ({ groups: options.groups }) } as Response;
    }
    if (url.includes('/floor-groups')) {
      return { ok: true, json: async () => ({ plans: PLANS }) } as Response;
    }
    if (url.includes('/athletes/list')) {
      return { ok: true, json: async () => ({ items: [{ athlete_id: 'ath-1', full_name: 'Jordan P.' }, { athlete_id: 'ath-2', full_name: 'Casey S.' }] }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('a day with no stations reads as a small-group day, not a broken circuit', async () => {
  global.fetch = mockFetch({ groups: SMALL_GROUPS });

  await act(async () => {
    render(<FloorGroupsPage />);
  });
  await act(async () => {
    fireEvent.change(await screen.findByLabelText('Floor plan'), { target: { value: 'p-1' } });
  });

  expect(await screen.findByText('Small-group day (no stations)')).toBeTruthy();
  expect(screen.getByText('small group')).toBeTruthy();
  // The placed athlete appears in their group, and the picker marks them
  // as already standing somewhere.
  expect(screen.getAllByText(/Jordan P\./).length).toBeGreaterThan(1);
  expect(screen.getByRole('option', { name: /Jordan P\. \(placed\)/ })).toBeTruthy();
});

test('a day with stations reads as a circuit and shows rotation order', async () => {
  global.fetch = mockFetch({ groups: CIRCUIT_GROUPS });

  await act(async () => {
    render(<FloorGroupsPage />);
  });
  await act(async () => {
    fireEvent.change(await screen.findByLabelText('Floor plan'), { target: { value: 'p-1' } });
  });

  expect(await screen.findByText('Circuit day (stations set)')).toBeTruthy();
  expect(screen.getByText('1. Bags')).toBeTruthy();
  expect(screen.getByText('2. Pads')).toBeTruthy();
});

test('placing an athlete posts a session-scoped placement', async () => {
  const capture = { posts: [] as unknown[] };
  global.fetch = mockFetch({ groups: CIRCUIT_GROUPS, capture });

  await act(async () => {
    render(<FloorGroupsPage />);
  });
  await act(async () => {
    fireEvent.change(await screen.findByLabelText('Floor plan'), { target: { value: 'p-1' } });
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Athlete to place'), { target: { value: 'ath-2' } });
  });
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: 'Place here' })[0]);
  });

  expect(capture.posts).toHaveLength(1);
  expect(capture.posts[0]).toMatchObject({
    action: 'place', plan_id: 'p-1', group_id: 'g-bags', athlete_id: 'ath-2',
  });
});
