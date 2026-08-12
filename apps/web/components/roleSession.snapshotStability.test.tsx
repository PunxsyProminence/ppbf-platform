/**
 * @jest-environment jsdom
 */

// Regression test for a real production incident: signing in crashed the
// whole page with React's "Maximum update depth exceeded" / "The result of
// getSnapshot should be cached to avoid an infinite loop." Signing in calls
// createPersistentRoleSession, whose change notification forces every
// useSyncExternalStore subscriber (GlobalRoleHeader) to re-check its
// snapshot -- and getRoleSessionSnapshot used to allocate a brand new object
// on every single call, so the check never concluded "unchanged", however
// nothing about the session had actually changed.
//
// This exercises the REAL module (not a mock) through the same hook React
// itself uses, so it fails the way the incident did rather than passing on
// an abstraction that hides the problem.

import { useSyncExternalStore } from 'react';
import { act, render, screen } from '@testing-library/react';

import {
  clearRoleSession,
  createPersistentRoleSession,
  getRoleSessionSnapshot,
  subscribeRoleSession,
} from './roleSession';

function Probe() {
  const session = useSyncExternalStore(subscribeRoleSession, getRoleSessionSnapshot, () => null);
  return <div data-testid="role">{session ? session.role : 'none'}</div>;
}

afterEach(() => {
  clearRoleSession();
});

it('returns the same reference across repeated calls when nothing changed', () => {
  createPersistentRoleSession('athlete');

  const first = getRoleSessionSnapshot();
  const second = getRoleSessionSnapshot();
  const third = getRoleSessionSnapshot();

  expect(first).toBe(second);
  expect(second).toBe(third);
});

it('a new session produces a new reference, but repeated reads of it stay stable', () => {
  createPersistentRoleSession('athlete');
  const beforeCoach = getRoleSessionSnapshot();

  createPersistentRoleSession('coach');
  const afterCoach1 = getRoleSessionSnapshot();
  const afterCoach2 = getRoleSessionSnapshot();

  expect(afterCoach1).not.toBe(beforeCoach);
  expect(afterCoach1).toBe(afterCoach2);
});

it('signing in does not crash a useSyncExternalStore subscriber (the actual incident)', () => {
  const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  render(<Probe />);
  expect(screen.getByTestId('role').textContent).toBe('none');

  // The exact trigger: createPersistentRoleSession's own change
  // notification, synchronously re-checking every subscriber's snapshot.
  act(() => {
    createPersistentRoleSession('athlete');
  });

  expect(screen.getByTestId('role').textContent).toBe('athlete');

  const loggedInfiniteLoop = consoleErrorSpy.mock.calls.some((call) =>
    call.some((arg) => typeof arg === 'string' && /getSnapshot should be cached|Maximum update depth/i.test(arg)),
  );
  expect(loggedInfiniteLoop).toBe(false);

  consoleErrorSpy.mockRestore();
});
