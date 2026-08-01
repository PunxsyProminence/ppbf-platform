/**
 * @jest-environment jsdom
 */

// The Publish control is the coach's only signal that a publication is cleared.
// Offering it on an uncleared publication produces a refusal the coach cannot
// act on; withholding the reason for a refusal is just as unusable.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import CoachVideoPublicationsPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

const SESSION_PATH = '/api/pilot/auth/session';

const publication = (overrides: Record<string, unknown> = {}) => ({
  publication_id: 'pub-1',
  video_session_id: 'vid-1',
  athlete_id: 'ath-1',
  submitted_by_account_id: 'coach-1',
  publication_type: 'research_library',
  title: 'Jab mechanics',
  description: 'Session review',
  status: 'approved',
  compliance_check_status: 'passed',
  created_at: '2026-07-30T00:00:00.000Z',
  ...overrides,
});

function mockFetch(publications: Array<Record<string, unknown>>, publishResponse?: () => Response) {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith(SESSION_PATH)) {
      return {
        ok: true,
        json: async () => ({ authenticated: true, role: 'coach', account_id: 'coach-1', organization_id: 'org-1' }),
      } as Response;
    }
    if (url.includes('/publications/publish')) {
      return publishResponse
        ? publishResponse()
        : ({ ok: true, json: async () => ({ ok: true, library_id: 'lib-1' }) } as Response);
    }
    if (url.includes('/publications/create')) {
      return { ok: true, json: async () => ({ items: publications }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('coach publication workflow', () => {
  test('a publication awaiting a compliance check says who has to act, and offers no Publish', async () => {
    global.fetch = mockFetch([
      publication({ status: 'draft', compliance_check_status: 'pending' }),
    ]) as unknown as typeof fetch;

    render(<CoachVideoPublicationsPage />);

    await screen.findByText('Waiting on an organization admin to record a compliance check.');
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  });

  test('a rejected publication says so and offers no Publish', async () => {
    global.fetch = mockFetch([
      publication({ status: 'rejected', compliance_check_status: 'failed' }),
    ]) as unknown as typeof fetch;

    render(<CoachVideoPublicationsPage />);

    await screen.findByText(/A compliance check failed/);
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  });

  test('a cleared publication this coach submitted offers Publish', async () => {
    global.fetch = mockFetch([publication()]) as unknown as typeof fetch;

    render(<CoachVideoPublicationsPage />);

    await screen.findByRole('button', { name: 'Publish' });
    expect(screen.getByText('Compliance checks passed. Ready for you to publish.')).toBeTruthy();
  });

  test('a cleared publication another coach submitted offers no Publish and says why', async () => {
    global.fetch = mockFetch([
      publication({ submitted_by_account_id: 'coach-2' }),
    ]) as unknown as typeof fetch;

    render(<CoachVideoPublicationsPage />);

    await screen.findByText(/Another coach submitted this one/);
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  });

  test("a refused publish shows the server's reason rather than a generic failure", async () => {
    global.fetch = mockFetch(
      [publication()],
      () => ({
        ok: false,
        status: 409,
        json: async () => ({ error: 'This publication is not cleared for the research library yet.' }),
      }) as Response,
    ) as unknown as typeof fetch;

    render(<CoachVideoPublicationsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));

    await screen.findByText('This publication is not cleared for the research library yet.');
    expect(screen.queryByText('Failed to publish')).toBeNull();
  });

  test('a successful publish reloads the list and shows the published state', async () => {
    let published = false;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(SESSION_PATH)) {
        return {
          ok: true,
          json: async () => ({ authenticated: true, role: 'coach', account_id: 'coach-1', organization_id: 'org-1' }),
        } as Response;
      }
      if (url.includes('/publications/publish')) {
        published = true;
        return { ok: true, json: async () => ({ ok: true, library_id: 'lib-1' }) } as Response;
      }
      if (url.includes('/publications/create')) {
        return {
          ok: true,
          json: async () => ({
            items: [published ? publication({ status: 'published' }) : publication()],
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    render(<CoachVideoPublicationsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));

    await screen.findByText('Published to the research library.');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull());
  });
});
