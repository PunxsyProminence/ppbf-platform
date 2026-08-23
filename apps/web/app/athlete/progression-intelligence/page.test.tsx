/**
 * @jest-environment jsdom
 */

// "No progression gaps assigned" is a claim about the athlete's coach, not about
// the network. It must never be shown while the gaps request is still in flight.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
