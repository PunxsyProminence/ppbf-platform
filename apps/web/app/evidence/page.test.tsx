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
import { act, render, screen } from '@testing-library/react';

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
