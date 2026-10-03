/**
 * @jest-environment jsdom
 */

/**
 * The floor view at the top of the coach dashboard: one thing at a time.
 *
 * What is pinned here is what the view must never do, more than how it looks:
 * it never fetches anything, "Next" changes no record, the only write it can
 * reach is the real escalation acknowledge it is handed, and a feed that failed
 * or is still loading is never read out as "nothing needs you".
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

import CoachFloorFocus, { type CoachFloorFocusProps, type FocusFeed, type FocusItem } from './CoachFloorFocus';

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
    badge: { tone: 'locked', label: 'high' },
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

function props(overrides: Partial<CoachFloorFocusProps> = {}): CoachFloorFocusProps {
  return {
    athletes: [
      { id: 'ath_1', name: 'Ada Rivera', readiness: 'GREEN' },
      { id: 'ath_2', name: 'Marcus Bell', readiness: 'UNKNOWN' },
    ],
    athletesState: 'loaded',
    athletesError: null,
    onSelectAthlete: jest.fn(),
    items: [escalation(), PAIN],
    feeds: LOADED,
    sessionStatus: 'No session in progress. Session Scripts is where a live delivery starts.',
    sessionState: 'loaded',
    sessionLive: false,
    sessionMode: 'Group',
    onSessionMode: jest.fn(),
    everythingElseHref: '#coach-dashboard-details',
    ...overrides,
  };
}

let fetchSpy: jest.Mock;

beforeEach(() => {
  fetchSpy = jest.fn();
  global.fetch = fetchSpy as unknown as typeof fetch;
});

test('shows one thing at a time, and Next moves to the next without fetching or writing anything', () => {
  render(<CoachFloorFocus {...props()} />);

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

test('the only write it can reach is the acknowledge it is handed, and only for an escalation', () => {
  const onAcknowledge = jest.fn();
  render(<CoachFloorFocus {...props({ items: [escalation(onAcknowledge), PAIN] })} />);

  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
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
  render(<CoachFloorFocus {...props({ items: [] })} />);
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
  render(<CoachFloorFocus {...props({ items: [], feeds })} />);

  expect(screen.queryByRole('heading', { name: 'Nothing needs you right now' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'Pain reports could not be read' })).toBeTruthy();
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
  render(<CoachFloorFocus {...props({ items: [], feeds })} />);
  expect(screen.queryByRole('heading', { name: 'Nothing needs you right now' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'Checking safety escalations...' })).toBeTruthy();
});

test('readiness is shown in words, and an athlete with no reading is never shown as fine', () => {
  render(<CoachFloorFocus {...props()} />);
  expect(screen.getByRole('button', { name: 'Ada Rivera: readiness Ready' })).toBeTruthy();
  const unknown = screen.getByRole('button', { name: 'Marcus Bell: readiness No reading' });
  expect(unknown.textContent).toContain('No reading');
  expect(unknown.textContent).not.toMatch(/ready|clear/i);
});

test('choosing an athlete only hands the id back; the view reads nothing about them', () => {
  const onSelectAthlete = jest.fn();
  render(<CoachFloorFocus {...props({ onSelectAthlete })} />);
  fireEvent.click(screen.getByRole('button', { name: 'Ada Rivera: readiness Ready' }));
  expect(onSelectAthlete).toHaveBeenCalledWith('ath_1');
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('a roster that failed to load says so instead of showing an empty floor', () => {
  render(<CoachFloorFocus {...props({ athletes: [], athletesState: 'error', athletesError: 'Roster read failed.' })} />);
  expect(screen.getByText(/Roster read failed\./)).toBeTruthy();
  expect(screen.queryByText('No athletes are assigned to you.')).toBeNull();
});

test('starting a session goes to Session Scripts, and a running one says so', () => {
  const { rerender } = render(<CoachFloorFocus {...props()} />);
  expect(screen.getByRole('link', { name: 'Start a session' }).getAttribute('href')).toBe('/coach/session-scripts');
  rerender(<CoachFloorFocus {...props({ sessionLive: true })} />);
  expect(screen.getByRole('link', { name: 'Return to live delivery' }).getAttribute('href')).toBe('/coach/session-scripts');
});

test('session mode is a real toggle with its state announced', () => {
  const onSessionMode = jest.fn();
  render(<CoachFloorFocus {...props({ onSessionMode })} />);
  expect(screen.getByRole('button', { name: 'Group' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'One-on-One' }));
  expect(onSessionMode).toHaveBeenCalledWith('One-on-One');
});

test('everything else on the dashboard stays one tap away', () => {
  render(<CoachFloorFocus {...props()} />);
  expect(screen.getByRole('link', { name: /Everything else on the dashboard/ }).getAttribute('href')).toBe('#coach-dashboard-details');
});

/* THE GAUGES. Each is a count the workspace already holds; one that was not
   read is "?" with the reason, never 0. */
function gauge(label: string) {
  const glance = within(screen.getByLabelText('Today at a glance'));
  return glance.getByText(label).closest('.coach-floor-focus__gauge') as HTMLElement;
}

test('the gauges show the counts the board was handed', () => {
  render(<CoachFloorFocus {...props()} />);
  expect(gauge('Athletes').textContent).toContain('2');
  expect(gauge('Needs you').textContent).toContain('2');
  expect(gauge('Needs you').getAttribute('data-gauge-state')).toBe('alert');
  // One GREEN, one UNKNOWN: one reading, out of two.
  expect(gauge('Readings').textContent).toContain('1 of 2');
  expect(gauge('Session').textContent).toContain('None');
});

test('a failed feed makes the needs-you gauge "?", never 0', () => {
  const feeds: FocusFeed[] = [
    { name: 'Safety escalations', state: 'error', error: 'boom' },
    { name: 'Pain reports', state: 'loaded' },
    { name: 'Family barrier reports', state: 'loaded' },
  ];
  render(<CoachFloorFocus {...props({ items: [], feeds })} />);
  const needs = gauge('Needs you');
  expect(needs.querySelector('.coach-floor-focus__gauge-value')?.textContent).toBe('?');
  expect(needs.textContent).toContain('A read failed');
  expect(needs.textContent).not.toMatch(/0/);
});

test('a feed still loading makes the needs-you gauge a wait, never 0', () => {
  const feeds: FocusFeed[] = [
    { name: 'Safety escalations', state: 'loaded' },
    { name: 'Pain reports', state: 'loading' },
    { name: 'Family barrier reports', state: 'loaded' },
  ];
  render(<CoachFloorFocus {...props({ items: [], feeds })} />);
  expect(gauge('Needs you').querySelector('.coach-floor-focus__gauge-value')?.textContent).toBe('…');
});

test('a live-run read that failed is never shown as "no session"', () => {
  render(<CoachFloorFocus {...props({ sessionState: 'error' })} />);
  expect(gauge('Session').textContent).toContain('?');
  expect(gauge('Session').textContent).not.toContain('None');
  expect(screen.queryByRole('link', { name: 'Start a session' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Open Session Scripts' }).getAttribute('href')).toBe('/coach/session-scripts');
});

test('a roster that was not read leaves the athlete and readings gauges unknown', () => {
  render(<CoachFloorFocus {...props({ athletes: [], athletesState: 'error', athletesError: 'Roster read failed.' })} />);
  expect(gauge('Athletes').textContent).toContain('?');
  expect(gauge('Readings').textContent).toContain('?');
  expect(gauge('Readings').querySelector('.coach-floor-focus__dial')).toBeNull();
});
