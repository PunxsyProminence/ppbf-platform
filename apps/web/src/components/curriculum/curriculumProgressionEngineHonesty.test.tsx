/**
 * @jest-environment jsdom
 */

// The curriculum engine is a hardcoded prototype: every athlete, badge and
// progression figure is fabricated. It names children alongside awarded
// badges and point totals, which is the kind of thing a coach repeats to a
// parent, so it declares itself the same way the sibling scaffolds do.

import { render, screen } from '@testing-library/react';

import CurriculumProgressionEngine from './CurriculumProgressionEngine';

describe('the curriculum progression engine declares itself a prototype', () => {
  test('the stamp and the fabricated-data disclaimer render above the sample rows', () => {
    render(<CurriculumProgressionEngine />);

    expect(screen.getByText('Planned — Not Yet Implemented')).toBeTruthy();
    expect(screen.getByText(/fabricated sample data/)).toBeTruthy();
    expect(screen.getByText(/do not act on anything it shows/)).toBeTruthy();
  });
});
