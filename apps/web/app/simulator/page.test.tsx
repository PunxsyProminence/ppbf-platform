/**
 * @jest-environment jsdom
 */

// This page used to print seven hard-coded physiological predictions as fact
// -- "Short-term adaptation spike with increased fatigue checkpoints." -- with
// no athlete, no source and no computation, then grade each one on the SAFETY
// ladder, up to and including badge--locked (#A81E22), the same red the clinic
// uses for a real medical hold.
//
// It reads nothing and computes nothing, which is exactly why these tests are
// about what it must NOT say. Every assertion below fails if the invented
// content comes back.

import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

import ScenarioSimulatorPage from './page';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

jest.mock('@/components/ShadowChatButton', () => ({
  __esModule: true,
  default: () => <button type="button">open shadow chat</button>,
}));

function renderPage() {
  const { container } = render(<ScenarioSimulatorPage />);
  return container;
}

test('states that nothing here is read, run or recorded', () => {
  renderPage();

  expect(screen.getByText(/reads no record, runs no model, and writes nothing/i)).toBeTruthy();
  expect(screen.getByText('Not Built')).toBeTruthy();
});

test('predicts no outcome for anything', () => {
  const container = renderPage();

  // The exact sentences that shipped, plus the label that framed them.
  expect(container.textContent).not.toMatch(/Short-term adaptation spike/);
  expect(container.textContent).not.toMatch(/Higher cardio gains/);
  expect(container.textContent).not.toMatch(/Reduced soreness carryover/);
  expect(container.textContent).not.toMatch(/Expected Outcome/i);
  // No claim about an athlete's current state either -- "Readiness trend
  // stable at baseline tolerance" is a measurement nothing took.
  expect(container.textContent).not.toMatch(/Readiness trend stable/);
  expect(container.textContent).not.toMatch(/Current State/i);
  expect(container.textContent).not.toMatch(/Proposed Change/i);
});

test('grades no risk, and puts nothing on the safety ladder', () => {
  const container = renderPage();

  expect(container.textContent).not.toMatch(/Low Risk|Moderate Risk|High Risk/);
  // Law 2: the four saturated rungs are for a safety state or a queue outcome.
  // An invented grade is neither, and badge--locked is a medical hold.
  expect(container.querySelectorAll('.badge--locked')).toHaveLength(0);
  expect(container.querySelectorAll('.badge--restricted')).toHaveLength(0);
  expect(container.querySelectorAll('.badge--cleared')).toHaveLength(0);
  expect(container.querySelectorAll('.badge--monitor')).toHaveLength(0);
  // The administrative rung is the one that fits: nothing has evaluated these.
  expect(container.querySelectorAll('.badge--filed').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Not Evaluated').length).toBe(7);
});

test('claims no validation, no evaluation, and no hand-off', () => {
  const container = renderPage();

  expect(container.textContent).not.toMatch(/Validated scenarios feed into/);
  expect(container.textContent).not.toMatch(/evaluate expected outcomes/);
  expect(container.textContent).not.toMatch(/Safe Validation/);
  expect(screen.getByText(/Nothing is validated here and nothing is handed on/i)).toBeTruthy();
});

test('keeps the scope list, which is the one thing here that was ever true', () => {
  renderPage();

  for (const title of [
    'Athlete Readiness', 'Training Load', 'Recovery Changes', 'Track Changes',
    'Capability Changes', 'Workflow Changes', 'Program Changes',
  ]) {
    expect(screen.getByText(title)).toBeTruthy();
  }
});

test('stands in the file room, not on bare ink', () => {
  const container = renderPage();

  const main = container.querySelector('main');
  expect(main?.className).toContain('room--file');
});
