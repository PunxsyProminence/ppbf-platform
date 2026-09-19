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

// Pinned to same-origin so the W-D4B tests can assert the EXACT url a preview
// reads. Every older test here matches on includes(), so this changes nothing
// for them.
jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

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
    // The server sends this column on every drill (DRILL_FIELDS); null is a
    // drill the gym wrote itself.
    reference_drill_id: null,
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
      // The operational drill the card was issued against. listCoachCards
      // selects it with the rest of ASSIGNMENT_FIELDS, so a real card row
      // always carries the key; only a legacy row has it null.
      drill_id: 'drill-rope',
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

// W-D4B fixtures. The same Jump rope drill, this time promoted from the
// reference library: reference_drill_id names the exact reference VERSION the
// gym adopted, and that pointer -- never the name -- is what a preview reads.
const PROMOTED_DRILL = { ...DRILLS[0], reference_drill_id: 'ref-rope' };

// A drill the gym wrote itself. It has no reference instruction to open.
const GYM_WRITTEN_DRILL = {
  organization_id: 'org-1',
  drill_id: 'drill-shadow',
  name: 'Shadow rounds',
  category: 'technique',
  focus: 'Three rounds, hands up',
  cues: [],
  difficulty: 'intermediate',
  active: true,
  reference_drill_id: null,
};

const W_D4B_DRILLS = [PROMOTED_DRILL, GYM_WRITTEN_DRILL];

// The coach detail shape (getDrillWithDetail): every reference column plus the
// three child sets, as app/coach/drills/page.test.tsx's referenceDetail. Both
// reads a coach can open answer with this shape, so one fixture serves both.
const REFERENCE_DETAIL = {
  organization_id: 'org-1',
  drill_id: 'ref-rope',
  lineage_id: 'ref-rope',
  version: 1,
  supersedes_drill_id: null,
  superseded_at: null,
  name: 'Jump rope',
  discipline: 'boxing',
  category: 'conditioning',
  difficulty: 'fundamentals',
  skill_id: 'SK-FOOT-01',
  target_behavior: 'Stay light on the feet for a full round.',
  purpose: 'Build rhythm on the balls of the feet.',
  standard_setup: 'Clear floor, rope sized to the armpits.',
  execution: 'Bounce on both feet.\n\nTurn the rope from the wrists.\n\nFinish the round without a miss.',
  what_good_looks_like: 'Quiet landings\nElbows close to the ribs',
  what_bad_looks_like: 'Flat-footed landings',
  common_errors: 'Turning the rope from the shoulders',
  corrections: 'Coach calls "wrists" on every miss',
  transfer: 'Rhythm carries into ring footwork [A2-010]',
  contact_level: 'none',
  equipment_needed: 'jump rope',
  requires_coach_authorization: false,
  content_class: 'COACHING CRAFT - PPBF source manual v3',
  source_ref: 'Punxsy_Drill_Library_Source_v3.docx',
  grounding_claim_ids: ['A2-010'],
  field_provenance: 'PPBF source manual v3',
  active: true,
  created_by_account_id: null,
  created_by_role: null,
  created_at: '2026-09-16T00:00:00.000Z',
  updated_at: '2026-09-16T00:00:00.000Z',
  scale_levels: [
    { organization_id: 'org-1', scale_id: 'rs-a', drill_id: 'ref-rope', scale_level: 'A', is_starting_point: false, demand_description: 'Single bounces, one minute.', constraint_applied: '', contact_level: 'none', coach_watch_point: 'Is the athlete landing quietly?', authoring_state: 'authored' },
    { organization_id: 'org-1', scale_id: 'rs-b', drill_id: 'ref-rope', scale_level: 'B', is_starting_point: true, demand_description: 'The drill as designed.', constraint_applied: '', contact_level: 'none', coach_watch_point: 'Can the athlete hold rhythm for a round?', authoring_state: 'authored' },
  ],
  stop_rules: [
    { organization_id: 'org-1', stop_rule_id: 'rst-1', drill_id: 'ref-rope', ordinal: 1, condition_text: 'Stop when fatigue breaks decision quality.', scope: 'universal', rule_kind: 'fatigue' },
    { organization_id: 'org-1', stop_rule_id: 'rst-2', drill_id: 'ref-rope', ordinal: 2, condition_text: 'Stop when the landings go flat-footed.', scope: 'drill_specific', rule_kind: 'technique_degradation' },
  ],
  cues: [
    { organization_id: 'org-1', cue_id: 'rc-1', drill_id: 'ref-rope', cue_text: 'Wrists, not shoulders', cue_family: 'Rope', focus_type: 'internal', evidence_note: 'Coaching craft.', source_ref: null },
  ],
  secondary_skills: [],
};

// What GET /api/pilot/progression/drill-instruction answers a COACH for a card
// issued against PROMOTED_DRILL, minus the assignment_id/assigned_by the fake
// adds. operational_lifecycle is 'retired': no version of Jump rope is active
// in the gym any more, and the card still opens at the version it was issued
// against. athlete_access is 'open_work_only' for the same reason: the server
// answers it by running the athlete's two reads. The Learn read only offers a
// reference some ACTIVE gym drill adopts, and none does now; the open-work
// read (OD-2026-09-19-002) drops only that adoption term, and the reference
// itself is still active. So the realistic retired answer carries both facts.
// Every answer spread over this one ('changed', 'current', a withdrawn
// reference) says its own athlete_access rather than inheriting this one.
const COACH_INSTRUCTION = {
  state: 'available',
  audience: 'coach',
  drill: REFERENCE_DETAIL,
  operational_lifecycle: 'retired',
  athlete_access: 'open_work_only',
};

// A second promoted drill, so a pick can move from one previewable drill to
// another. The new pick then has a 'card-picked-instructions' toggle of its
// own -- the element a focus return would land on, if the page asked for one.
const PROMOTED_SLIP_DRILL = {
  organization_id: 'org-1',
  drill_id: 'drill-slip',
  name: 'Slip line',
  category: 'defense',
  focus: 'Slip under the rope, eyes up',
  cues: [],
  difficulty: 'intermediate',
  active: true,
  reference_drill_id: 'ref-slip',
};

// Slip line's reference version, as the assignment read answers it for a card
// issued against PROMOTED_SLIP_DRILL.
const SLIP_REFERENCE_DETAIL = { ...REFERENCE_DETAIL, drill_id: 'ref-slip', lineage_id: 'ref-slip', name: 'Slip line' };

// An individual card issued against Slip line.
const SLIP_GROUP = {
  issuance_id: null,
  assigned_at: '2026-08-23T10:00:00Z',
  cards: [
    {
      ...CARD_GROUP.cards[0],
      assignment_id: 'asg-slip',
      issuance_id: null,
      drill_id: 'drill-slip',
      drill_name: 'Slip line',
      drill_description: 'Slip under the rope, eyes up',
      drill_display_name: 'Slip line',
      drill_display_description: 'Slip under the rope, eyes up',
      drill_difficulty: 'intermediate',
      status: 'assigned',
      completion_percentage: 0,
      assigned_at: '2026-08-23T10:00:00Z',
      completions: [],
    },
  ],
};

// CARD_GROUP as REPORT describes it: one issuance, two cards. The instruction
// is read off the FIRST card, asg-1.
const ISSUED_GROUP = {
  ...CARD_GROUP,
  cards: [
    CARD_GROUP.cards[0],
    {
      ...CARD_GROUP.cards[0],
      assignment_id: 'asg-2',
      athlete_id: 'ath-3',
      athlete_name: 'Cora Cards',
      status: 'assigned',
      completion_percentage: 0,
      completions: [],
    },
  ],
};

// An individual card issued against the gym-written drill. Keyed by its own
// assignment id, because an individual card has no issuance.
const GYM_WRITTEN_GROUP = {
  issuance_id: null,
  assigned_at: '2026-08-22T10:00:00Z',
  cards: [
    {
      ...CARD_GROUP.cards[0],
      assignment_id: 'asg-shadow',
      issuance_id: null,
      drill_id: 'drill-shadow',
      drill_name: 'Shadow rounds',
      drill_description: 'Three rounds, hands up',
      drill_display_name: 'Shadow rounds',
      drill_display_description: 'Three rounds, hands up',
      drill_difficulty: 'intermediate',
      status: 'assigned',
      completion_percentage: 0,
      assigned_at: '2026-08-22T10:00:00Z',
      completions: [],
    },
  ],
};

// A card written before drills had identity: drill_id is null, and there is
// no drill behind it to open.
const LEGACY_GROUP = {
  issuance_id: null,
  assigned_at: '2026-08-01T10:00:00Z',
  cards: [
    {
      ...CARD_GROUP.cards[0],
      assignment_id: 'asg-legacy',
      athlete_id: 'ath-2',
      athlete_name: 'Bela Cards',
      issuance_id: null,
      drill_id: null,
      drill_name: 'Heavy bag',
      drill_description: 'Three rounds on the bag',
      drill_display_name: 'Heavy bag',
      drill_display_description: 'Three rounds on the bag',
      drill_difficulty: 'intermediate',
      status: 'assigned',
      completion_percentage: 0,
      assigned_at: '2026-08-01T10:00:00Z',
      completions: [],
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
  /** The reference drills GET /api/pilot/drill-library?drill_id= can answer,
      keyed by reference id. Any other id is a 404, as the route answers it --
      so a preview that read by anything but the drill's own pointer would
      come back empty rather than pass. */
  referenceDetails?: Record<string, unknown>;
  /** Per reference id: that read is held until its promise settles, so a
      test can change the pick while one reference read is still in flight
      and another, unheld, answers at once. */
  referenceGates?: Record<string, Promise<void>>;
  /** What GET /api/pilot/progression/drill-instruction answers: the
      instruction half of the body (the fake adds assignment_id from the URL
      and assigned_by), or 'fail' for a 500. */
  drillInstruction?: Record<string, unknown> | 'fail';
} = {}) {
  const calls: FetchCall[] = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    // The two W-D4B reads, answered explicitly. Left to the fallthrough below
    // they would get {items: []}, which carries no drill at all.
    if (url.includes('/api/pilot/drill-library?drill_id=')) {
      const referenceId = decodeURIComponent(url.split('drill_id=')[1] ?? '');
      await options.referenceGates?.[referenceId];
      const detail = (options.referenceDetails ?? { [REFERENCE_DETAIL.drill_id]: REFERENCE_DETAIL })[referenceId];
      return detail
        ? { ok: true, status: 200, json: async () => ({ drill: detail }) }
        : { ok: false, status: 404, json: async () => ({ error: 'DRILL_NOT_FOUND' }) };
    }
    if (url.includes('/api/pilot/progression/drill-instruction?assignment_id=')) {
      const instruction = options.drillInstruction ?? COACH_INSTRUCTION;
      if (instruction === 'fail') {
        return { ok: false, status: 500, json: async () => ({ error: 'Internal error' }) };
      }
      const assignmentId = decodeURIComponent(url.split('assignment_id=')[1] ?? '');
      return {
        ok: true,
        status: 200,
        json: async () => ({ assignment_id: assignmentId, assigned_by: 'Coach Rivera', ...instruction }),
      };
    }
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

/*
 * W-D4B, OD-2026-09-19-001: THE COACH CAN READ THE DRILL BEHIND A CARD.
 *
 * Twice: before issuing, from the picked drill's own reference pointer, and
 * after, from the card itself -- resolved on the server, so a drill the gym has
 * since retired still opens at the version the card was issued against.
 *
 * Both are READS. Opening a drill writes nothing, and the issue POST is not
 * changed by having looked: the W-D3 body goes out exactly as before, with no
 * title, no description, and no reference id riding along.
 */
describe('W-D4B: the drill behind a card opens from where it is issued and reviewed', () => {
  /** Every request that was not a plain read. Mount reads carry no method, which is a GET. */
  const writes = (calls: FetchCall[]) => calls.filter((call) => (call.init?.method ?? 'GET') !== 'GET');

  // The two lifecycle notes, exactly. "Changed" and "retired" are different
  // facts: adopting a refinement deactivates the version it replaces, so an
  // inactive version alone does not mean the gym stopped running the drill.
  const CHANGED_NOTE =
    'This gym has changed this drill since the work was issued, and another version of it is in use now. These are the reference instructions this work was issued against.';
  const RETIRED_NOTE =
    'This gym has retired this drill since the work was issued. These are the reference instructions it was issued against.';
  // A third, independent fact: which of an athlete's work opens this same
  // instruction (athlete_access). A coach reading it should not send an
  // athlete to read it if they cannot. Three answers, two notes:
  //   all_work        nothing is said -- any work opens it, as Learn does.
  //   open_work_only  said plainly: a retired drill still opens from work
  //                   that is assigned or in progress (OD-2026-09-19-002).
  //   none            said as a restriction: the reference was withdrawn.
  const OPEN_WORK_NOTE =
    'Athletes can still open these instructions from work that is assigned or in progress, but not from completed, cancelled or incomplete work.';
  const WITHDRAWN_NOTE =
    'Athletes cannot open these instructions from any work, because the reference drill has been withdrawn.';
  // The sentence the page said before OD-2026-09-19-002, for any drill the
  // athlete's Learn read withheld. For a retired drill it is now false for
  // open work, so it must not survive anywhere on the page.
  const OLD_ATHLETE_WORDING = 'Athletes cannot open these instructions from this work';
  /** Any athlete-access sentence at all, old or new. */
  const ANY_ATHLETE_NOTE = /Athletes (can still|cannot) open these instructions/i;
  // The two inks a note is drawn in: the page's muted body ink, and the
  // restricted ink the panel uses for something no longer on offer (a retired
  // drill, a withdrawn reference).
  const PLAIN_INK = 'text-[color:var(--bone-300)]';
  const RESTRICTED_INK = 'text-[color:var(--restricted-ink)]';
  const LOAD_FAILED =
    "The drill's instructions did not load. This is a failure to load, not a missing drill; try again in a minute.";
  /** What the panel's live region says once a drill is open. The notes never join it. */
  const OPENED_ANNOUNCEMENT = 'Jump rope: instructions open below.';

  /** Whether `later` comes after `earlier` in document order. */
  const follows = (earlier: Node, later: Node) =>
    Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);

  /**
   * A note about where the card's drill stands, found where it now lives:
   * INSIDE the opened drill, in the drill's own header, after the heading focus
   * lands on and the content-status line it qualifies, and before the Safety
   * section -- so reading forward from the heading reaches it before the
   * instruction. Exactly one copy on the page, so a note left behind as a
   * sibling before the article fails here too, and never in the live region.
   */
  function noteInOpenedDrill(article: HTMLElement, text: string): HTMLElement {
    const note = within(article).getByText(text);
    expect(screen.getAllByText(text)).toHaveLength(1);
    const header = article.querySelector('header');
    expect(header?.contains(note)).toBe(true);
    const heading = within(article).getByRole('heading', { level: 2 });
    const contentStatus = within(article).getByText(/^Content: /);
    const safety = within(article).getByRole('region', { name: 'Safety' });
    expect(follows(heading, note)).toBe(true);
    expect(follows(contentStatus, note)).toBe(true);
    expect(follows(note, safety)).toBe(true);
    expect(screen.getByRole('status').contains(note)).toBe(false);
    return note;
  }

  /** A note is drawn in exactly one of the two inks. */
  function expectInk(note: HTMLElement, ink: 'plain' | 'restricted') {
    const classes = note.className.split(/\s+/);
    expect(classes).toContain(ink === 'plain' ? PLAIN_INK : RESTRICTED_INK);
    expect(classes).not.toContain(ink === 'plain' ? RESTRICTED_INK : PLAIN_INK);
  }

  /**
   * Every line of text in the opened drill's header after its content-status
   * line, in reading order -- all the notes, and nothing but the notes. An
   * exact list, so a note that is missing, extra, doubled or out of order
   * fails, whatever element it was rendered in.
   */
  function notesInHeader(article: HTMLElement): string[] {
    const header = article.querySelector('header') as HTMLElement;
    const contentStatus = within(article).getByText(/^Content: /);
    return Array.from(header.querySelectorAll('*'))
      .filter((element) => element.childElementCount === 0 && follows(contentStatus, element))
      .map((element) => element.textContent ?? '')
      .filter((text) => text.trim() !== '');
  }

  /**
   * Whether `text` is put on screen at any point from now until the returned
   * check is called -- not only whether it is there at the end. A stale answer
   * that lands and is then replaced would pass a query made afterwards. (The
   * same watch the progression page's race tests use.)
   */
  function watchScreenFor(text: string) {
    let seen = document.body.textContent?.includes(text) ?? false;
    const inspect = (records: MutationRecord[]) => {
      for (const record of records) {
        if (record.type === 'characterData' && record.target.textContent?.includes(text)) seen = true;
        for (const node of Array.from(record.addedNodes)) {
          if (node.textContent?.includes(text)) seen = true;
        }
      }
    };
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    return () => {
      inspect(observer.takeRecords());
      observer.disconnect();
      return seen || (document.body.textContent?.includes(text) ?? false);
    };
  }

  /** Lets one animation frame pass. A close that returns focus does so in requestAnimationFrame, in order. */
  const nextFrame = () =>
    act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

  test('a promoted drill offers its instructions before issuing, read by its own reference pointer', async () => {
    const calls = installFetch({ drills: W_D4B_DRILLS, cardsList: [] });

    await act(async () => {
      render(<CoachCardsPage />);
    });

    fireEvent.change(screen.getByLabelText('Drill'), { target: { value: 'drill-rope' } });

    const toggle = screen.getByRole('button', { name: 'View instructions: Jump rope' });
    expect(toggle.id).toBe('card-picked-instructions');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // Offered, not opened: picking a drill reads nothing on its own.
    expect(calls.some((call) => call.url.includes('/api/pilot/drill-library'))).toBe(false);

    await act(async () => {
      fireEvent.click(toggle);
    });

    // Exactly one read, of exactly the version the gym adopted.
    const reads = calls.filter((call) => call.url.includes('/api/pilot/drill-library'));
    expect(reads).toHaveLength(1);
    expect(reads[0].url).toBe('/api/pilot/drill-library?drill_id=ref-rope');
    expect(reads[0].init?.method).toBe('GET');

    const detail = screen.getByRole('article', { name: 'Jump rope' });
    const safety = within(detail).getByRole('region', { name: 'Safety' });
    expect(within(safety).getByText('Stop when the landings go flat-footed.')).toBeTruthy();
    expect(within(safety).getByText('Stop when fatigue breaks decision quality.')).toBeTruthy();
    // The coach's line on what the content is and whether it is current.
    expect(within(detail).getByText('Content: PPBF source manual v3. Current version.')).toBeTruthy();
    // A reference read knows nothing about an issued card, so it claims no
    // lifecycle at all -- neither note belongs anywhere but the assignment read.
    expect(screen.queryByText(/retired this drill since the work was issued/)).toBeNull();
    expect(screen.queryByText(/changed this drill since the work was issued/)).toBeNull();
    // Nor anything about the athlete: there is no work yet for them to open it
    // from. Not knowing (null) is none of the three answers, so the drill's
    // header ends at its content-status line.
    expect(screen.queryByText(OPEN_WORK_NOTE)).toBeNull();
    expect(screen.queryByText(WITHDRAWN_NOTE)).toBeNull();
    expect(document.body.textContent).not.toMatch(ANY_ATHLETE_NOTE);
    expect(notesInHeader(detail)).toEqual([]);
    expect(detail.querySelector('header')?.lastElementChild).toBe(
      within(detail).getByText('Content: PPBF source manual v3. Current version.'),
    );
    // Learning is not doing: nothing inside the opened drill logs, completes
    // or issues anything.
    expect(within(detail).queryByRole('button', { name: /log|complete|verify|dispute|issue|promote/i })).toBeNull();

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Hide instructions: Jump rope');
    // The preview adds a labelled article and a labelled Safety region; the
    // form's own 'Drill' label must still name exactly one control.
    const picker = screen.getByLabelText('Drill');
    expect(picker.tagName).toBe('SELECT');
    expect(picker.id).toBe('card-drill');

    // The opener is also the closer.
    fireEvent.click(toggle);
    expect(screen.queryByRole('article', { name: 'Jump rope' })).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('View instructions: Jump rope');
    // Closing is not a read either.
    expect(calls.filter((call) => call.url.includes('/api/pilot/drill-library'))).toHaveLength(1);
    expect(writes(calls)).toEqual([]);
  });

  test('a gym-written drill says there is nothing to open, and offers no dead control', async () => {
    const calls = installFetch({ drills: W_D4B_DRILLS, cardsList: [] });

    await act(async () => {
      render(<CoachCardsPage />);
    });

    fireEvent.change(screen.getByLabelText('Drill'), { target: { value: 'drill-shadow' } });

    expect(screen.getByText('Written by this gym, so there are no reference instructions to open.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /instructions: Shadow rounds/ })).toBeNull();
    expect(document.getElementById('card-picked-instructions')).toBeNull();
    expect(calls.some((call) => call.url.includes('/api/pilot/drill-library'))).toBe(false);
  });

  test('changing the picked drill closes an open preview, and picking it again does not reopen it', async () => {
    installFetch({ drills: W_D4B_DRILLS, cardsList: [] });

    await act(async () => {
      render(<CoachCardsPage />);
    });

    fireEvent.change(screen.getByLabelText('Drill'), { target: { value: 'drill-rope' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'View instructions: Jump rope' }));
    });
    expect(screen.getByRole('article', { name: 'Jump rope' })).toBeTruthy();

    // The open instructions described a drill that is no longer being issued.
    fireEvent.change(screen.getByLabelText('Drill'), { target: { value: 'drill-shadow' } });
    expect(screen.queryByRole('article', { name: 'Jump rope' })).toBeNull();

    // The half that proves it was CLOSED rather than merely hidden: the panel
    // is keyed by the picked drill, so a preview left open would reappear the
    // moment its drill was picked again.
    fireEvent.change(screen.getByLabelText('Drill'), { target: { value: 'drill-rope' } });
    const toggle = screen.getByRole('button', { name: 'View instructions: Jump rope' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('article', { name: 'Jump rope' })).toBeNull();
  });

  test('changing the picked drill while its preview is open leaves focus on the Drill select, not on the toggle', async () => {
    // Closing a preview returns focus to the control that opened it -- when the
    // coach closed it. Here the close is a side effect of picking another
    // drill, and the coach is still working the select.
    installFetch({ drills: [PROMOTED_DRILL, PROMOTED_SLIP_DRILL], cardsList: [] });

    await act(async () => {
      render(<CoachCardsPage />);
    });

    const picker = screen.getByLabelText('Drill') as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: 'drill-rope' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'View instructions: Jump rope' }));
    });
    expect(screen.getByRole('article', { name: 'Jump rope' })).toBeTruthy();

    // Back to the select, and a different promoted drill.
    picker.focus();
    expect(document.activeElement).toBe(picker);
    fireEvent.change(picker, { target: { value: 'drill-slip' } });

    expect(screen.queryByRole('article')).toBeNull();
    // The new pick has a toggle under the SAME id the old one had, so a focus
    // return would have somewhere to land. Without this the assertion below
    // could pass by the opener simply not existing.
    const toggle = screen.getByRole('button', { name: 'View instructions: Slip line' });
    expect(toggle.id).toBe('card-picked-instructions');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    await nextFrame();

    expect(document.activeElement).toBe(picker);
    expect(document.activeElement?.id).toBe('card-drill');
    expect(document.activeElement).not.toBe(toggle);
  });

  test("a reference read still in flight when the pick changes is abandoned, and never lands in the next pick's preview", async () => {
    /* The coach opens one adopted drill's preview, its read hangs, and they pick
       a different ADOPTED drill and open its preview, which answers at once.
       Both previews render in the same place, under the same
       'card-picked-instructions' toggle -- so when the hung read finally
       answers, there is a live preview for it to land in, and only the
       opener's own guard keeps it out. (Review NB-2: this test used to pick a
       gym-written drill second, which has no preview at all, so its
       "never lands" half had nowhere to land and could not fail.)

       The hung read answers with a name used nowhere else on the page, and the
       screen is watched from before it answers, so "never lands" means never
       rendered at any moment -- not merely gone by the time anyone looks. The
       fake ignores the abort signal on purpose: a server that answers anyway
       is the case the guard has to hold against. */
    const HELD_ONLY_NAME = 'Double-under ladder';
    let release: () => void = () => {};
    const ropeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = installFetch({
      drills: [PROMOTED_DRILL, PROMOTED_SLIP_DRILL],
      cardsList: [],
      referenceGates: { 'ref-rope': ropeGate },
      referenceDetails: {
        'ref-rope': { ...REFERENCE_DETAIL, name: HELD_ONLY_NAME },
        'ref-slip': SLIP_REFERENCE_DETAIL,
      },
    });

    await act(async () => {
      render(<CoachCardsPage />);
    });

    // 1. The first pick's preview, held in flight.
    const picker = screen.getByLabelText('Drill');
    fireEvent.change(picker, { target: { value: 'drill-rope' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'View instructions: Jump rope' }));
    });
    expect(screen.getByText('Loading the drill…')).toBeTruthy();
    const heldRead = calls.find((call) => call.url === '/api/pilot/drill-library?drill_id=ref-rope');
    expect(heldRead).toBeTruthy();
    const heldEverShown = watchScreenFor(HELD_ONLY_NAME);

    // 2. The pick changes to another adopted drill. That abandons the held read.
    fireEvent.change(picker, { target: { value: 'drill-slip' } });
    expect(heldRead?.init?.signal?.aborted).toBe(true);
    expect(screen.queryByText('Loading the drill…')).toBeNull();

    // 3. The new pick's preview, in the same place, answered at once.
    const slipToggle = screen.getByRole('button', { name: 'View instructions: Slip line' });
    expect(slipToggle.id).toBe('card-picked-instructions');
    await act(async () => {
      fireEvent.click(slipToggle);
    });
    const slipPanel = slipToggle.parentElement as HTMLElement;
    expect(within(slipPanel).getByRole('article', { name: 'Slip line' })).toBeTruthy();

    // 4. The held read answers anyway, with its own drill. Released, and then
    // one macrotask so the whole read-then-parse chain has settled.
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Never on screen, at any moment since it was abandoned.
    expect(heldEverShown()).toBe(false);
    expect(screen.queryByRole('article', { name: HELD_ONLY_NAME })).toBeNull();
    // The preview is still the new pick's drill, open, and the only drill open.
    expect(within(slipPanel).getByRole('article', { name: 'Slip line' })).toBeTruthy();
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(slipToggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByText('Loading the drill…')).toBeNull();
    // Two reads, each by its own drill's pointer, and nothing written.
    expect(calls.filter((call) => call.url.includes('/api/pilot/drill-library')).map((call) => call.url)).toEqual([
      '/api/pilot/drill-library?drill_id=ref-rope',
      '/api/pilot/drill-library?drill_id=ref-slip',
    ]);
    expect(writes(calls)).toEqual([]);
  });

  test("a slow picked-drill read that lands after an issued group was opened never replaces the group's drill", async () => {
    /* The two openers on this page share one slot. The coach opens the picked
       drill's preview, its read hangs, and they open an issued card's drill
       instead, which answers at once. When the hung read finally answers, it
       is an answer to a question nobody is asking any more -- and if it landed
       it would sit under the card's toggle, reading as the drill that card was
       issued against.

       The reference read is answered with a name used nowhere else on the page,
       so "it never appears anywhere" is a statement about that answer alone.
       The fake ignores the abort signal on purpose: a server that answers
       anyway is exactly the case the opener's own guard has to hold against. */
    const PICKED_ONLY_NAME = 'Double-under ladder';
    let release: () => void = () => {};
    const referenceGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = installFetch({
      drills: W_D4B_DRILLS,
      cardsList: [SLIP_GROUP],
      referenceGates: { 'ref-rope': referenceGate },
      referenceDetails: { 'ref-rope': { ...REFERENCE_DETAIL, name: PICKED_ONLY_NAME } },
      drillInstruction: {
        state: 'available',
        audience: 'coach',
        drill: SLIP_REFERENCE_DETAIL,
        operational_lifecycle: 'current',
        athlete_access: 'all_work',
      },
    });

    await act(async () => {
      render(<CoachCardsPage />);
    });

    const groupToggle = await screen.findByRole('button', { name: 'View instructions: Slip line' });
    expect(groupToggle.id).toBe('card-group-instructions-asg-slip');

    // 1. The picked preview, held in flight.
    fireEvent.change(screen.getByLabelText('Drill'), { target: { value: 'drill-rope' } });
    const pickedToggle = screen.getByRole('button', { name: 'View instructions: Jump rope' });
    expect(pickedToggle.id).toBe('card-picked-instructions');
    await act(async () => {
      fireEvent.click(pickedToggle);
    });
    expect(screen.getByText('Loading the drill…')).toBeTruthy();
    const pickedRead = calls.find((call) => call.url === '/api/pilot/drill-library?drill_id=ref-rope');
    expect(pickedRead).toBeTruthy();

    // 2. The group's drill, answered at once.
    await act(async () => {
      fireEvent.click(groupToggle);
    });
    expect(calls.filter((call) => call.url.includes('/api/pilot/progression/drill-instruction')).map((call) => call.url)).toEqual([
      '/api/pilot/progression/drill-instruction?assignment_id=asg-slip',
    ]);
    // The newer open cancelled the older one.
    expect(pickedRead?.init?.signal?.aborted).toBe(true);
    const groupPanel = groupToggle.parentElement as HTMLElement;
    expect(within(groupPanel).getByRole('article', { name: 'Slip line' })).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(PICKED_ONLY_NAME);

    // 3. The held read answers anyway, with its own drill. Released, and then
    // one macrotask so the whole read-then-parse chain has settled.
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The group's panel still shows the group's drill, and it is the only drill open.
    expect(within(groupPanel).getByRole('article', { name: 'Slip line' })).toBeTruthy();
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(groupToggle.getAttribute('aria-expanded')).toBe('true');
    // The late answer is nowhere: not as an article, not as text, not in an attribute.
    expect(screen.queryByRole('article', { name: PICKED_ONLY_NAME })).toBeNull();
    expect(document.body.innerHTML).not.toContain(PICKED_ONLY_NAME);
    // And the picked preview is closed, not waiting.
    expect(pickedToggle.getAttribute('aria-expanded')).toBe('false');
    expect(pickedToggle.getAttribute('aria-label')).toBe('View instructions: Jump rope');
    expect(screen.queryByText('Loading the drill…')).toBeNull();
    expect(writes(calls)).toEqual([]);
  });

  test.each([
    ['one athlete', undefined, 'Issue card', { athlete_id: 'ath-1' }],
    ['a whole program', 'Whole program', 'Issue to program', { program_id: 'prog-1' }],
  ] as const)(
    'previewing changes nothing about what is issued to %s: the POST body is the W-D3 body exactly',
    async (_label, modeButton, issueButton, target) => {
      const calls = installFetch({ drills: W_D4B_DRILLS, cardsList: [] });

      await act(async () => {
        render(<CoachCardsPage />);
      });

      if (modeButton) {
        fireEvent.click(screen.getByRole('button', { name: modeButton }));
        fireEvent.change(screen.getByLabelText('Program'), { target: { value: 'prog-1' } });
      } else {
        fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
      }
      fireEvent.change(screen.getByLabelText('Drill'), { target: { value: 'drill-rope' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'View instructions: Jump rope' }));
      });
      expect(screen.getByRole('article', { name: 'Jump rope' })).toBeTruthy();
      // Opening wrote nothing.
      expect(writes(calls)).toEqual([]);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: issueButton }));
      });

      const posts = writes(calls);
      expect(posts).toHaveLength(1);
      expect(posts[0].url).toBe('/api/pilot/coach/cards');
      expect(posts[0].init?.method).toBe('POST');
      // toEqual, not toMatchObject: no title, no description, and no
      // reference_drill_id carried in from the preview.
      expect(JSON.parse(String(posts[0].init?.body))).toEqual({
        drill_id: 'drill-rope',
        drill_difficulty: 'beginner',
        ...target,
      });
      // The form was reset, and the preview of the drill it held went with it.
      expect(screen.queryByRole('article', { name: 'Jump rope' })).toBeNull();
    },
  );

  test('an issued group opens the instruction its first card links to, by assignment id, and says inside the drill that the gym has since retired it and that athletes can still open it from open work only', async () => {
    const calls = installFetch({ drills: W_D4B_DRILLS, cardsList: [ISSUED_GROUP, LEGACY_GROUP] });

    await act(async () => {
      render(<CoachCardsPage />);
    });

    const toggle = await screen.findByRole('button', { name: 'View instructions: Jump rope' });
    expect(toggle.id).toBe('card-group-instructions-issuance-1');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      fireEvent.click(toggle);
    });

    // Keyed by the card, never by a drill or reference id: which version to
    // show is the server's to resolve from the card's own drill row, so the
    // client cannot substitute a newer one.
    const reads = calls.filter((call) => call.url.includes('/api/pilot/progression/drill-instruction'));
    expect(reads).toHaveLength(1);
    expect(reads[0].url).toBe('/api/pilot/progression/drill-instruction?assignment_id=asg-1');
    expect(reads[0].init?.method).toBe('GET');
    expect(calls.some((call) => call.url.includes('/api/pilot/drill-library'))).toBe(false);

    const detail = screen.getByRole('article', { name: 'Jump rope' });
    // operational_lifecycle 'retired': said in words, in the drill's own header
    // straight after its heading and content status -- and only that. Retired
    // is not "changed".
    const retired = noteInOpenedDrill(detail, RETIRED_NOTE);
    expectInk(retired, 'restricted');
    expect(screen.queryByText(CHANGED_NOTE)).toBeNull();
    expect(screen.queryByText(/changed this drill/)).toBeNull();
    // athlete_access 'open_work_only' (OD-2026-09-19-002): said too, after the
    // lifecycle it follows from. Plainly, because it restricts nothing about
    // work still in progress: the athlete doing it can still read the exact
    // instruction, safety and stop rules included.
    const athlete = noteInOpenedDrill(detail, OPEN_WORK_NOTE);
    expect(follows(retired, athlete)).toBe(true);
    expectInk(athlete, 'plain');
    // Those two notes, in that order, and no others: the old "cannot open from
    // this work" line is gone, and nothing calls the reference withdrawn.
    expect(notesInHeader(detail)).toEqual([RETIRED_NOTE, OPEN_WORK_NOTE]);
    expect(screen.queryByText(WITHDRAWN_NOTE)).toBeNull();
    expect(document.body.textContent).not.toContain(OLD_ATHLETE_WORDING);
    expect(document.body.textContent).not.toMatch(/Athletes cannot open/i);
    // What the toggle produced is announced from the panel's one live region,
    // and the notes are not part of that announcement.
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe(OPENED_ANNOUNCEMENT);
    expect(within(detail).getByRole('region', { name: 'Safety' })).toBeTruthy();
    expect(within(detail).getByText('Content: PPBF source manual v3. Current version.')).toBeTruthy();
    // Coach-only context comes through on the coach read.
    expect(within(detail).getByText('Can the athlete hold rhythm for a round?')).toBeTruthy();
    expect(within(detail).queryByRole('button', { name: /log|complete|verify|dispute|issue|promote/i })).toBeNull();

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Hide instructions: Jump rope');

    fireEvent.click(toggle);
    expect(screen.queryByRole('article', { name: 'Jump rope' })).toBeNull();
    expect(screen.queryByText(/retired this drill since the work was issued/)).toBeNull();
    expect(screen.queryByText(OPEN_WORK_NOTE)).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('View instructions: Jump rope');
    expect(writes(calls)).toEqual([]);
  });

  test('a card whose drill the gym has since CHANGED says it changed, and never says it was retired', async () => {
    /* Adopting a refinement deactivates the version it replaces, so the card's
       own drill row is inactive while the gym still runs the drill as v2. The
       old read saw only "inactive" and told the coach the drill was retired --
       false, and the kind of false that sends a coach to re-plan work that is
       still current. */
    // The refinement carried reference_drill_id forward unchanged, and the
    // active successor still adopts it -- so the athlete's Learn read opens it,
    // from any work.
    const calls = installFetch({
      drills: W_D4B_DRILLS,
      cardsList: [ISSUED_GROUP],
      drillInstruction: { ...COACH_INSTRUCTION, operational_lifecycle: 'changed', athlete_access: 'all_work' },
    });

    await act(async () => {
      render(<CoachCardsPage />);
    });

    const toggle = await screen.findByRole('button', { name: 'View instructions: Jump rope' });
    await act(async () => {
      fireEvent.click(toggle);
    });

    // Still the version the card was issued against, not the newer one -- and
    // the note that says so sits inside it, after its heading.
    const detail = screen.getByRole('article', { name: 'Jump rope' });
    noteInOpenedDrill(detail, CHANGED_NOTE);
    expect(within(detail).getByRole('region', { name: 'Safety' })).toBeTruthy();
    // The word itself, anywhere on the page -- not merely the one sentence.
    expect(screen.queryByText(RETIRED_NOTE)).toBeNull();
    expect(document.body.textContent).not.toMatch(/retired/i);
    // 'all_work': the athlete can open it from any work, so nothing is said
    // about the athlete at all -- not the open-work line, which would imply a
    // limit that does not exist, and not either refusal.
    expect(screen.queryByText(OPEN_WORK_NOTE)).toBeNull();
    expect(screen.queryByText(WITHDRAWN_NOTE)).toBeNull();
    expect(document.body.textContent).not.toMatch(ANY_ATHLETE_NOTE);
    expect(notesInHeader(detail)).toEqual([CHANGED_NOTE]);
    expect(screen.getByRole('status').textContent).toBe(OPENED_ANNOUNCEMENT);
    expect(writes(calls)).toEqual([]);
  });

  test('a card whose drill is still current, and which athletes can open from any work, carries no note at all', async () => {
    installFetch({
      drills: W_D4B_DRILLS,
      cardsList: [ISSUED_GROUP],
      drillInstruction: { ...COACH_INSTRUCTION, operational_lifecycle: 'current', athlete_access: 'all_work' },
    });

    await act(async () => {
      render(<CoachCardsPage />);
    });

    const toggle = await screen.findByRole('button', { name: 'View instructions: Jump rope' });
    await act(async () => {
      fireEvent.click(toggle);
    });

    const detail = screen.getByRole('article', { name: 'Jump rope' });
    for (const note of [RETIRED_NOTE, CHANGED_NOTE, OPEN_WORK_NOTE, WITHDRAWN_NOTE]) {
      expect(screen.queryByText(note)).toBeNull();
    }
    expect(document.body.textContent).not.toMatch(/retired/i);
    expect(document.body.textContent).not.toMatch(/changed this drill/i);
    expect(document.body.textContent).not.toMatch(ANY_ATHLETE_NOTE);
    // Nothing is rendered where the notes go -- not even an empty row: the
    // drill's header ends at its content-status line.
    expect(notesInHeader(detail)).toEqual([]);
    expect(detail.querySelector('header')?.lastElementChild).toBe(
      within(detail).getByText('Content: PPBF source manual v3. Current version.'),
    );
    expect(screen.getByRole('status').textContent).toBe(OPENED_ANNOUNCEMENT);
  });

  test('a card whose drill is current but whose reference was withdrawn says athletes cannot open it from any work, and claims no lifecycle change', async () => {
    /* The two facts are independent. Here the gym still runs the drill, but the
       reference it adopted has been withdrawn from the library: the coach can
       still review it (the content status says Retracted), while neither of
       the athlete's reads -- the two the server ran to answer athlete_access --
       offers anything, open work included. A coach told only "current" would
       send the athlete to read instructions they cannot open. */
    const calls = installFetch({
      drills: W_D4B_DRILLS,
      cardsList: [ISSUED_GROUP],
      drillInstruction: {
        ...COACH_INSTRUCTION,
        drill: { ...REFERENCE_DETAIL, active: false },
        operational_lifecycle: 'current',
        athlete_access: 'none',
      },
    });

    await act(async () => {
      render(<CoachCardsPage />);
    });

    const toggle = await screen.findByRole('button', { name: 'View instructions: Jump rope' });
    await act(async () => {
      fireEvent.click(toggle);
    });

    const detail = screen.getByRole('article', { name: 'Jump rope' });
    expect(within(detail).getByText('Content: PPBF source manual v3. Retracted.')).toBeTruthy();
    const withdrawn = noteInOpenedDrill(detail, WITHDRAWN_NOTE);
    // A restriction, drawn as one: no work opens it.
    expectInk(withdrawn, 'restricted');
    // Only that note: the gym has neither changed nor retired its drill, and
    // open work is no exception for a withdrawn reference.
    expect(notesInHeader(detail)).toEqual([WITHDRAWN_NOTE]);
    expect(screen.queryByText(OPEN_WORK_NOTE)).toBeNull();
    expect(screen.queryByText(RETIRED_NOTE)).toBeNull();
    expect(screen.queryByText(CHANGED_NOTE)).toBeNull();
    expect(document.body.textContent).not.toMatch(/retired this drill|changed this drill/i);
    expect(document.body.textContent).not.toContain(OLD_ATHLETE_WORDING);
    expect(screen.getByRole('status').textContent).toBe(OPENED_ANNOUNCEMENT);
    expect(writes(calls)).toEqual([]);
  });

  test('a retired card whose reference was also withdrawn says both, in that order, and never that open work still opens it', async () => {
    /* OD-2026-09-19-002's exception for open work drops only the adoption
       term. A withdrawn reference is still withheld from every athlete read,
       open work included -- so a retired drill whose reference was withdrawn
       opens from no work at all, and the open-work line would send an athlete
       to instructions they cannot reach. */
    const calls = installFetch({
      drills: W_D4B_DRILLS,
      cardsList: [ISSUED_GROUP],
      drillInstruction: {
        ...COACH_INSTRUCTION,
        drill: { ...REFERENCE_DETAIL, active: false },
        operational_lifecycle: 'retired',
        athlete_access: 'none',
      },
    });

    await act(async () => {
      render(<CoachCardsPage />);
    });

    const toggle = await screen.findByRole('button', { name: 'View instructions: Jump rope' });
    await act(async () => {
      fireEvent.click(toggle);
    });

    const detail = screen.getByRole('article', { name: 'Jump rope' });
    const retired = noteInOpenedDrill(detail, RETIRED_NOTE);
    const withdrawn = noteInOpenedDrill(detail, WITHDRAWN_NOTE);
    expect(follows(retired, withdrawn)).toBe(true);
    expectInk(withdrawn, 'restricted');
    expect(notesInHeader(detail)).toEqual([RETIRED_NOTE, WITHDRAWN_NOTE]);
    expect(screen.queryByText(OPEN_WORK_NOTE)).toBeNull();
    expect(document.body.textContent).not.toMatch(/Athletes can still open/i);
    expect(document.body.textContent).not.toContain(OLD_ATHLETE_WORDING);
    expect(screen.getByRole('status').textContent).toBe(OPENED_ANNOUNCEMENT);
    expect(writes(calls)).toEqual([]);
  });

  test('a card issued against a gym-written drill says so when opened, and shows no drill', async () => {
    const calls = installFetch({
      drills: W_D4B_DRILLS,
      cardsList: [GYM_WRITTEN_GROUP],
      drillInstruction: { state: 'gym_written' },
    });

    await act(async () => {
      render(<CoachCardsPage />);
    });

    const toggle = await screen.findByRole('button', { name: 'View instructions: Shadow rounds' });
    // An individual card has no issuance, so the group is keyed by the card.
    expect(toggle.id).toBe('card-group-instructions-asg-shadow');

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(calls.filter((call) => call.url.includes('/api/pilot/progression/drill-instruction')).map((call) => call.url)).toEqual([
      '/api/pilot/progression/drill-instruction?assignment_id=asg-shadow',
    ]);
    expect(
      screen.getByText(
        "This drill was written by this gym, so there are no reference instructions to open. The athlete reads the gym's own wording.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('article')).toBeNull();
  });

  test('an instruction read that fails says it did not load -- plainly, not as a failed write', async () => {
    installFetch({ drills: W_D4B_DRILLS, cardsList: [ISSUED_GROUP], drillInstruction: 'fail' });
    // useDrillOpener logs the failure for the operator; the page decides what the coach reads.
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await act(async () => {
      render(<CoachCardsPage />);
    });

    const alertsBefore = screen.queryAllByRole('alert').length;
    expect(alertsBefore).toBe(0);

    const toggle = await screen.findByRole('button', { name: 'View instructions: Jump rope' });
    await act(async () => {
      fireEvent.click(toggle);
    });

    // Said from the panel's ONE polite live region, so a screen-reader user
    // hears what the toggle produced. getByRole throws on a second status, so
    // a failure line that carried a role of its own would fail here too.
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe(LOAD_FAILED);
    expect(toggle.parentElement?.contains(region)).toBe(true);
    const failure = within(region).getByText(LOAD_FAILED);
    expect(failure.tagName).toBe('P');
    expect(failure.hasAttribute('role')).toBe(false);
    expect(failure.hasAttribute('aria-live')).toBe(false);
    expect(failure.closest('[role]')).toBe(region);
    // The page's red alert is reserved for a failed write. Nothing was written.
    expect(screen.queryAllByRole('alert')).toHaveLength(alertsBefore);
    expect(screen.queryByText('Failed')).toBeNull();
    expect(screen.queryByRole('article')).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({ event: 'drill-instruction-load-failed' }));
  });

  test('a legacy card with no drill behind it offers nothing to open', async () => {
    installFetch({ drills: W_D4B_DRILLS, cardsList: [LEGACY_GROUP] });

    await act(async () => {
      render(<CoachCardsPage />);
    });

    // The card itself is still listed with its own wording.
    expect(await screen.findByText('Heavy bag')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /instructions: Heavy bag/ })).toBeNull();
    expect(document.getElementById('card-group-instructions-asg-legacy')).toBeNull();
  });

  test('no preview action, opened or closed, before or after the pick changes, sends anything but a GET', async () => {
    const calls = installFetch({ drills: W_D4B_DRILLS, cardsList: [ISSUED_GROUP, LEGACY_GROUP] });

    await act(async () => {
      render(<CoachCardsPage />);
    });
    await screen.findByRole('button', { name: 'Verify' });
    const mounted = calls.length;

    fireEvent.change(screen.getByLabelText('Drill'), { target: { value: 'drill-rope' } });
    // Both controls carry the drill's name; document order puts the form first.
    const [picked, group] = screen.getAllByRole('button', { name: 'View instructions: Jump rope' });
    expect(picked.id).toBe('card-picked-instructions');
    expect(group.id).toBe('card-group-instructions-issuance-1');

    await act(async () => {
      fireEvent.click(picked);
    });
    fireEvent.click(picked);
    await act(async () => {
      fireEvent.click(group);
    });
    fireEvent.click(group);
    // And with a preview open when the pick changes.
    await act(async () => {
      fireEvent.click(picked);
    });
    fireEvent.change(screen.getByLabelText('Drill'), { target: { value: 'drill-shadow' } });

    // The snapshot: every request the preview actions made, in order. Three
    // reads and nothing else -- no write, and no read of anything but the two
    // instruction routes.
    expect(calls.slice(mounted).map((call) => [call.init?.method, call.url])).toEqual([
      ['GET', '/api/pilot/drill-library?drill_id=ref-rope'],
      ['GET', '/api/pilot/progression/drill-instruction?assignment_id=asg-1'],
      ['GET', '/api/pilot/drill-library?drill_id=ref-rope'],
    ]);
    expect(writes(calls)).toEqual([]);
  });
});
