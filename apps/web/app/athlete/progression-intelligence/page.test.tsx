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
