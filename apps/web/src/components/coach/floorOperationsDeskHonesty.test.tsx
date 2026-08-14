/**
 * @jest-environment jsdom
 */

// The desk is a hardcoded prototype: every athlete, clearance row, attendance
// figure, and matchup is fabricated. The building map deliberately gives
// /coach/operations no door for exactly that reason (buildingMapCoverage
// test), but the route itself is live for anyone who types the URL, and
// fabricated return-to-play clearance state must never read as real. This
// pins the on-page declaration the same way the sibling scaffolds
// (sports-medicine, passbook-check) carry theirs.

import { render, screen } from '@testing-library/react';

import FloorOperationsDesk from './FloorOperationsDesk';

describe('the floor operations desk declares itself a prototype', () => {
  test('the stamp and the fabricated-data disclaimer render above the sample rows', () => {
    render(<FloorOperationsDesk />);

    expect(screen.getByText('Planned — Not Yet Implemented')).toBeTruthy();
    expect(screen.getByText(/fabricated sample data/)).toBeTruthy();
    expect(screen.getByText(/do not act on anything it shows/)).toBeTruthy();
  });
});
