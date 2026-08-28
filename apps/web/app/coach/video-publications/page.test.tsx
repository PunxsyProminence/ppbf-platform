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
      publication({ status: 'pending_review', compliance_check_status: 'pending' }),
    ]) as unknown as typeof fetch;

    render(<CoachVideoPublicationsPage />);

    await screen.findByText('Waiting on an organization admin to record a compliance check.');
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit for review' })).toBeNull();
  });

  test('a draft this coach created offers Submit for review, and no Publish', async () => {
    global.fetch = mockFetch([
      publication({ status: 'draft', compliance_check_status: 'pending' }),
    ]) as unknown as typeof fetch;

    render(<CoachVideoPublicationsPage />);

    await screen.findByText('A draft. Submit it for compliance review when it is ready.');
    expect(screen.getByRole('button', { name: 'Submit for review' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  });

  test("a draft another coach created offers no Submit and says why", async () => {
    global.fetch = mockFetch([
      publication({ status: 'draft', compliance_check_status: 'pending', submitted_by_account_id: 'coach-2' }),
    ]) as unknown as typeof fetch;

    render(<CoachVideoPublicationsPage />);

    await screen.findByText(/Another coach created this draft/);
    expect(screen.queryByRole('button', { name: 'Submit for review' })).toBeNull();
  });

  test('a successful submit reloads the list into the review queue state', async () => {
    let submitted = false;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(SESSION_PATH)) {
        return {
          ok: true,
          json: async () => ({ authenticated: true, role: 'coach', account_id: 'coach-1', organization_id: 'org-1' }),
        } as Response;
      }
      if (url.includes('/publications/submit')) {
        submitted = true;
        return { ok: true, json: async () => ({ ok: true, status: 'pending_review' }) } as Response;
      }
      if (url.includes('/publications/create')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              submitted
                ? publication({ status: 'pending_review', compliance_check_status: 'pending' })
                : publication({ status: 'draft', compliance_check_status: 'pending' }),
            ],
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    render(<CoachVideoPublicationsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Submit for review' }));

    await screen.findByText('Waiting on an organization admin to record a compliance check.');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Submit for review' })).toBeNull());
  });

  test("a refused submit shows the server's reason rather than a generic failure", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(SESSION_PATH)) {
        return {
          ok: true,
          json: async () => ({ authenticated: true, role: 'coach', account_id: 'coach-1', organization_id: 'org-1' }),
        } as Response;
      }
      if (url.includes('/publications/submit')) {
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: 'Only a draft can be submitted for review.' }),
        } as Response;
      }
      if (url.includes('/publications/create')) {
        return {
          ok: true,
          json: async () => ({ items: [publication({ status: 'draft', compliance_check_status: 'pending' })] }),
        } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    render(<CoachVideoPublicationsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Submit for review' }));

    await screen.findByText('Only a draft can be submitted for review.');
    expect(screen.queryByText('Failed to submit for review')).toBeNull();
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

test('a retracted publication says why it is gone and offers no actions', async () => {
  // compliance stays 'passed' on purpose: this is the exact state a sweep
  // leaves behind (published -> retracted), and it proves the retracted
  // status ALONE hides the Publish button -- not the compliance value.
  global.fetch = mockFetch([
    publication({ status: 'retracted', compliance_check_status: 'passed' }),
  ]) as unknown as typeof fetch;

  render(<CoachVideoPublicationsPage />);

  await screen.findByText(/Retracted from distribution/);
  expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Submit for review' })).toBeNull();
});

/*
 * A FAILED READ IS NOT AN EMPTY SHELF.
 *
 * This list previously swallowed a non-ok response -- `if (pubRes.ok)` with no
 * else -- and then cleared the error state unconditionally, so a 403 or a 500
 * left the coach looking at "Publications (0)" and "No publications yet." with
 * nothing on screen to say otherwise. The natural response to that sentence is
 * to publish a minor's footage that may already be published.
 */
describe('a publications read that failed says so', () => {
  function failingCreateFetch() {
    return jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(SESSION_PATH)) {
        return {
          ok: true,
          json: async () => ({ authenticated: true, role: 'coach', account_id: 'coach-1', organization_id: 'org-1' }),
        } as Response;
      }
      if (url.includes('/publications/create')) {
        return { ok: false, status: 403, json: async () => ({ error: 'forbidden' }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    });
  }

  test('a refused read is reported, and never as "you have published none"', async () => {
    global.fetch = failingCreateFetch() as unknown as typeof fetch;

    render(<CoachVideoPublicationsPage />);

    await screen.findByText(/Your publications could not be read/);
    // The half that is the actual defect: the asserting sentence must be gone.
    expect(screen.queryByText('No publications yet.')).toBeNull();
    // And a count of a list that failed to load is not a count.
    expect(screen.queryByText('Publications (0)')).toBeNull();
    expect(screen.getByText('Publications (unavailable)')).toBeTruthy();
  });

  test('a reload that fails after a write is reported too, not left showing stale success', async () => {
    /* The RELOAD path, which is a second read and was a second silent
       swallow. It runs right after a coach submits, which is the worst moment
       to go quiet: the page has just told them the write worked, so an empty
       list reads as confirmation rather than as a read nobody could make. */
    let submitted = false;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(SESSION_PATH)) {
        return {
          ok: true,
          json: async () => ({ authenticated: true, role: 'coach', account_id: 'coach-1', organization_id: 'org-1' }),
        } as Response;
      }
      if (url.includes('/publications/submit')) {
        submitted = true;
        return { ok: true, json: async () => ({ ok: true, status: 'pending_review' }) } as Response;
      }
      if (url.includes('/publications/create')) {
        // Mount succeeds; the reload that follows the submit does not.
        return submitted
          ? ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) } as Response)
          : ({ ok: true, json: async () => ({ items: [publication({ status: 'draft', compliance_check_status: 'pending' })] }) } as Response);
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    render(<CoachVideoPublicationsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Submit for review' }));

    await screen.findByText(/Your publications could not be read/);
    expect(screen.queryByText('No publications yet.')).toBeNull();
  });

  test('a coach who really has published nothing still reads that plainly', async () => {
    /* The other direction, and without it the test above would pass for a
       page that claimed failure permanently. An empty shelf is a real and
       ordinary state, and it must keep its own plain words. */
    global.fetch = mockFetch([]) as unknown as typeof fetch;

    render(<CoachVideoPublicationsPage />);

    await screen.findByText('No publications yet.');
    expect(screen.queryByText(/could not be read/)).toBeNull();
    expect(screen.getByText('Publications (0)')).toBeTruthy();
  });
});
