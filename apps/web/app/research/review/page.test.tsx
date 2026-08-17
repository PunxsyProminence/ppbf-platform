/**
 * @jest-environment jsdom
 */

// The missing UI surface for issue #345's submission-review lifecycle: the
// PATCH endpoint that moves a submitted source through responsive /
// partially_responsive / not_responsive / duplicate existed with zero
// callers before this page. These pin: only open requirements with
// submissions render, the verdict buttons PATCH the right submission with
// the right body, a review note is optional and only sent when filled in,
// and a failed review shows the error rather than a false success message.

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';

import ResearchSubmissionReviewPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

const OPEN_REQUIREMENT = {
  research_requirement_id: 7,
  source_event_name: 'question',
  research_requirement: 'Is RPE reliable at age 12?',
  knowledge_gap: 'adolescent RPE reliability',
  status: 'open' as const,
};

const RESOLVED_REQUIREMENT = {
  research_requirement_id: 8,
  source_event_name: 'question',
  research_requirement: 'Does footwork drill order matter?',
  knowledge_gap: 'footwork sequencing',
  status: 'resolved' as const,
};

const SUBMISSION = {
  submission_id: 'sub-1',
  research_requirement_id: 7,
  source_id: 'src-1',
  document_id: null,
  provenance: { doi_or_pmid: '10.1000/x' },
  submission_note: 'Directly answers the reliability question.',
  applicability_state: 'unreviewed' as const,
  reviewed_by_account_id: null,
  reviewed_at: null,
  review_note: '',
  submitted_by_account_id: 'acct-1',
  created_at: '2026-08-10T12:00:00.000Z',
};

const LIBRARY_SOURCE = { source_id: 'src-1', title: 'RPE reliability in adolescents', source_type: 'peer_reviewed' };

function mockFetch(options: {
  requirements?: Array<Record<string, unknown>>;
  submissionsByRequirement?: Record<number, Array<Record<string, unknown>>>;
  patchHandler?: (body: Record<string, unknown>) => Response;
  sourcesOk?: boolean;
}) {
  const requirements = options.requirements ?? [OPEN_REQUIREMENT];
  const submissionsByRequirement: Record<number, Array<Record<string, unknown>>> =
    options.submissionsByRequirement ?? { 7: [SUBMISSION] };
  const sourcesOk = options.sourcesOk ?? true;

  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.includes('/research-requirements')) {
      return { ok: true, json: async () => ({ items: requirements }) } as Response;
    }
    if (url.includes('/research-submissions') && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return options.patchHandler
        ? options.patchHandler(body)
        : ({ ok: true, json: async () => ({ item: { ...SUBMISSION, applicability_state: body.applicability_state, review_note: body.review_note ?? '' } }) } as Response);
    }
    if (url.includes('/research-submissions?research_requirement_id=')) {
      const id = Number(new URL(url, 'http://localhost').searchParams.get('research_requirement_id'));
      return { ok: true, json: async () => ({ items: submissionsByRequirement[id] ?? [] }) } as Response;
    }
    if (url.includes('/library/sources')) {
      return sourcesOk
        ? ({ ok: true, json: async () => ({ sources: [LIBRARY_SOURCE] }) } as Response)
        : ({ ok: false, status: 403, json: async () => ({}) } as Response);
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  });
}

function installFetch(options: Parameters<typeof mockFetch>[0]) {
  const fetchMock = mockFetch(options);
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('a submission against an open requirement renders with its source title and unreviewed badge', async () => {
  installFetch({});

  await act(async () => {
    render(<ResearchSubmissionReviewPage />);
  });

  await screen.findByText('Is RPE reliable at age 12?');
  expect(screen.getByText('RPE reliability in adolescents (peer_reviewed)')).toBeInTheDocument();
  expect(screen.getByText('Unreviewed')).toBeInTheDocument();
});

test('a resolved requirement is never listed even if it somehow carries submissions', async () => {
  installFetch({
    requirements: [OPEN_REQUIREMENT, RESOLVED_REQUIREMENT],
    submissionsByRequirement: { 7: [SUBMISSION], 8: [{ ...SUBMISSION, submission_id: 'sub-2', research_requirement_id: 8 }] },
  });

  await act(async () => {
    render(<ResearchSubmissionReviewPage />);
  });

  await screen.findByText('Is RPE reliable at age 12?');
  expect(screen.queryByText('Does footwork drill order matter?')).toBeNull();
});

test('an open requirement with no submissions is not shown on this review-only panel', async () => {
  installFetch({ requirements: [OPEN_REQUIREMENT], submissionsByRequirement: { 7: [] } });

  await act(async () => {
    render(<ResearchSubmissionReviewPage />);
  });

  await screen.findByText(/No sources have been submitted/i);
  expect(screen.queryByText('Is RPE reliable at age 12?')).toBeNull();
});

test('a fallback to the bare source id renders when the sources probe is refused', async () => {
  installFetch({ sourcesOk: false });

  await act(async () => {
    render(<ResearchSubmissionReviewPage />);
  });

  await screen.findByText('Source src-1');
});

test('marking a verdict PATCHes the submission id and chosen state, without a review note when none was typed', async () => {
  const fetchMock = installFetch({});

  await act(async () => {
    render(<ResearchSubmissionReviewPage />);
  });

  await screen.findByText('Is RPE reliable at age 12?');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Mark Responsive' }));
  });

  const patchCall = fetchMock.mock.calls.find(
    (call) => String(call[0]).includes('/research-submissions') && (call[1] as RequestInit | undefined)?.method === 'PATCH',
  );
  expect(patchCall).toBeDefined();
  const body = JSON.parse(String((patchCall?.[1] as RequestInit).body));
  expect(body).toEqual({ submission_id: 'sub-1', applicability_state: 'responsive' });

  await screen.findByText('Marked Responsive.');
});

test('a typed review note is included in the PATCH body', async () => {
  const fetchMock = installFetch({});

  await act(async () => {
    render(<ResearchSubmissionReviewPage />);
  });

  await screen.findByText('Is RPE reliable at age 12?');
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Review note (optional)'), { target: { value: 'Matches age and modality.' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Mark Not Responsive' }));
  });

  const patchCall = fetchMock.mock.calls.find(
    (call) => String(call[0]).includes('/research-submissions') && (call[1] as RequestInit | undefined)?.method === 'PATCH',
  );
  const body = JSON.parse(String((patchCall?.[1] as RequestInit).body));
  expect(body).toEqual({
    submission_id: 'sub-1',
    applicability_state: 'not_responsive',
    review_note: 'Matches age and modality.',
  });
});

test('a failed review shows the error under that submission, not a false success message', async () => {
  installFetch({
    patchHandler: () => ({ ok: false, json: async () => ({ error: 'Forbidden' }) } as Response),
  });

  await act(async () => {
    render(<ResearchSubmissionReviewPage />);
  });

  await screen.findByText('Is RPE reliable at age 12?');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Mark Duplicate' }));
  });

  await screen.findByText('Forbidden');
  expect(screen.queryByText('Marked Duplicate.')).toBeNull();
});
