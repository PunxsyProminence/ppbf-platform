/**
 * @jest-environment jsdom
 */

// The Revenue & Funding Center is a hardcoded prototype: every account, row,
// status and dollar figure in it was typed into the file, and the component
// makes no request at all. Three of its tabs -- Memberships, Grants and
// Scholarships -- describe records the organisation now genuinely has, in a live
// register one click away (/admin/memberships, /admin/grants). That is what
// makes this console more dangerous than its
// prototype siblings rather than less: an admin has no way to tell the invented
// grant from their real one, and for a 501(c)(3) a fabricated figure copied
// into a board packet or a funder's report is a false statement made by the
// organisation.
//
// So this pins the same declaration the sibling prototypes carry -- the brass
// stamp plus a sentence naming the rows as fabricated sample data
// (floorOperationsDeskHonesty.test.tsx, coachWorkspaceHonesty.test.tsx) -- and
// the part that goes further: that each of the three tabs also hands the reader
// the real surface, as a working link and not as prose. It also pins the claim
// the notices make about themselves. "This tab makes no request and reads no
// record" is a factual assertion on screen, so a test has to hold the component
// to it; the day someone wires a real read in here, that sentence becomes the
// lie instead of the rows, and this suite is what says so.

import { fireEvent, render, screen } from '@testing-library/react';

import RevenueFundingCenter from './RevenueFundingCenter';

/** Every tab that renders fabricated rows for a record type that really exists. */
const TABS_WITH_REAL_RECORDS = [
  { tab: 'Memberships', rows: /Every membership row below is fabricated sample data/, link: 'Open the real membership records', href: '/admin/memberships' },
  { tab: 'Grants', rows: /Every grant row below is fabricated sample data/, link: 'Open the real grant records', href: '/admin/grants' },
  // Not a typo and not a missing register: a real scholarship is a discount
  // percentage stored on a real membership row, so the membership register is
  // the honest destination for this tab.
  { tab: 'Scholarships', rows: /Every scholarship row below is fabricated sample data/, link: 'Open the real scholarship records', href: '/admin/memberships' },
] as const;

function openTab(label: string): void {
  fireEvent.click(screen.getByRole('button', { name: label }));
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the revenue centre declares itself a prototype before it shows a figure', () => {
  test('the stamp and the fabricated-data disclaimer render in the header, on the first tab', () => {
    render(<RevenueFundingCenter />);

    expect(screen.getAllByText('Planned — Not Yet Implemented').length).toBeGreaterThan(0);
    expect(screen.getByText(/Every row on every tab of this screen is fabricated sample data/)).toBeTruthy();
    // The summary tiles are the figures most likely to be transcribed without
    // opening anything, so the header has to disown them by name.
    expect(screen.getByText(/not counts of your organisation's records/)).toBeTruthy();
  });

  test('the console makes no request, which is what the notices claim of themselves', () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<RevenueFundingCenter />);
    for (const { tab } of TABS_WITH_REAL_RECORDS) {
      openTab(tab);
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('each tab with real records behind it says so and hands over the door', () => {
  for (const { tab, rows, link, href } of TABS_WITH_REAL_RECORDS) {
    test(`${tab} stamps its rows as fabricated and links to ${href}`, () => {
      render(<RevenueFundingCenter />);
      openTab(tab);

      expect(screen.getAllByText('Planned — Not Yet Implemented').length).toBeGreaterThan(0);
      expect(screen.getByText(rows)).toBeTruthy();
      expect(screen.getByText(/do not copy a figure from it into a board packet, a grant report, or a filing/)).toBeTruthy();
      expect(screen.getByText(/becomes a false statement by the organisation/)).toBeTruthy();

      // A real anchor, not a sentence telling the admin to go and find it:
      // the whole point of going further than the sibling stamps is that the
      // honest message is also the way out.
      const door = screen.getByRole('link', { name: link });
      expect(door.getAttribute('href')).toBe(href);
    });
  }

  test('the fabricated rows are still on screen -- declared, not deleted, as the siblings do it', () => {
    render(<RevenueFundingCenter />);
    openTab('Grants');

    // Deleting the sample rows would have been the other way to fix this, and
    // it is not the established pattern: the prototype stays legible as a
    // prototype. What must never happen is the rows without the declaration.
    expect(screen.getByText('Grant Placeholder')).toBeTruthy();
  });
});
