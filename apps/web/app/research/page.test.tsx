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
//
// Added with the route guard: this page rendered its whole workspace shell to
// a signed-out visitor. The last test in this file is the regression pin for
// that, and it is the one test here that runs the REAL RoleStandaloneView --
// a stubbed shell cannot prove a gate.

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import ResearchIntakePage from './page';
import { RESEARCH_CLASSIFICATION_DOMAINS } from '@/src/shared/researchClassification';

// Passthrough by default, so the content tests below exercise the page rather
// than the shell -- the same stub /research/review's suite uses. The guard
// test flips it off.
let mockBypassShell = true;

jest.mock('@/components/RoleStandaloneView', () => {
  const React = jest.requireActual('react');
  const actual = jest.requireActual('@/components/RoleStandaloneView');
  return {
    __esModule: true,
    default: (props: { readonly children: ReactNode }) =>
      mockBypassShell
        ? React.createElement('div', null, props.children)
        : React.createElement(actual.default, props),
  };
});

const mockReplace = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

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
  mockBypassShell = true;
  mockReplace.mockReset();
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
  expect(screen.queryByRole('region', { name: 'Add source text to the Library' })).toBeNull();
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
  expect(screen.getByRole('region', { name: 'Add source text to the Library' })).toBeTruthy();
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

  // THE TAXONOMY'S ONLY UI CONSUMER, PINNED. Widening the constant to R01-R19 is
  // pointless if the page that renders it truncates the list -- and until this
  // test existed, changing the render to `.slice(0, 14).map(...)` left the whole
  // suite green while curators lost the ability to file into R15-R19. That is
  // the exact regression this work exists to prevent, so it gets an assertion
  // on the rendered <option> list rather than on the constant.
  //
  // Asserts the FULL ordered list, not just that R15-R19 are present: a
  // presence-only check would still pass if a domain in the middle vanished or
  // the order drifted away from the archive crosswalk the curator reads against.
  test('the classification select offers every domain in the taxonomy, in order', async () => {
    global.fetch = mockFetchGeneral({ curator: true, capture: { posts: [], patches: [] } });

    await act(async () => {
      render(<ResearchIntakePage />);
    });

    await screen.findByText('General Research Intake');
    const select = screen.getByLabelText('Classification domain') as HTMLSelectElement;
    const options = Array.from(select.options);

    expect(options[0].value).toBe('');
    expect(options.slice(1).map((option) => option.value))
      .toEqual(RESEARCH_CLASSIFICATION_DOMAINS.map((domain) => domain.key));
    expect(options.slice(1).map((option) => option.textContent))
      .toEqual(RESEARCH_CLASSIFICATION_DOMAINS.map((domain) => domain.label));

    // The reclassification select on an already-registered source renders the
    // same list from the same constant; if only one of the two were pinned, a
    // truncation applied to the other would still ship.
    const correction = screen.getByLabelText(
      'Correct classification for Nonprofit board best practices',
    ) as HTMLSelectElement;
    expect(Array.from(correction.options).slice(1).map((option) => option.value))
      .toEqual(RESEARCH_CLASSIFICATION_DOMAINS.map((domain) => domain.key));
  });

  test('correcting a classification PATCHes the narrow endpoint', async () => {
    const capture = { posts: [] as unknown[], patches: [] as unknown[] };
    global.fetch = mockFetchGeneral({ curator: true, capture });

    await act(async () => {
      render(<ResearchIntakePage />);
    });

    // selector: the title is also an option in the Add Source Text panel.
    await screen.findByText('Nonprofit board best practices', { selector: 'p' });
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

// The projection fetch starts `items` at [] before its request ever resolves,
// so an unguarded "items.length === 0" empty state renders on the very first
// paint and is indistinguishable from the projection actually being empty --
// a loading state that lies about being an empty state. This pins a real
// pending state in between.
test('a still-loading projection shows a pending state, not the empty state, until it resolves', async () => {
  let resolveProjection: (value: Response) => void = () => {};
  const projectionPromise = new Promise<Response>((resolve) => {
    resolveProjection = resolve;
  });

  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/research-projection')) {
      return projectionPromise;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;

  await act(async () => {
    render(<ResearchIntakePage />);
  });

  expect(screen.getByText('Loading research projection...')).toBeTruthy();
  expect(screen.queryByText('Empty State')).toBeNull();

  await act(async () => {
    resolveProjection({ ok: true, json: async () => ({ items: [] }) } as Response);
    await projectionPromise;
  });

  await screen.findByText('Empty State');
  expect(screen.queryByText('Loading research projection...')).toBeNull();
});

// #991 class (Lane 14 batch 8, R1). The sentence was guarded; the counts were
// not. A failed projection read printed ITEMS: 0, PENDING REVIEW: 0 and four 0
// tiles beside the failure alert, a measured-looking zero the read never gave.
function failProjection(projection: () => Promise<Response>) {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/research-projection')) return projection();
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;
}

function summaryTileValues(): string[] {
  const heading = screen.getByRole('heading', { name: 'Review State Summary' });
  const section = heading.closest('section');
  if (!section) throw new Error('Review State Summary section is missing');
  return Array.from(section.querySelectorAll('article p.t-data')).map((element) => element.textContent ?? '');
}

test.each([
  ['a refused read', async () => ({ ok: false, json: async () => ({}) }) as Response],
  ['a network failure', async (): Promise<Response> => { throw new TypeError('Failed to fetch'); }],
])('%s prints no projection count, only the alert', async (_name, projection) => {
  failProjection(projection);

  await act(async () => {
    render(<ResearchIntakePage />);
  });

  // The plaques read '--' while loading too, so wait for the read to settle.
  await waitFor(() => expect(screen.queryByText('Loading research projection...')).toBeNull());
  expect(screen.getByText('ITEMS: --')).toBeTruthy();
  expect(screen.getByText('PENDING REVIEW: --')).toBeTruthy();
  expect(summaryTileValues()).toEqual(['--', '--', '--', '--']);
  expect(screen.queryByText('Empty State')).toBeNull();
});

test('a projection that answered empty prints real zeros', async () => {
  failProjection(async () => ({ ok: true, json: async () => ({ items: [] }) }) as Response);

  await act(async () => {
    render(<ResearchIntakePage />);
  });

  await screen.findByText('Empty State');
  expect(screen.getByText('ITEMS: 0')).toBeTruthy();
  expect(summaryTileValues()).toEqual(['0', '0', '0', '0']);
});

// The guard. /research shipped with no gate at all: an unauthenticated visitor
// got 200 and the full workspace shell -- pipeline banner, review-state
// summary, and the Save Requirement form. The data APIs refused correctly
// throughout, so nothing leaked, but the shell itself is not a public surface
// and it must not render before the session is authorized.
test('an unauthenticated visitor gets no workspace shell, only the bounce', async () => {
  mockBypassShell = false;

  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/pilot/auth/session')) {
      return { ok: false, status: 401, json: async () => ({ authenticated: false }) } as Response;
    }
    // Every data route this page reaches for refuses the same visitor.
    return { ok: false, status: 401, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;

  await act(async () => {
    render(<ResearchIntakePage />);
  });

  // None of the workspace: not the header, not the pipeline banner, not the
  // form. queryBy* (never getBy*) so a rendered shell fails as an assertion
  // rather than as a thrown lookup.
  expect(screen.queryByRole('heading', { name: 'Research Inbox' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save Requirement' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Mark Resolved' })).toBeNull();
  expect(screen.queryByText('Research Intake')).toBeNull();

  // What they get instead, and where they are sent.
  expect(screen.getByText('Checking access')).toBeTruthy();
  expect(mockReplace).toHaveBeenCalledWith('/login');
});

// RINT-05b (OD-2026-10-02-013 1B; OD-2026-10-02-015 D2/D3). The platform
// owner's curator block works the platform shelf: every Library read and write
// names it, and no gym-shelf write control is offered (the server would refuse
// it, M1 of #1115). A gym curator's requests carry no shelf at all.
describe('the platform shelf', () => {
  interface Seen { gets: string[]; posts: Array<{ url: string; body: Record<string, unknown> }> }

  function mockShelfFetch(role: string, seen: Seen, pageOf: (offset: number) => unknown[] = () => [SOURCE]) {
    return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/pilot/auth/session')) {
        return { ok: true, json: async () => ({ authenticated: true, role, auth_provider: 'microsoft' }) } as Response;
      }
      if (init?.method === 'POST' || init?.method === 'PATCH') {
        seen.posts.push({ url, body: JSON.parse(String(init.body)) });
        if (url.includes('/research-projection')) return { ok: true, json: async () => ({ items: [] }) } as Response;
        return { ok: true, status: 201, json: async () => ({ ok: true, source: {}, document: { document_id: 'doc_1' } }) } as Response;
      }
      if (url.includes('/library/sources')) {
        seen.gets.push(url);
        const offset = Number(new URL(url, 'https://app.test').searchParams.get('offset') ?? '0');
        return { ok: true, json: async () => ({ items: url.includes('general_research=true') ? [] : pageOf(offset) }) } as Response;
      }
      if (url.includes('/research-requirements')) {
        return { ok: true, json: async () => ({ items: [REQUIREMENT] }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;
  }

  async function registerOne() {
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Hydration position stand' } });
      fireEvent.change(screen.getByLabelText('Classification domain'), {
        target: { value: RESEARCH_CLASSIFICATION_DOMAINS[0].key },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Register general research' }));
    });
  }

  test('the platform owner reads and writes the platform shelf and is offered no gym-shelf write', async () => {
    const seen: Seen = { gets: [], posts: [] };
    global.fetch = mockShelfFetch('platform_owner', seen);

    await act(async () => {
      render(<ResearchIntakePage />);
    });

    await screen.findByText('General Research Intake');
    expect(screen.getByText('PLATFORM SHELF (EVERY GYM READS THIS)')).toBeTruthy();
    expect(seen.gets.length).toBeGreaterThan(0);
    expect(seen.gets.every((url) => url.includes('shelf=platform'))).toBe(true);

    // Requirements are the gym's: answering one would be a gym-shelf write.
    await screen.findByText('Is RPE reliable at age 12?');
    expect(screen.queryByRole('button', { name: 'Answer this gap' })).toBeNull();

    await registerOne();
    const registration = seen.posts.find((post) => post.url.includes('/library/sources'));
    expect(registration?.body.shelf).toBe('platform');
  });

  test('a gym curator names no shelf anywhere and still answers gaps', async () => {
    const seen: Seen = { gets: [], posts: [] };
    global.fetch = mockShelfFetch('organization_admin', seen);

    await act(async () => {
      render(<ResearchIntakePage />);
    });

    await screen.findByText('General Research Intake');
    expect(screen.queryByText('PLATFORM SHELF (EVERY GYM READS THIS)')).toBeNull();
    expect(seen.gets.length).toBeGreaterThan(0);
    expect(seen.gets.some((url) => url.includes('shelf'))).toBe(false);
    await screen.findByText('Is RPE reliable at age 12?');
    expect(screen.getByRole('button', { name: 'Answer this gap' })).toBeTruthy();

    await registerOne();
    const registration = seen.posts.find((post) => post.url.includes('/library/sources'));
    expect(registration).toBeTruthy();
    expect(registration?.body).not.toHaveProperty('shelf');
  });

  test('the picker loads the newest thousand a page at a time and says when there are more', async () => {
    const seen: Seen = { gets: [], posts: [] };
    const fullPage = (offset: number) => Array.from({ length: 200 }, (_, index) => ({
      source_id: `src_${offset + index}`, title: `Paper ${offset + index}`, source_type: 'peer_reviewed',
    }));
    global.fetch = mockShelfFetch('platform_owner', seen, fullPage);

    await act(async () => {
      render(<ResearchIntakePage />);
    });

    await screen.findByText('General Research Intake');
    const pickerReads = seen.gets.filter((url) => !url.includes('general_research'));
    expect(pickerReads.map((url) => new URL(url, 'https://app.test').searchParams.get('offset') ?? '0'))
      .toEqual(['0', '200', '400', '600', '800', '1000']);
    const select = screen.getByLabelText('Registered source') as HTMLSelectElement;
    expect(select.options).toHaveLength(1 + 1_000);
    expect(screen.getByText(/Only the newest 1,000 are listed/)).toBeTruthy();
  });

  test('a short shelf is read once and not called incomplete', async () => {
    const seen: Seen = { gets: [], posts: [] };
    global.fetch = mockShelfFetch('organization_admin', seen);

    await act(async () => {
      render(<ResearchIntakePage />);
    });

    await screen.findByText('General Research Intake');
    expect(seen.gets.filter((url) => !url.includes('general_research'))).toHaveLength(1);
    expect(screen.queryByText(/Only the newest/)).toBeNull();
  });
});

describe('the picker at the cap', () => {
  function pagedFetch(pageOf: (offset: number) => unknown[] | null, gets: string[]) {
    return jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/library/sources')) {
        gets.push(url);
        if (url.includes('general_research=true')) return { ok: true, json: async () => ({ items: [] }) } as Response;
        const offset = Number(new URL(url, 'https://app.test').searchParams.get('offset') ?? '0');
        const page = pageOf(offset);
        return page === null
          ? ({ ok: false, status: 500, json: async () => ({}) } as Response)
          : ({ ok: true, json: async () => ({ items: page }) } as Response);
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;
  }
  const rows = (from: number, count: number) => Array.from({ length: count }, (_, index) => ({
    source_id: `src_${from + index}`, title: `Paper ${from + index}`, source_type: 'peer_reviewed',
  }));

  test('a shelf of exactly 1,000 is complete, not cut short', async () => {
    global.fetch = pagedFetch((offset) => (offset < 1_000 ? rows(offset, 200) : []), []);
    await act(async () => {
      render(<ResearchIntakePage />);
    });
    await screen.findByText('General Research Intake');
    expect((screen.getByLabelText('Registered source') as HTMLSelectElement).options).toHaveLength(1 + 1_000);
    expect(screen.queryByText(/Only the newest/)).toBeNull();
  });

  test('a page that fails part-way keeps what loaded and says how many that is', async () => {
    global.fetch = pagedFetch((offset) => (offset === 0 ? rows(0, 200) : null), []);
    await act(async () => {
      render(<ResearchIntakePage />);
    });
    await screen.findByText('General Research Intake');
    expect(screen.getByText(/Only the newest 200 are listed/)).toBeTruthy();
  });

  test('a row repeated across pages is listed once', async () => {
    global.fetch = pagedFetch((offset) => (offset === 0 ? rows(0, 200) : offset === 200 ? rows(199, 3) : []), []);
    await act(async () => {
      render(<ResearchIntakePage />);
    });
    await screen.findByText('General Research Intake');
    expect((screen.getByLabelText('Registered source') as HTMLSelectElement).options).toHaveLength(1 + 202);
  });
});
