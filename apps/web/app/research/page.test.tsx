/**
 * @jest-environment jsdom
 */

// Slice 2 of issue #345 layered the answer-state ladder and the curator's
// Answer-a-Gap panel onto the research inbox. What these pin: the ladder
// badge renders from the batch endpoint; a viewer whose sources probe is
// refused sees no answer panel at all (the panel's visibility matches the
// POST's own gate); a curator's submission carries the provenance and is
// answered with the review-first message; and the pre-existing inbox --
// intake cards, requirement create, Mark Resolved -- still renders.

import { act, fireEvent, render, screen } from '@testing-library/react';

import ResearchIntakePage from './page';

const REQUIREMENT = {
  research_requirement_id: 7,
  source_event_name: 'question',
  source_entity_type: 'athlete',
  source_entity_id: 'ath-1',
  research_requirement: 'Is RPE reliable at age 12?',
  knowledge_gap: 'adolescent RPE reliability',
  evidence_label: null,
  source_status: 'active',
  source_confidence_tier: 'tier_2',
  source_verification_state: 'unverified',
  status: 'open',
  created_at: '2026-08-10T12:00:00.000Z',
};

const SOURCE = { source_id: 'src-1', title: 'RPE reliability in adolescents', source_type: 'peer_reviewed' };

function mockFetch(options: { curator: boolean; capture?: { posts: unknown[] } }) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/research-submissions') && init?.method === 'POST') {
      options.capture?.posts.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ item: {} }) } as Response;
    }
    if (url.includes('research_requirement_ids=')) {
      return { ok: true, json: async () => ({ answer_states: { '7': 'sources_submitted' } }) } as Response;
    }
    if (url.includes('/library/sources')) {
      return options.curator
        ? ({ ok: true, json: async () => ({ sources: [SOURCE] }) } as Response)
        : ({ ok: false, status: 403, json: async () => ({}) } as Response);
    }
    if (url.includes('/research-requirements')) {
      return { ok: true, json: async () => ({ items: [REQUIREMENT] }) } as Response;
    }
    if (url.includes('/research-projection')) {
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('the ladder badge renders from the batch answer-state read', async () => {
  global.fetch = mockFetch({ curator: false });

  await act(async () => {
    render(<ResearchIntakePage />);
  });

  await screen.findByText('Is RPE reliable at age 12?');
  expect(screen.getByText('Sources Submitted')).toBeTruthy();
});

test('a viewer refused by the sources probe gets no Answer-a-Gap panel', async () => {
  global.fetch = mockFetch({ curator: false });

  await act(async () => {
    render(<ResearchIntakePage />);
  });

  await screen.findByText('Is RPE reliable at age 12?');
  expect(screen.queryByRole('button', { name: 'Answer this gap' })).toBeNull();
  // The rest of the inbox is untouched.
  expect(screen.getByRole('button', { name: 'Mark Resolved' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Save Requirement' })).toBeTruthy();
});

test('a curator files the link with provenance and is told review decides, not the upload', async () => {
  const capture = { posts: [] as unknown[] };
  global.fetch = mockFetch({ curator: true, capture });

  await act(async () => {
    render(<ResearchIntakePage />);
  });

  await screen.findByText('Is RPE reliable at age 12?');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Answer this gap' }));
  });
  await act(async () => {
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'src-1' } });
    fireEvent.change(screen.getByLabelText(/DOI \/ PMID/i), { target: { value: '10.1000/x' } });
    fireEvent.change(screen.getByLabelText(/Provider/i), { target: { value: 'Penn State Library' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Submit source' }));
  });

  expect(capture.posts).toHaveLength(1);
  const posted = capture.posts[0] as Record<string, unknown>;
  expect(posted.research_requirement_id).toBe(7);
  expect(posted.source_id).toBe('src-1');
  expect(posted.provenance).toEqual({ doi_or_pmid: '10.1000/x', provider: 'Penn State Library' });
  expect(screen.getByText(/answers nothing until evidence review says so/i)).toBeTruthy();
});
