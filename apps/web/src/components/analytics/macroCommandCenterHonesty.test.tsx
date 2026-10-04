/**
 * @jest-environment jsdom
 */

// This console is a hardcoded prototype: every staff member, certification,
// SafeSport status, background-check result and risk flag is fabricated.
//
// It carries the strictest wording of the prototype scaffolds because of what
// it renders. A row reading "Avery Hall - SafeSport Current - Cleared 2026
// cycle" is exactly the sentence an administrator acts on when deciding who
// may supervise minors, and nothing on the page distinguishes it from a real
// clearance record. The per-cell verification marker that shipped with it is
// developer shorthand, not a disclaimer a gym owner would read as "invented".
//
// Pinned the same way the floor operations desk pins its declaration.

import { render, screen } from '@testing-library/react';

import MacroCommandCenter from './MacroCommandCenter';

describe('the macro command center declares itself a prototype', () => {
  test('the stamp and the fabricated-data disclaimer render above the sample rows', () => {
    render(<MacroCommandCenter />);

    expect(screen.getByText('Planned — Not Yet Implemented')).toBeTruthy();
    expect(screen.getByText(/fabricated sample data/)).toBeTruthy();
    expect(screen.getByText(/do not act on anything it shows/)).toBeTruthy();
  });

  test('the disclaimer names the safeguarding fields specifically', () => {
    render(<MacroCommandCenter />);

    // Naming SafeSport and the background check matters more than the generic
    // sentence: those two columns are the ones a reader would otherwise treat
    // as a cleared-adult record.
    expect(screen.getByText(/SafeSport status, background-check result/)).toBeTruthy();
    expect(screen.getByText(/never treat a name here as a cleared\s+adult/)).toBeTruthy();
  });
});

describe('the fabricated deload panel is gone', () => {
  // The old list read "reduce by 12% for 5-day cycle" -- an invented deload
  // number on a screen whose ruling refuses one. The real signal is the
  // coach-confirmed load-jump suggestion, and this pointer must lead there.
  test('no deload recommendation text renders; the pointer leads to the real flag', () => {
    render(<MacroCommandCenter />);

    expect(screen.queryByText(/Deload Recommendations/)).toBeNull();
    expect(screen.queryByText(/reduce by 12%/)).toBeNull();
    const link = screen.getByRole('link', { name: 'Progression Intelligence' });
    expect(link.getAttribute('href')).toBe('/coach/progression-intelligence');
  });
});
