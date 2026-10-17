/**
 * @jest-environment jsdom
 */

import { render } from '@testing-library/react';

import FightCard from './FightCard';
import type { FightCardPayload } from './profileClient';

// The faces on a fight card are fetched by the CARD, not by anybody's account
// id, so a family's card -- which carries no account id at all
// (OD-2026-10-06-025 ruling 2; F-119) -- still shows both portraits, and no
// address the page requests names an account.

function card(overrides: Partial<FightCardPayload> = {}): FightCardPayload {
  return {
    accountId: null,
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
    portraitPath: '/api/pilot/profile/card/photo?athlete_id=ath-1',
    coachPortraitPath: '/api/pilot/profile/card/coach-photo?athlete_id=ath-1&coach_name=Ray%20Nolan',
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
      '/api/pilot/profile/card/coach-photo?athlete_id=ath-1&coach_name=Ray%20Nolan',
    ]);
  });

  test('the card’s own face is fetched by the card’s path, never an account id', () => {
    const { container } = render(<FightCard card={card({ photoAvailable: true })} />);
    const sources = imageSources(container);
    expect(sources).toEqual([
      '/api/pilot/profile/card/photo?athlete_id=ath-1',
      '/api/pilot/profile/card/coach-photo?athlete_id=ath-1&coach_name=Ray%20Nolan',
    ]);
    for (const src of sources) expect(src).not.toContain('@');
  });

  test('a card with no path shows the plate and requests nothing', () => {
    const { container } = render(
      <FightCard card={card({ photoAvailable: true, portraitPath: null, coachPortraitPath: null })} />,
    );
    expect(imageSources(container)).toEqual([]);
  });

  test('a staff card that does carry the id never puts it in an address', () => {
    const { container } = render(
      <FightCard card={card({ accountId: 'acct-athlete', coachAccountId: 'acct-coach-7f3a' })} />,
    );
    const sources = imageSources(container);
    expect(sources).toEqual(['/api/pilot/profile/card/coach-photo?athlete_id=ath-1&coach_name=Ray%20Nolan']);
    for (const src of sources) expect(src).not.toContain('acct-coach-7f3a');
  });

  test('no released coach portrait means the plate and no request at all', () => {
    const { container } = render(<FightCard card={card({ coachPhotoAvailable: false })} />);
    expect(imageSources(container)).toEqual([]);
  });
});
