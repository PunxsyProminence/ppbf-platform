/**
 * @jest-environment jsdom
 */

/**
 * My Corner on its own: what it may say about the athlete's day, and what it
 * must never do. It fetches nothing; "checked in" appears only when the session
 * read answered and found an open session; a read in flight or a failed read
 * says so instead of "not checked in"; and Report pain is always there, first,
 * and never waits on anything.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

import AthleteCorner, { type AthleteCornerProps } from './AthleteCorner';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

function props(overrides: Partial<AthleteCornerProps> = {}): AthleteCornerProps {
  return {
    sessionState: 'loaded',
    identityState: 'resolved',
    checkedInAt: null,
    checkingIn: false,
    onCheckIn: jest.fn(),
    onRetrySession: jest.fn(),
    coachWork: { status: 'read', count: 0 },
    onOpenFloor: jest.fn(),
    goals: { status: 'read', count: 1 },
    onOpenGoals: jest.fn(),
    onReportPain: jest.fn(),
    onAskShadow: jest.fn(),
    ...overrides,
  };
}

let fetchSpy: jest.Mock;

beforeEach(() => {
  fetchSpy = jest.fn();
  global.fetch = fetchSpy as unknown as typeof fetch;
});

const checkIn = () => within(document.querySelector('[data-corner-panel="check-in"]') as HTMLElement);

test('renders and every control in it makes no request of its own', () => {
  const p = props();
  render(<AthleteCorner {...p} />);
  for (const button of screen.getAllByRole('button')) fireEvent.click(button);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(p.onCheckIn).toHaveBeenCalledTimes(1);
  expect(p.onReportPain).toHaveBeenCalledTimes(1);
  expect(p.onOpenFloor).toHaveBeenCalledTimes(1);
  expect(p.onOpenGoals).toHaveBeenCalledTimes(1);
  expect(p.onAskShadow).toHaveBeenCalledTimes(1);
});

describe('check-in says only what the session read said', () => {
  test('no open session: not checked in, and Start check-in calls the workspace handler', () => {
    const p = props();
    render(<AthleteCorner {...p} />);
    expect(checkIn().getByText('You have not checked in today.')).toBeTruthy();
    fireEvent.click(checkIn().getByRole('button', { name: 'Start check-in' }));
    expect(p.onCheckIn).toHaveBeenCalledTimes(1);
  });

  test('an open session: checked in, with its time, and no second check-in offered', () => {
    render(<AthleteCorner {...props({ checkedInAt: '4:05 PM' })} />);
    expect(checkIn().getByText('Checked in 4:05 PM.')).toBeTruthy();
    expect(checkIn().queryByRole('button', { name: 'Start check-in' })).toBeNull();
  });

  test('a read still in flight is said as checking -- never as checked in, never as not', () => {
    render(<AthleteCorner {...props({ sessionState: 'loading' })} />);
    const panel = document.querySelector('[data-corner-panel="check-in"]') as HTMLElement;
    expect(panel.textContent).toContain('Checking whether you are checked in...');
    expect(panel.textContent).not.toMatch(/Checked in |not checked in/i);
    expect(checkIn().queryByRole('button', { name: 'Start check-in' })).toBeNull();
  });

  test('a failed read is said as a failure, offers a retry of the same read, and no check-in', () => {
    const p = props({ sessionState: 'unavailable' });
    render(<AthleteCorner {...p} />);
    const panel = document.querySelector('[data-corner-panel="check-in"]') as HTMLElement;
    expect(within(panel).getByRole('alert').textContent).toContain('Could not tell whether you are checked in');
    expect(panel.textContent).not.toMatch(/Checked in |not checked in/i);
    expect(checkIn().queryByRole('button', { name: 'Start check-in' })).toBeNull();
    fireEvent.click(checkIn().getByRole('button', { name: 'Try again' }));
    expect(p.onRetrySession).toHaveBeenCalledTimes(1);
  });

  test('an athlete who is not signed in as one is told so, and offered no check-in', () => {
    render(<AthleteCorner {...props({ identityState: 'unavailable', sessionState: 'loading' })} />);
    expect(checkIn().getByText(/needs an athlete sign-in/)).toBeTruthy();
    expect(checkIn().queryByRole('button', { name: 'Start check-in' })).toBeNull();
  });

  test('a check-in in progress says so and cannot be pressed twice', () => {
    render(<AthleteCorner {...props({ checkingIn: true })} />);
    const button = checkIn().getByRole('button', { name: 'Checking in...' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});

describe('Report pain', () => {
  test('is the first thing in the corner', () => {
    render(<AthleteCorner {...props()} />);
    const first = document.querySelector('.athlete-corner__grid > *') as HTMLElement;
    expect(first.getAttribute('data-corner-panel')).toBe('pain');
  });

  test('is there and pressable while every read is loading or has failed', () => {
    for (const overrides of [
      { sessionState: 'loading', identityState: 'loading', coachWork: { status: 'loading' }, goals: { status: 'loading' } },
      { sessionState: 'unavailable', identityState: 'unavailable', coachWork: { status: 'unavailable' }, goals: { status: 'unavailable' } },
    ] as Array<Partial<AthleteCornerProps>>) {
      const p = props(overrides);
      const { unmount } = render(<AthleteCorner {...p} />);
      const button = screen.getByRole('button', { name: 'Report pain or soreness' }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      fireEvent.click(button);
      expect(p.onReportPain).toHaveBeenCalledTimes(1);
      unmount();
    }
  });
});

describe('counts are only numbers when a read answered', () => {
  test.each([
    [{ status: 'loading' }, 'Checking...'],
    [{ status: 'unavailable' }, 'Not available right now.'],
    [{ status: 'read', count: 0 }, 'No assigned work recorded.'],
    [{ status: 'read', count: 2 }, '2 still to do.'],
  ] as const)('coach work %j reads "%s"', (coachWork, line) => {
    render(<AthleteCorner {...props({ coachWork })} />);
    const panel = document.querySelector('[data-corner-panel="coach-work"]') as HTMLElement;
    expect(panel.textContent).toContain(line);
  });

  test.each([
    [{ status: 'loading' }, 'Checking...'],
    [{ status: 'unavailable' }, 'Not available right now.'],
    [{ status: 'read', count: 0 }, 'No active goals recorded.'],
    [{ status: 'read', count: 3 }, '3 active.'],
  ] as const)('goals %j reads "%s"', (goals, line) => {
    render(<AthleteCorner {...props({ goals })} />);
    const panel = document.querySelector('[data-corner-panel="goals"]') as HTMLElement;
    expect(panel.textContent).toContain(line);
  });
});

test('says nothing about clearance', () => {
  render(<AthleteCorner {...props({ checkedInAt: '4:05 PM' })} />);
  expect(document.body.textContent).not.toMatch(/clear/i);
});
