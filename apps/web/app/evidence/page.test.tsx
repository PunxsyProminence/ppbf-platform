/**
 * @jest-environment jsdom
 */

// The evidence review queue had no test coverage before this and no loading
// state either: `queue` started at `{ sources: [], documents: [] }`, so a
// slow or failed GET rendered "No sources/documents are awaiting review" --
// a claim about the SHADOW pipeline -- while the request was still in
// flight or had failed outright. What this pins: the empty copy is withheld
// during the load, a failed load shows the failure instead of (not beside)
// the empty copy, and a populated queue still renders its rows and actions.

import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import EvidenceReviewPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

const SOURCE = {
  source_id: 'src-1',
  title: 'Youth Strength Training Guidelines',
  publisher: 'NSCA',
  source_type: 'guideline',
  status: 'indexed',
  approval_state: 'pending_review' as const,
  verification_state: 'unverified',
};

function mockFetch(responder: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => responder(String(input), init)) as unknown as typeof fetch;
}

const okWith = (sources: unknown[], documents: unknown[] = []) =>
  ({ ok: true, json: async () => ({ sources, documents }) }) as Response;

afterEach(() => {
  jest.restoreAllMocks();
});

test('the empty copy is withheld while the queue is still loading', async () => {
  global.fetch = mockFetch(() => new Promise<Response>(() => {}));

  render(<EvidenceReviewPage />);

  await screen.findAllByText(/Loading the review queue/);
  expect(screen.queryByText('No sources are awaiting review')).toBeNull();
  expect(screen.queryByText('No documents are awaiting review')).toBeNull();
});

test('a failed load shows the failure, never the empty copy, in each panel', async () => {
  global.fetch = mockFetch(() => ({ ok: false, status: 500, json: async () => ({}) }) as Response);

  render(<EvidenceReviewPage />);

  await waitFor(() => expect(screen.getAllByText('Unable to load the evidence review queue.')).toHaveLength(2)); // Sources + Documents panels
  expect(screen.queryByText('No sources are awaiting review')).toBeNull();
  expect(screen.queryByText('No documents are awaiting review')).toBeNull();
});

test('an empty queue shows the built empty state once loading settles', async () => {
  global.fetch = mockFetch(() => okWith([]));

  render(<EvidenceReviewPage />);

  await screen.findByText('No sources are awaiting review');
  await screen.findByText('No documents are awaiting review');
  await waitFor(() => expect(screen.queryByText(/Loading the review queue/)).toBeNull());
});

test('a populated queue renders its rows and review actions', async () => {
  global.fetch = mockFetch(() => okWith([SOURCE]));

  render(<EvidenceReviewPage />);

  await screen.findByText('Youth Strength Training Guidelines');
  expect(screen.getByText('Pending Review')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Approve + verify' })).toBeTruthy();
  expect(screen.queryByText('No sources are awaiting review')).toBeNull();
});
