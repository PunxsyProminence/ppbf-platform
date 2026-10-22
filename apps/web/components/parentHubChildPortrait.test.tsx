/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';

import ParentHub from './ParentHub';

// F-119: the guardian's card reads carry no account id, the child's or their
// own. The child switcher's portrait is fetched by the card's own path (an
// athlete id the guardian already holds), never by an account id.

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function card(athleteId: string, name: string, initials: string) {
  return {
    accountId: null,
    displayName: name,
    initials,
    ringName: null,
    corner: 'none',
    cornerLabel: 'No corner',
    program: 'youth_mentorship',
    programLabel: 'Youth Mentorship Program',
    coachName: 'Coach Ray',
    coachAccountId: null,
    coachPhotoAvailable: false,
    coachInitials: 'CR',
    timeAtGym: '1 year',
    photoAvailable: true,
    portraitPath: `/api/pilot/profile/card/photo?athlete_id=${athleteId}`,
    coachPortraitPath: `/api/pilot/profile/card/coach-photo?athlete_id=${athleteId}&coach_name=Coach%20Ray`,
  };
}

beforeEach(() => {
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/pilot/athletes/list')) {
      return jsonResponse({ items: [{ athlete_id: 'ath_1', full_name: 'First Child' }] });
    }
    if (url.includes('/api/pilot/profile/card')) return jsonResponse({ card: card('ath_1', 'First Child', 'FC') });
    if (url.includes('/api/pilot/scheduler')) return jsonResponse({ ok: true, classes: [], registrations: [], attendance: [] });
    if (url.includes('/api/pilot/announcements/get')) return jsonResponse({ ok: true, announcements: [] });
    return jsonResponse({ ok: true, items: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

test('the child switcher shows the child’s face from the card’s path, never an account id', async () => {
  const { container } = render(<ParentHub />);

  await screen.findByRole('button', { name: /First Child/ });
  await waitFor(() => {
    const sources = Array.from(container.querySelectorAll('img')).map((img) => img.getAttribute('src') ?? '');
    expect(sources).toContain('/api/pilot/profile/card/photo?athlete_id=ath_1');
  });

  const sources = Array.from(container.querySelectorAll('img')).map((img) => img.getAttribute('src') ?? '');
  for (const src of sources) {
    expect(src).not.toContain('/api/pilot/profile/photo/');
    expect(src).not.toContain('@');
  }
});
