/**
 * @jest-environment jsdom
 */

// The board command center is a hardcoded prototype: every financial figure,
// governance metric and compliance statement is fabricated.
//
// The risk here is not a coach acting on a bad number, it is a number leaving
// the building. This page renders what looks like fiduciary reporting for a
// 501(c)(3), and a figure copied from it into a board packet, a grant report
// or a filing becomes a false statement made by the organization. The
// declaration says so in those terms.

import { render, screen } from '@testing-library/react';

import BoardViewportSwitcher from './BoardViewportSwitcher';

describe('the board viewport switcher declares itself a prototype', () => {
  test('the stamp and the fabricated-data disclaimer render above the sample figures', () => {
    render(<BoardViewportSwitcher />);

    expect(screen.getByText('Planned — Not Yet Implemented')).toBeTruthy();
    expect(screen.getByText(/fabricated\s+sample data/)).toBeTruthy();
    expect(screen.getByText(/do not act on anything it\s+shows/)).toBeTruthy();
  });

  test('the disclaimer warns against carrying a figure into a board packet or filing', () => {
    render(<BoardViewportSwitcher />);

    expect(screen.getByText(/never carry a number from this page into a board packet or a filing/))
      .toBeTruthy();
  });
});
