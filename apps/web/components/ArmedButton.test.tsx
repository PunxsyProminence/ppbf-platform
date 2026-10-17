/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';

import ArmedButton, { ARM_SETTLE_MS, ARM_TIMEOUT_MS } from './ArmedButton';

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-10-17T16:00:00Z') });
});
afterEach(() => {
  jest.useRealTimers();
});

function wait(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

function renderArmed(props: Partial<Parameters<typeof ArmedButton>[0]> = {}) {
  const onConfirm = jest.fn();
  const view = render(
    <ArmedButton armedLabel="Press again: lift Ada's hold" onConfirm={onConfirm} {...props}>
      Lift this hold
    </ArmedButton>,
  );
  return { onConfirm, ...view };
}

test('the first press only arms it and says what the next press does', () => {
  const { onConfirm } = renderArmed();
  fireEvent.click(screen.getByRole('button', { name: 'Lift this hold' }));
  expect(onConfirm).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: "Press again: lift Ada's hold" })).toBeInTheDocument();
});

test('a second press after the settle time does it, once', () => {
  const { onConfirm } = renderArmed();
  fireEvent.click(screen.getByRole('button', { name: 'Lift this hold' }));
  wait(ARM_SETTLE_MS);
  fireEvent.click(screen.getByRole('button', { name: "Press again: lift Ada's hold" }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Lift this hold' })).toBeInTheDocument();
});

test('a fast double tap only arms it (UXB-01)', () => {
  const { onConfirm } = renderArmed();
  const button = screen.getByRole('button');
  fireEvent.click(button);
  wait(ARM_SETTLE_MS - 100);
  fireEvent.click(button);
  expect(onConfirm).not.toHaveBeenCalled();
  // Still armed: a deliberate press after the settle time goes through.
  wait(200);
  fireEvent.click(button);
  expect(onConfirm).toHaveBeenCalledTimes(1);
});

test('it disarms on its own after the timeout', () => {
  const { onConfirm } = renderArmed();
  fireEvent.click(screen.getByRole('button'));
  wait(ARM_TIMEOUT_MS);
  expect(screen.getByRole('button', { name: 'Lift this hold' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button'));
  expect(onConfirm).not.toHaveBeenCalled();
});

test('it disarms on blur', () => {
  const { onConfirm } = renderArmed();
  const button = screen.getByRole('button');
  fireEvent.click(button);
  fireEvent.blur(button);
  wait(ARM_SETTLE_MS);
  fireEvent.click(button);
  expect(onConfirm).not.toHaveBeenCalled();
});

test('it disarms when what it acts on changes, and does not come back armed', () => {
  const onConfirm = jest.fn();
  const { rerender } = render(
    <ArmedButton armKey="ath-1:cleared" armedLabel="Press again" onConfirm={onConfirm}>Set Status</ArmedButton>,
  );
  fireEvent.click(screen.getByRole('button'));
  rerender(<ArmedButton armKey="ath-1:pending" armedLabel="Press again" onConfirm={onConfirm}>Set Status</ArmedButton>);
  expect(screen.getByRole('button', { name: 'Set Status' })).toBeInTheDocument();
  rerender(<ArmedButton armKey="ath-1:cleared" armedLabel="Press again" onConfirm={onConfirm}>Set Status</ArmedButton>);
  expect(screen.getByRole('button', { name: 'Set Status' })).toBeInTheDocument();
  wait(ARM_SETTLE_MS);
  fireEvent.click(screen.getByRole('button'));
  expect(onConfirm).not.toHaveBeenCalled();
});

test('while busy it is locked and shows the busy words', () => {
  const { onConfirm } = renderArmed({ busy: true, busyLabel: 'Lifting…' });
  const button = screen.getByRole('button', { name: 'Lifting…' });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  wait(ARM_SETTLE_MS);
  fireEvent.click(button);
  expect(onConfirm).not.toHaveBeenCalled();
});

test('it is never a submit button, so Enter in a form cannot send past the second press', () => {
  const onSubmit = jest.fn((event: { preventDefault: () => void }) => event.preventDefault());
  render(
    <form onSubmit={onSubmit}>
      <ArmedButton armedLabel="Press again" onConfirm={jest.fn()}>Set Status</ArmedButton>
    </form>,
  );
  expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
});
