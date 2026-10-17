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

function mockFetch(options: {
  curator: boolean;
  capture?: { posts: unknown[] };
  requirements?: Array<Record<string, unknown>>;
  role?: string;
}) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    // A coach unless a test says otherwise: closing a research need that names
    // no athlete is a staff act since CL-C14.
    if (url.includes('/api/pilot/auth/session')) {
      return {
        ok: true,
        // A curator fixture signs in as an organization admin: the Library's
        // curator sections are theirs, while a coach only attaches (A-Q13).
        json: async () => ({ authenticated: true, role: options.role ?? (options.curator ? 'organization_admin' : 'coach'), auth_provider: 'microsoft' }),
      } as Response;
    }
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

/* /research is three tabs (#345); a panel not shown is hidden, so a role
   query reaches it only after its tab is opened. */
function openTab(name: 'Needs Evidence' | 'General Research' | 'Intake Cards') {
  fireEvent.click(screen.getByRole('tab', { name }));
}

afterEach(() => {
  // The chosen tab is remembered in this browser; each test starts fresh.
  window.localStorage.clear();
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
  // The probe failing (a refused or broken read) hides the panel; the rest of
  // the inbox, including a coach's Mark Resolved, stays.
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

// Release 11 walk-through: a signed-in parent was shown the "Operational
// research requirements" form and its Save Requirement button. The requirements
// POST refuses everyone but coaches and organization admins, so the form is
// offered only to them. Their list stays: "Family reads, staff closes"
// (OD-2026-10-06-010).
test.each(['parent', 'athlete', 'volunteer', 'staff'])('a %s is not offered the Save Requirement form', async (role) => {
  global.fetch = mockFetch({ curator: false, role });

  await act(async () => {
    render(<ResearchIntakePage />);
  });

  await screen.findByText('Is RPE reliable at age 12?');
  expect(screen.queryByRole('button', { name: 'Save Requirement' })).toBeNull();
  expect(screen.queryByPlaceholderText('Research requirement')).toBeNull();
  // Reading is untouched; only staff get the close control.
  expect(screen.getByRole('heading', { name: 'Operational Research Requirements' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Mark Resolved' })).toBeNull();
});

test.each(['coach', 'organization_admin', 'admin'])('a %s is still offered the Save Requirement form', async (role) => {
  global.fetch = mockFetch({ curator: false, role });

  await act(async () => {
    render(<ResearchIntakePage />);
  });

  await screen.findByText('Is RPE reliable at age 12?');
  expect(screen.getByRole('button', { name: 'Save Requirement' })).toBeTruthy();
});

test('a curator files the link with provenance and is told review decides, not the upload', async () => {
  const capture = { posts: [] as unknown[] };
  global.fetch = mockFetch({ curator: true, capture });

  await act(async () => {
    render(<ResearchIntakePage />);
  });

  await screen.findByText('Is RPE reliable at age 12?');
  openTab('General Research');
  expect(screen.getByRole('region', { name: 'Add source text to the Library' })).toBeTruthy();
  openTab('Needs Evidence');
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

  function mockFetchGeneral(options: { curator: boolean; capture: { posts: unknown[]; patches: unknown[] }; role?: string }) {
    return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/pilot/auth/session')) {
        return { ok: true, json: async () => ({ authenticated: true, role: options.role ?? 'organization_admin', auth_provider: 'microsoft' }) } as Response;
      }
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

  test('a viewer the sources list refuses sees no general research section', async () => {
    global.fetch = mockFetchGeneral({ curator: false, capture: { posts: [], patches: [] }, role: 'volunteer' });

    await act(async () => {
      render(<ResearchIntakePage />);
    });

    expect(screen.queryByText('General Research Intake')).toBeNull();
  });

  // A coach reads the list (A-Q13) but does not register sources.
  test('a coach, whom the sources list answers, still sees no general research section', async () => {
    const capture = { posts: [] as unknown[], patches: [] as unknown[] };
    global.fetch = mockFetchGeneral({ curator: true, capture, role: 'coach' });

    await act(async () => {
      render(<ResearchIntakePage />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText('General Research Intake')).toBeNull();
    expect(capture.posts).toHaveLength(0);
  });

  test('registration posts the taxonomy key and provenance under general_research', async () => {
    const capture = { posts: [] as unknown[], patches: [] as unknown[] };
    global.fetch = mockFetchGeneral({ curator: true, capture });

    await act(async () => {
      render(<ResearchIntakePage />);
    });

    await screen.findByText('General Research Intake');
    openTab('General Research');
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
  openTab('Intake Cards');
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

// CL-A3 / CL-C14 (Jason 2026-10-06: "Staff only"; "Family reads, staff
// closes"). Members see their own questions and families see rows about their
// child, but only coaches and organization admins close any requirement, and
// the server refuses everyone else (403). The button must not be offered to
// someone it would refuse.
describe('Mark Resolved is offered to staff only', () => {
  const ABOUT_A_CHILD = { ...SECOND_REQUIREMENT, subject_id: 'ath-1', metadata: {} };

  test.each(['athlete', 'parent', 'volunteer', 'staff', 'platform_owner'])(
    'a %s sees their own question with no Mark Resolved',
    async (role) => {
      global.fetch = mockFetch({ curator: false, role, requirements: [{ ...REQUIREMENT, subject_id: null, metadata: {} }] });

      await act(async () => {
        render(<ResearchIntakePage />);
      });

      await screen.findByText('Is RPE reliable at age 12?');
      expect(screen.queryByRole('button', { name: 'Mark Resolved' })).toBeNull();
    },
  );

  // "Family reads, staff closes" (Jason 2026-10-06): a row about the athlete
  // themselves is shown, with no button to close it.
  test.each(['athlete', 'parent'])('a %s reads a row about their child with no Mark Resolved', async (role) => {
    global.fetch = mockFetch({ curator: false, role, requirements: [ABOUT_A_CHILD] });

    await act(async () => {
      render(<ResearchIntakePage />);
    });

    await screen.findByText('Does footwork drill order matter?');
    expect(screen.queryByRole('button', { name: 'Mark Resolved' })).toBeNull();
  });

  test.each(['coach', 'organization_admin', 'admin'])('a %s keeps Mark Resolved on every open row', async (role) => {
    global.fetch = mockFetch({ curator: false, role, requirements: [REQUIREMENT, ABOUT_A_CHILD] });

    await act(async () => {
      render(<ResearchIntakePage />);
    });

    await screen.findByText('Is RPE reliable at age 12?');
    expect(screen.getAllByRole('button', { name: 'Mark Resolved' })).toHaveLength(2);
  });
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
    openTab('General Research');
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
      if (url.includes('/api/pilot/auth/session')) {
        return { ok: true, json: async () => ({ authenticated: true, role: 'organization_admin', auth_provider: 'microsoft' }) } as Response;
      }
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

// OD-2026-10-08-005 A-Q13 (#1467): closing a research requirement needs a
// closing note or an approved submission. The page closes with a note.
describe('closing a requirement with a note', () => {
  function captureResolves(response: { ok: boolean; status?: number; body?: Record<string, unknown> } = { ok: true }) {
    const resolves: Array<Record<string, unknown>> = [];
    const base = mockFetch({ curator: false });
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/research-requirements') && init?.method === 'POST') {
        resolves.push(JSON.parse(String(init.body)));
        return { ok: response.ok, status: response.status ?? 200, json: async () => response.body ?? { ok: true } } as Response;
      }
      return base(input, init);
    }) as unknown as typeof fetch;
    return resolves;
  }

  test('Mark Resolved asks for a note, and Resolve sends it once there is one', async () => {
    const resolves = captureResolves();
    await act(async () => {
      render(<ResearchIntakePage />);
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Mark Resolved' }));
    const resolve = screen.getByRole('button', { name: 'Resolve' });
    expect((resolve as HTMLButtonElement).disabled).toBe(true);
    expect(resolves).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('Closing note'), { target: { value: '  Covered by the RPE review in the Library.  ' } });
    expect((resolve as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(resolve);
    });

    expect(resolves).toEqual([expect.objectContaining({
      action: 'resolve',
      research_requirement_id: 7,
      closing_note: 'Covered by the RPE review in the Library.',
    })]);
    expect(await screen.findByText('Closing note: Covered by the RPE review in the Library.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mark Resolved' })).toBeNull();
  });

  test('a refused close shows the server reason and keeps the note and the row open', async () => {
    captureResolves({ ok: false, status: 400, body: { error: 'missing closing_note or closing_submission_id: a requirement closes with a closing note or an approved submission' } });
    await act(async () => {
      render(<ResearchIntakePage />);
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Mark Resolved' }));
    fireEvent.change(screen.getByLabelText('Closing note'), { target: { value: 'Answered.' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    });

    expect(screen.getByText(/a requirement closes with a closing note or an approved submission/)).toBeTruthy();
    expect((screen.getByLabelText('Closing note') as HTMLTextAreaElement).value).toBe('Answered.');
    expect(screen.queryByText(/^Closing note:/)).toBeNull();
  });

  test('a resolved requirement shows the closing note it was closed with', async () => {
    global.fetch = mockFetch({
      curator: false,
      requirements: [{ ...REQUIREMENT, status: 'resolved', metadata: { closing_note: 'No reliable data under 14; revisit next year.' } }],
    });
    await act(async () => {
      render(<ResearchIntakePage />);
    });

    expect(await screen.findByText('Closing note: No reliable data under 14; revisit next year.')).toBeTruthy();
  });

  test('Cancel closes the note field without sending anything', async () => {
    const resolves = captureResolves();
    await act(async () => {
      render(<ResearchIntakePage />);
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Mark Resolved' }));
    fireEvent.change(screen.getByLabelText('Closing note'), { target: { value: 'half written' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByLabelText('Closing note')).toBeNull();
    expect(resolves).toHaveLength(0);
  });
});

test('while one requirement is resolving, no other row opens a note field', async () => {
  let finish: (() => void) | null = null;
  const base = mockFetch({ curator: false, requirements: [REQUIREMENT, SECOND_REQUIREMENT] });
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/research-requirements') && init?.method === 'POST') {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    }
    return base(input, init);
  }) as unknown as typeof fetch;
  await act(async () => {
    render(<ResearchIntakePage />);
  });

  fireEvent.click((await screen.findAllByRole('button', { name: 'Mark Resolved' }))[0]);
  fireEvent.change(screen.getByLabelText('Closing note'), { target: { value: 'Answered.' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
  });

  expect(screen.getByRole('button', { name: 'Resolving...' })).toBeTruthy();
  const others = screen.getAllByRole('button', { name: 'Mark Resolved' });
  expect(others).toHaveLength(1);
  expect((others[0] as HTMLButtonElement).disabled).toBe(true);

  await act(async () => {
    finish?.();
  });
  expect(await screen.findByText('Closing note: Answered.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Mark Resolved' }) as HTMLButtonElement).disabled).toBe(false);
});

// Issue #1466: a question a coach filed from an unanswered SHADOW reply shows
// up in this feed, open, and is named in words rather than by its event name.
test('a requirement filed from SHADOW reads "Asked in SHADOW" with its open status; others keep their event name', async () => {
  global.fetch = mockFetch({
    curator: false,
    requirements: [
      {
        ...REQUIREMENT,
        research_requirement_id: 9,
        source_event_name: 'shadow_unanswered_question',
        source_entity_type: 'shadow_question',
        source_entity_id: 'how long should a 13-year-old rest between sparring rounds?',
        research_requirement: 'How long should a 13-year-old rest between sparring rounds?',
      },
      REQUIREMENT,
    ],
  });

  await act(async () => {
    render(<ResearchIntakePage />);
  });

  const filed = (await screen.findByText('How long should a 13-year-old rest between sparring rounds?')).closest('article');
  expect(filed?.textContent).toContain('Asked in SHADOW');
  expect(filed?.textContent).toContain('Open');
  expect(filed?.textContent).not.toContain('shadow_unanswered_question');
  const other = screen.getByText('Is RPE reliable at age 12?').closest('article');
  expect(other?.textContent).toContain('question');
  expect(other?.textContent).not.toContain('Asked in SHADOW');
});

// OD-2026-10-08-005 A-Q13, ruling 6: "a coach may attach a source". The
// sources list now answers a coach, so the attach panel shows; the Library's
// curator sections (registering a source, adding its text) do not.
describe('a coach attaches an existing source', () => {
  test('the attach panel is offered and posts an unreviewed link; the curator sections are not shown', async () => {
    const capture = { posts: [] as unknown[] };
    global.fetch = mockFetch({ curator: true, capture, role: 'coach' });

    await act(async () => {
      render(<ResearchIntakePage />);
    });

    await screen.findByText('Is RPE reliable at age 12?');
    expect(screen.queryByRole('region', { name: 'Add source text to the Library' })).toBeNull();
    expect(screen.queryByText('General Research Intake')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Answer this gap' }));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Library source'), { target: { value: 'src-1' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Submit source' }));
    });

    expect(capture.posts).toHaveLength(1);
    const posted = capture.posts[0] as Record<string, unknown>;
    expect(posted.research_requirement_id).toBe(7);
    expect(posted.source_id).toBe('src-1');
    expect(posted).not.toHaveProperty('document_id');
    expect(screen.getByText(/answers nothing until evidence review says so/i)).toBeTruthy();
  });

  test.each(['parent', 'athlete'])('a %s, refused the sources list, gets no attach panel', async (role) => {
    global.fetch = mockFetch({ curator: false, role });

    await act(async () => {
      render(<ResearchIntakePage />);
    });

    await screen.findByText('Is RPE reliable at age 12?');
    expect(screen.queryByRole('button', { name: 'Answer this gap' })).toBeNull();
  });
});

describe('the requirements list comes a page at a time (F-025)', () => {
  function pagedFetch(urls: string[]) {
    const pageOne = Array.from({ length: 50 }, (_, index) => ({
      ...REQUIREMENT,
      research_requirement_id: 1000 - index,
      research_requirement: `Paged requirement ${1000 - index}`,
    }));
    const pageTwo = [{ ...REQUIREMENT, research_requirement_id: 900, research_requirement: 'The last requirement' }];
    return jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/api/pilot/auth/session')) {
        return { ok: true, json: async () => ({ authenticated: true, role: 'coach', auth_provider: 'microsoft' }) } as Response;
      }
      if (url.includes('research_requirement_ids=')) {
        return { ok: true, json: async () => ({ answer_states: {} }) } as Response;
      }
      if (url.includes('/library/sources')) {
        return { ok: false, status: 403, json: async () => ({}) } as Response;
      }
      if (url.includes('/research-requirements')) {
        return url.includes('cursor=')
          ? ({ ok: true, json: async () => ({ items: pageTwo, next_cursor: null }) } as Response)
          : ({ ok: true, json: async () => ({ items: pageOne, next_cursor: 'cursor-after-951' }) } as Response);
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;
  }

  test('the first page is asked for with a limit, and Load more appends the next page by its cursor', async () => {
    const urls: string[] = [];
    global.fetch = pagedFetch(urls);

    await act(async () => {
      render(<ResearchIntakePage />);
    });

    await screen.findByText('Paged requirement 1000');
    expect(urls.some((url) => url.includes('/research-requirements?limit=50') && !url.includes('cursor='))).toBe(true);
    expect(screen.queryByText('The last requirement')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load more requirements' }));
    });

    await screen.findByText('The last requirement');
    expect(screen.getByText('Paged requirement 951')).toBeTruthy();
    expect(urls.some((url) => url.includes('/research-requirements?limit=50&cursor=cursor-after-951'))).toBe(true);
    // The answer states of the new page are asked for too.
    expect(urls.some((url) => url.includes('research_requirement_ids=900'))).toBe(true);
    // Nothing left: the control goes away.
    expect(screen.queryByRole('button', { name: 'Load more requirements' })).toBeNull();
  });

  test('a list with nothing after it shows no Load more control', async () => {
    global.fetch = mockFetch({ curator: false });

    await act(async () => {
      render(<ResearchIntakePage />);
    });

    await screen.findByText('Is RPE reliable at age 12?');
    expect(screen.queryByRole('button', { name: 'Load more requirements' })).toBeNull();
  });
});

describe('closing on a submission reviewed Responsive (OD-2026-10-08-005 A-Q13)', () => {
  const SUBMISSIONS = [
    { submission_id: 'sub-yes', source_id: 'src-1', applicability_state: 'responsive', review_note: 'Answers it for 12-14' },
    { submission_id: 'sub-wait', source_id: 'src-2', applicability_state: 'unreviewed', review_note: '' },
    { submission_id: 'sub-no', source_id: 'src-3', applicability_state: 'not_responsive', review_note: '' },
  ];

  function lifecycleFetch(options: {
    role?: string;
    submissions?: Array<Record<string, unknown>> | 'refused';
    requirements?: Array<Record<string, unknown>>;
  } = {}) {
    const resolves: Array<Record<string, unknown>> = [];
    const submissionReads: string[] = [];
    const base = mockFetch({ curator: true, role: options.role ?? 'coach', requirements: options.requirements });
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/research-requirements') && init?.method === 'POST') {
        resolves.push(JSON.parse(String(init.body)));
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      if (url.includes('/research-submissions?research_requirement_id=')) {
        submissionReads.push(url);
        if (options.submissions === 'refused') return { ok: false, status: 403, json: async () => ({}) } as Response;
        return { ok: true, json: async () => ({ items: options.submissions ?? SUBMISSIONS, answer_state: 'partially_answered' }) } as Response;
      }
      return base(input, init);
    }) as unknown as typeof fetch;
    return { resolves, submissionReads };
  }

  test('a coach closes on the Responsive submission with no note, and the row says which source answered it', async () => {
    const { resolves, submissionReads } = lifecycleFetch();
    await act(async () => {
      render(<ResearchIntakePage />);
    });

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Mark Resolved' }));
    });
    expect(submissionReads).toEqual([expect.stringContaining('research_requirement_id=7')]);

    const resolve = screen.getByRole('button', { name: 'Resolve' }) as HTMLButtonElement;
    expect(resolve.disabled).toBe(true);
    // Only the Responsive submission is offered, beside "None".
    const group = screen.getByRole('group', { name: 'Close with a submission reviewed Responsive' });
    expect(Array.from(group.querySelectorAll('label')).map((label) => label.textContent)).toEqual([
      'None', 'RPE reliability in adolescents',
    ]);

    fireEvent.click(screen.getByRole('radio', { name: 'RPE reliability in adolescents' }));
    expect(resolve.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(resolve);
    });

    expect(resolves).toEqual([{
      action: 'resolve',
      research_requirement_id: 7,
      closing_submission_id: 'sub-yes',
      metadata: { resolved_from: 'research_page' },
    }]);
    expect(await screen.findByText('Answered by: RPE reliability in adolescents')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mark Resolved' })).toBeNull();
  });

  test('a note and a submission are sent together when both are given', async () => {
    const { resolves } = lifecycleFetch();
    await act(async () => {
      render(<ResearchIntakePage />);
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Mark Resolved' }));
    });
    fireEvent.click(screen.getByRole('radio', { name: 'RPE reliability in adolescents' }));
    fireEvent.change(screen.getByLabelText('Closing note'), { target: { value: 'Good for 12-14 only.' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    });
    expect(resolves).toEqual([expect.objectContaining({ closing_note: 'Good for 12-14 only.', closing_submission_id: 'sub-yes' })]);
  });

  test('with no Responsive submission there is nothing to pick, and a note is still required', async () => {
    const { resolves } = lifecycleFetch({ submissions: SUBMISSIONS.filter((s) => s.applicability_state !== 'responsive') });
    await act(async () => {
      render(<ResearchIntakePage />);
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Mark Resolved' }));
    });
    expect(screen.queryByRole('group', { name: 'Close with a submission reviewed Responsive' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Resolve' }) as HTMLButtonElement).disabled).toBe(true);
    expect(resolves).toHaveLength(0);
  });

  test('picking None again takes the submission back out of the close', async () => {
    const { resolves } = lifecycleFetch();
    await act(async () => {
      render(<ResearchIntakePage />);
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Mark Resolved' }));
    });
    fireEvent.click(screen.getByRole('radio', { name: 'RPE reliability in adolescents' }));
    fireEvent.click(screen.getByRole('radio', { name: 'None' }));
    expect((screen.getByRole('button', { name: 'Resolve' }) as HTMLButtonElement).disabled).toBe(true);
    expect(resolves).toHaveLength(0);
  });

  test('Submitted sources lists each source with its verdict and review note', async () => {
    lifecycleFetch();
    await act(async () => {
      render(<ResearchIntakePage />);
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Submitted sources' }));
    });
    const list = await screen.findByRole('list', { name: 'Submitted sources' });
    expect(Array.from(list.querySelectorAll('li')).map((item) => item.textContent)).toEqual([
      'RPE reliability in adolescents — Responsive (Answers it for 12-14)',
      'src-2 — Unreviewed',
      'src-3 — Not Responsive',
    ]);
  });

  test('a refused submissions read says so instead of "none submitted"', async () => {
    lifecycleFetch({ submissions: 'refused' });
    await act(async () => {
      render(<ResearchIntakePage />);
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Submitted sources' }));
    });
    expect(await screen.findByText('The submitted sources could not be read.')).toBeTruthy();
    expect(screen.queryByText('No sources submitted yet.')).toBeNull();
  });

  test('a row closed on a submission says so before its sources are read', async () => {
    lifecycleFetch({ requirements: [{ ...REQUIREMENT, status: 'resolved', metadata: { closing_note: null, closing_submission_id: 'sub-yes' } }] });
    await act(async () => {
      render(<ResearchIntakePage />);
    });
    expect(await screen.findByText('Closed with a submission reviewed Responsive.')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Submitted sources' }));
    });
    expect(await screen.findByText('Answered by: RPE reliability in adolescents')).toBeTruthy();
  });

  test.each(['parent', 'athlete', 'volunteer'])('a %s is offered neither the submitted sources nor a close', async (role) => {
    lifecycleFetch({ role });
    await act(async () => {
      render(<ResearchIntakePage />);
    });
    await screen.findByText('Is RPE reliable at age 12?');
    expect(screen.queryByRole('button', { name: 'Submitted sources' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark Resolved' })).toBeNull();
  });

  test('a pick on one row is not carried to the next, and a string id from the list is sent back as it came', async () => {
    // The list route hands ids back as pg returns a bigint: a string.
    const second = { ...SECOND_REQUIREMENT, research_requirement_id: '4108' };
    const { resolves } = lifecycleFetch({ requirements: [REQUIREMENT, second] });
    await act(async () => {
      render(<ResearchIntakePage />);
    });
    await screen.findByText('Does footwork drill order matter?');

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Mark Resolved' })[0]);
    });
    fireEvent.click(screen.getByRole('radio', { name: 'RPE reliability in adolescents' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark Resolved' }));
    });
    const resolve = screen.getByRole('button', { name: 'Resolve' }) as HTMLButtonElement;
    expect(resolve.disabled).toBe(true);
    expect((screen.getByRole('radio', { name: 'None' }) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole('radio', { name: 'RPE reliability in adolescents' }));
    await act(async () => {
      fireEvent.click(resolve);
    });
    expect(resolves).toEqual([expect.objectContaining({ research_requirement_id: '4108', closing_submission_id: 'sub-yes' })]);
  });

  test('a pick that is no longer Responsive on reload leaves the close', async () => {
    let reads = 0;
    const base = mockFetch({ curator: true, role: 'coach' });
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/research-submissions?research_requirement_id=')) {
        reads += 1;
        const items = reads === 1 ? SUBMISSIONS : SUBMISSIONS.map((s) => ({ ...s, applicability_state: 'not_responsive' }));
        return { ok: true, json: async () => ({ items }) } as Response;
      }
      return base(input, init);
    }) as unknown as typeof fetch;
    await act(async () => {
      render(<ResearchIntakePage />);
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Mark Resolved' }));
    });
    fireEvent.click(screen.getByRole('radio', { name: 'RPE reliability in adolescents' }));
    expect((screen.getByRole('button', { name: 'Resolve' }) as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Submitted sources' }));
    });
    expect(reads).toBe(2);
    expect(screen.queryByRole('group', { name: 'Close with a submission reviewed Responsive' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Resolve' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('attaching a source re-reads a submitted-sources list already shown', async () => {
    const { submissionReads } = lifecycleFetch();
    await act(async () => {
      render(<ResearchIntakePage />);
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Submitted sources' }));
    });
    expect(submissionReads).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Answer this gap' }));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Library source'), { target: { value: 'src-1' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Submit source' }));
    });
    expect(submissionReads).toHaveLength(2);
  });

  test('the Submission Review door is shown to a curator and not to a coach', async () => {
    lifecycleFetch({ role: 'organization_admin' });
    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(<ResearchIntakePage />);
    });
    expect((await screen.findByRole('link', { name: 'Submission Review' })).getAttribute('href')).toBe('/research/review');
    view?.unmount();

    lifecycleFetch({ role: 'coach' });
    await act(async () => {
      render(<ResearchIntakePage />);
    });
    await screen.findByText('Is RPE reliable at age 12?');
    expect(screen.queryByRole('link', { name: 'Submission Review' })).toBeNull();
  });
});

describe("/research as #345's three workflows", () => {
  function panel(id: 'needs_evidence' | 'general_research' | 'intake') {
    return document.getElementById(`research-panel-${id}`);
  }

  function tabNames() {
    return screen.getAllByRole('tab').map((tab) => [tab.textContent, tab.getAttribute('aria-selected')]);
  }

  async function renderPage(fetchOptions: Parameters<typeof mockFetch>[0]) {
    global.fetch = mockFetch(fetchOptions);
    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(<ResearchIntakePage />);
    });
    await screen.findByText('Is RPE reliable at age 12?');
    return view!;
  }

  test('a curator sees three tabs and lands on Needs Evidence; the other panels are hidden', async () => {
    await renderPage({ curator: true });
    await screen.findByRole('tab', { name: 'General Research' });
    expect(tabNames()).toEqual([
      ['Needs Evidence', 'true'], ['General Research', 'false'], ['Intake Cards', 'false'],
    ]);
    expect(panel('needs_evidence')?.hidden).toBe(false);
    expect(panel('general_research')?.hidden).toBe(true);
    expect(panel('intake')?.hidden).toBe(true);
    expect(screen.getByRole('button', { name: 'Mark Resolved' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Review State Summary' })).toBeNull();
  });

  test('a coach, who curates nothing, gets no General Research tab', async () => {
    await renderPage({ curator: true, role: 'coach' });
    expect(tabNames()).toEqual([['Needs Evidence', 'true'], ['Intake Cards', 'false']]);
    expect(panel('general_research')).toBeNull();
  });

  test('opening a tab shows its panel only, and the choice is remembered on the next visit', async () => {
    const view = await renderPage({ curator: false });
    openTab('Intake Cards');
    expect(panel('intake')?.hidden).toBe(false);
    expect(panel('needs_evidence')?.hidden).toBe(true);
    expect(screen.getByRole('heading', { name: 'Review State Summary' })).toBeTruthy();
    view.unmount();

    await renderPage({ curator: false });
    expect(screen.getByRole('tab', { name: 'Intake Cards' }).getAttribute('aria-selected')).toBe('true');
    expect(panel('intake')?.hidden).toBe(false);
  });

  test.each([['general_research', 'a tab this viewer does not have'], ['bogus', 'an unknown value']])(
    'a remembered %s (%s) falls back to Needs Evidence',
    async (stored) => {
      window.localStorage.setItem('ppbf.research.tab', stored);
      await renderPage({ curator: false });
      expect(screen.getByRole('tab', { name: 'Needs Evidence' }).getAttribute('aria-selected')).toBe('true');
      expect(panel('needs_evidence')?.hidden).toBe(false);
    },
  );

  test('blocked browser storage leaves the tabs working', async () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    await renderPage({ curator: false });
    expect(panel('needs_evidence')?.hidden).toBe(false);
    openTab('Intake Cards');
    expect(panel('intake')?.hidden).toBe(false);
  });

  test('a half-typed General Research draft survives a look at another tab', async () => {
    await renderPage({ curator: true });
    await screen.findByRole('tab', { name: 'General Research' });
    openTab('General Research');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Hydration position stand' } });
    openTab('Needs Evidence');
    openTab('General Research');
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Hydration position stand');
  });

  test('the arrow keys move between the tabs this viewer has', async () => {
    await renderPage({ curator: false });
    const first = screen.getByRole('tab', { name: 'Needs Evidence' });
    expect(first.tabIndex).toBe(0);
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Intake Cards' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Intake Cards' }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Needs Evidence' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Intake Cards' }).getAttribute('aria-selected')).toBe('true');
  });
});
