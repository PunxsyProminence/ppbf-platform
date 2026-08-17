/**
 * @jest-environment jsdom
 */

/**
 * A PAGE THAT INVENTS ITS NUMBERS HAS TO SAY SO.
 *
 * Six capability consoles render with zero fetch calls between them. That is a
 * staging decision and it is fine; what was not fine is that nothing on the
 * page said so, while BoardViewportSwitcher rendered budget lines and a grant
 * pipeline and MacroCommandCenter rendered SafeSport clearance statuses. The
 * handoff brief describing this work asserted the disclaimer was already
 * shipped on all six. It was not on any of them, which is exactly how a
 * believed-solved honesty problem stays open.
 *
 * So these tests pin the parts that a later patch could quietly remove without
 * anything else noticing:
 *   1. the admission itself is present, in words, not only as a stamp;
 *   2. it is not dressed as a safety alert -- Law 2 spends saturated colour on
 *      a participant's safety state, and a page admitting its own figures are
 *      samples must not borrow that ladder; and
 *   3. the pointer to real records appears only when a real route was actually
 *      supplied, because a link to a surface that does not exist is the same
 *      class of defect this component was written to fix.
 */

import { render, screen } from '@testing-library/react';

import SampleDataNotice from './SampleDataNotice';

describe('SampleDataNotice', () => {
  it('says the figures are fabricated, in words a reader can read', () => {
    render(<SampleDataNotice what="The budget lines here are illustrative." />);

    expect(screen.getByText(/fabricated sample data/i)).not.toBeNull();
    expect(screen.getByText(/budget lines here are illustrative/i)).not.toBeNull();
  });

  it('carries the brass stamp the prototype consoles already use', () => {
    const { container } = render(<SampleDataNotice what="Illustrative." />);

    const stamp = container.querySelector('.stamp');
    expect(stamp).not.toBeNull();
    expect(stamp?.className).toContain('stamp--brass');
    expect(stamp?.textContent).toMatch(/Planned/i);
  });

  it('does not dress itself as a safety state (Law 2)', () => {
    const { container } = render(<SampleDataNotice what="Illustrative." />);

    // .alert--* and the saturated badge rungs belong to a participant's safety
    // status. A sample-data admission borrowing them would spend a ladder that
    // has to still mean something when a child is actually at risk.
    expect(container.querySelector('[class*="alert--"]')).toBeNull();
    expect(container.querySelector('[class*="badge--"]')).toBeNull();
    expect(container.innerHTML).not.toMatch(/\brole="alert"/);
  });

  it('reads as one message, not two stacked warnings, when real records exist', () => {
    render(
      <SampleDataNotice
        what="The grant pipeline is illustrative."
        realHref="/admin/grants"
        realLabel="Grants"
      />,
    );

    const link = screen.getByRole('link', { name: 'Grants' });
    expect(link.getAttribute('href')).toBe('/admin/grants');
    // Same paragraph as the admission -- an admin told to distrust the page
    // needs somewhere to go in the same breath, not a second banner.
    expect(link.closest('p')?.textContent).toMatch(/fabricated sample data/i);
  });

  it('offers no pointer when no real surface was named', () => {
    render(<SampleDataNotice what="Illustrative." />);

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText(/real records are at/i)).toBeNull();
  });

  it('is a note rather than an interruption', () => {
    render(<SampleDataNotice what="Illustrative." />);

    // Nothing here is time-critical; it is a standing property of the screen,
    // so it should be read in document order rather than announced over it.
    expect(screen.getByRole('note')).not.toBeNull();
  });
});
