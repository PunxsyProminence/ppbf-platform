/**
 * @jest-environment jsdom
 */

// Three things this page used to say that it could not support.
//
// It called every chunk row indexed. chunk_count is a plain count over
// shadow_library_chunks with no state filter (listShadowLibraryReviewQueue),
// so a mid-pipeline document read "chunking · 14 indexed chunks" -- naming as
// indexed exactly the chunks the retrieval gate would refuse, two words after
// printing the state that says otherwise.
//
// It called an empty library a cleared queue. The read returns every source
// and document for the organization, with pending merely sorted first.
//
// And it said both of those before the read had resolved, because there was no
// loading state at all.

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import EvidenceReviewPage from './page';

jest.mock('@/components/RoleStandaloneView', () => {
  const React = jest.requireActual('react');
  return {
    __esModule: true,
    default: (props: { readonly children: ReactNode }) => React.createElement('div', null, props.children),
  };
});

const DOCUMENT = {
  document_id: 'doc_1',
  source_id: 'src_1',
  document_name: 'Adolescent load tolerance',
  ingest_state: 'chunking',
  index_completed_at: null,
  approval_state: 'pending_review' as const,
  verification_state: 'unverified',
  extraction_error: null,
  chunk_count: 14,
};

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

function mockQueue(queue: { sources: unknown[]; documents: unknown[] }) {
  const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => queue });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

test('asserts nothing about the library while the read is still open', async () => {
  // A promise nothing resolves: the render below is the state an admin sees
  // between opening the page and the response arriving.
  global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;

  render(<EvidenceReviewPage />);

  expect(screen.getByText(/Loading the evidence library/i)).toBeTruthy();
  expect(screen.queryByText(/No sources have been recorded/i)).toBeNull();
  expect(screen.queryByText(/No documents have been recorded/i)).toBeNull();
});

test('an empty result is an empty library, not a cleared queue', async () => {
  mockQueue({ sources: [], documents: [] });

  await act(async () => {
    render(<EvidenceReviewPage />);
  });

  expect(screen.getByText(/No sources have been recorded for this organization yet/i)).toBeTruthy();
  expect(screen.getByText(/No documents have been recorded for this organization yet/i)).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/awaiting review\./i);
  // And the page says which list it is showing, which is what makes the
  // sentence above mean anything.
  expect(screen.getByText(/with anything awaiting review sorted first/i)).toBeTruthy();
});

test('does not call a chunk indexed on the word of a count that never checked', async () => {
  mockQueue({ sources: [], documents: [DOCUMENT] });

  await act(async () => {
    render(<EvidenceReviewPage />);
  });

  expect(screen.getByText(/chunking · 14 chunks stored · indexing not confirmed/)).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/14 indexed chunks/);
});

test('says indexing is confirmed only when index_completed_at says so', async () => {
  mockQueue({
    sources: [],
    documents: [{ ...DOCUMENT, ingest_state: 'indexed', index_completed_at: '2026-08-11T09:00:00.000Z', chunk_count: 1 }],
  });

  await act(async () => {
    render(<EvidenceReviewPage />);
  });

  expect(screen.getByText(/indexed · 1 chunk stored · indexing confirmed/)).toBeTruthy();
});

test('a failed read shows the failure and nothing about the library', async () => {
  // The read never answered, so the page does not know whether the library
  // is empty. The banner used to sit on top of both empty sentences, which
  // told an admin the library was empty AND that nobody could look.
  global.fetch = jest.fn().mockResolvedValue({ ok: false, json: async () => ({}) }) as unknown as typeof fetch;

  await act(async () => {
    render(<EvidenceReviewPage />);
  });

  expect(screen.getByRole('alert').textContent).toMatch(/Unable to load the evidence review queue\./);
  expect(screen.queryByText(/No sources have been recorded/i)).toBeNull();
  expect(screen.queryByText(/No documents have been recorded/i)).toBeNull();
  expect(screen.queryByText(/Loading the evidence library/i)).toBeNull();
});

// RINT-05b (OD-2026-10-02-013 1B and 5A; OD-2026-10-02-015 D2). The platform
// owner opens on the platform shelf and can switch to the gym shelf; its reads
// and its review actions name the shelf it is looking at. Anyone else gets no
// switch and requests that name no shelf.
describe('the shelf switch', () => {
  interface Seen { gets: string[]; patches: Array<Record<string, unknown>> }

  function mockShelves(role: string | null, seen: Seen) {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/pilot/auth/session')) {
        return { ok: true, json: async () => (role ? { authenticated: true, role } : { authenticated: false }) } as Response;
      }
      if (init?.method === 'PATCH') {
        seen.patches.push(JSON.parse(String(init.body)));
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      seen.gets.push(url);
      const platform = url.includes('shelf=platform');
      return {
        ok: true,
        json: async () => ({
          sources: [],
          documents: [{ ...DOCUMENT, document_id: platform ? 'doc_p' : 'doc_g', document_name: platform ? 'Platform paper' : 'Gym paper' }],
        }),
      } as Response;
    }) as unknown as typeof fetch;
  }

  test('the platform owner opens on the platform shelf, reviews it there, and can switch to the gym shelf', async () => {
    const seen: Seen = { gets: [], patches: [] };
    mockShelves('platform_owner', seen);

    await act(async () => {
      render(<EvidenceReviewPage />);
    });

    expect(await screen.findByText('Platform paper')).toBeTruthy();
    expect(seen.gets).toHaveLength(1);
    expect(seen.gets[0]).toContain('shelf=platform');
    expect(screen.getByRole('button', { name: 'Platform shelf (every gym reads this)' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/held on the platform shelf is listed/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Approve + verify' })[0]);
    });
    expect(seen.patches).toEqual([
      { entityType: 'document', entityId: 'doc_p', action: 'review', approvalState: 'approved', shelf: 'platform' },
    ]);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: "Gym shelf (this account's gym only)" }));
    });
    expect(await screen.findByText('Gym paper')).toBeTruthy();
    expect(screen.queryByText('Platform paper')).toBeNull();
    expect(seen.gets[seen.gets.length - 1]).not.toContain('shelf');

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Approve + verify' })[0]);
    });
    expect(seen.patches[1]).toEqual({ entityType: 'document', entityId: 'doc_g', action: 'review', approvalState: 'approved' });
  });

  test('an organization admin gets no switch, and nothing it sends names a shelf', async () => {
    const seen: Seen = { gets: [], patches: [] };
    mockShelves('organization_admin', seen);

    await act(async () => {
      render(<EvidenceReviewPage />);
    });

    expect(await screen.findByText('Gym paper')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Which shelf to review' })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Approve + verify' })[0]);
    });
    expect(seen.gets.some((url) => url.includes('shelf'))).toBe(false);
    expect(seen.patches[0]).not.toHaveProperty('shelf');
  });

  test('a slow answer for the shelf just left does not land on the one just chosen', async () => {
    let releasePlatform: (() => void) | null = null;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/pilot/auth/session')) {
        return { ok: true, json: async () => ({ authenticated: true, role: 'platform_owner' }) } as Response;
      }
      if (url.includes('shelf=platform')) {
        await new Promise<void>((resolve) => { releasePlatform = resolve; });
        return { ok: true, json: async () => ({ sources: [], documents: [{ ...DOCUMENT, document_name: 'Platform paper' }] }) } as Response;
      }
      return { ok: true, json: async () => ({ sources: [], documents: [{ ...DOCUMENT, document_name: 'Gym paper' }] }) } as Response;
    }) as unknown as typeof fetch;

    await act(async () => {
      render(<EvidenceReviewPage />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: "Gym shelf (this account's gym only)" }));
    });
    expect(await screen.findByText('Gym paper')).toBeTruthy();
    await act(async () => {
      releasePlatform?.();
    });
    expect(screen.getByText('Gym paper')).toBeTruthy();
    expect(screen.queryByText('Platform paper')).toBeNull();
  });
});
