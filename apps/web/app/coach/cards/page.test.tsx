/**
 * @jest-environment jsdom
 */

// Coach Cards page. What these pin: the form's two modes really swap the
// target picker (athlete roster vs program catalog); a group issue posts
// program_id and then renders the issued/skipped report VERBATIM -- a card
// that reached 2 of 3 members must say who was skipped, not imply everyone
// got it; the verify button wires into the EXISTING completions verify
// endpoint with the card's own athlete_id; and the no-frequency semantics
// (four 25% logs complete a card) are stated to the coach rather than
// silently imposed.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';

import CoachCardsPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

// full_name, because that is what getAthletesForCoach selects and therefore
// what /api/pilot/athletes/list sends. The first version of this mock said
// display_name -- a key the server has never produced -- so it pinned the
// page's bug in place instead of catching it.
const ROSTER = [
  { athlete_id: 'ath-1', full_name: 'Anna Cards' },
  { athlete_id: 'ath-2', full_name: 'Bela Cards' },
];

const PROGRAMS = [
  { program_id: 'prog-1', program_name: 'Junior Boxing', status: 'active', active_member_count: 3 },
  { program_id: 'prog-2', program_name: 'Old Guard', status: 'archived', active_member_count: 0 },
];

// The gym's operational drills. Since W-D3 a card requires one, so the issue
// form is only rendered when this list is non-empty -- which is why the
// harness answers with a drill by default rather than an empty list.
const DRILLS = [
  {
    organization_id: 'org-1',
    drill_id: 'drill-rope',
    name: 'Jump rope',
    category: 'conditioning',
    focus: 'Ten minutes, no misses',
    cues: [],
    difficulty: 'beginner',
    active: true,
  },
];

const REPORT = {
  program_id: 'prog-1',
  program_name: 'Junior Boxing',
  issuance_id: 'issuance-1',
  issued: [
    { athlete_id: 'ath-1', athlete_name: 'Anna Cards', assignment_id: 'asg-1' },
    { athlete_id: 'ath-3', athlete_name: 'Cora Cards', assignment_id: 'asg-2' },
  ],
  skipped: [{ athlete_id: 'ath-2', athlete_name: 'Bela Cards' }],
};

const CARD_GROUP = {
  issuance_id: 'issuance-1',
  assigned_at: '2026-08-20T10:00:00Z',
  cards: [
    {
      assignment_id: 'asg-1',
      athlete_id: 'ath-1',
      athlete_name: 'Anna Cards',
      issuance_id: 'issuance-1',
      drill_name: 'Jump rope',
      drill_description: 'Ten minutes, no misses',
      drill_display_name: 'Jump rope',
      drill_display_description: 'Ten minutes, no misses',
      drill_difficulty: 'beginner',
      rep_count: null,
      duration_minutes: null,
      frequency_per_week: 3,
      due_date: null,
      status: 'in_progress',
      completion_percentage: 33,
      assigned_at: '2026-08-20T10:00:00Z',
      completions: [
        {
          completion_id: 'comp-1',
          completed_at: '2026-08-21T09:00:00Z',
          reps_completed: null,
          notes: 'Before school',
          verification_status: 'pending',
          verified_at: null,
        },
      ],
    },
  ],
};

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function installFetch(options: {
  cardsPostResponse?: unknown;
  /** What the card LIST read answers. An array stands in for the groups the
      server holds; `false` refuses the read, which is the difference between
      "no cards were issued" and "nobody could look". */
  cardsList?: unknown[] | false;
  /** What the operational drill list answers. An array is the gym's drills;
      `false` refuses the read -- the difference between "this gym has no
      drills" and "the list did not load", which the page must not conflate.
      'reject' is a fetch that never got an answer (the network), and
      'bad-json' an answer whose body could not be read: both leave the drill
      list UNKNOWN, not empty. */
  drills?: unknown[] | false | 'reject' | 'bad-json';
} = {}) {
  const calls: FetchCall[] = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/api/pilot/athletes/list')) {
      return { ok: true, status: 200, json: async () => ({ items: ROSTER }) };
    }
    if (url.includes('/api/pilot/admin/programs')) {
      return { ok: true, status: 200, json: async () => ({ items: PROGRAMS }) };
    }
    if (url.includes('/api/pilot/drills')) {
      if (options.drills === 'reject') {
        throw new TypeError('Failed to fetch');
      }
      if (options.drills === 'bad-json') {
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token < in JSON');
          },
        };
      }
      if (options.drills === false) {
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ items: options.drills ?? DRILLS }) };
    }
    if (url.includes('/api/pilot/coach/cards') && init?.method === 'POST') {
      return { ok: true, status: 201, json: async () => options.cardsPostResponse ?? REPORT };
    }
    if (url.includes('/api/pilot/coach/cards')) {
      if (options.cardsList === false) {
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ items: options.cardsList ?? [CARD_GROUP] }) };
    }
    if (url.includes('/api/pilot/progression/completions')) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  }) as unknown as typeof fetch;
  return calls;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('the two form modes swap the target picker: roster athletes vs ACTIVE programs only', async () => {
  installFetch();

  await act(async () => {
    render(<CoachCardsPage />);
  });

  // Athlete mode is the default: the roster select is present, and it shows
  // the athlete's NAME. Asserting the id is absent is the half that matters
  // -- the bug this pins rendered `display_name || athlete_id`, and since
  // display_name was a key the server never sends, every option silently
  // fell back to the raw id. A test that only looked for a truthy option,
  // or matched on the id, would have passed straight through that.
  const athleteSelect = screen.getByLabelText('Athlete');
  const options = within(athleteSelect).getAllByRole('option');
  // Placeholder plus the two roster rows.
  expect(options.map((option) => option.textContent)).toEqual([
    'Choose from roster…',
    'Anna Cards',
    'Bela Cards',
  ]);
  // The value stays the id -- it is what gets POSTed -- while the label is
  // the name. Both halves are checked so a fix that swapped them would fail.
  expect(options.map((option) => (option as HTMLOptionElement).value)).toEqual(['', 'ath-1', 'ath-2']);
  expect(within(athleteSelect).queryByText('ath-1')).toBeNull();
  expect(screen.queryByLabelText('Program')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Whole program' }));

  const programSelect = screen.getByLabelText('Program');
  expect(within(programSelect).getByText('Junior Boxing (3 active)')).toBeTruthy();
  // Archived programs are history, not a target for new work.
  expect(within(programSelect).queryByText(/Old Guard/)).toBeNull();
  expect(screen.queryByLabelText('Athlete')).toBeNull();
});

test('a group issue posts program_id and renders the issued/skipped report verbatim', async () => {
  const calls = installFetch();

  await act(async () => {
    render(<CoachCardsPage />);
  });

  fireEvent.click(screen.getByRole('button', { name: 'Whole program' }));
  fireEvent.change(screen.getByLabelText('Program'), { target: { value: 'prog-1' } });
  fireEvent.change(screen.getByLabelText('Drill'), { target: { value: 'drill-rope' } });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Issue to program' }));
  });

  const post = calls.find((call) => call.url.includes('/api/pilot/coach/cards') && call.init?.method === 'POST');
  expect(post).toBeTruthy();
  const body = JSON.parse(String(post!.init!.body));
  expect(body.program_id).toBe('prog-1');
  expect(body.athlete_id).toBeUndefined();
  // W-D3: the card is identified by the drill alone. The server refuses a
  // request carrying a typed title or description, so sending one -- even the
  // drill's own name -- would turn every issue into a 400.
  expect(body.drill_id).toBe('drill-rope');
  expect(body).not.toHaveProperty('title');
  expect(body).not.toHaveProperty('description');

  // The report, verbatim: who got it AND who did not.
  const reportSection = await screen.findByLabelText('Issuance report');
  expect(within(reportSection).getByText('2 issued, 1 skipped.')).toBeTruthy();
  expect(within(reportSection).getByText('Cora Cards')).toBeTruthy();
  expect(within(reportSection).getByText('Bela Cards')).toBeTruthy();
  expect(within(reportSection).getByText(/Skipped/)).toBeTruthy();
});

test('verify and dispute wire into the existing completions endpoint with the card\'s athlete', async () => {
  const calls = installFetch();

  await act(async () => {
    render(<CoachCardsPage />);
  });

  // The card list is ready once its Verify button exists. This used to wait on
  // the card's title, 'Jump rope' -- but since W-D3 the issue form lists the
  // gym's drills, and the drill that card was built from carries the same name,
  // so the title is no longer unique on the page. Waiting on the control the
  // test is about to press is the more honest readiness signal anyway.
  const verify = await screen.findByRole('button', { name: 'Verify' });
  await act(async () => {
    fireEvent.click(verify);
  });

  await waitFor(() => {
    const verifyCall = calls.find((call) => call.url.includes('/api/pilot/progression/completions'));
    expect(verifyCall).toBeTruthy();
    const body = JSON.parse(String(verifyCall!.init!.body));
    expect(body).toEqual({
      completion_id: 'comp-1',
      athlete_id: 'ath-1',
      verify: true,
      verified: true,
    });
  });
});

test('the no-frequency auto-complete semantics are stated to the coach, not silently imposed', async () => {
  installFetch();

  await act(async () => {
    render(<CoachCardsPage />);
  });

  expect(screen.getByText(/each logged session counts 25% and four logs complete the card/)).toBeTruthy();
  // No default is written into the field for the coach.
  expect((screen.getByLabelText('Sessions per week (optional)') as HTMLInputElement).value).toBe('');
});

// Leaving the page mid-load must abandon the load, not finish writing into
// an unmounted tree. The failure this prevents is not abstract on this
// page: the finally block's setLoading(false) would swap "Loading cards…"
// for "No cards issued yet", which is a claim about the gym made by a
// request nobody is waiting for any more.
test('unmounting mid-load aborts every request and writes no state after', async () => {
  const controllers: AbortSignal[] = [];
  let resolveRoster: ((value: unknown) => void) | undefined;

  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal) controllers.push(init.signal);
    if (String(input).includes('/api/pilot/athletes/list')) {
      // Hold the first read open so the unmount lands mid-flight.
      return new Promise((resolve) => {
        resolveRoster = resolve;
      });
    }
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  }) as unknown as typeof fetch;

  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  const view = render(<CoachCardsPage />);
  // Every fetch the effect started carries the effect's signal.
  expect(controllers.length).toBeGreaterThan(0);
  expect(controllers.every((signal) => signal.aborted === false)).toBe(true);

  view.unmount();

  // The cleanup aborted them all.
  expect(controllers.every((signal) => signal.aborted)).toBe(true);

  // Let the held request settle after unmount; nothing may be written.
  await act(async () => {
    resolveRoster?.({ ok: true, status: 200, json: async () => ({ items: [{ athlete_id: 'ath-1', full_name: 'Anna Cards' }] }) });
  });

  // React logs an act/update-after-unmount warning through console.error if
  // state is written into an unmounted tree.
  expect(errorSpy).not.toHaveBeenCalled();
  errorSpy.mockRestore();
});

/*
 * "NO CARDS ISSUED YET" IS A CLAIM ABOUT THE GYM.
 *
 * This file already says so, in the comment above the abort test: that
 * sentence is "a claim about the gym rather than about the request". The abort
 * case was guarded and the FAILURE case was not, so a read the server refused
 * put the same sentence on screen -- and a coach who believes a child has no
 * cards issues the card again, on top of the one already sitting in that
 * child's list.
 *
 * The read failure is tracked apart from errorMessage deliberately, and the
 * last test here is why: errorMessage also carries write-path validation
 * ("Pick an athlete."), which says nothing whatsoever about whether the list
 * could be read.
 */
describe('a card list nobody could read is not an empty card list', () => {
  test('a refused list read says the cards could not be read, and does not say none were issued', async () => {
    installFetch({ cardsList: false });

    await act(async () => {
      render(<CoachCardsPage />);
    });

    expect(await screen.findByText(/Your cards could not be read/i)).toBeTruthy();
    // The half that was the defect: the sentence a coach acts on by
    // re-issuing work a child already has.
    expect(screen.queryByText('No cards issued yet')).toBeNull();
  });

  test('a genuinely empty list still says no cards were issued, and claims no failure', async () => {
    // The other direction. A page that says "could not be read" whenever it
    // has nothing to show is lying in the opposite direction, and it hides the
    // one case where the sentence is true.
    installFetch({ cardsList: [] });

    await act(async () => {
      render(<CoachCardsPage />);
    });

    expect(await screen.findByText('No cards issued yet')).toBeTruthy();
    expect(screen.queryByText(/Your cards could not be read/i)).toBeNull();
  });

  test('issuing a card without picking an athlete does not make the list claim it could not be read', async () => {
    /* The regression a later "simplification" is most likely to reintroduce:
       fold cardsUnreadable back into errorMessage, and a coach who hit Issue
       one field too early is told their card list is unreadable. The list read
       succeeded. It is genuinely empty. Only the click was wrong -- and the
       two facts must not share a flag. */
    installFetch({ cardsList: [] });

    await act(async () => {
      render(<CoachCardsPage />);
    });

    await screen.findByText('No cards issued yet');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Issue card' }));
    });

    // The validation really fired, so this is exercising the errorMessage
    // path and not an inert page.
    expect(screen.getByText('Pick an athlete.')).toBeTruthy();
    expect(screen.queryByText(/Your cards could not be read/i)).toBeNull();
    expect(screen.getByText('No cards issued yet')).toBeTruthy();
  });
});

// W-D3, OD-2026-09-18-001. A card is built from a drill in the gym's own
// library; there is no longer a typed-out card.
describe('a card is built from an operational drill', () => {
  test('the drill picker is required and the typed title/description inputs are gone', async () => {
    installFetch();

    await act(async () => {
      render(<CoachCardsPage />);
    });

    const picker = screen.getByLabelText('Drill') as HTMLSelectElement;
    expect(picker.required).toBe(true);
    // The old escape hatch, and the two inputs it led to, are gone.
    expect(within(picker).queryByText(/Type it out instead/)).toBeNull();
    expect(screen.queryByLabelText('Title')).toBeNull();
    expect(screen.queryByLabelText('Description')).toBeNull();
  });

  test('issuing without picking a drill is stopped on the client, and nothing is posted', async () => {
    const calls = installFetch();

    await act(async () => {
      render(<CoachCardsPage />);
    });

    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Issue card' }));
    });

    expect(screen.getByText("Pick a drill from this gym's library.")).toBeTruthy();
    expect(calls.some((call) => call.url.includes('/api/pilot/coach/cards') && call.init?.method === 'POST')).toBe(false);
  });

  test("picking a drill shows the drill's own wording, read-only, as what the athlete will see", async () => {
    installFetch();

    await act(async () => {
      render(<CoachCardsPage />);
    });

    fireEvent.change(screen.getByLabelText('Drill'), { target: { value: 'drill-rope' } });

    expect(screen.getByText('What the athlete will see')).toBeTruthy();
    expect(screen.getAllByText('Ten minutes, no misses').length).toBeGreaterThan(0);
  });

  test('a gym with no drills gets a truthful empty state, not a form that can never submit', async () => {
    installFetch({ drills: [] });

    await act(async () => {
      render(<CoachCardsPage />);
    });

    expect(await screen.findByText(/This gym has no drills to issue yet/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the Drill Library' }).getAttribute('href')).toBe('/coach/drills');
    // No dead form: neither the picker nor an issue button is offered.
    expect(screen.queryByLabelText('Drill')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Issue card' })).toBeNull();
  });

  test('a drill list that failed to load says so, rather than claiming the gym has none', async () => {
    installFetch({ drills: false });

    await act(async () => {
      render(<CoachCardsPage />);
    });

    expect(await screen.findByText(/did not load, so a card cannot be issued right now/)).toBeTruthy();
    expect(screen.queryByText(/This gym has no drills to issue yet/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Issue card' })).toBeNull();
  });

  // W-D3 review N1. A refused read (above) answers; these two never do. A
  // rejected fetch or an unreadable body throws out of the load, and the drill
  // list is left as the empty array it started as -- which, read as data, is
  // exactly "this gym has no drills". It is not data. It is not knowing.
  test.each([
    ['a drill fetch that is rejected', 'reject' as const],
    ['a drill answer whose body cannot be read', 'bad-json' as const],
  ])('%s says the list did not load, never that the gym has none', async (_label, drills) => {
    installFetch({ drills });

    await act(async () => {
      render(<CoachCardsPage />);
    });

    expect(await screen.findByText(/did not load, so a card cannot be issued right now/)).toBeTruthy();
    expect(screen.queryByText(/This gym has no drills to issue yet/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open the Drill Library' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Issue card' })).toBeNull();
  });

  test('a card list that fails AFTER the drills loaded leaves the drills readable and the form usable', async () => {
    // The over-correction this guards against: the card list is read after the
    // drills, and its failure lands in the same catch. It says nothing about
    // the drill list, which was read successfully.
    installFetch({ cardsList: false });

    await act(async () => {
      render(<CoachCardsPage />);
    });

    expect(await screen.findByText(/Your cards could not be read/i)).toBeTruthy();
    expect(screen.queryByText(/did not load, so a card cannot be issued right now/)).toBeNull();
    expect(screen.queryByText(/This gym has no drills to issue yet/)).toBeNull();
    const picker = screen.getByLabelText('Drill') as HTMLSelectElement;
    expect(within(picker).getByRole('option', { name: 'Jump rope' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Issue card' })).toBeTruthy();
  });
});
