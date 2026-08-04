/**
 * @jest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act, render, screen } from '@testing-library/react';

import PrintRoom from './PrintRoom';
import PrintableCertificate, { awardedOnLabel, markedByLine } from './PrintableCertificate';
import PrintableFightCard from './PrintableFightCard';
import type { FightCardPayload } from './profileClient';
import { milestoneByKey } from '@/src/shared/achievementPaths';

const GLOBALS = path.resolve(__dirname, '../app/globals.css');

function card(overrides: Partial<FightCardPayload> = {}): FightCardPayload {
  return {
    accountId: 'acct-1',
    displayName: 'Marcus Ruiz',
    initials: 'MR',
    ringName: 'The Engine',
    corner: 'red',
    cornerLabel: 'Red corner',
    program: 'youth_mentorship',
    programLabel: 'Youth Mentorship Programme',
    coachName: 'Jason Neale',
    coachAccountId: 'acct-coach',
    coachPhotoAvailable: true,
    coachInitials: 'JN',
    timeAtGym: '2 years',
    photoAvailable: true,
    ...overrides,
  };
}

/**
 * Everything a printed artifact must never say. Paper leaves the building and
 * never comes back: it is photographed, filed, and handed to somebody at a
 * tournament, and it says whatever it said on the day it printed forever.
 *
 * Scanned against the rendered TEXT rather than the source, so a field pulled
 * in from an API six months from now is caught even though nobody typed the
 * word into this repository.
 */
const FORBIDDEN_ON_PAPER = [
  'readiness',
  'cleared',
  'clearance',
  'medical',
  'injury',
  'injured',
  'concussion',
  'diagnos',
  'suspend',
  'suspension',
  'discipline',
  'disciplinary',
  'sanction',
  'restricted',
  'locked',
  'weight class',
  'physician',
  'doctor',
];

function assertNothingClinical(text: string) {
  const lower = text.toLowerCase();
  for (const word of FORBIDDEN_ON_PAPER) {
    expect({ word, present: lower.includes(word) }).toEqual({ word, present: false });
  }
}

const originalFetch = global.fetch;
const originalPrint = window.print;

afterEach(() => {
  global.fetch = originalFetch;
  window.print = originalPrint;
  jest.clearAllMocks();
});

function stubFetch(options: {
  cardStatus?: number;
  awards?: Array<{ milestone_key: string; awarded_by_role: string; awarded_at: string }>;
  completedSessions?: number;
  athleteId?: string | null;
}) {
  const mock = jest.fn(async (url: unknown) => {
    const href = String(url);
    if (href.includes('/api/pilot/auth/session')) {
      return {
        ok: true,
        json: async () => ({ authenticated: true, athlete_id: options.athleteId ?? 'ath-1', role: 'athlete' }),
      } as Response;
    }
    if (href.includes('/api/pilot/profile/card')) {
      const status = options.cardStatus ?? 200;
      return { ok: status === 200, status, json: async () => ({ ok: true, card: card() }) } as Response;
    }
    if (href.includes('/api/pilot/achievements/milestones')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          items: options.awards ?? [],
          completed_sessions: options.completedSessions ?? 0,
        }),
      } as Response;
    }
    throw new Error(`unexpected fetch: ${href}`);
  });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

async function renderRoom(options: Parameters<typeof stubFetch>[0] = {}) {
  const mock = stubFetch(options);
  let container!: HTMLElement;
  await act(async () => {
    container = render(<PrintRoom />).container;
  });
  return { container, mock };
}

describe('the printed card', () => {
  it('prints who somebody is', () => {
    render(<PrintableFightCard card={card()} now={new Date('2026-08-03T12:00:00.000Z')} />);

    expect(screen.getByText('Marcus Ruiz')).toBeTruthy();
    expect(screen.getByText(/The Engine/)).toBeTruthy();
    expect(screen.getByText('Youth Mentorship Programme')).toBeTruthy();
    expect(screen.getByText('Jason Neale')).toBeTruthy();
  });

  it('carries the corner in words, so a photocopier cannot lose it', () => {
    // Law 3: the dye is never the only channel, and a printed sheet is where
    // the dye is most likely to be thrown away.
    render(<PrintableFightCard card={card({ corner: 'blue', cornerLabel: 'Blue corner' })} />);
    expect(screen.getByText('Blue corner')).toBeTruthy();
  });

  it('prints the brass plate rather than a photograph, even when one is released', () => {
    const { container } = render(<PrintableFightCard card={card({ photoAvailable: true })} />);

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('img', { name: 'Marcus Ruiz' }).textContent).toBe('MR');
  });

  it('says nothing clinical, and says out loud that it is not a clearance document', () => {
    const { container } = render(<PrintableFightCard card={card()} />);
    const text = container.textContent ?? '';

    // The footer legitimately uses the words in a denial, so the scan runs on
    // the body only and the denial is asserted separately.
    const body = container.querySelector('.print-sheet-body')?.textContent ?? '';
    assertNothingClinical(body);
    expect(text).toMatch(/not a medical, clearance or eligibility document/i);
  });

  it('carries no record, ranking or weight class -- a fitness member’s card is the same object', () => {
    const { container } = render(<PrintableFightCard card={card({ programLabel: 'Fitness Programme' })} />);
    const text = (container.textContent ?? '').toLowerCase();

    for (const word of ['win', 'loss', 'record:', 'rank', 'ranking', 'points', 'score']) {
      expect({ word, present: text.includes(word) }).toEqual({ word, present: false });
    }
  });

  it('is honest about what the platform does not know', () => {
    render(<PrintableFightCard card={card({ coachName: null, timeAtGym: null, ringName: null })} />);

    expect(screen.getByText('No coach of record yet')).toBeTruthy();
    expect(screen.getByText('Start date not recorded')).toBeTruthy();
    // An empty quotation mark is a gap wearing a decoration.
    expect(screen.queryByText('""')).toBeNull();
  });
});

describe('the certificate', () => {
  const milestone = milestoneByKey('community.helped_someone_new');

  it('leads with the words a parent reads, and keeps the gym’s own underneath', () => {
    render(
      <PrintableCertificate
        athleteName="Marcus Ruiz"
        milestone={milestone!}
        awardedAt="2026-06-14T12:00:00.000Z"
        awardedByRole="coach"
      />,
    );

    expect(screen.getByText('Helped a newer kid settle in')).toBeTruthy();
    expect(screen.getByText(/Helped somebody new find their feet/)).toBeTruthy();
    expect(screen.getByText('Marcus Ruiz')).toBeTruthy();
    expect(screen.getByText(/Marked by a coach who watched it happen/)).toBeTruthy();
  });

  it('never ranks, scores or compares', () => {
    const { container } = render(
      <PrintableCertificate athleteName="Marcus Ruiz" milestone={milestone!} awardedAt={null} />,
    );
    const text = (container.textContent ?? '').toLowerCase();

    for (const word of ['points', 'score', 'rank', 'level ', 'out of', 'place', 'best in']) {
      expect({ word, present: text.includes(word) }).toEqual({ word, present: false });
    }
  });

  it('says nothing clinical', () => {
    const { container } = render(
      <PrintableCertificate athleteName="Marcus Ruiz" milestone={milestone!} awardedAt={null} />,
    );
    assertNothingClinical(container.querySelector('.print-sheet-body')?.textContent ?? '');
  });

  it('does not invent a date it does not have', () => {
    expect(awardedOnLabel(null)).toBe('Date not recorded');
    expect(awardedOnLabel('nonsense')).toBe('Date not recorded');
  });

  it('names the athlete’s own mark as a mark, not as a lesser one', () => {
    expect(markedByLine('self')).toMatch(/Their word, and that counts here/);
    expect(markedByLine('coach')).toMatch(/watched it happen/);
    // An unrecognised role is simply not mentioned rather than guessed at.
    expect(markedByLine('gremlin')).toBeNull();
    expect(markedByLine(null)).toBeNull();
  });

  it('carries a stamp, which is the one mark the print rules let keep its colour', () => {
    const { container } = render(
      <PrintableCertificate athleteName="Marcus Ruiz" milestone={milestone!} awardedAt={null} />,
    );
    expect(container.querySelector('.stamp')).not.toBeNull();
  });
});

describe('the print room', () => {
  it('produces two sheets: the card, then a certificate', async () => {
    const { container } = await renderRoom({
      awards: [
        { milestone_key: 'craft.wraps_own_hands', awarded_by_role: 'self', awarded_at: '2026-05-02T10:00:00.000Z' },
      ],
    });

    expect(container.querySelectorAll('.print-sheet')).toHaveLength(2);
    expect(screen.getByText('Certificate')).toBeTruthy();
    expect(screen.getByText('Wraps their own hands properly')).toBeTruthy();
  });

  it('still produces two sheets on day one, and says why the second is blank', async () => {
    const { container } = await renderRoom({ awards: [], completedSessions: 0 });

    expect(container.querySelectorAll('.print-sheet')).toHaveLength(2);
    expect(screen.getByText('No certificate to print')).toBeTruthy();
    expect(screen.getByText(/Nothing is missing and nothing is late/)).toBeTruthy();
  });

  it('counts a milestone the session ledger earned, with no award row behind it', async () => {
    // consistency.first_session is earned by the count alone. A certificate for
    // it must print even though pilot.athlete_milestones has nothing in it.
    await renderRoom({ awards: [], completedSessions: 1 });
    expect(screen.getByText('Came in for the first time')).toBeTruthy();
  });

  it('prints nothing at all for somebody else’s child', async () => {
    // The server answers 404 for a refusal (hiddenNotFound), which is
    // indistinguishable from "no such athlete" on purpose.
    const { container } = await renderRoom({ cardStatus: 404 });

    expect(container.querySelectorAll('.print-sheet')).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toMatch(/ask a coach/i);
  });

  it('keeps the controls off the paper', async () => {
    const { container } = await renderRoom({ awards: [] });
    const bar = container.querySelector('.print-room-bar');

    expect(bar).not.toBeNull();
    expect(bar?.className).toContain('screen-only');
  });

  it('drops an award naming a milestone the catalogue no longer has', async () => {
    const { container } = await renderRoom({
      awards: [
        { milestone_key: 'milestone.that.was.deleted', awarded_by_role: 'coach', awarded_at: '2026-05-02T10:00:00.000Z' },
      ],
      completedSessions: 0,
    });

    // Not a blank certificate: the honest day-one sheet.
    expect(container.querySelectorAll('.print-sheet')).toHaveLength(2);
    expect(screen.getByText('No certificate to print')).toBeTruthy();
  });
});

/**
 * PAGINATION.
 *
 * There is no browser in this environment (`npx playwright install chromium`
 * cannot reach the download host here), so this does not prove what a printer
 * emits -- it proves the arithmetic and the break rules that decide it. What is
 * asserted: the page is US Letter with a stated margin, the sheet box is
 * exactly the printable area that leaves, and the break lands BETWEEN sheets
 * rather than after every one -- the last being the classic way a two-page
 * print becomes a three-page print with a blank at the end.
 */
describe('the sheet fits the page', () => {
  const css = readFileSync(GLOBALS, 'utf8');
  const printBlock = css.slice(css.lastIndexOf('@media print'));

  it('sets US Letter portrait with a stated margin', () => {
    expect(printBlock).toMatch(/@page\s*\{[^}]*size:\s*letter portrait/);
    expect(printBlock).toMatch(/@page\s*\{[^}]*margin:\s*1in/);
  });

  it('sizes the sheet to exactly what the margins leave', () => {
    const sheet = css.slice(css.indexOf('.print-sheet {'), css.indexOf('.print-sheet + .print-sheet'));
    const width = Number(/width:\s*([\d.]+)in/.exec(sheet)?.[1]);
    const height = Number(/min-height:\s*([\d.]+)in/.exec(sheet)?.[1]);

    // US Letter is 8.5in x 11in; a 1in margin on each side leaves 6.5 x 9.
    expect(width).toBe(8.5 - 2 * 1);
    expect(height).toBe(11 - 2 * 1);
  });

  it('breaks between sheets and never after the last one', () => {
    expect(css).toMatch(/\.print-sheet \+ \.print-sheet \{[^}]*break-before:\s*page/);
    expect(css).not.toMatch(/\.print-sheet \{[^}]*break-after:\s*page/);
  });

  it('never splits one sheet across a fold', () => {
    const sheet = css.slice(css.indexOf('.print-sheet {'), css.indexOf('.print-sheet + .print-sheet'));
    expect(sheet).toMatch(/break-inside:\s*avoid/);
  });

  it('hides the screen controls on paper', () => {
    expect(printBlock).toMatch(/\.screen-only\s*\{[^}]*display:\s*none/);
  });
});
