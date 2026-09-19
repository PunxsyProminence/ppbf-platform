/**
 * @jest-environment jsdom
 */

// "No progression gaps assigned" is a claim about the athlete's coach, not about
// the network. It must never be shown while the gaps request is still in flight.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';

import type { RabbitHoleLessonItem } from '@/components/RabbitHole';
import AthleteProgressionIntelligencePage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

const SESSION_PATH = '/api/pilot/auth/session';

function mockFetch(gapsResponse: () => Promise<Response>) {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith(SESSION_PATH)) {
      return {
        ok: true,
        json: async () => ({ authenticated: true, athlete_id: 'athlete-001' }),
      } as Response;
    }
    if (url.includes('/progression/gaps')) {
      return gapsResponse();
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  });
}

const emptyOk = async () => ({ ok: true, json: async () => ({ items: [] }) }) as Response;

describe('athlete progression empty state', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('the empty state is withheld while progression data is still loading', async () => {
    global.fetch = mockFetch(() => new Promise<Response>(() => {})) as unknown as typeof fetch;

    render(<AthleteProgressionIntelligencePage />);

    await screen.findByText(/Loading your progression data/);
    expect(screen.queryByText('No progression gaps assigned')).toBeNull();
  });

  test('the empty state appears once loading finishes with no gaps', async () => {
    global.fetch = mockFetch(emptyOk) as unknown as typeof fetch;

    render(<AthleteProgressionIntelligencePage />);

    await screen.findByText('No progression gaps assigned');
    await waitFor(() => expect(screen.queryByText(/Loading your progression data/)).toBeNull());
  });
});

// A gap card names two vocabulary terms -- its gap type and its severity -- and
// a lesson is stored against a term, never against the card. These pin that the
// card asks for both, that an athlete reads the gym's coaching as the gym's
// coaching, and that a term nobody has written about adds nothing to the page.
describe('rabbit holes on the athlete gap cards', () => {
  const GAP = {
    gap_id: 'gap-1',
    athlete_id: 'athlete-001',
    gap_type: 'technique',
    gap_description: 'Rear foot stays flat through the cross.',
    severity: 'high',
    status: 'identified',
    created_at: '2026-07-30T12:00:00.000Z',
    updated_at: '2026-07-30T12:00:00.000Z',
  };

  const LESSON: RabbitHoleLessonItem = {
    rabbit_hole_id: 'rh-1',
    title: 'Biomechanics of Kinetic Force Transfer',
    concept: 'Power does not generate in the shoulders.',
    homework: 'Thirty slow crosses, three seconds at full extension.',
    author_display_name: 'Coach Jason',
    citation: null,
  };

  let anchorsAsked: string[] = [];

  function mockWithLessons(byAnchor: Record<string, RabbitHoleLessonItem[]>) {
    anchorsAsked = [];
    return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(SESSION_PATH)) {
        return { ok: true, json: async () => ({ authenticated: true, athlete_id: 'athlete-001' }) } as Response;
      }
      if (url.includes('/progression/gaps')) {
        return { ok: true, json: async () => ({ items: [GAP] }) } as Response;
      }
      if (url.includes('/rabbit-holes/get')) {
        const body = JSON.parse(String(init?.body)) as { anchor_type: string; anchor_key: string };
        const anchor = `${body.anchor_type}:${body.anchor_key}`;
        anchorsAsked.push(anchor);
        return { ok: true, json: async () => ({ ok: true, rabbit_holes: byAnchor[anchor] ?? [] }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    });
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('the card asks for the gap type and the severity it names, not for the card', async () => {
    global.fetch = mockWithLessons({}) as unknown as typeof fetch;

    await act(async () => {
      render(<AthleteProgressionIntelligencePage />);
    });

    await waitFor(() => expect(anchorsAsked).toContain('gap_type:technique'));
    expect(anchorsAsked).toContain('severity:high');
  });

  test('an athlete reads the lesson as the gym coaching it is, with no evidence tier', async () => {
    global.fetch = mockWithLessons({ 'gap_type:technique': [LESSON] }) as unknown as typeof fetch;

    await act(async () => {
      render(<AthleteProgressionIntelligencePage />);
    });

    const opener = await screen.findByRole('button', { name: /GO DEEPER \(1 LESSON\)/ });
    fireEvent.click(opener);

    expect(screen.getByText('Biomechanics of Kinetic Force Transfer')).toBeTruthy();
    expect(screen.getByText(/Power does not generate in the shoulders/)).toBeTruthy();
    expect(screen.getByText(/Thirty slow crosses/)).toBeTruthy();
    expect(screen.getByText(/Gym coaching/)).toBeTruthy();
    expect(screen.getByText(/Written by Coach Jason/)).toBeTruthy();

    // Hand-written teaching must never borrow SHADOW's evidence vocabulary.
    for (const tier of ['PROVEN', 'EMERGING', 'EXPERIMENTAL', 'RESEARCH_NEEDED']) {
      expect(screen.queryByText(tier)).toBeNull();
    }
  });

  test('a term nobody has written about leaves no expander behind', async () => {
    global.fetch = mockWithLessons({}) as unknown as typeof fetch;

    await act(async () => {
      render(<AthleteProgressionIntelligencePage />);
    });

    await waitFor(() => expect(anchorsAsked.length).toBeGreaterThan(0));
    expect(screen.queryByText(/GO DEEPER/)).toBeNull();
    // The gap itself still renders: a rabbit hole sits on top of the page's
    // real work and never replaces it.
    expect(screen.getByText('Rear foot stays flat through the cross.')).toBeTruthy();
  });

  test('a failed rabbit hole read leaves the gap card standing', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(SESSION_PATH)) {
        return { ok: true, json: async () => ({ authenticated: true, athlete_id: 'athlete-001' }) } as Response;
      }
      if (url.includes('/progression/gaps')) {
        return { ok: true, json: async () => ({ items: [GAP] }) } as Response;
      }
      if (url.includes('/rabbit-holes/get')) {
        throw new Error('rabbit holes offline');
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    await act(async () => {
      render(<AthleteProgressionIntelligencePage />);
    });

    expect(screen.getByText('Rear foot stays flat through the cross.')).toBeTruthy();
    expect(screen.queryByText(/GO DEEPER/)).toBeNull();
  });
});

// A Coach Card is an assignment with NO gap behind it (gap_id null, per the
// coach-cards migration). The athlete's list renders it exactly like any
// other assignment -- name, description, the log-completion button -- and
// simply omits the "Assigned for" gap line instead of inventing a gap or
// crashing on the null.
describe('gap-free Coach Cards on the assignments list', () => {
  const COACH_CARD_ASSIGNMENT = {
    assignment_id: 'asg-card-1',
    gap_id: null,
    drill_name: 'Shadowbox',
    drill_description: 'Three rounds before Friday, southpaw looks.',
    drill_display_name: 'Shadowbox',
    drill_display_description: 'Three rounds before Friday, southpaw looks.',
    drill_difficulty: 'intermediate',
    frequency_per_week: 3,
    completion_percentage: 0,
    status: 'assigned',
    created_at: '2026-08-20T10:00:00.000Z',
  };

  const GAP_DRIVEN_ASSIGNMENT = {
    assignment_id: 'asg-gap-1',
    gap_id: 'gap-1',
    drill_name: 'Pivot drill',
    drill_description: 'Rounds on the line.',
    drill_display_name: 'Pivot drill',
    drill_display_description: 'Rounds on the line.',
    drill_difficulty: 'intermediate',
    frequency_per_week: null,
    completion_percentage: 0,
    status: 'assigned',
    created_at: '2026-08-20T11:00:00.000Z',
  };

  const GAP = {
    gap_id: 'gap-1',
    athlete_id: 'athlete-001',
    gap_type: 'technique',
    gap_description: 'Rear foot stays flat through the cross.',
    severity: 'high',
    status: 'assigned',
    created_at: '2026-07-30T12:00:00.000Z',
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockWithAssignments() {
    return jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(SESSION_PATH)) {
        return { ok: true, json: async () => ({ authenticated: true, athlete_id: 'athlete-001' }) } as Response;
      }
      if (url.includes('/progression/gaps')) {
        return { ok: true, json: async () => ({ items: [GAP] }) } as Response;
      }
      if (url.includes('/progression/assignments')) {
        return {
          ok: true,
          json: async () => ({ items: [COACH_CARD_ASSIGNMENT, GAP_DRIVEN_ASSIGNMENT] }),
        } as Response;
      }
      if (url.includes('/progression/completions')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    });
  }

  test('a gap-free assignment renders unchanged next to a gap-driven one, minus the gap line', async () => {
    global.fetch = mockWithAssignments() as unknown as typeof fetch;

    await act(async () => {
      render(<AthleteProgressionIntelligencePage />);
    });

    // The card renders as a full assignment.
    await screen.findByText('Shadowbox');
    expect(screen.getByText('Three rounds before Friday, southpaw looks.')).toBeTruthy();
    expect(screen.getByText('3x/week')).toBeTruthy();

    // The gap-driven neighbor keeps its "Assigned for" line; the card has
    // none -- exactly one such line on the page.
    expect(screen.getByText('Pivot drill')).toBeTruthy();
    expect(screen.getAllByText(/Assigned for:/)).toHaveLength(1);

    // The athlete can log against the card like any other assignment.
    const logButtons = screen.getAllByRole('button', { name: 'Log completion' });
    expect(logButtons).toHaveLength(2);
  });
});

// The one thing an athlete must never be handed on their own screen: the
// developer's half of the conversation. This page used to render
// `Failed to fetch gaps: ${res.status}` and `Log failed (${res.status})`
// straight into the alert -- a stored HTTP status, read off a gym tablet by a
// kid. These pin the copy a failure produces, in both directions: no status
// code and no fetch jargon on screen, and the status still on the console for
// whoever has to debug it.
describe('a failure speaks to the athlete, not to the developer', () => {
  const DEVELOPER_TEXT = /\b[45]\d\d\b|Failed to fetch|Log failed/i;

  const ASSIGNMENT = {
    assignment_id: 'asg-1',
    gap_id: null,
    drill_name: 'Return-to-guard shadow rounds',
    drill_description: 'Three rounds, hands back to the chin.',
    drill_difficulty: 'foundational',
    rep_count: 30,
    completion_percentage: 0,
    status: 'assigned',
    created_at: '2026-08-20T10:00:00.000Z',
  };

  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function loggedCause(event: string): Record<string, unknown> | undefined {
    const call = consoleError.mock.calls.find(
      ([arg]) => (arg as { event?: string } | undefined)?.event === event,
    );
    const error = (call?.[0] as { error?: unknown } | undefined)?.error;
    return error instanceof Error ? (error.cause as Record<string, unknown> | undefined) : undefined;
  }

  test('a 500 on the gaps read renders no status code and no fetch jargon', async () => {
    global.fetch = mockFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response) as unknown as typeof fetch;

    render(<AthleteProgressionIntelligencePage />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toMatch(DEVELOPER_TEXT);
    expect(document.body.textContent).not.toMatch(DEVELOPER_TEXT);

    // What it says instead: what did not happen, what is still true, what to do.
    expect(alert.textContent).toContain('The gaps your coach wrote down did not load');
    expect(alert.textContent).toContain('Nothing is lost');
    expect(alert.textContent).toContain('they are still there');
  });

  test('the status stays on the console for whoever is debugging the tablet', async () => {
    global.fetch = mockFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response) as unknown as typeof fetch;

    render(<AthleteProgressionIntelligencePage />);
    await screen.findByRole('alert');

    expect(loggedCause('athlete-progression-load-failed')).toEqual({ status: 503 });
  });

  test("a dead network does not get to write the athlete's copy itself", async () => {
    // The browser's own message for a rejected fetch is the literal string
    // "Failed to fetch", so rendering err.message would have leaked developer
    // text on the one failure nobody in this repo authored.
    global.fetch = mockFetch(() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;

    render(<AthleteProgressionIntelligencePage />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toMatch(DEVELOPER_TEXT);
    expect(alert.textContent).toContain('This screen did not load');
  });

  test('a failed read never claims the coach assigned nothing', async () => {
    global.fetch = mockFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response) as unknown as typeof fetch;

    render(<AthleteProgressionIntelligencePage />);
    await screen.findByRole('alert');

    // Both empty-record claims are about the athlete's COACH. A read that
    // failed gives the page no standing to make either one.
    expect(screen.queryByText('No progression gaps assigned')).toBeNull();
    expect(screen.queryByText('No drills assigned yet')).toBeNull();
    expect(screen.queryByText(/Your coaches will identify gaps/)).toBeNull();
  });

  test('a refused log says so in words, and what the athlete typed is still in the box', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(SESSION_PATH)) {
        return { ok: true, json: async () => ({ authenticated: true, athlete_id: 'athlete-001' }) } as Response;
      }
      if (url.includes('/progression/assignments')) {
        return { ok: true, json: async () => ({ items: [ASSIGNMENT] }) } as Response;
      }
      if (url.includes('/progression/completions') && init?.method === 'POST') {
        // Exactly what this endpoint answers a bad log with -- a sentence
        // written for a developer, and a status.
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: 'Assignment does not belong to the specified athlete' }),
        } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    await act(async () => {
      render(<AthleteProgressionIntelligencePage />);
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Log completion' }));
    fireEvent.change(screen.getByLabelText('Reps completed (optional)'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Hands came back every round.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save log' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toMatch(DEVELOPER_TEXT);
    expect(alert.textContent).not.toContain('Assignment does not belong');
    expect(alert.textContent).toContain('That log did not save');

    // "What you typed is still in the box" has to be true when the page says it.
    expect((screen.getByLabelText('Reps completed (optional)') as HTMLInputElement).value).toBe('30');
    expect((screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('Hands came back every round.');

    // A failed WRITE is not a failed read: the drill that was read fine is
    // still on screen, and no empty-record claim is made.
    expect(screen.getByText(ASSIGNMENT.drill_description)).toBeTruthy();
    expect(screen.queryByText('No drills assigned yet')).toBeNull();

    // The developer's half of it is on the console, not on the tablet.
    expect(loggedCause('athlete-progression-log-failed')).toEqual({
      status: 400,
      detail: { error: 'Assignment does not belong to the specified athlete' },
    });
  });

  test('a gateway that answers with no JSON at all still gets a sentence, not a number', async () => {
    // The old fallback here was `Log failed (${res.status})` -- reached
    // exactly when the body has no `error` to borrow, which is when a proxy
    // or a gateway answers instead of the app.
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(SESSION_PATH)) {
        return { ok: true, json: async () => ({ authenticated: true, athlete_id: 'athlete-001' }) } as Response;
      }
      if (url.includes('/progression/assignments')) {
        return { ok: true, json: async () => ({ items: [ASSIGNMENT] }) } as Response;
      }
      if (url.includes('/progression/completions') && init?.method === 'POST') {
        return { ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); } } as unknown as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    await act(async () => {
      render(<AthleteProgressionIntelligencePage />);
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Log completion' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save log' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toMatch(DEVELOPER_TEXT);
    expect(alert.textContent).toContain('That log did not save');
    expect(loggedCause('athlete-progression-log-failed')).toEqual({ status: 502, detail: {} });
  });
});

// W-D4B (OD-2026-09-19-001): the drill a piece of assigned work was issued
// against, opened from that work. Opening is READING -- one GET, keyed by the
// assignment, and nothing written. The assignment stays on screen above the
// drill so the athlete reads it as THIS work, and the drill offers no way to
// log: logging stays on the assignment, one Back away. The list the drill was
// opened from is hidden, not unmounted, and jsdom loads no CSS -- so its
// buttons are still in the tree, and every query below is scoped with within().
describe('W-D4B: opening the drill an assignment was issued against', () => {
  // An id with characters a query string must escape, so an encoded read can
  // be told apart from one that pasted the id in raw.
  const ASSIGNMENT_ID = 'asg:7/jab';
  const ASSIGNMENT_NAME = 'Jab return shadow rounds';
  const DRILL_NAME = 'Jab return to guard';
  const INSTRUCTION_PATH = '/api/pilot/progression/drill-instruction';

  // The page's own copy, pinned here word for word.
  const LEARNING_IS_NOT_LOGGING =
    'Reading the drill does not log your work. When you have done it, go back to your assigned work and use Log completion.';
  const ALREADY_LOGGED = 'This work is already logged as complete. Reading the drill does not change it.';
  const DRILL_DID_NOT_LOAD = 'The drill did not load. Nothing about your assignment changed — try again in a minute.';
  // ONE line for every state that has nothing to open. Whether the gym wrote
  // the drill itself, took it from the reference library, or has since retired
  // it is how the library is assembled and governed -- provenance an athlete's
  // screen does not carry (OD-2026-09-19-001 role projection).
  // Word for word, and with no "right now": the line states what is so, and
  // makes no suggestion about when that might change.
  const DRILL_NOTHING_TO_OPEN =
    'There are no library instructions to open for this drill. What your coach wrote for this work is above — ask your coach how to run it.';
  const LOADING_THE_DRILL = 'Loading the drill…';
  const DRILL_IS_BELOW = `${DRILL_NAME}: the drill is below.`;

  // The words the per-state lines this page used to show were built from --
  // who wrote the drill, whether it is linked, whether it is in the library,
  // whether it was retired or changed. None of them may reach an athlete, in
  // any state. The neutral line above matches none of these.
  const PROVENANCE =
    /gym wrote|wrote this drill itself|library instructions for it|not linked|gym's library|retired|changed this drill|reference|version|operational|promot/i;

  // The assignment's own wording, and the drill's snapshot beside it.
  const ASSIGNMENT_DESCRIPTION = 'Three rounds, the hand comes home after every jab.';
  const SNAPSHOT_DESCRIPTION = 'Hands home after every jab.';

  const GAP = {
    gap_id: 'gap-1',
    athlete_id: 'athlete-001',
    gap_type: 'technique',
    gap_description: 'Lead hand drifts low after the jab.',
    severity: 'high',
    status: 'assigned',
    created_at: '2026-09-10T12:00:00.000Z',
  };

  // drill_id is the OPERATIONAL version the work was issued against. The
  // display name is the assignment's own snapshot wording, deliberately not
  // the library drill's name, so the two can be told apart on screen.
  const DRILL_ASSIGNMENT = {
    assignment_id: ASSIGNMENT_ID,
    drill_id: 'op-drill-v1',
    gap_id: 'gap-1',
    drill_name: 'Jab return',
    drill_description: SNAPSHOT_DESCRIPTION,
    drill_display_name: ASSIGNMENT_NAME,
    drill_display_description: ASSIGNMENT_DESCRIPTION,
    drill_difficulty: 'foundational',
    rep_count: 40,
    duration_minutes: 15,
    frequency_per_week: 3,
    due_date: '2026-09-30',
    completion_percentage: 25,
    status: 'in_progress',
    created_at: '2026-09-18T10:00:00.000Z',
  };

  // Written before drills had identity: no drill to open, so no opener.
  const LEGACY_ASSIGNMENT = {
    assignment_id: 'asg-legacy-1',
    drill_id: null,
    gap_id: null,
    drill_name: 'Skipping rope',
    drill_description: 'Ten minutes, steady rhythm.',
    drill_difficulty: 'foundational',
    duration_minutes: 10,
    completion_percentage: 0,
    status: 'assigned',
    created_at: '2026-08-01T10:00:00.000Z',
  };

  // What the route answers an athlete: the athlete-safe projection with NO
  // drill_id key. On that projection drill_id is the reference pointer, and it
  // never leaves the server.
  const ATHLETE_INSTRUCTION = {
    assignment_id: ASSIGNMENT_ID,
    assigned_by: 'Coach Jason',
    state: 'available',
    audience: 'athlete',
    drill: {
      name: DRILL_NAME,
      purpose: 'Bring the lead hand home before the next beat.',
      setup: 'Partner holds one mitt at technical distance.',
      execution:
        'Step in behind the jab and touch the mitt.\n\nBring the hand straight back to the chin before the mitt moves.',
      contact_level: 'light_technical',
      requires_coach_authorization: true,
      cues: ['Hand home first', 'Chin down'],
      what_good_looks_like: 'Hand is back at the chin before the next beat',
      what_bad_looks_like: 'Hand drops on the way back',
      common_errors: 'Pawing the jab',
      corrections: 'Slow the tempo until the hand comes home every time',
      equipment_needed: 'focus mitt',
      scale_levels: [
        { scale_level: 'A', is_starting_point: false, demand_description: 'Half pace, no partner.', constraint_applied: '', contact_level: 'none', coach_watch_point: 'Is the athlete repeating it unprompted?' },
        { scale_level: 'B', is_starting_point: true, demand_description: 'The drill as designed.', constraint_applied: 'One jab at a time.', contact_level: 'light_technical', coach_watch_point: 'Can the athlete respond to one cue?' },
        { scale_level: 'C', is_starting_point: false, demand_description: 'Partner counters with a slow hook.', constraint_applied: '', contact_level: 'light_technical', coach_watch_point: 'Does the return survive a counter?' },
      ],
      stop_rules: [
        { ordinal: 1, condition_text: 'Stop when the hand stops coming home.', scope: 'drill_specific', rule_kind: 'technique_degradation' },
        { ordinal: 2, condition_text: 'Stop when fatigue breaks decision quality.', scope: 'universal', rule_kind: 'fatigue' },
        { ordinal: 3, condition_text: 'Re-warm before contact after about twenty minutes idle.', scope: 'universal', rule_kind: 'warmup_decay' },
      ],
    },
  };

  const json = (body: unknown, status = 200) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

  // Which branch of the fake each request reached, in order. The list read
  // matches on '/progression/assignments'; the instruction read's query string
  // is '?assignment_id=', which does NOT contain that substring -- this log is
  // what shows the two were routed apart rather than one answering for both.
  let routed: string[] = [];

  function mockAssignedWork(options: {
    assignments?: unknown[];
    instruction?: () => Promise<Response>;
  } = {}) {
    routed = [];
    const assignments = options.assignments ?? [DRILL_ASSIGNMENT, LEGACY_ASSIGNMENT];
    const instruction = options.instruction ?? (async () => json(ATHLETE_INSTRUCTION));
    return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(SESSION_PATH)) {
        routed.push('session');
        return json({ authenticated: true, athlete_id: 'athlete-001' });
      }
      if (url.includes('/progression/gaps')) {
        routed.push('gaps');
        return json({ items: [GAP] });
      }
      if (url.includes('/progression/assignments')) {
        routed.push('assignments');
        return json({ items: assignments });
      }
      if (url.includes('/progression/completions')) {
        if (init?.method === 'POST') {
          routed.push('completion-write');
          return json({ ok: true }, 201);
        }
        routed.push('completions');
        return json({ items: [] });
      }
      if (url.includes(`${INSTRUCTION_PATH}?assignment_id=`)) {
        routed.push('instruction');
        return instruction();
      }
      if (url.includes('/rabbit-holes/get')) {
        routed.push('rabbit-hole');
        return json({ ok: true, rabbit_holes: [] });
      }
      routed.push(`unrouted ${url}`);
      return json({ items: [] });
    });
  }

  function method(init: unknown): string {
    return ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase();
  }

  /** Renders the page and waits until everything it reads on mount has landed. */
  async function renderAssignedWork(fetchMock: jest.Mock) {
    global.fetch = fetchMock as unknown as typeof fetch;

    await act(async () => {
      render(<AthleteProgressionIntelligencePage />);
    });

    const opener = await screen.findByRole('button', { name: `Open drill: ${ASSIGNMENT_NAME}` });
    // The gap card's two rabbit holes read (by POST) on mount. Let them land
    // first, so a snapshot taken after this counts only what opening does.
    await waitFor(() => expect(routed.filter((r) => r === 'rabbit-hole')).toHaveLength(2));
    return opener;
  }

  /** The container the list sits in -- the element the page hides. */
  function assignedWorkList(): HTMLElement {
    const section = screen.getByRole('heading', { name: 'Drill Assignments' }).closest('section');
    return section?.parentElement as HTMLElement;
  }

  /** Clicks the opener and returns the opened view: Back, the assignment context, and the drill. */
  function openDrill(opener: HTMLElement): HTMLElement {
    fireEvent.click(opener);
    return screen.getByRole('button', { name: 'Back to your assigned work' }).parentElement as HTMLElement;
  }

  /** The value a <dt> labels inside the assignment context. */
  function contextValue(context: HTMLElement, label: string): string | null | undefined {
    return within(context).getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;
  }

  /**
   * The opened view's one live region. Every outcome line -- loading, did not
   * load, nothing to open, the drill is below -- is announced from inside it,
   * and nothing else in the opened view claims a live role.
   */
  function outcomeRegion(openedView: HTMLElement): HTMLElement {
    const regions = within(openedView).getAllByRole('status');
    expect(regions).toHaveLength(1);
    expect(regions[0].getAttribute('aria-live')).toBe('polite');
    expect(within(openedView).queryAllByRole('alert')).toEqual([]);
    return regions[0];
  }

  /** An instruction read that answers only when the test says so. */
  function heldInstruction() {
    let answer: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    return { read: () => pending, answer: (response: Response) => answer(response) };
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('only work linked to a drill offers to open it', async () => {
    await renderAssignedWork(mockAssignedWork());

    // Exactly one opener on the page, and it is the linked assignment's.
    const openers = screen.getAllByRole('button', { name: /^Open drill/ });
    expect(openers).toHaveLength(1);
    expect(openers[0].getAttribute('aria-label')).toBe(`Open drill: ${ASSIGNMENT_NAME}`);
    expect(openers[0].id).toBe(`assignment-open-${ASSIGNMENT_ID}`);

    // The legacy row renders as it always did -- log control and all -- with
    // no opener to a drill that is not there.
    const legacyCard = screen.getByText('Skipping rope').closest('.mat-leather') as HTMLElement;
    expect(within(legacyCard).queryByRole('button', { name: /Open drill/ })).toBeNull();
    expect(within(legacyCard).getByRole('button', { name: 'Log completion' })).toBeTruthy();
  });

  test('opening reads the one instruction by assignment id, and writes nothing', async () => {
    const fetchMock = mockAssignedWork();
    const opener = await renderAssignedWork(fetchMock);
    const callsBefore = fetchMock.mock.calls.length;
    const routedBefore = routed.length;

    openDrill(opener);
    await screen.findByRole('article', { name: DRILL_NAME });

    // Exactly one request, and it is a GET.
    const opened = fetchMock.mock.calls.slice(callsBefore);
    expect(opened).toHaveLength(1);
    const [url, init] = opened[0];
    expect(method(init)).toBe('GET');

    // Keyed by the assignment and nothing else: no drill id, no reference id,
    // nothing the client could use to pick a version. The id is encoded.
    const read = new URL(String(url), 'http://localhost');
    expect(read.pathname).toBe(INSTRUCTION_PATH);
    expect([...read.searchParams.keys()]).toEqual(['assignment_id']);
    expect(read.searchParams.get('assignment_id')).toBe(ASSIGNMENT_ID);
    expect(String(url)).toContain(`assignment_id=${encodeURIComponent(ASSIGNMENT_ID)}`);

    // Routed apart from the list read, which ran once on mount and not again.
    expect(String(url)).not.toContain('/progression/assignments');
    expect(routed.slice(routedBefore)).toEqual(['instruction']);
    expect(routed.filter((r) => r === 'assignments')).toHaveLength(1);

    // Nothing written because of opening -- and nothing written at all. The
    // only non-GETs this page has sent are the session check and the gap
    // card's two rabbit-hole reads, all on mount, before the drill was opened.
    const allCalls = fetchMock.mock.calls.map(([u, i]) => ({ url: String(u), method: method(i) }));
    const nonGets = allCalls
      .map((call, index) => ({ ...call, index }))
      .filter((call) => call.method !== 'GET');
    expect(nonGets.map((call) => (call.url.endsWith(SESSION_PATH) ? 'session' : call.url.includes('/rabbit-holes/get') ? 'rabbit-hole' : call.url)))
      .toEqual(['session', 'rabbit-hole', 'rabbit-hole']);
    expect(nonGets.every((call) => call.index < callsBefore)).toBe(true);
    expect(allCalls.some((call) => call.url.includes('/progression/completions') && call.method !== 'GET')).toBe(false);

    // The reference pointer is never asked for: no library read, no drills read.
    expect(allCalls.some((call) => call.url.includes('/api/pilot/drill-library'))).toBe(false);
    expect(allCalls.some((call) => call.url.includes('/api/pilot/drills'))).toBe(false);
    expect(routed.filter((r) => r.startsWith('unrouted'))).toEqual([]);
  });

  test('the opened drill sits under the assignment it was opened from', async () => {
    const opener = await renderAssignedWork(mockAssignedWork());
    const list = assignedWorkList();
    expect(list.classList.contains('hidden')).toBe(false);

    const openedView = openDrill(opener);
    await within(openedView).findByRole('article', { name: DRILL_NAME });

    // The list is hidden -- not gone -- and Back is offered.
    expect(list.classList.contains('hidden')).toBe(true);
    expect(list.isConnected).toBe(true);
    expect(within(openedView).getByRole('button', { name: 'Back to your assigned work' })).toBeTruthy();

    // The assignment comes first, in its own words: the snapshot name, not the
    // library drill's, with who set it and every figure the card carried.
    const context = within(openedView).getByRole('region', { name: ASSIGNMENT_NAME });
    expect(within(context).getByText('Your assignment')).toBeTruthy();
    expect(within(context).getByText(ASSIGNMENT_NAME)).toBeTruthy();
    // The coach's own words for this work, under its name -- the opened view
    // is never emptier than the card it came from. The assignment's wording
    // wins over the drill's snapshot, exactly as on the card.
    expect(within(context).getByText(ASSIGNMENT_DESCRIPTION)).toBeTruthy();
    expect(within(context).queryByText(SNAPSHOT_DESCRIPTION)).toBeNull();
    expect(contextValue(context, 'From')).toBe('Coach Jason');
    expect(contextValue(context, 'Due')).toBe('Sep 30, 2026');
    expect(contextValue(context, 'Reps')).toBe('40');
    expect(contextValue(context, 'Duration')).toBe('15 min');
    expect(contextValue(context, 'Frequency')).toBe('3x/week');
    expect(contextValue(context, 'Progress')).toBe('25% · in progress');

    // Learning is not logging, said in words.
    expect(within(context).getByText(LEARNING_IS_NOT_LOGGING)).toBeTruthy();

    // Focus lands on the assignment, not on <body> under a hidden button.
    await waitFor(() => expect(document.activeElement).toBe(context));
  });

  test('the opened drill is the athlete instruction: safety first, steps in order, nothing to log', async () => {
    const opener = await renderAssignedWork(mockAssignedWork());
    const openedView = openDrill(opener);
    const article = await within(openedView).findByRole('article', { name: DRILL_NAME });

    // Keyed by the assignment: the client never had a drill id to key it by.
    expect(article.getAttribute('aria-labelledby')).toBe(`drill-detail-assignment-${ASSIGNMENT_ID}`);

    // Safety, always open, with each kind of stop rule under its own heading.
    const safety = within(article).getByRole('region', { name: 'Safety' });
    expect(within(safety).getByText(/Light technical contact/)).toBeTruthy();
    expect(within(safety).getByText(/Only run this drill with a coach who has approved it/)).toBeTruthy();
    const stopGroup = (heading: string) =>
      [...(within(safety).getByText(heading).nextElementSibling?.querySelectorAll('li') ?? [])].map((li) => li.textContent);
    expect(stopGroup("This drill's stop rules")).toEqual(['Stop when the hand stops coming home.']);
    expect(stopGroup('Stop rules for every drill')).toEqual(['Stop when fatigue breaks decision quality.']);
    expect(stopGroup('Before contact or maximal effort')).toEqual(['Re-warm before contact after about twenty minutes idle.']);

    // The two paragraphs the author wrote come back as two ordered steps.
    const howItRuns = within(article).getByRole('heading', { name: 'How it runs' }).parentElement as HTMLElement;
    const steps = within(howItRuns).getByRole('list');
    expect(steps.tagName).toBe('OL');
    expect(within(steps).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Step in behind the jab and touch the mitt.',
      'Bring the hand straight back to the chin before the mitt moves.',
    ]);

    expect(within(article).getByText('Bring the lead hand home before the next beat.')).toBeTruthy();
    expect(within(article).getByText('Partner holds one mitt at technical distance.')).toBeTruthy();
    expect(within(article).getByText('focus mitt')).toBeTruthy();
    expect(within(article).getByText('Hand home first')).toBeTruthy();
    expect(within(article).getByText('Pawing the jab')).toBeTruthy();
    expect(within(article).getByText(/Standard \(B\) · where to start/)).toBeTruthy();

    // Rendered for an athlete: no coach watch points, no source or version.
    expect(within(article).queryByText(/Can the athlete respond to one cue/)).toBeNull();
    expect(within(article).queryByText(/Watch for:/)).toBeNull();
    expect(within(article).queryByText('Source and version')).toBeNull();
    expect(within(article).queryByText(/^Content:/)).toBeNull();

    // Learning, kept apart from doing: Back is the only control in the opened
    // view, and there is nowhere to type a log.
    expect(within(openedView).queryAllByRole('button', { name: /log|complete|save/i })).toEqual([]);
    expect(within(openedView).getAllByRole('button').map((b) => b.textContent)).toEqual(['Back to your assigned work']);
    expect(within(openedView).queryAllByRole('spinbutton')).toEqual([]);
    expect(within(openedView).queryAllByRole('textbox')).toEqual([]);
  });

  test('Back returns to the list as it was, focus on the opener, with nothing reloaded', async () => {
    const fetchMock = mockAssignedWork();
    const opener = await renderAssignedWork(fetchMock);
    const list = assignedWorkList();
    const openedView = openDrill(opener);
    await within(openedView).findByRole('article', { name: DRILL_NAME });
    const callsOpen = fetchMock.mock.calls.length;

    fireEvent.click(within(openedView).getByRole('button', { name: 'Back to your assigned work' }));

    expect(list.classList.contains('hidden')).toBe(false);
    expect(screen.queryByRole('article', { name: DRILL_NAME })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back to your assigned work' })).toBeNull();
    // Same node as before: the list was hidden, never torn down.
    expect(document.getElementById(`assignment-open-${ASSIGNMENT_ID}`)).toBe(opener);

    // Focus returns to the control that opened the drill, one frame later.
    await waitFor(() => expect(document.activeElement).toBe(opener));

    // Nothing on the list reloaded -- no re-read, and no rabbit hole asked twice.
    expect(fetchMock.mock.calls.length).toBe(callsOpen);
  });

  test('after Back, Log completion records exactly what it always has', async () => {
    const fetchMock = mockAssignedWork();
    const opener = await renderAssignedWork(fetchMock);
    const openedView = openDrill(opener);
    await within(openedView).findByRole('article', { name: DRILL_NAME });
    fireEvent.click(within(openedView).getByRole('button', { name: 'Back to your assigned work' }));

    const card = opener.closest('.mat-leather') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Log completion' }));
    fireEvent.change(within(card).getByLabelText('Reps completed (optional)'), { target: { value: '12' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save log' }));

    await waitFor(() => expect(routed).toContain('completion-write'));
    const posts = fetchMock.mock.calls.filter(([u, i]) => String(u).includes('/progression/completions') && method(i) === 'POST');
    expect(posts).toHaveLength(1);
    const [url, init] = posts[0];
    expect(String(url).endsWith('/api/pilot/progression/completions')).toBe(true);
    // The body the log has always sent -- nothing about the drill that was
    // read, and no marker that it was.
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      assignment_id: ASSIGNMENT_ID,
      athlete_id: 'athlete-001',
      reps_completed: 12,
    });

    // The page re-reads after a saved log; let that land before the test ends.
    await waitFor(() => expect(routed.filter((r) => r === 'assignments')).toHaveLength(2));
    await screen.findByRole('button', { name: `Open drill: ${ASSIGNMENT_NAME}` });
  });

  test.each([404, 500])(
    'a %i from the instruction read says the drill did not load -- as status, never as an alert',
    async (status) => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      const opener = await renderAssignedWork(
        mockAssignedWork({ instruction: async () => json({ error: 'Not found' }, status) }),
      );
      expect(screen.queryByRole('alert')).toBeNull();

      const openedView = openDrill(opener);
      const failure = await within(openedView).findByText(DRILL_DID_NOT_LOAD);

      // Announced from the one live region, and alone in it. The line has no
      // role of its own -- a second status, or an alert, would be a second
      // announcement competing with the first.
      const notice = outcomeRegion(openedView);
      expect(notice.contains(failure)).toBe(true);
      expect(failure.hasAttribute('role')).toBe(false);
      expect(notice.textContent).toBe(DRILL_DID_NOT_LOAD);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(within(openedView).queryByRole('article')).toBeNull();
      expect(within(openedView).queryByText(/Loading the drill/)).toBeNull();
      // A network failure is not a fact about the drill.
      expect(within(openedView).queryByText(DRILL_NOTHING_TO_OPEN)).toBeNull();
      // No status code on the tablet; it stays on the console.
      expect(openedView.textContent).not.toMatch(/\b[45]\d\d\b|drill-instruction read answered/);
      expect(
        consoleError.mock.calls.some(([arg]) => (arg as { event?: string } | undefined)?.event === 'drill-instruction-load-failed'),
      ).toBe(true);

      // The assignment is still there, unchanged, with its learning-vs-logging line.
      const context = within(openedView).getByRole('region', { name: ASSIGNMENT_NAME });
      expect(contextValue(context, 'Progress')).toBe('25% · in progress');
      expect(within(context).getByText(LEARNING_IS_NOT_LOGGING)).toBeTruthy();
      expect(within(context).getByText(ASSIGNMENT_DESCRIPTION)).toBeTruthy();
      // The read that would have named the coach never answered, and the row
      // is still drawn -- in the words every athlete surface falls back to.
      expect(contextValue(context, 'From')).toBe('Your coach');
    },
  );

  // The route sends an athlete ONE non-available state ('unavailable') for all
  // of these. The page is pinned against the other two anyway: were the server
  // ever to let a staff state through, the athlete would still read the one
  // neutral line, never which kind of "nothing" it was.
  test.each(['unavailable', 'gym_written', 'no_drill'])(
    'state %s reads as the one neutral line, carries no provenance, and opens no drill',
    async (state) => {
      const opener = await renderAssignedWork(
        mockAssignedWork({
          instruction: async () => json({ assignment_id: ASSIGNMENT_ID, assigned_by: 'Coach Jason', state }),
        }),
      );

      const openedView = openDrill(opener);
      const line = await within(openedView).findByText(DRILL_NOTHING_TO_OPEN);

      // The exact sentence, alone in the live region: not a failure, not a
      // loading line, and no drill announced below.
      const notice = outcomeRegion(openedView);
      expect(notice.contains(line)).toBe(true);
      expect(notice.textContent).toBe(DRILL_NOTHING_TO_OPEN);
      expect(line.textContent).not.toContain('right now');
      expect(within(openedView).queryByText(DRILL_DID_NOT_LOAD)).toBeNull();
      expect(within(openedView).queryByRole('article')).toBeNull();

      // Nothing on the opened view says who wrote the drill, whether it is
      // linked or in the library, or what became of it.
      expect(openedView.textContent).not.toMatch(PROVENANCE);

      // "What your coach wrote for this work is above" has to be true when the
      // page says it: the assignment's own description, above the line.
      const context = within(openedView).getByRole('region', { name: ASSIGNMENT_NAME });
      expect(within(context).getByText(ASSIGNMENT_DESCRIPTION)).toBeTruthy();
      expect(context.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      // The assignment context stands, including who set the work.
      expect(contextValue(context, 'From')).toBe('Coach Jason');
      expect(within(context).getByText(LEARNING_IS_NOT_LOGGING)).toBeTruthy();
    },
  );

  test('while the drill is loading, the assignment already says who set it', async () => {
    const held = heldInstruction();
    const opener = await renderAssignedWork(mockAssignedWork({ instruction: held.read }));

    const openedView = openDrill(opener);
    const context = within(openedView).getByRole('region', { name: ASSIGNMENT_NAME });

    // The read is out and has not answered. The From row is drawn all the
    // same, and the loading line is announced from the one live region.
    await waitFor(() => expect(routed).toContain('instruction'));
    expect(contextValue(context, 'From')).toBe('Your coach');
    expect(within(context).getByText(ASSIGNMENT_DESCRIPTION)).toBeTruthy();
    expect(outcomeRegion(openedView).textContent).toBe(LOADING_THE_DRILL);
    expect(within(openedView).queryByRole('article')).toBeNull();

    // Once it answers, the row names the coach the read derived.
    await act(async () => {
      held.answer(json(ATHLETE_INSTRUCTION));
    });
    await within(openedView).findByRole('article', { name: DRILL_NAME });
    expect(contextValue(context, 'From')).toBe('Coach Jason');
    expect(outcomeRegion(openedView).textContent).toBe(DRILL_IS_BELOW);
  });

  test('an opened drill is announced by name from the live region, to a screen reader only', async () => {
    const opener = await renderAssignedWork(mockAssignedWork());
    const openedView = openDrill(opener);
    const article = await within(openedView).findByRole('article', { name: DRILL_NAME });

    // Focus stays on the assignment, so the live region is what tells a
    // screen-reader user the drill arrived -- and where.
    const notice = outcomeRegion(openedView);
    expect(notice.textContent).toBe(DRILL_IS_BELOW);
    expect(within(notice).getByText(DRILL_IS_BELOW).classList.contains('sr-only')).toBe(true);
    // "Below" is true: the drill follows the region, outside it, so its whole
    // body is not read out as one announcement.
    expect(notice.contains(article)).toBe(false);
    expect(notice.compareDocumentPosition(article) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(openedView).queryByText(DRILL_NOTHING_TO_OPEN)).toBeNull();
    expect(within(openedView).queryByText(DRILL_DID_NOT_LOAD)).toBeNull();
  });

  test("an assignment with no description of its own shows the drill's snapshot wording", async () => {
    const plain = { ...DRILL_ASSIGNMENT, drill_display_description: undefined };
    const opener = await renderAssignedWork(mockAssignedWork({ assignments: [plain, LEGACY_ASSIGNMENT] }));

    const openedView = openDrill(opener);
    await within(openedView).findByRole('article', { name: DRILL_NAME });

    const context = within(openedView).getByRole('region', { name: ASSIGNMENT_NAME });
    expect(within(context).getByText(SNAPSHOT_DESCRIPTION)).toBeTruthy();
  });

  test('completed work says it is already logged, and that reading does not change it', async () => {
    const completed = { ...DRILL_ASSIGNMENT, status: 'completed', completion_percentage: 100 };
    const opener = await renderAssignedWork(mockAssignedWork({ assignments: [completed, LEGACY_ASSIGNMENT] }));

    const openedView = openDrill(opener);
    await within(openedView).findByRole('article', { name: DRILL_NAME });

    const context = within(openedView).getByRole('region', { name: ASSIGNMENT_NAME });
    expect(within(context).getByText(ALREADY_LOGGED)).toBeTruthy();
    expect(within(context).queryByText(LEARNING_IS_NOT_LOGGING)).toBeNull();
    expect(contextValue(context, 'Progress')).toBe('100% · completed');
    expect(within(openedView).queryAllByRole('button', { name: /log|complete|save/i })).toEqual([]);
  });
});
