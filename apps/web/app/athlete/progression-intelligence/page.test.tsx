/**
 * @jest-environment jsdom
 */

// "No progression gaps assigned" is a claim about the athlete's coach, not about
// the network. It must never be shown while the gaps request is still in flight.

import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import AthleteProgressionIntelligencePage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

const SESSION_PATH = '/api/pilot/auth/session';

function mockFetch(gapsResponse: () => Promise<Response>) {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith(SESSION_PATH)) {
      return {
        ok: true,
        json: async () => ({ authenticated: true, athlete_id: 'athlete-001' }),
      } as Response;
    }
    if (url.includes('/progression/gaps')) {
      return gapsResponse();
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  });
}

const emptyOk = async () => ({ ok: true, json: async () => ({ items: [] }) }) as Response;

describe('athlete progression empty state', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('the empty state is withheld while progression data is still loading', async () => {
    global.fetch = mockFetch(() => new Promise<Response>(() => {})) as unknown as typeof fetch;

    render(<AthleteProgressionIntelligencePage />);

    await screen.findByText(/Loading your progression data/);
    expect(screen.queryByText('No progression gaps assigned')).toBeNull();
  });

  test('the empty state appears once loading finishes with no gaps', async () => {
    global.fetch = mockFetch(emptyOk) as unknown as typeof fetch;

    render(<AthleteProgressionIntelligencePage />);

    await screen.findByText('No progression gaps assigned');
    await waitFor(() => expect(screen.queryByText(/Loading your progression data/)).toBeNull());
  });
});
