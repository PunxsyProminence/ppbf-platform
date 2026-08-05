/**
 * @jest-environment jsdom
 */

import { render, screen } from '@testing-library/react';

import PublicPortalPage from './page';
import { GYM_STAFF_CARDS, gymPhotoSlotsFor } from '@/src/shared/gymPhotos';

/**
 * The front door of the front door.
 *
 * The owner is taking photographs and has none yet, so every frame on this page
 * is empty and will be for a while. That is the state a nervous parent will see
 * when they open this on their phone, so it is the state that is tested.
 */

describe('the public page while every frame is empty', () => {
  it('hangs a frame for each slot the public surface asks for', () => {
    const { container } = render(<PublicPortalPage />);

    const slots = gymPhotoSlotsFor('public');
    expect(slots.length).toBeGreaterThan(0);

    // One frame per gym slot, plus one per named member of staff.
    expect(container.querySelectorAll('.photo-slot').length).toBe(slots.length + GYM_STAFF_CARDS.length);
    for (const slot of slots) {
      expect(screen.getByText(slot.title)).toBeTruthy();
    }
  });

  it('shows no image at all rather than a stand-in', () => {
    const { container } = render(<PublicPortalPage />);

    // No stock photo, no illustration, no gradient block dressed as a picture.
    // An <img> on this page today could only be one of those things.
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('.photo-slot [data-filled="yes"]')).toHaveLength(0);
  });

  it('says why the frames are empty, and what to do instead', () => {
    render(<PublicPortalPage />);

    expect(screen.getByText(/nobody has taken the photographs yet/i)).toBeTruthy();
    expect(screen.getByText(/come and look at the real thing/i)).toBeTruthy();
  });

  it('does not apologise or promise a date', () => {
    const { container } = render(<PublicPortalPage />);
    const text = (container.textContent ?? '').toLowerCase();

    for (const phrase of ['coming soon', 'under construction', 'check back', 'placeholder', 'image unavailable']) {
      expect({ phrase, present: text.includes(phrase) }).toEqual({ phrase, present: false });
    }
  });
});

describe('who would be coaching your kid', () => {
  it('shows a frame and a name for every member of staff the platform knows of', () => {
    render(<PublicPortalPage />);

    expect(screen.getByText('WHO WOULD BE COACHING YOUR KID')).toBeTruthy();
    for (const person of GYM_STAFF_CARDS) {
      expect(screen.getByText(person.name)).toBeTruthy();
      expect(screen.getByText(person.role)).toBeTruthy();
    }
  });

  it('invents nobody', () => {
    // The page names exactly the people the repository already named. A grid of
    // plausible-sounding coaches would be a lie on the page a parent reads
    // before deciding whether to trust this gym with their child.
    expect(GYM_STAFF_CARDS).toHaveLength(1);
    expect(GYM_STAFF_CARDS[0].name).toBe('Jason Neale');
  });

  it('says plainly that the missing coaches are missing from the page, not from the gym', () => {
    render(<PublicPortalPage />);
    expect(screen.getByText(/a gap on this page, not a gap in the gym/i)).toBeTruthy();
  });
});

describe('the page keeps the voice it was rewritten into', () => {
  it('still leads with what it led with', () => {
    render(<PublicPortalPage />);

    expect(
      screen.getByText(/A boxing gym for kids, for adults, and for anyone who just wants to get in shape\./),
    ).toBeTruthy();
    expect(screen.getByText('WHAT WE ACTUALLY RUN')).toBeTruthy();
    expect(screen.getByText('QUESTIONS PEOPLE ACTUALLY ASK')).toBeTruthy();
  });

  it('can still be jumped to, including the two new sections', () => {
    const { container } = render(<PublicPortalPage />);
    const hrefs = [...container.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'));

    expect(hrefs).toContain('/public#the-room');
    expect(hrefs).toContain('/public#who-coaches');
    expect(container.querySelector('#the-room')).not.toBeNull();
    expect(container.querySelector('#who-coaches')).not.toBeNull();
  });
});
