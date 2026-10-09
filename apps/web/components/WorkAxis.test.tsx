/**
 * @jest-environment jsdom
 */

import { render, screen } from '@testing-library/react';

import WorkAxis from './WorkAxis';

test('carries the four words, in order', () => {
  render(<WorkAxis />);

  const steps = screen.getAllByRole('listitem').map((item) => item.textContent?.trim());

  expect(steps).toEqual(['Observe.', '→Decide.', '→Execute.', '→Repeat.']);
});

/* One approved board tints DECIDE. Marking a step would be a claim about
   where somebody is in their day, and nothing here knows that -- Law 1, brass
   is the chassis and never the message. */
test('never marks a step as the current one', () => {
  const { container } = render(<WorkAxis />);

  expect(container.querySelector('[aria-current]')).toBeNull();
  expect(container.querySelector('[aria-selected]')).toBeNull();
});

/* The arrows are furniture between list items. An ordered list already
   carries the sequence, so announcing "right arrow" three times adds nothing
   but noise. */
test('hides the arrows from the accessibility tree', () => {
  const { container } = render(<WorkAxis />);

  expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(3);
});

/* This foot hangs on dark leather under the workspaces and on cream paper
   under The Bell. A named tint that reads on one is invisible on the other --
   it was, on the first render of the sign-in page -- so the words take the
   host's ink and only the arrows name a colour. */
test('names no colour for the words themselves', () => {
  render(<WorkAxis />);

  for (const item of screen.getAllByRole('listitem')) {
    const word = item.querySelector('span:not([aria-hidden])');
    expect(word?.className).not.toMatch(/text-\[color:/);
  }
});

/* Law 5, OD-2026-10-02-004/-007: gym-floor text is 19.1px (--t-md). A clamp
   whose floor is --t-sm resolved to 15px on tablets and phones. */
test('holds the gym-floor type size at every viewport', () => {
  render(<WorkAxis />);

  const list = screen.getByRole('list', { name: 'The work axis' });
  expect(list.style.fontSize).toBe('var(--t-md)');
});
