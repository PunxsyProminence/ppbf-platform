/**
 * @jest-environment jsdom
 */

import { act, render, screen } from '@testing-library/react';

import StaffCredentialsPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const STAFF = [
  {
    staff_key: 'a1b2c3d4e5f6', display_name: 'Jane Okafor', role: 'coach',
    credentials: [
      { clearance_type_id: 'ct-safesport', clearance_name: 'SafeSport Training', band: 'current', expires_on: '2027-01-01' },
      { clearance_type_id: 'ct-cpr', clearance_name: 'CPR/First Aid', band: 'missing', expires_on: null },
    ],
  },
];

function mockFetch(staff = STAFF) {
  return jest.fn(async () => ({ ok: true, json: async () => ({ staff }) } as Response)) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('shows each staff member with a badge per credential, and states it never shows documents', async () => {
  global.fetch = mockFetch();

  await act(async () => {
    render(<StaffCredentialsPage />);
  });

  expect(await screen.findByText('Jane Okafor')).toBeTruthy();
  expect(screen.getByText(/never the documents themselves/i)).toBeTruthy();
  expect(screen.getByText(/SafeSport Training: Current/)).toBeTruthy();
  expect(screen.getByText(/CPR\/First Aid: Not on file/)).toBeTruthy();
});

test('never renders a document link or a raw storage path', async () => {
  global.fetch = mockFetch();

  await act(async () => {
    render(<StaffCredentialsPage />);
  });

  await screen.findByText('Jane Okafor');
  expect(screen.queryByRole('link', { name: /document/i })).toBeNull();
  expect(document.body.innerHTML).not.toMatch(/credentials\/document\//);
});

test('an empty roster shows an empty state rather than an error', async () => {
  global.fetch = mockFetch([]);

  await act(async () => {
    render(<StaffCredentialsPage />);
  });

  expect(await screen.findByText(/no staff credential records yet/i)).toBeTruthy();
});
