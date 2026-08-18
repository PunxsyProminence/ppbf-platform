/**
 * @jest-environment jsdom
 */

// The communications hub is a hardcoded prototype: every contact, media item
// and release status is fabricated.
//
// The specific hazard is the release column. A fabricated "cleared to
// publish" against a child's name is the one entry on any of these scaffolds
// that could put a minor's image out in public on the strength of invented
// consent, so the declaration says that outright rather than only saying the
// data is sample data.

import { render, screen } from '@testing-library/react';

import MediaAndCommsHub from './MediaAndCommsHub';

describe('the media and communications hub declares itself a prototype', () => {
  test('the stamp and the fabricated-data disclaimer render above the sample rows', () => {
    render(<MediaAndCommsHub />);

    expect(screen.getByText('Planned — Not Yet Implemented')).toBeTruthy();
    expect(screen.getByText(/fabricated sample data/)).toBeTruthy();
    expect(screen.getByText(/do not act on anything it shows/)).toBeTruthy();
  });

  test('the disclaimer warns that no entry here is consent to publish a minor', () => {
    render(<MediaAndCommsHub />);

    expect(screen.getByText(/never treat\s+an entry here as consent to publish a minor/)).toBeTruthy();
  });
});
