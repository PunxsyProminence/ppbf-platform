/**
 * @jest-environment jsdom
 */

/**
 * THE FAMILY PAGE DOES NOT WATCH THE FAMILY.
 *
 * /public carried a panel headed "WHAT YOU HAVE CLICKED ON THIS PAGE" over a
 * scrolling mono list of `[timestamp]` lines -- the After Hours idiom, on the
 * one surface a parent reaches before they have an account. It existed to
 * demonstrate a privacy promise the page already makes in plain words two
 * panels up, and showing a family a running log of themselves to prove nothing
 * is logged reads as surveillance whatever the caption says.
 *
 * ROOM-PURPOSE-DNA lists night telemetry as forbidden chrome in the front
 * office. These fail if the panel, or the click-recording behind it, comes
 * back -- and they pin that the prose the panel was standing in for is still
 * on the page, because deleting the panel must not delete the promise.
 */

import { fireEvent, render, screen } from '@testing-library/react';

import PublicPortalPage from './page';

test('no click trace is shown to a signed-out visitor', () => {
  const { container } = render(<PublicPortalPage />);

  expect(screen.queryByText(/what you have clicked on this page/i)).toBeNull();
  expect(screen.queryByText(/this fills in as you click around/i)).toBeNull();
  expect(container.textContent).not.toMatch(/quick link clicked|visitor path selected|FAQ opened/);
});

test('clicking around records nothing on the page', () => {
  const { container } = render(<PublicPortalPage />);

  // The three interactions that used to be recorded: picking a visitor path,
  // opening a question, and following a jump link.
  fireEvent.click(screen.getAllByRole('button', { name: 'That is me' })[0]);
  fireEvent.click(screen.getAllByRole('button', { expanded: false })[0]);
  fireEvent.click(screen.getByRole('link', { name: 'The room' }));

  // A bracketed ISO timestamp is the shape the removed feed printed.
  expect(container.textContent).not.toMatch(/\[\d{4}-\d{2}-\d{2}T/);
});

test('the privacy promise the panel stood in for is still made in words', () => {
  render(<PublicPortalPage />);

  expect(screen.getByText(/what is not on this page/i)).toBeTruthy();
  expect(screen.getByText(/what your family tells us stays with staff/i)).toBeTruthy();
});
