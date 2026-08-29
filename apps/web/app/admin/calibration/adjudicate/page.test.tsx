/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import CalibrationAdjudicationPage from './page';

/**
 * THE ADJUDICATION DESK.
 *
 * What these cases are for: this is the only screen in the platform that
 * writes a durable statement about two coaches' work, so the things it must
 * NOT do are as load-bearing as the things it must. It must not send a claim
 * about WHICH two readings were weighed, must not offer a control that edits
 * or deletes either reading, must not invent an agreement figure, and must
 * show the server's own refusal rather than a house-style substitute for it.
 */

const searchParams = new URLSearchParams('calibration_clip_id=clip-1');

jest.mock('next/navigation', () => ({
  useSearchParams: () => searchParams,
  // ONE object at module scope, returned every render. A useRouter mock that
  // returns a fresh object per render closes an infinite loop with any
  // component that subscribes to the role-session store, and the suite hangs
  // with no failing assertion and no timeout.
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

function eventOf(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 'evt-a1',
    event_class: 'punch',
    actor_track: 'red',
    start_ms: 1_000,
    end_ms: 1_400,
    punch_type: 'lead_straight',
    defense_type: null,
    visibility: 'clear',
    certainty: 'clear',
    ...overrides,
  };
}

const DESK = {
  ok: true,
  clip: {
    calibration_clip_id: 'clip-1',
    clip_code: 'C-01',
    start_ms: 12_000,
    end_ms: 18_000,
    primary_sampling_reason: 'occlusion',
  },
  sets: {
    a: {
      annotation_set_id: 'set-a',
      annotator_account_id: 'coach-a',
      ontology_version: 'boxing-ontology-0.1',
      status: 'submitted',
    },
    b: {
      annotation_set_id: 'set-b',
      annotator_account_id: 'coach-b',
      ontology_version: 'boxing-ontology-0.1',
      status: 'submitted',
    },
  },
  events: {
    a: [eventOf(), eventOf({ event_id: 'evt-a2', start_ms: 3_000, end_ms: 3_200 })],
    b: [eventOf({ event_id: 'evt-b1', punch_type: 'rear_hook' })],
  },
  adjudications: [
    {
      adjudication_id: 'adj-1',
      source_event_id_a: 'evt-a2',
      source_event_id_b: null,
      resolution_type: 'unresolvable',
      missed_event_verdict: 'unresolvable',
      adjudicator_account_id: 'admin-1',
      adjudicated_at: '2026-08-29T00:00:00.000Z',
      notes: null,
      fields: [
        {
          adjudicated_field_id: 'f-1',
          field_name: 'punch_type',
          disagreement_category: 'PUNCH_TYPE',
          resolved_from: 'adjudicator',
          resolved_value: null,
          unresolved: true,
        },
      ],
    },
  ],
  vocabularies: {
    resolution_types: [
      'agreement', 'accept_a', 'accept_b', 'new_adjudicated_value', 'unresolvable',
    ],
    missed_event_verdicts: [
      'a_event_real', 'b_event_real', 'both_distinct', 'neither_valid', 'unresolvable',
    ],
    resolved_from_sources: ['annotator_a', 'annotator_b', 'adjudicator'],
    disagreement_categories: ['EVENT_MISSED', 'PUNCH_TYPE', 'TARGET', 'OTHER'],
  },
};

function respondWith(body: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: async () => body,
  } as Response);
}

const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('what the desk shows', () => {
  test('both readings, and what has already been settled', async () => {
    fetchMock.mockImplementation(() => respondWith(DESK));

    render(<CalibrationAdjudicationPage />);

    expect(await screen.findByText('Clip C-01')).toBeInTheDocument();
    expect(screen.getByText('Coach A marked')).toBeInTheDocument();
    expect(screen.getByText('Coach B marked')).toBeInTheDocument();

    const settled = screen.getByText('Already settled on this clip').closest('table');
    expect(settled).not.toBeNull();
    expect(within(settled as HTMLElement).getByText(/nothing from B/)).toBeInTheDocument();
    expect(within(settled as HTMLElement).getByText(/punch_type: not settled/))
      .toBeInTheDocument();
  });

  test('the vocabularies rendered are the ones the server sent, not a local copy', async () => {
    /* The page cannot import them -- adjudication.ts imports ./db and would
     * drag the Postgres driver into the browser bundle -- so the route serves
     * them. This case is what makes that real: a payload carrying a shortened
     * vocabulary renders exactly that vocabulary, so a hardcoded <option> list
     * in the page would fail here. */
    fetchMock.mockImplementation(() => respondWith({
      ...DESK,
      vocabularies: {
        ...DESK.vocabularies,
        resolution_types: ['only_this_one'],
      },
    }));

    render(<CalibrationAdjudicationPage />);

    const select = await screen.findByLabelText('What was concluded');
    const options = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Choose an outcome', 'only_this_one']);
    // And none of the real vocabulary leaked in from a copy in this file.
    expect(options).not.toContain('accept_a');
  });

  test("a refusal is shown in the server's own words, in warning and not the safeguarding red", async () => {
    fetchMock.mockImplementation(() => respondWith(
      { error: 'Forbidden: this clip is not ready for adjudication -- an annotation set on it has not been submitted' },
      false,
      403,
    ));

    render(<CalibrationAdjudicationPage />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('not ready for adjudication');
    expect(alert).toHaveClass('alert--warning');
    expect(alert).not.toHaveClass('alert--critical');
    // Nothing about either reading rendered behind the refusal.
    expect(screen.queryByText('Coach A marked')).not.toBeInTheDocument();
    expect(screen.queryByText('Record a decision')).not.toBeInTheDocument();
  });

  test('no agreement figure, score or ranking appears anywhere on the screen', async () => {
    /* Counting how often a reviewer sided with one coach is an accuracy figure
     * by another name. comparison.ts refuses to compute one and this screen
     * must not manufacture it from the settled list either. */
    fetchMock.mockImplementation(() => respondWith(DESK));

    const { container } = render(<CalibrationAdjudicationPage />);
    await screen.findByText('Clip C-01');

    const text = (container.textContent ?? '').toLowerCase();
    for (const forbidden of ['score', 'accuracy', 'kappa', 'agreement rate', 'percent', 'ranking']) {
      expect(text).not.toContain(forbidden);
    }
  });

  test('there is no control that edits or deletes either coach\'s reading', async () => {
    // The two annotations are the measurement and are frozen by trigger after
    // submission. A button that appeared to change one would either do nothing
    // or do something nobody agreed to.
    fetchMock.mockImplementation(() => respondWith(DESK));

    render(<CalibrationAdjudicationPage />);
    await screen.findByText('Clip C-01');

    const labels = screen.getAllByRole('button').map((b) => (b.textContent ?? '').toLowerCase());
    for (const label of labels) {
      expect(label).not.toMatch(/edit|delete|remove this mark|correct/);
    }
  });
});

describe('what the desk sends', () => {
  test('the decision carries no claim about which two readings were weighed', async () => {
    /* THE CASE THIS SCREEN'S HALF OF THE GATE RESTS ON. The server derives the
     * two annotation set ids, the adjudicator, the vocabulary version and the
     * row's primary key from what the blinding gate returned. A page that sent
     * any of them would be making a claim it has no standing to make, and a
     * later server change that started trusting the body would have nothing
     * red to warn it. */
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => (
      init?.method === 'POST'
        ? respondWith({ ok: true, adjudication: { adjudication_id: 'adj-new' }, fields: [] })
        : respondWith(DESK)
    ));

    render(<CalibrationAdjudicationPage />);
    await screen.findByText('Clip C-01');

    fireEvent.change(screen.getByLabelText("Coach A's mark"), { target: { value: 'evt-a1' } });
    fireEvent.change(screen.getByLabelText('What was concluded'), { target: { value: 'accept_a' } });
    fireEvent.click(screen.getByText('Record this decision'));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true);
    });

    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    const sent = JSON.parse((postCall?.[1] as RequestInit).body as string);

    expect(sent.calibration_clip_id).toBe('clip-1');
    expect(sent.source_event_id_a).toBe('evt-a1');
    expect(sent.resolution_type).toBe('accept_a');

    expect(sent).not.toHaveProperty('annotation_set_id_a');
    expect(sent).not.toHaveProperty('annotation_set_id_b');
    expect(sent).not.toHaveProperty('adjudicator_account_id');
    expect(sent).not.toHaveProperty('ontology_version');
    expect(sent).not.toHaveProperty('adjudication_id');
  });

  test('a side nobody picked is sent as blank, not as an invented id', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => (
      init?.method === 'POST'
        ? respondWith({ ok: true, adjudication: { adjudication_id: 'adj-new' }, fields: [] })
        : respondWith(DESK)
    ));

    render(<CalibrationAdjudicationPage />);
    await screen.findByText('Clip C-01');

    fireEvent.change(screen.getByLabelText("Coach A's mark"), { target: { value: 'evt-a1' } });
    fireEvent.click(screen.getByText('Record this decision'));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true);
    });
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    const sent = JSON.parse((postCall?.[1] as RequestInit).body as string);

    // The server turns '' into "this annotator recorded nothing here". The
    // page never substitutes an id of its own for an unmade choice.
    expect(sent.source_event_id_b).toBe('');
    expect(sent.missed_event_verdict).toBe('');
  });

  test('an unresolved field is sent carrying no value', async () => {
    // The module refuses an unresolved field that carries a value, so a
    // control left holding text would be a 400 the reviewer cannot act on.
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => (
      init?.method === 'POST'
        ? respondWith({ ok: true, adjudication: { adjudication_id: 'adj-new' }, fields: [] })
        : respondWith(DESK)
    ));

    render(<CalibrationAdjudicationPage />);
    await screen.findByText('Clip C-01');

    fireEvent.click(screen.getByText('Add a field decision'));
    fireEvent.change(screen.getByLabelText('Field'), { target: { value: 'punch_type' } });
    fireEvent.change(screen.getByLabelText('Accepted value'), { target: { value: 'lead_hook' } });
    fireEvent.click(screen.getByLabelText('This field cannot be settled from the footage'));
    fireEvent.click(screen.getByText('Record this decision'));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true);
    });
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    const sent = JSON.parse((postCall?.[1] as RequestInit).body as string);

    expect(sent.fields).toHaveLength(1);
    expect(sent.fields[0].unresolved).toBe(true);
    expect(sent.fields[0].resolved_value).toBe('');
  });

  test("a refused decision shows the server's reason and records nothing", async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => (
      init?.method === 'POST'
        ? respondWith(
          { error: 'Missing fields: a new_adjudicated_value resolution must record the value the adjudicator supplied' },
          false,
          400,
        )
        : respondWith(DESK)
    ));

    render(<CalibrationAdjudicationPage />);
    await screen.findByText('Clip C-01');

    fireEvent.change(screen.getByLabelText('What was concluded'), {
      target: { value: 'new_adjudicated_value' },
    });
    fireEvent.click(screen.getByText('Record this decision'));

    const alert = await screen.findByText(/must record the value the adjudicator supplied/);
    expect(alert).toBeInTheDocument();
    expect(screen.queryByText(/is on the record/)).not.toBeInTheDocument();
  });

  test('a recorded decision is confirmed by id and the clip is re-read', async () => {
    // Re-read rather than patched in locally: the settled list must show what
    // the server actually holds, not the page's optimistic idea of it.
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => (
      init?.method === 'POST'
        ? respondWith({ ok: true, adjudication: { adjudication_id: 'adj-new' }, fields: [] })
        : respondWith(DESK)
    ));

    render(<CalibrationAdjudicationPage />);
    await screen.findByText('Clip C-01');

    const readsBefore = fetchMock.mock.calls.filter(([, init]) => init?.method !== 'POST').length;

    fireEvent.change(screen.getByLabelText('What was concluded'), { target: { value: 'agreement' } });
    fireEvent.click(screen.getByText('Record this decision'));

    expect(await screen.findByText(/adj-new is on the record/)).toBeInTheDocument();
    await waitFor(() => {
      const readsAfter = fetchMock.mock.calls.filter(([, init]) => init?.method !== 'POST').length;
      expect(readsAfter).toBeGreaterThan(readsBefore);
    });
  });
});
