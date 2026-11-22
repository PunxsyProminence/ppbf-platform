/**
 * @jest-environment jsdom
 */

// Lane BT, BOA-19: on Platform Overview a figure below the cohort floor reads
// "Suppressed", the word the board pages use for the same state, not "n/a".

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';

import PlatformOverview from './page';
import { usePilotSession } from '@/components/usePilotSession';

jest.mock('@/components/usePilotSession', () => ({
  ...jest.requireActual('@/components/usePilotSession'),
  usePilotSession: jest.fn(),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

test('a suppressed figure reads "Suppressed", a counted one its count', async () => {
  (usePilotSession as jest.Mock).mockReturnValue({
    role: 'platform_owner',
    organizationId: 'ppbf',
    authProvider: 'microsoft',
    accountId: 'owner',
    mustChangePin: false,
    loading: false,
  });
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      gyms: [{
        organizationId: 'org-1',
        organizationName: 'Test Gym',
        status: 'active',
        board: {
          activeAthletes: { status: 'insufficient_data', count: null },
          trainingSessions30Days: { status: 'available', count: 40 },
          coachReviews30Days: { status: 'insufficient_data', count: null },
        },
        growth: { totalInteractions: 7 },
        capabilityCount: 0,
        trackAssignmentCount: 0,
      }],
    }),
  })) as unknown as typeof fetch;

  render(<PlatformOverview />);

  const row = (await screen.findByText('Test Gym')).closest('tr') as HTMLElement;
  expect(within(row).getAllByText('Suppressed')).toHaveLength(2);
  expect(within(row).getByText('40')).toBeInTheDocument();
  expect(within(row).queryByText('n/a')).toBeNull();
});

// AS12-2, BOA-11 and Q3: the way back is named by its page's title, and a
// figure that was not read says Omega's words, "No data yet", not a dash.
test('the way back reads Omega, and an unread figure reads "No data yet"', async () => {
  (usePilotSession as jest.Mock).mockReturnValue({
    role: 'platform_owner',
    organizationId: 'ppbf',
    authProvider: 'microsoft',
    accountId: 'owner',
    mustChangePin: false,
    loading: false,
  });
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      gyms: [{
        organizationId: 'org-1',
        organizationName: 'Test Gym',
        status: 'active',
        board: {
          activeAthletes: { status: 'unavailable', count: null },
          trainingSessions30Days: { status: 'available', count: 40 },
        },
        growth: null,
        capabilityCount: 0,
        trackAssignmentCount: 0,
      }],
    }),
  })) as unknown as typeof fetch;

  render(<PlatformOverview />);

  const row = (await screen.findByText('Test Gym')).closest('tr') as HTMLElement;
  // activeAthletes unavailable, coachReviews30Days missing, growth missing.
  expect(within(row).getAllByText('No data yet')).toHaveLength(3);
  expect(within(row).getByText('40')).toBeInTheDocument();
  expect(within(row).queryByText('—')).toBeNull();
  expect(screen.getByRole('link', { name: 'Omega' })).toHaveAttribute('href', '/admin/platform');
  expect(screen.queryByText('Back To Gym Switcher')).toBeNull();
});
