/**
 * @jest-environment jsdom
 */

// A rabbit hole sits inside somebody else's surface, so most of what matters is
// what it does NOT do. The knowledge base starts empty and will stay sparse: an
// expander drawn on every card that opens onto nothing would be worse than no
// feature, and a read that fails must leave the page it decorates untouched.
//
// The other half is honesty. A lesson is hand-written gym coaching. It names
// its author and it never carries an evidence tier -- PROVEN / EMERGING /
// EXPERIMENTAL / RESEARCH_NEEDED mean retrieved-and-cited SHADOW evidence, and
// hand-written teaching cannot borrow that authority. A citation appears only
// when the lesson points at a Library document that is still approved.

import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: function MockLink({ href, children, ...rest }: { href: string; children: React.ReactNode }) {
    return React.createElement('a', { href, ...rest }, children);
  },
}));

// Only the anchor vocabulary is wanted from the server module; the driver it
// pulls in behind that has no place in a DOM test environment.
jest.mock('@/src/server/pilot/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));

import { RABBIT_HOLE_ANCHOR_TYPES as SERVER_ANCHOR_TYPES } from '@/src/server/pilot/rabbitHoles';

import { HelpPanel } from './RoleSummaryPanels';
import { RabbitHole, RABBIT_HOLE_ANCHOR_TYPES, type RabbitHoleLessonItem } from './RabbitHole';

const ANCHOR = { anchorType: 'gap_type', anchorKey: 'technique' } as const;

let rabbitHoleCalls: Array<Record<string, unknown>> = [];
let lessons: RabbitHoleLessonItem[] = [];
let readFails: 'no' | 'status' | 'throws' | 'not-ok-payload' = 'no';

function lesson(overrides: Partial<RabbitHoleLessonItem> = {}): RabbitHoleLessonItem {
  return {
    rabbit_hole_id: 'rh-1',
    title: 'Kinetic force transfer',
    concept: 'Power does not generate in the shoulders.',
    homework: 'Thirty slow crosses, three seconds at full extension.',
    author_display_name: 'Coach Jason',
    citation: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  rabbitHoleCalls = [];
  lessons = [];
  readFails = 'no';

  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.endsWith('/api/pilot/rabbit-holes/get')) {
      rabbitHoleCalls.push(typeof init?.body === 'string' ? JSON.parse(init.body) : {});
      if (readFails === 'throws') throw new Error('network down');
      if (readFails === 'status') return jsonResponse({ error: 'Internal server error' }, false);
      if (readFails === 'not-ok-payload') return jsonResponse({ ok: false });
      return jsonResponse({ ok: true, rabbit_holes: lessons });
    }

    // ShadowChatButton, rendered inside every open HelpPanel.
    return jsonResponse({ authenticated: true, role: 'athlete' });
  }) as unknown as typeof fetch;
});

describe('a rabbit hole with nothing to say says nothing', () => {
  test('an anchor with no lesson renders nothing at all', async () => {
    render(<RabbitHole anchor={ANCHOR} />);

    await waitFor(() => expect(rabbitHoleCalls).toHaveLength(1));
    expect(screen.queryByTestId('rabbit-hole')).toBeNull();
    // Not even the expander: an empty shell on every card is worse than no
    // feature.
    expect(document.body.textContent).toBe('');
  });

  test('a read that fails renders nothing and never breaks the surface around it', async () => {
    for (const mode of ['status', 'throws', 'not-ok-payload'] as const) {
      readFails = mode;
      lessons = [lesson()];
      const { unmount } = render(
        <div>
          <p>Session notes for today</p>
          <RabbitHole anchor={ANCHOR} />
        </div>,
      );

      await waitFor(() => expect(rabbitHoleCalls.length).toBeGreaterThan(0));
      expect(screen.queryByTestId('rabbit-hole')).toBeNull();
      // The surface it decorates is untouched.
      expect(screen.getByText('Session notes for today')).toBeTruthy();
      rabbitHoleCalls = [];
      unmount();
    }
  });

  test('the read asks for exactly the anchor it was given', async () => {
    lessons = [lesson()];
    render(<RabbitHole anchor={{ anchorType: 'board_seat', anchorKey: 'treasurer' }} />);

    await waitFor(() => expect(rabbitHoleCalls).toHaveLength(1));
    expect(rabbitHoleCalls[0]).toEqual({ anchor_type: 'board_seat', anchor_key: 'treasurer' });
  });

  // A lesson left on screen from the previous anchor would be teaching about a
  // term this surface is no longer showing.
  test('changing the anchor drops the previous anchor lessons', async () => {
    lessons = [lesson({ title: 'Technique lesson' })];
    const { rerender } = render(<RabbitHole anchor={ANCHOR} />);

    (await screen.findByRole('button')).click();
    expect((await screen.findByTestId('rabbit-hole-lesson')).textContent).toContain('Technique lesson');

    lessons = [];
    rerender(<RabbitHole anchor={{ anchorType: 'gap_type', anchorKey: 'endurance' }} />);

    await waitFor(() => expect(screen.queryByTestId('rabbit-hole')).toBeNull());
    expect(rabbitHoleCalls[1]).toEqual({ anchor_type: 'gap_type', anchor_key: 'endurance' });
  });
});

describe('a lesson a reader can see', () => {
  test('the expander is collapsed by default and opens onto the lesson', async () => {
    lessons = [lesson()];
    render(<RabbitHole anchor={ANCHOR} />);

    const toggle = await screen.findByRole('button');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('rabbit-hole-lesson')).toBeNull();

    toggle.click();

    const article = await screen.findByTestId('rabbit-hole-lesson');
    expect(article.textContent).toContain('Kinetic force transfer');
    expect(article.textContent).toContain('Power does not generate in the shoulders.');
    expect(article.textContent).toContain('Thirty slow crosses');
  });

  test('every lesson says it is gym coaching and names who wrote it', async () => {
    lessons = [lesson()];
    render(<RabbitHole anchor={ANCHOR} />);
    (await screen.findByRole('button')).click();

    const article = await screen.findByTestId('rabbit-hole-lesson');
    expect(article.textContent).toContain('Gym coaching');
    expect(article.textContent).toContain('Coach Jason');
  });

  // The line this component must never cross.
  test('no lesson ever draws a SHADOW evidence tier', async () => {
    lessons = [
      lesson(),
      lesson({
        rabbit_hole_id: 'rh-2',
        title: 'Why the elbow finishes down',
        homework: null,
        citation: { document_id: 'doc-1', document_name: 'Boxing Biomechanics, ch. 4' },
      }),
    ];
    render(<RabbitHole anchor={ANCHOR} />);
    (await screen.findByRole('button')).click();

    await screen.findAllByTestId('rabbit-hole-lesson');
    expect(document.body.textContent).not.toMatch(/PROVEN|EMERGING|EXPERIMENTAL|RESEARCH_NEEDED/);
    expect(document.body.textContent).not.toMatch(/evidence tier/i);
  });

  test('an approved Library document is shown as a citation, and without one nothing is claimed', async () => {
    lessons = [
      lesson({ rabbit_hole_id: 'rh-cited', citation: { document_id: 'doc-1', document_name: 'Boxing Biomechanics, ch. 4' } }),
      lesson({ rabbit_hole_id: 'rh-uncited', title: 'Cites nothing', citation: null }),
    ];
    render(<RabbitHole anchor={ANCHOR} />);
    (await screen.findByRole('button')).click();

    const articles = await screen.findAllByTestId('rabbit-hole-lesson');
    expect(articles[0].textContent).toContain('Library source:');
    expect(articles[0].textContent).toContain('Boxing Biomechanics, ch. 4');
    // No empty citation shell on the one that cites nothing.
    expect(articles[1].textContent).not.toContain('Library source');
  });

  test('a lesson with no homework renders no homework line', async () => {
    lessons = [lesson({ homework: null })];
    render(<RabbitHole anchor={ANCHOR} />);
    (await screen.findByRole('button')).click();

    const article = await screen.findByTestId('rabbit-hole-lesson');
    expect(article.textContent).toContain('Concept:');
    expect(article.textContent).not.toContain('Homework:');
  });

  test('an anchor carries lessons, plural', async () => {
    lessons = [lesson(), lesson({ rabbit_hole_id: 'rh-2', title: 'Why the elbow finishes down' })];
    render(<RabbitHole anchor={ANCHOR} />);

    const toggle = await screen.findByRole('button');
    expect(toggle.textContent).toContain('2 LESSONS');
    toggle.click();
    expect((await screen.findAllByTestId('rabbit-hole-lesson')).length).toBe(2);
  });
});

// This module is client-side and must not pull the database layer into the
// bundle, so the anchor vocabulary is declared on both sides. Declared twice
// means it can drift, which is what this asserts it has not.
test('the client anchor vocabulary is the server anchor vocabulary', () => {
  expect([...RABBIT_HOLE_ANCHOR_TYPES].sort()).toEqual([...SERVER_ANCHOR_TYPES].sort());
});

describe('HelpPanel keeps working without an anchor', () => {
  const HELP = {
    title: 'Rabbit Holes - Deep Learning',
    description: 'Advanced research into biomechanics, neurology, and boxing theory.',
    usage: ['Read concept breakdowns carefully', 'Complete homework to internalize learning'],
    mistakes: ['Reading but not doing homework'],
  };

  // The reason the anchor is optional: roughly fifty existing call sites pass
  // none, and every one of them must behave exactly as it did.
  test('a panel with no anchor renders its help and never reads a rabbit hole', async () => {
    lessons = [lesson()];
    render(<HelpPanel {...HELP} />);

    (await screen.findByRole('button', { name: /HELP:/ })).click();

    expect(await screen.findByText('Advanced research into biomechanics, neurology, and boxing theory.')).toBeTruthy();
    expect(screen.getByText('Reading but not doing homework')).toBeTruthy();
    expect(screen.queryByTestId('rabbit-hole')).toBeNull();
    expect(rabbitHoleCalls).toHaveLength(0);
  });

  test('a closed panel reads nothing, so an unopened panel costs no request', async () => {
    lessons = [lesson()];
    render(<HelpPanel {...HELP} anchor={ANCHOR} />);

    await waitFor(() => expect((global.fetch as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(0));
    expect(rabbitHoleCalls).toHaveLength(0);
  });

  test('an anchored panel renders the matching lessons inside itself', async () => {
    lessons = [lesson()];
    render(<HelpPanel {...HELP} anchor={ANCHOR} />);

    (await screen.findByRole('button', { name: /HELP:/ })).click();

    await waitFor(() => expect(rabbitHoleCalls).toEqual([{ anchor_type: 'gap_type', anchor_key: 'technique' }]));
    const expander = await screen.findByTestId('rabbit-hole');
    expect(expander.textContent).toContain('GO DEEPER');
    // Still collapsed inside the panel: depth is opt-in twice over.
    expect(screen.queryByTestId('rabbit-hole-lesson')).toBeNull();
  });

  test('an anchored panel with no lesson for that anchor renders no expander', async () => {
    lessons = [];
    render(<HelpPanel {...HELP} anchor={ANCHOR} />);

    (await screen.findByRole('button', { name: /HELP:/ })).click();

    await waitFor(() => expect(rabbitHoleCalls).toHaveLength(1));
    expect(screen.queryByTestId('rabbit-hole')).toBeNull();
    // The help itself is unaffected.
    expect(screen.getByText('Reading but not doing homework')).toBeTruthy();
  });
});
