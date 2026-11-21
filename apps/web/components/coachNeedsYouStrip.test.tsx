/**
 * @jest-environment jsdom
 */

/**
 * NEEDS YOU NOW, THE COACH HOME'S STRIP (lane 6C7, AS-7 step 7b).
 *
 * The pager tests below MOVED here from coachFloorFocus.test.tsx with the card
 * they pin (stage 2 section 3.4 row 11, "Kept, widened"; Q6 = A). Each keeps its
 * assertions; only the component rendered changed. What is pinned is what the
 * strip must never do: it fetches nothing, "Next" changes no record, the only
 * write it can reach is the escalation acknowledge it is handed, and a feed that
 * failed or is still loading is never read out as "nothing needs you".
 *
 * New in 7b: the counts. A count whose read failed shows "?" and "not checked",
 * one still loading shows "…", a list that returned fewer than matched shows
 * "n+", and none of them is ever 0 unless the read answered 0. No mark on the
 * strip is the medical stop (--locked).
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { armOnly, pressArmed } from '@/src/testing/pressArmed';
import React from 'react';

import CoachNeedsYouStrip, { type CoachNeedsYouStripProps, type NeedsYouCount } from './CoachNeedsYouStrip';
import type { FocusFeed, FocusItem } from './CoachFloorFocus';
import { takeArrivalAthlete } from './decisionLoopArrival';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

const LOADED: FocusFeed[] = [
  { name: 'Safety escalations', state: 'loaded' },
  { name: 'Pain reports', state: 'loaded' },
  { name: 'Family barrier reports', state: 'loaded' },
];

function escalation(onAcknowledge = jest.fn()): FocusItem {
  return {
    id: 'escalation:e1',
    kind: 'Safety escalation',
    urgent: true,
    title: 'Ada Rivera',
    meta: 'Near miss · Oct 2',
    badge: { tone: 'restricted', label: 'high' },
    details: [],
    body: 'Took a hard shot and kept going.',
    acknowledge: { busy: false, disabled: false, onAcknowledge },
  };
}

const PAIN: FocusItem = {
  id: 'pain:p1',
  kind: 'Pain report',
  urgent: true,
  title: 'Marcus Bell',
  meta: 'Athlete ID ath_2 · recorded Oct 2',
  badge: { tone: 'restricted', label: 'moderate - 5/10' },
  details: [{ label: 'Body location', value: 'Left shoulder' }],
  link: { href: '/coach/decision-loop', label: 'Record what you did' },
};

function count(overrides: Partial<NeedsYouCount> & Pick<NeedsYouCount, 'key' | 'label'>): NeedsYouCount {
  return { state: 'loaded', count: 0, href: '#x', safety: false, inPager: true, ...overrides };
}

const COUNTS: NeedsYouCount[] = [
  count({ key: 'escalations', label: 'Safety escalations', count: 1, href: '#coach-safety-escalations', safety: true }),
  count({ key: 'pain', label: 'Pain reports', count: 1, href: '#coach-dashboard-details', safety: true }),
  count({ key: 'barrier', label: 'Family barrier reports', count: 0, href: '#coach-barrier-reports' }),
  count({ key: 'cards', label: 'Cards to verify', count: 0, href: '/coach/cards', inPager: false }),
];

function props(overrides: Partial<CoachNeedsYouStripProps> = {}): CoachNeedsYouStripProps {
  return { counts: COUNTS, items: [escalation(), PAIN], feeds: LOADED, ...overrides };
}

const strip = () => screen.getByRole('region', { name: /^Needs you now/ });
const countLink = (key: string) => strip().querySelector(`[data-needs-count="${key}"]`) as HTMLElement;
const countValue = (key: string) => countLink(key).querySelector('[data-needs-count-value]')?.textContent;

let fetchSpy: jest.Mock;

beforeEach(() => {
  fetchSpy = jest.fn();
  global.fetch = fetchSpy as unknown as typeof fetch;
});

describe('the counts (new in 7b)', () => {
  test('one count per list, each opening the list that holds it, cards to verify opening Cards (CF-12)', () => {
    render(<CoachNeedsYouStrip {...props()} />);
    const links = within(screen.getByRole('list', { name: 'What is waiting' })).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '#coach-safety-escalations', '#coach-dashboard-details', '#coach-barrier-reports', '/coach/cards',
    ]);
    expect(countValue('escalations')).toBe('1');
    expect(countLink('escalations').textContent).toContain('waiting');
    expect(countValue('cards')).toBe('0');
    expect(countLink('cards').textContent).toContain('Cards to verify');
    expect(countLink('cards').textContent).toContain('none');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a failed or refused read is "?" and "not checked", never 0', () => {
    render(<CoachNeedsYouStrip {...props({
      counts: [
        count({ key: 'escalations', label: 'Safety escalations', state: 'error', safety: true }),
        count({ key: 'cards', label: 'Cards to verify', state: 'error', inPager: false }),
      ],
    })} />);
    for (const key of ['escalations', 'cards']) {
      expect(countValue(key)).toBe('?');
      expect(countLink(key).textContent).toContain('not checked');
      expect(countLink(key).textContent).not.toMatch(/\b0\b/);
    }
  });

  test('a read still loading is a wait, never 0', () => {
    render(<CoachNeedsYouStrip {...props({ counts: [count({ key: 'pain', label: 'Pain reports', state: 'loading', safety: true })] })} />);
    expect(countValue('pain')).toBe('…');
    expect(countLink('pain').textContent).toContain('checking');
  });

  test('a list that returned fewer than matched makes its count a floor', () => {
    render(<CoachNeedsYouStrip {...props({ counts: [count({ key: 'pain', label: 'Pain reports', count: 3, floor: true, safety: true })] })} />);
    expect(countValue('pain')).toBe('3+');
  });

  test('a safety count that is waiting or unread carries the restricted glyph and a word; none is the medical stop', () => {
    const { container } = render(<CoachNeedsYouStrip {...props({
      counts: [
        count({ key: 'escalations', label: 'Safety escalations', count: 2, safety: true }),
        count({ key: 'pain', label: 'Pain reports', state: 'error', safety: true }),
        count({ key: 'barrier', label: 'Family barrier reports', count: 0 }),
      ],
    })} />);
    expect(countLink('escalations').textContent).toContain('▲');
    expect(countLink('escalations').textContent).toContain('waiting');
    expect(countLink('pain').textContent).toContain('▲');
    expect(countLink('barrier').textContent).not.toContain('▲');
    // --locked means a medical stop and nothing else (OD-2026-09-29-001).
    expect(container.innerHTML).not.toMatch(/locked/);
  });

  test('cards waiting to be verified keep the all-clear from saying nothing needs you', () => {
    render(<CoachNeedsYouStrip {...props({
      items: [],
      counts: [count({ key: 'cards', label: 'Cards to verify', count: 2, inPager: false })],
    })} />);
    expect(screen.queryByRole('heading', { name: 'Nothing needs you right now' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'No report needs you right now' })).toBeTruthy();
  });

  test('cards to verify that could not be read keep it from saying nothing needs you too', () => {
    render(<CoachNeedsYouStrip {...props({
      items: [],
      counts: [count({ key: 'cards', label: 'Cards to verify', state: 'error', inPager: false })],
    })} />);
    expect(screen.queryByRole('heading', { name: 'Nothing needs you right now' })).toBeNull();
  });
});

/* DESIGN REVIEW OF 7b. The strip sits outside the board, so the board's
   high-contrast focus rule does not reach it; each control carries the same 3px
   bone outline itself (a browser render on the dev server measured it). Only
   the position line is a polite live region; the counts and lists are not
   re-read on every read that lands. */
describe('focus and announcements', () => {
  // Width, style, colour and offset: without the width the unlayered `.btn:focus-visible { outline: 0 }`
  // leaves only the faint app-wide ring (design re-review of 7b).
  const FOCUS_CLASSES = [
    'focus-visible:outline-3!',
    'focus-visible:outline-solid!',
    'focus-visible:outline-[var(--bone-100)]!',
    'focus-visible:outline-offset-2!',
  ];
  const hasRing = (element: HTMLElement) => FOCUS_CLASSES.every((cls) => element.className.split(/\s+/).includes(cls));

  test('every control on the strip carries the bone focus outline', () => {
    render(<CoachNeedsYouStrip {...props()} />);
    const controls = [
      ...within(strip()).getAllByRole('link'),
      ...within(strip()).getAllByRole('button'),
    ];
    expect(controls.length).toBeGreaterThan(5);
    for (const control of controls) {
      expect(hasRing(control)).toBe(true);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(hasRing(screen.getByRole('button', { name: 'Acknowledge' }))).toBe(true);
  });

  test('the strip is not one live region; the position line, the button row and the acknowledge status are', () => {
    render(<CoachNeedsYouStrip {...props()} />);
    expect(strip().getAttribute('aria-live')).toBeNull();
    expect(screen.getByRole('heading', { level: 2 }).getAttribute('aria-live')).toBe('polite');
    // The armed Acknowledge changes its words ("Press again: ..."): the row it sits in is polite.
    expect(screen.getByRole('button', { name: 'Open' }).closest('[aria-live="polite"]')).not.toBeNull();
    // The acknowledge notice is mounted before anything is acknowledged, so its words arrive into it.
    const status = strip().querySelector('[data-needs-ack-status]') as HTMLElement;
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toBe('');
    // Out of the panel's flow while empty: the board panel's `> * { position: relative }` would keep it in.
    expect(status.className.split(/\s+/)).toEqual(expect.arrayContaining(['sr-only', 'absolute!']));
  });

  test('the armed Acknowledge sits in the polite row, and the notice lands in the same mounted status line', () => {
    const first = { ...escalation(), id: 'escalation:e1', title: 'Ada Rivera' };
    const second = { ...escalation(), id: 'escalation:e2', title: 'Marcus Bell' };
    const { rerender } = render(<CoachNeedsYouStrip {...props({ items: [first, second] })} />);
    const status = strip().querySelector('[data-needs-ack-status]') as HTMLElement;

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    armOnly(screen.getByRole('button', { name: 'Acknowledge' }));
    const armed = screen.getByRole('button', { name: 'Press again: acknowledge Ada Rivera' });
    expect(armed.closest('[aria-live="polite"]')).not.toBeNull();
    pressArmed(armed);

    rerender(<CoachNeedsYouStrip {...props({ items: [second] })} />);
    expect(strip().querySelector('[data-needs-ack-status]')).toBe(status);
    expect(status.textContent).toContain('Acknowledged: Ada Rivera');
  });
});

describe('the pager (moved from the floor board with its card)', () => {
  test('shows one thing at a time, and Next moves to the next without fetching or writing anything', () => {
    render(<CoachNeedsYouStrip {...props()} />);

    expect(screen.getByText('Needs you now · 1 of 2')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Ada Rivera' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Marcus Bell' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
    expect(screen.getByText('Needs you now · 2 of 2')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Marcus Bell' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
    expect(screen.getByText('Needs you now · 1 of 2')).toBeTruthy();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a double tap on Open does not acknowledge: the tap that lands on Acknowledge does not even arm it (UXB-01)', () => {
    const onAcknowledge = jest.fn();
    render(<CoachNeedsYouStrip {...props({ items: [escalation(onAcknowledge)] })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));

    expect(onAcknowledge).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeTruthy();
    expect(screen.getByText('Took a hard shot and kept going.')).toBeTruthy();
  });

  test('a deliberate press arms Acknowledge and names who; only the next press acknowledges', () => {
    const onAcknowledge = jest.fn();
    render(<CoachNeedsYouStrip {...props({ items: [escalation(onAcknowledge)] })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    armOnly(screen.getByRole('button', { name: 'Acknowledge' }));
    expect(onAcknowledge).not.toHaveBeenCalled();
    pressArmed(screen.getByRole('button', { name: 'Press again: acknowledge Ada Rivera' }));
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
  });

  test('the only write it can reach is the acknowledge it is handed, and only for an escalation', () => {
    const onAcknowledge = jest.fn();
    render(<CoachNeedsYouStrip {...props({ items: [escalation(onAcknowledge), PAIN] })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    pressArmed(screen.getByRole('button', { name: 'Acknowledge' }));
    expect(onAcknowledge).toHaveBeenCalledTimes(1);

    // A pain report has no acknowledge on the backend, so the view offers none.
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Record what you did' }).getAttribute('href')).toBe('/coach/decision-loop');
    expect(screen.getByText('Left shoulder')).toBeTruthy();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('says nothing needs you only when every feed answered and none had anything', () => {
    render(<CoachNeedsYouStrip {...props({ items: [] })} />);
    expect(screen.getByRole('heading', { name: 'Nothing needs you right now' })).toBeTruthy();
    expect(screen.getByText(/not that everyone is fine/)).toBeTruthy();
  });

  test('a failed read is put first and is never read out as "nothing needs you"', () => {
    const onRetry = jest.fn();
    const feeds: FocusFeed[] = [
      { name: 'Safety escalations', state: 'loaded' },
      {
        name: 'Pain reports',
        state: 'error',
        error: 'Pain reports could not be loaded.',
        failureMeaning: 'Do not read this as "no athlete reported pain".',
        onRetry,
      },
      { name: 'Family barrier reports', state: 'loaded' },
    ];
    render(<CoachNeedsYouStrip {...props({ items: [], feeds })} />);

    expect(screen.queryByRole('heading', { name: 'Nothing needs you right now' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Could not be read' })).toBeTruthy();
    expect(screen.getAllByText('Pain reports').length).toBeGreaterThan(0);
    expect(screen.getByRole('alert').textContent).toContain('Do not read this as "no athlete reported pain".');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('a feed still loading is never read out as "nothing needs you" either', () => {
    const feeds: FocusFeed[] = [
      { name: 'Safety escalations', state: 'loading' },
      { name: 'Pain reports', state: 'loaded' },
      { name: 'Family barrier reports', state: 'loaded' },
    ];
    render(<CoachNeedsYouStrip {...props({ items: [], feeds })} />);
    expect(screen.queryByRole('heading', { name: 'Nothing needs you right now' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Still checking' })).toBeTruthy();
    expect(screen.getAllByText('Safety escalations').length).toBeGreaterThan(0);
  });

  /* CS-04 (lane U1). The Morning Read has no pain-report or family-barrier read,
     so the link does not call it the full list. */
  test('the Morning Read link does not claim to be the full list', () => {
    render(<CoachNeedsYouStrip {...props()} />);
    expect(screen.queryByText(/Full list/)).toBeNull();
    expect(screen.getByRole('link', { name: 'More reads: The Morning Read' }).getAttribute('href')).toBe('/coach/intelligence');
  });

  test('the all-clear line names the pain window it read', () => {
    render(<CoachNeedsYouStrip {...props({ items: [], painWindowDays: 7 })} />);
    expect(screen.getByText(/No pain report in the last 7 days/)).toBeTruthy();
  });

  test('a truncated feed says so under the pager', () => {
    const feeds: FocusFeed[] = [
      { name: 'Safety escalations', state: 'loaded' },
      { name: 'Pain reports', state: 'loaded', truncatedNote: 'More pain reports matched than are listed.' },
      { name: 'Family barrier reports', state: 'loaded' },
    ];
    render(<CoachNeedsYouStrip {...props({ feeds })} />);
    expect(screen.getByText('More pain reports matched than are listed.')).toBeTruthy();
  });

  test('no heading in the pager carries a feed panel\'s name', () => {
    const feeds: FocusFeed[] = [
      { name: 'Safety escalations', state: 'loading' },
      { name: 'Pain reports', state: 'error', error: 'boom' },
      { name: 'Family barrier reports', state: 'loaded' },
    ];
    render(<CoachNeedsYouStrip {...props({ feeds })} />);
    for (const heading of screen.getAllByRole('heading')) {
      expect(heading.textContent ?? '').not.toMatch(/safety escalations|pain reports|barrier reports/i);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
    for (const heading of screen.getAllByRole('heading')) {
      expect(heading.textContent ?? '').not.toMatch(/safety escalations|pain reports|barrier reports/i);
    }
  });
});

/* THE VIEW FOLLOWS AN ITEM, NOT A POSITION (review finding, 2026-10-03; moved with the card). */
function escalationFor(id: string, title: string, onAcknowledge = jest.fn()): FocusItem {
  return { ...escalation(onAcknowledge), id: `escalation:${id}`, title };
}

test('after an acknowledge, the next child\'s escalation arrives closed, and the coach is told it landed', () => {
  const first = escalationFor('e1', 'Ada Rivera');
  const second = escalationFor('e2', 'Marcus Bell');
  const { rerender } = render(<CoachNeedsYouStrip {...props({ items: [first, second] })} />);

  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  pressArmed(screen.getByRole('button', { name: 'Acknowledge' }));
  expect(first.acknowledge?.onAcknowledge).toHaveBeenCalledTimes(1);

  // The workspace drops the acknowledged escalation from the queue.
  rerender(<CoachNeedsYouStrip {...props({ items: [second] })} />);

  expect(screen.getByRole('heading', { name: 'Marcus Bell' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
  expect(screen.getByText(/Acknowledged: Ada Rivera/)).toBeTruthy();
  expect(second.acknowledge?.onAcknowledge).not.toHaveBeenCalled();
});

test('a feed going back to loading does not move the coach onto a different child\'s item', () => {
  const { rerender } = render(<CoachNeedsYouStrip {...props()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  expect(screen.getByRole('heading', { name: 'Marcus Bell' })).toBeTruthy();

  const feeds: FocusFeed[] = [
    { name: 'Safety escalations', state: 'loading' },
    { name: 'Pain reports', state: 'loaded' },
    { name: 'Family barrier reports', state: 'loaded' },
  ];
  rerender(<CoachNeedsYouStrip {...props({ feeds })} />);

  expect(screen.getByRole('heading', { name: 'Marcus Bell' })).toBeTruthy();
  expect(screen.getByText('Needs you now · 3 of 3')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Record what you did' })).toBeTruthy();
});

// #1474 item 5: "Record what you did" opens the Decision Loop on the athlete
// the report is about. The athlete is handed over in page memory; the address
// stays /coach/decision-loop with no athlete in it (Overwatch, #1474 Q2 = C).
describe('"Record what you did" hands its athlete to the Decision Loop', () => {
  const PAIN_FOR_ATH_2: FocusItem = { ...PAIN, link: { href: '/coach/decision-loop', label: 'Record what you did', athleteId: 'ath_2' } };

  afterEach(() => {
    takeArrivalAthlete();
  });

  function openLink(item: FocusItem): HTMLElement {
    render(<CoachNeedsYouStrip {...props({ items: [item] })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    return screen.getByRole('link', { name: 'Record what you did' });
  }

  test('a plain click hands over the athlete, and the address carries none', () => {
    const link = openLink(PAIN_FOR_ATH_2);
    expect(link.getAttribute('href')).toBe('/coach/decision-loop');
    expect(takeArrivalAthlete()).toBeNull();

    fireEvent.click(link);
    expect(takeArrivalAthlete()).toBe('ath_2');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test.each([
    ['ctrl', { ctrlKey: true }],
    ['cmd', { metaKey: true }],
    ['shift', { shiftKey: true }],
    ['alt', { altKey: true }],
    ['middle button', { button: 1 }],
  ])('a %s click, which opens another tab, hands nothing over', (_name, init) => {
    fireEvent.click(openLink(PAIN_FOR_ATH_2), init);
    expect(takeArrivalAthlete()).toBeNull();
  });

  test('a link with no athlete on it hands nothing over', () => {
    fireEvent.click(openLink(PAIN));
    expect(takeArrivalAthlete()).toBeNull();
  });
});
