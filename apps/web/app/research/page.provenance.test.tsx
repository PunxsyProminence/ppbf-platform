/**
 * @jest-environment jsdom
 */

// Issue #345 R29 (PR "E2"): the General Research form collects the provenance
// fields the contract accepts (src/shared/researchProvenance.ts) and the
// registered-source list shows what was saved. What these pin: the new fields
// are in one collapsed block; an empty value is never sent; a set value is sent
// in the contract's shape; the contract's own validator refuses a bad value
// before anything is posted; the route's 400 message is shown as written; and
// the list shows only the fields that are set.

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import ResearchIntakePage from './page';
import {
  RESEARCH_BOXING_SPECIFICITY_VALUES,
  RESEARCH_PROTECTED_DOMAINS,
  parseResearchProvenance,
} from '@/src/shared/researchProvenance';

jest.mock('@/components/RoleStandaloneView', () => {
  const React = jest.requireActual('react');
  return {
    __esModule: true,
    default: (props: { readonly children: ReactNode }) => React.createElement('div', null, props.children),
  };
});

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn() }),
}));

type Answer = { status: number; json: unknown };

function mockLibrary(options: { sources?: unknown[]; answers?: Answer[]; posts: Array<Record<string, unknown>> }) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/pilot/auth/session')) {
      return { ok: true, json: async () => ({ authenticated: true, role: 'organization_admin', auth_provider: 'microsoft' }) } as Response;
    }
    if (url.includes('/library/sources') && init?.method === 'POST') {
      options.posts.push(JSON.parse(String(init.body)));
      const answer = options.answers?.shift() ?? { status: 201, json: { ok: true, source: {} } };
      return { ok: answer.status < 400, status: answer.status, json: async () => answer.json } as Response;
    }
    if (url.includes('/library/sources')) {
      return { ok: true, json: async () => ({ items: options.sources ?? [] }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;
}

async function openForm() {
  await act(async () => {
    render(<ResearchIntakePage />);
  });
  await screen.findByText('General Research Intake');
  fireEvent.click(screen.getByRole('tab', { name: 'General Research' }));
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function fillRequired() {
  await act(async () => {
    fill('Title', 'Punch force in amateur boxers');
    fill('Classification domain', 'youth_development_safeguarding');
  });
}

async function register() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Register general research' }));
  });
}

const PROVENANCE_LABELS = [
  'Institutional source ID', 'Authors (separate with semicolons)', 'Year', 'Journal', 'Publication date', 'Study design',
  'Population', 'Age range', 'Sex', 'Transfer status', 'Boxing specificity',
];

afterEach(() => {
  window.localStorage.clear();
  jest.restoreAllMocks();
});

describe('the provenance fields on the General Research form', () => {
  test('they are in one collapsed block, and every field the contract takes is there', async () => {
    global.fetch = mockLibrary({ posts: [] });
    await openForm();

    const block = screen.getByText('More provenance (optional)').closest('details') as HTMLDetailsElement;
    expect(block.open).toBe(false);
    for (const label of PROVENANCE_LABELS) {
      expect(within(block).getByLabelText(label)).toBeTruthy();
    }
    // The title/domain/DOI path stays outside the block.
    expect(block.contains(screen.getByLabelText('Title'))).toBe(false);
    expect(block.contains(screen.getByLabelText('DOI / PMID'))).toBe(false);
  });

  test('the boxing-specificity select and the protected-domain boxes are the contract\'s own lists', async () => {
    global.fetch = mockLibrary({ posts: [] });
    await openForm();

    const select = screen.getByLabelText('Boxing specificity') as HTMLSelectElement;
    const offered = Array.from(select.options).map((option) => option.value).filter(Boolean);
    expect(offered).toEqual([...RESEARCH_BOXING_SPECIFICITY_VALUES]);
    expect(offered).toHaveLength(4);

    const group = screen.getByRole('group', { name: 'Protected domains this source speaks to' });
    expect(within(group).getAllByRole('checkbox')).toHaveLength(RESEARCH_PROTECTED_DOMAINS.length);
    expect(within(group).getByLabelText('Return to play')).toBeTruthy();
  });

  test('a registration with none of them sends none of them', async () => {
    const posts: Array<Record<string, unknown>> = [];
    global.fetch = mockLibrary({ posts });
    await openForm();
    await fillRequired();
    await act(async () => {
      fill('DOI / PMID', '10.1000/abc');
    });
    await register();

    expect(posts).toHaveLength(1);
    const body = posts[0] as { metadata: { provenance: unknown } };
    expect(body.metadata.provenance).toEqual({ doi_or_pmid: '10.1000/abc' });
    expect(Object.keys(posts[0])).not.toContain('publisher');
    expect(Object.keys(posts[0])).not.toContain('publication_date');
  });

  test('blank and whitespace-only values are not sent, and unchecked boxes are not flags', async () => {
    const posts: Array<Record<string, unknown>> = [];
    global.fetch = mockLibrary({ posts });
    await openForm();
    await fillRequired();
    await act(async () => {
      fill('Study design', '   ');
      fill('Authors (separate with semicolons)', ' ; ');
      fill('Journal', '  ');
      fireEvent.click(screen.getByLabelText('Medical'));
      fireEvent.click(screen.getByLabelText('Medical'));
    });
    await register();

    expect(posts).toHaveLength(1);
    expect((posts[0] as { metadata: { provenance: unknown } }).metadata.provenance).toEqual({});
    expect(Object.keys(posts[0])).not.toContain('publisher');
  });

  test('set values are sent in the contract\'s shape', async () => {
    const posts: Array<Record<string, unknown>> = [];
    global.fetch = mockLibrary({ posts });
    await openForm();
    await fillRequired();
    await act(async () => {
      fill('Institutional source ID', ' PSU-2041 ');
      fill('Authors (separate with semicolons)', 'Smith J; Jones K\nLee M');
      fill('Year', '2019');
      fill('Journal', 'Journal of Strength and Conditioning Research');
      fill('Publication date', '2019-05-17');
      fill('Study design', 'Randomised crossover trial');
      fill('Population', 'Amateur boxers');
      fill('Age range', '16-18');
      fill('Sex', 'Male');
      fill('Transfer status', 'Direct');
      fill('Boxing specificity', 'ppbf_specific');
      fireEvent.click(screen.getByLabelText('Medical'));
      fireEvent.click(screen.getByLabelText('Weight management'));
    });
    await register();

    expect(posts).toHaveLength(1);
    const body = posts[0] as { publisher: string; publication_date: string; metadata: { provenance: Record<string, unknown> } };
    expect(body.publisher).toBe('Journal of Strength and Conditioning Research');
    expect(body.publication_date).toBe('2019-05-17');
    expect(body.metadata.provenance).toEqual({
      institutional_source_id: 'PSU-2041',
      authors: ['Smith J', 'Jones K', 'Lee M'],
      year: 2019,
      study_design: 'Randomised crossover trial',
      population: 'Amateur boxers',
      age_range: '16-18',
      sex: 'Male',
      transfer_status: 'Direct',
      boxing_specificity: 'ppbf_specific',
      protected_domains: { medical: true, weight_management: true },
    });
    // What was sent is what the contract itself accepts, unchanged.
    expect(parseResearchProvenance(body.metadata.provenance)).toEqual({ ok: true, provenance: body.metadata.provenance });
  });

  test('a value the contract refuses shows the contract\'s message, opens the block, and posts nothing', async () => {
    const posts: Array<Record<string, unknown>> = [];
    global.fetch = mockLibrary({ posts });
    await openForm();
    await fillRequired();
    await act(async () => {
      fill('Year', '19x9');
    });
    await register();

    expect(posts).toHaveLength(0);
    expect(screen.getByText(/year must be a whole year from \d{4} to \d{4}/)).toBeTruthy();
    expect((screen.getByText('More provenance (optional)').closest('details') as HTMLDetailsElement).open).toBe(true);

    // A too-long text value is refused by the same validator, not a copied limit.
    await act(async () => {
      fill('Year', '');
      fill('Population', 'x'.repeat(5000));
    });
    await register();
    expect(posts).toHaveLength(0);
    expect(screen.getByText(/population must be \d+ characters or fewer/)).toBeTruthy();
  });

  test('a block the curator closed is opened again by the next refusal', async () => {
    global.fetch = mockLibrary({ posts: [] });
    await openForm();
    await fillRequired();
    await act(async () => {
      fill('Year', 'abc');
    });
    await register();
    const block = screen.getByText('More provenance (optional)').closest('details') as HTMLDetailsElement;
    expect(block.open).toBe(true);

    // The curator closes it (the browser flips `open` and fires toggle) and tries again.
    await act(async () => {
      block.open = false;
      fireEvent(block, new Event('toggle'));
    });
    expect(block.open).toBe(false);
    await register();
    expect(block.open).toBe(true);
  });

  test('a 400 from the route shows the route\'s message and keeps what was typed', async () => {
    const posts: Array<Record<string, unknown>> = [];
    global.fetch = mockLibrary({ posts, answers: [{ status: 400, json: { ok: false, error: 'publication_date must be YYYY-MM-DD' } }] });
    await openForm();
    await fillRequired();
    await act(async () => {
      fill('Journal', 'Sports Medicine');
      fill('Publication date', '2019-05-17');
    });
    await register();

    expect(posts).toHaveLength(1);
    expect(screen.getByText('publication_date must be YYYY-MM-DD')).toBeTruthy();
    expect((screen.getByLabelText('Journal') as HTMLInputElement).value).toBe('Sports Medicine');
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Punch force in amateur boxers');
  });

  test('a registration whose answer is lost locks the new fields with the rest', async () => {
    const posts: Array<Record<string, unknown>> = [];
    global.fetch = mockLibrary({ posts, answers: [{ status: 503, json: { error: 'unavailable' } }] });
    await openForm();
    await fillRequired();
    await register();

    expect((screen.getByLabelText('Year') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Boxing specificity') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText('Medical') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('saved provenance on the registered general research list', () => {
  const FULL = {
    source_id: 'src-full',
    title: 'Punch force in amateur boxers',
    source_type: 'peer_reviewed',
    publisher: 'Journal of Strength and Conditioning Research',
    publication_date: '2019-05-17',
    metadata: {
      general_research: true,
      classification_domain: 'youth_development_safeguarding',
      provenance: {
        doi_or_pmid: '10.1000/abc',
        authors: ['Smith J', 'Jones K'],
        year: 2019,
        boxing_specificity: 'ppbf_specific',
        protected_domains: { medical: true, sparring: false, return_to_play: true },
      },
    },
  };
  const BARE = {
    source_id: 'src-bare',
    title: 'Board governance basics',
    source_type: 'textbook',
    metadata: { general_research: true, classification_domain: 'fundraising_donor_development', provenance: {} },
  };

  test('each set field is a read-only line, and a field that is not set has none', async () => {
    global.fetch = mockLibrary({ posts: [], sources: [FULL, BARE] });
    await openForm();

    const full = (await screen.findByText('Punch force in amateur boxers', { selector: 'p' })).closest('article') as HTMLElement;
    expect(within(full).getByText('Journal: Journal of Strength and Conditioning Research')).toBeTruthy();
    expect(within(full).getByText('Publication date: 2019-05-17')).toBeTruthy();
    expect(within(full).getByText('Year: 2019')).toBeTruthy();
    expect(within(full).getByText('Authors: Smith J; Jones K')).toBeTruthy();
    expect(within(full).getByText('DOI / PMID: 10.1000/abc')).toBeTruthy();
    expect(within(full).getByText('Boxing specificity: PPBF specific')).toBeTruthy();
    expect(within(full).getByText('Protected domains: Medical, Return to play')).toBeTruthy();
    // Set nowhere on this source: no line, not even an empty one.
    for (const unset of ['Population', 'Age range', 'Sex', 'Study design', 'Transfer status', 'Institutional source ID', 'Provider']) {
      expect(within(full).queryByText(new RegExp(`^${unset}:`))).toBeNull();
    }

    const bare = screen.getByText('Board governance basics', { selector: 'p' }).closest('article') as HTMLElement;
    expect(within(bare).queryByText(/^[A-Za-z /]+: /)).toBeNull();
  });
});
