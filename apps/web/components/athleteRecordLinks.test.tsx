/**
 * @jest-environment jsdom
 */

// Lane AS-11 (app scrub CF-15; Q1 = A, Q2 = A, Q4 = A): Passbook names the
// rest of one athlete's record, and an athlete's name opens their Passbook.
// Pinned here: each page on the line is a door whose roles are exactly the
// page's own gate, and its page exists; a role sees only the pages it may
// open; a plain click hands the athlete to that page and nothing else does;
// no address carries the athlete.

import fs from 'node:fs';
import path from 'node:path';
import type { MouseEventHandler, ReactNode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import AthleteRecordLinks, { AthleteNameLink } from './AthleteRecordLinks';
import { ATHLETE_RECORD_PAGES, COACH_CARDS_PAGE, PASSBOOK_PAGE } from './athleteRecordPages';
import { BUILDING, OPEN } from './buildingMap';
import { ATHLETE_SAFETY_PAGE, takeArrivalAthlete } from './decisionLoopArrival';
import { clearRoleSession, createPersistentRoleSession } from './roleSession';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({
    children,
    href,
    onClick,
    className,
  }: {
    readonly children: ReactNode;
    readonly href: string;
    readonly onClick?: MouseEventHandler<HTMLAnchorElement>;
    readonly className?: string;
  }) => (
    <a
      href={href}
      className={className}
      onClick={(event) => {
        // A real link navigates; the test only needs the hand-off.
        event.preventDefault();
        onClick?.(event);
      }}
    >
      {children}
    </a>
  ),
}));

const WEB = path.resolve(__dirname, '..');
const pageFile = (href: string) => path.join(WEB, 'app', ...href.split('/').filter(Boolean), 'page.tsx');
const gateOf = (source: string) => {
  const match = source.match(/allowedRoles=\{\[([^\]]*)\]\}/);
  return match ? [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort() : null;
};

const LABELS = [
  'Athlete Safety',
  'Development Plans',
  'Jump Test and Skill Ratings',
  'Coach Cards',
  'The Work',
  'Progression Intelligence',
  'Athlete Intelligence',
];

afterEach(() => {
  clearRoleSession();
  for (const page of [...ATHLETE_RECORD_PAGES, PASSBOOK_PAGE]) takeArrivalAthlete(page);
});

async function renderLine(role: 'coach' | 'admin' | null) {
  if (role) createPersistentRoleSession(role);
  await act(async () => {
    render(
      <section>
        <h2 id="athlete-name">Ana Boxer</h2>
        <AthleteRecordLinks athleteId="ath-1" labelledBy="athlete-name" />
      </section>,
    );
  });
}

describe('the pages on Passbook\'s line (lane AS-11)', () => {
  test.each([...ATHLETE_RECORD_PAGES, PASSBOOK_PAGE])(
    '%s exists and has a door whose roles are exactly its gate',
    (href) => {
      expect(fs.existsSync(pageFile(href))).toBe(true);
      const door = BUILDING.find((d) => d.href === href);
      expect(door).toBeDefined();
      expect(door!.roles).not.toBe(OPEN);
      expect([...(door!.roles as readonly string[])].sort()).toEqual(gateOf(fs.readFileSync(pageFile(href), 'utf8')));
    },
  );

  test('every page on the line takes a hand-off keyed to its own address', () => {
    for (const href of ATHLETE_RECORD_PAGES) {
      expect(fs.readFileSync(pageFile(href), 'utf8')).toMatch(/takeArrivalAthlete\([A-Z_]+_PAGE\)/);
    }
  });
});

describe('Passbook\'s line (lane AS-11)', () => {
  test('a coach sees every page, in order, named by its door, labelled by the athlete', async () => {
    await renderLine('coach');
    const nav = screen.getByRole('navigation', { name: 'Ana Boxer' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(LABELS);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([...ATHLETE_RECORD_PAGES]);
  });

  test('an admin is not shown Coach Cards, which refuses them', async () => {
    await renderLine('admin');
    const nav = screen.getByRole('navigation', { name: 'Ana Boxer' });
    const labels = within(nav).getAllByRole('link').map((link) => link.textContent);
    expect(labels).toEqual(LABELS.filter((label) => label !== 'Coach Cards'));
    expect(within(nav).queryByRole('link', { name: 'Coach Cards' })).toBeNull();
    expect(BUILDING.find((d) => d.href === COACH_CARDS_PAGE)!.roles).toEqual(['coach']);
  });

  test('with no role session there is no line', async () => {
    await renderLine(null);
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  test('no address carries the athlete', async () => {
    await renderLine('coach');
    for (const link of screen.getAllByRole('link')) expect(link.getAttribute('href')).not.toContain('ath-1');
  });

  test.each(ATHLETE_RECORD_PAGES.map((href, index) => [LABELS[index], href] as const))(
    'a plain click on %s hands the athlete to that page only',
    async (label, href) => {
      await renderLine('coach');
      fireEvent.click(screen.getByRole('link', { name: label }));
      const otherPage = href === ATHLETE_SAFETY_PAGE ? PASSBOOK_PAGE : ATHLETE_SAFETY_PAGE;
      expect(takeArrivalAthlete(otherPage)).toBeNull();
      fireEvent.click(screen.getByRole('link', { name: label }));
      expect(takeArrivalAthlete(href)).toBe('ath-1');
    },
  );

  test.each([
    ['a ctrl-click', { ctrlKey: true }],
    ['a cmd-click', { metaKey: true }],
    ['a shift-click', { shiftKey: true }],
    ['a middle click', { button: 1 }],
  ])('%s hands nothing off: the new tab arrives with nobody', async (_name, init) => {
    await renderLine('coach');
    fireEvent.click(screen.getByRole('link', { name: 'Development Plans' }), init);
    expect(takeArrivalAthlete('/coach/development-blocks')).toBeNull();
  });

  // `.btn` is unlayered and outranks a size utility, so a `.btn` link gets the
  // 55px floor and the 19.1px type only from a kiosk surface around it
  // (`[data-surface="kiosk"] .btn` in the design system). The line brings its
  // own, so it does not depend on the page it is shown on.
  test('each link on the line is a .btn inside a kiosk surface', async () => {
    await renderLine('coach');
    for (const link of screen.getAllByRole('link')) {
      expect(link.classList.contains('btn')).toBe(true);
      expect(link.closest('[data-surface="kiosk"]')).not.toBeNull();
    }
  });
});

describe('a name that opens Passbook (lane AS-11)', () => {
  test('opens Passbook on that athlete on a plain click, with no athlete in the address', async () => {
    await act(async () => {
      render(<AthleteNameLink athleteId="ath-2" name="Ben Boxer" />);
    });
    const link = screen.getByRole('link', { name: 'Ben Boxer' });
    expect(link.getAttribute('href')).toBe('/coach/passbook');
    expect(link.className).toContain('min-h-[var(--tap)]');
    expect(link.className).toContain('text-[length:var(--t-md)]');
    fireEvent.click(link, { ctrlKey: true });
    expect(takeArrivalAthlete(PASSBOOK_PAGE)).toBeNull();
    fireEvent.click(link);
    expect(takeArrivalAthlete(PASSBOOK_PAGE)).toBe('ath-2');
  });
});
