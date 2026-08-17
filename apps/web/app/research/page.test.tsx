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

const SECOND_REQUIREMENT = {
  ...REQUIREMENT,
  research_requirement_id: 8,
  research_requirement: 'Does footwork drill order matter?',
};

function mockFetch(options: { curator: boolean; capture?: { posts: unknown[] }; requirements?: Array<Record<string, unknown>> }) {
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
      return { ok: true, json: async () => ({ items: options.requirements ?? [REQUIREMENT] }) } as Response;
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
    fireEvent.change(screen.getByLabelText('Library source'), { target: { value: 'src-1' } });
    fireEvent.change(screen.getAllByLabelText(/DOI \/ PMID/i)[0], { target: { value: '10.1000/x' } });
    fireEvent.change(screen.getAllByLabelText(/Provider/i)[0], { target: { value: 'Penn State Library' } });
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

// Review catch on the shared message string: with several gaps open, a
// message produced under one card must never render under another.
test('the submission message renders only under the requirement it belongs to', async () => {
  const capture = { posts: [] as unknown[] };
  global.fetch = mockFetch({ curator: true, capture, requirements: [REQUIREMENT, SECOND_REQUIREMENT] });

  await act(async () => {
    render(<ResearchIntakePage />);
  });

  await screen.findByText('Does footwork drill order matter?');
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: 'Answer this gap' })[0]);
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Library source'), { target: { value: 'src-1' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Submit source' }));
  });

  expect(screen.getAllByText(/answers nothing until evidence review says so/i)).toHaveLength(1);
});

// Issue #345 workflow 3: general-research intake. Classification is a
// human-picked, human-correctable filing label in source metadata. These pin
// that registration posts the taxonomy key with provenance under
// general_research, that correction PATCHes the narrow endpoint, and that a
// non-curator sees none of it.
describe('general research intake', () => {
  const GENERAL_SOURCE = {
    source_id: 'src-gen',
    title: 'Nonprofit board best practices',
    source_type: 'textbook',
    metadata: { general_research: true, classification_domain: 'fundraising_donor_development' },
  };

  function mockFetchGeneral(options: { curator: boolean; capture: { posts: unknown[]; patches: unknown[] } }) {
    return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/library/sources') && init?.method === 'POST') {
        options.capture.posts.push(JSON.parse(String(init.body)));
        return { ok: true, json: async () => ({ ok: true, source: {} }) } as Response;
      }
      if (url.includes('/library/sources') && init?.method === 'PATCH') {
        options.capture.patches.push(JSON.parse(String(init.body)));
        return { ok: true, json: async () => ({ ok: true, source: {} }) } as Response;
      }
      if (url.includes('/library/sources')) {
        return options.curator
          ? ({ ok: true, json: async () => ({ items: [GENERAL_SOURCE] }) } as Response)
          : ({ ok: false, status: 403, json: async () => ({}) } as Response);
      }
      if (url.includes('/research-requirements')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;
  }

  test('a non-curator sees no general research section', async () => {
    global.fetch = mockFetchGeneral({ curator: false, capture: { posts: [], patches: [] } });

    await act(async () => {
      render(<ResearchIntakePage />);
    });

    expect(screen.queryByText('General Research Intake')).toBeNull();
  });

  test('registration posts the taxonomy key and provenance under general_research', async () => {
    const capture = { posts: [] as unknown[], patches: [] as unknown[] };
    global.fetch = mockFetchGeneral({ curator: true, capture });

    await act(async () => {
      render(<ResearchIntakePage />);
    });

    await screen.findByText('General Research Intake');
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Youth safeguarding review' } });
      fireEvent.change(screen.getByLabelText('Classification domain'), { target: { value: 'youth_development_safeguarding' } });
      fireEvent.change(screen.getByLabelText('DOI / PMID'), { target: { value: 'PMID: 123' } });
      fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'Penn State Library' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Register general research' }));
    });

    expect(capture.posts).toHaveLength(1);
    const posted = capture.posts[0] as { metadata: Record<string, unknown> };
    expect(posted.metadata.general_research).toBe(true);
    expect(posted.metadata.classification_domain).toBe('youth_development_safeguarding');
    expect(posted.metadata.provenance).toEqual({ doi_or_pmid: 'PMID: 123', provider: 'Penn State Library' });
    expect(screen.getByText(/Evidence review still decides what becomes citable/)).toBeTruthy();
  });

  test('correcting a classification PATCHes the narrow endpoint', async () => {
    const capture = { posts: [] as unknown[], patches: [] as unknown[] };
    global.fetch = mockFetchGeneral({ curator: true, capture });

    await act(async () => {
      render(<ResearchIntakePage />);
    });

    await screen.findByText('Nonprofit board best practices');
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Correct classification for Nonprofit board best practices'), {
        target: { value: 'nonprofit_management_governance' },
      });
    });

    expect(capture.patches).toEqual([
      { source_id: 'src-gen', classification_domain: 'nonprofit_management_governance' },
    ]);
  });
});

// The submission-review lifecycle (GET/POST/PATCH on research-submissions)
// had no caller: a curator could submit a source and never move it past
// "submitted" through any shipped screen. These pin the panel that closes
// that gap -- it lists a requirement's submitted sources on demand and
// applies one of the four review verdicts via the existing PATCH.
describe('submission review panel', () => {
  const REVIEW_SUBMISSION = {
    submission_id: 'sub-1',
    source_id: 'src-1',
    submission_note: 'Directly compares two roadwork volumes.',
    applicability_state: 'unreviewed' as const,
    review_note: '',
    created_at: '2026-08-02T00:00:00Z',
  };

  function mockFetchReview(options: { curator: boolean; patches?: unknown[] }) {
    return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.includes('/research-submissions') && method === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as { submission_id: string; applicability_state: string };
        options.patches?.push(body);
        return {
          ok: true,
          json: async () => ({ item: { ...REVIEW_SUBMISSION, applicability_state: body.applicability_state } }),
        } as Response;
      }
      if (url.includes('/research-submissions') && url.includes('research_requirement_ids=')) {
        return { ok: true, json: async () => ({ answer_states: { '7': 'sources_submitted' } }) } as Response;
      }
      if (url.includes('/research-submissions') && url.includes('research_requirement_id=7')) {
        return { ok: true, json: async () => ({ items: [REVIEW_SUBMISSION], answer_state: 'sources_submitted' }) } as Response;
      }
      if (url.includes('/library/sources')) {
        if (!options.curator) return { ok: false, status: 403, json: async () => ({}) } as Response;
        // The general-research probe (its own filtered read) must not also
        // surface SOURCE, or the source title matches twice: once as the
        // review panel's row, once in the unrelated general-intake list.
        return { ok: true, json: async () => ({ sources: url.includes('general_research=true') ? [] : [SOURCE] }) } as Response;
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

  test('a non-curator sees no review controls', async () => {
    global.fetch = mockFetchReview({ curator: false });

    await act(async () => {
      render(<ResearchIntakePage />);
    });

    await screen.findByText('Is RPE reliable at age 12?');
    expect(screen.queryByRole('button', { name: 'Review submitted sources' })).toBeNull();
  });

  test('a curator opens the panel and sees the pending submission', async () => {
    global.fetch = mockFetchReview({ curator: true });

    await act(async () => {
      render(<ResearchIntakePage />);
    });

    const toggle = await screen.findByRole('button', { name: 'Review submitted sources' });
    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(await screen.findByText('RPE reliability in adolescents')).toBeTruthy();
    expect(screen.getByText('Directly compares two roadwork volumes.')).toBeTruthy();
    expect(screen.getByText('Unreviewed')).toBeTruthy();
  });

  test('applying a verdict PATCHes the endpoint and updates the badge', async () => {
    const patches: unknown[] = [];
    global.fetch = mockFetchReview({ curator: true, patches });

    await act(async () => {
      render(<ResearchIntakePage />);
    });

    const toggle = await screen.findByRole('button', { name: 'Review submitted sources' });
    await act(async () => {
      fireEvent.click(toggle);
    });
    await screen.findByText('RPE reliability in adolescents');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Responsive' }));
    });

    expect(patches).toEqual([{ submission_id: 'sub-1', applicability_state: 'responsive' }]);
    expect(await screen.findByText('Review recorded.')).toBeTruthy();
    // Two "Responsive" nodes now exist: the resulting badge and the
    // (now-disabled) verdict button that produced it.
    expect(screen.getAllByText('Responsive')).toHaveLength(2);
  });
});
