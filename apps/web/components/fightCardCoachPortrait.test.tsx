/**
 * @jest-environment jsdom
 */

import { render } from '@testing-library/react';

import FightCard from './FightCard';
import type { FightCardPayload } from './profileClient';

// The coach's face on a fight card is fetched by the CARD, not by the coach's
// account id, so a family's card -- which carries coachAccountId: null under
// OD-2026-10-06-025 ruling 2 -- still shows the coach's portrait, and no
// address the page requests names the coach.

function card(overrides: Partial<FightCardPayload> = {}): FightCardPayload {
  return {
    accountId: 'acct-athlete',
    displayName: 'Marisol Vance',
    initials: 'MV',
    ringName: null,
    corner: 'none',
    cornerLabel: 'No corner',
    program: 'youth_mentorship',
    programLabel: 'Youth Mentorship Programme',
    coachName: 'Ray Nolan',
    coachAccountId: null,
    coachPhotoAvailable: true,
    coachInitials: 'RN',
    timeAtGym: '9 months',
    photoAvailable: false,
    ...overrides,
  };
}

function imageSources(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('img')).map((img) => img.getAttribute('src') ?? '');
}

describe('FightCard coach portrait', () => {
  test('a family card with no coach id still shows the coach, fetched by the card', () => {
    const { container } = render(<FightCard card={card()} />);
    expect(imageSources(container)).toEqual([
      '/api/pilot/profile/card/coach-photo?account_id=acct-athlete',
    ]);
  });

  test('a staff card that does carry the id never puts it in an address', () => {
    const { container } = render(<FightCard card={card({ coachAccountId: 'acct-coach-7f3a' })} />);
    const sources = imageSources(container);
    expect(sources).toEqual(['/api/pilot/profile/card/coach-photo?account_id=acct-athlete']);
    for (const src of sources) expect(src).not.toContain('acct-coach-7f3a');
  });

  test('no released coach portrait means the plate and no request at all', () => {
    const { container } = render(<FightCard card={card({ coachPhotoAvailable: false })} />);
    expect(imageSources(container)).toEqual([]);
  });
});
