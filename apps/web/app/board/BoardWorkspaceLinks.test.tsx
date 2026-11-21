/**
 * @jest-environment jsdom
 */

// Lane AS-12 (app scrub BOA-03, BOA-04, BOA-07): the one row that takes a board
// member to the board's three reads, and the President to Board Seats.
//
// Two things are pinned here, and both are about meaning rather than look:
//  - nobody is shown a link to a page that refuses them (OD-2026-10-05-006
//    part (b), F-003 option A: the platform owner is not served the board's
//    aggregates, so those doors are hidden from that role);
//  - each label is the title of the page it opens (OD-2026-10-17-001 ruling 1).

import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';

import { useBoardSession } from '@/components/BoardRoleGate';

import BoardWorkspaceLinks from './BoardWorkspaceLinks';
import type { BoardSeatSlug } from './boardWorkspaceConfig';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

jest.mock('@/components/BoardRoleGate', () => ({
  __esModule: true,
  useBoardSession: jest.fn(),
}));

const mockUseBoardSession = jest.mocked(useBoardSession);

type Session = { role: 'board' | 'platform_owner'; seats: BoardSeatSlug[] } | null;

const HUB = ['Board Hub', '/board'] as const;
const READS = [
  ['Program Aggregates', '/board/aggregates'],
  ['Escalation Ladder', '/board/escalation-monitoring'],
  ['Hand-Filed Compliance Register', '/board/compliance-monitoring'],
] as const;
const SEATS = ['Board Seats', '/admin/board-seats'] as const;

/** The row's links as [label, href], in the order drawn; [] when no row is drawn. */
function renderLinks(session: Session, seat?: BoardSeatSlug): Array<[string, string]> {
  mockUseBoardSession.mockReturnValue(session);
  render(<BoardWorkspaceLinks seat={seat} />);
  const row = screen.queryByRole('navigation', { name: 'Workspace Links' });
  if (!row) return [];
  return within(row).getAllByRole('link').map((link) => [link.textContent ?? '', link.getAttribute('href') ?? '']);
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('on the Board Hub', () => {
  test('a board member with no seat is shown the three reads and Board Seats, and no link to the hub itself', () => {
    expect(renderLinks({ role: 'board', seats: [] })).toEqual([...READS, SEATS]);
  });

  test('a seat holder is shown the same row', () => {
    expect(renderLinks({ role: 'board', seats: ['treasurer'] })).toEqual([...READS, SEATS]);
  });

  test('the platform owner is shown no row: every one of those pages refuses that role', () => {
    expect(renderLinks({ role: 'platform_owner', seats: [] })).toEqual([]);
    expect(document.querySelector('a')).toBeNull();
    expect(screen.queryByText('Workspace Links')).toBeNull();
  });

  test('with no board session above it, no row is drawn', () => {
    expect(renderLinks(null)).toEqual([]);
    expect(document.querySelector('a')).toBeNull();
  });
});

describe('on a seat workspace', () => {
  test('a seat holder is shown Board Hub and the three reads, and not Board Seats', () => {
    expect(renderLinks({ role: 'board', seats: ['treasurer'] }, 'treasurer')).toEqual([HUB, ...READS]);
  });

  test('the President workspace also carries Board Seats', () => {
    expect(renderLinks({ role: 'board', seats: ['president'] }, 'president')).toEqual([HUB, ...READS, SEATS]);
  });

  test('the President reading another seat under oversight is not shown Board Seats there', () => {
    expect(renderLinks({ role: 'board', seats: ['president'] }, 'secretary')).toEqual([HUB, ...READS]);
  });

  test.each(['president', 'safety-director'] as const)(
    'the platform owner on the %s workspace is shown Board Hub only',
    (seat) => {
      expect(renderLinks({ role: 'platform_owner', seats: [] }, seat)).toEqual([HUB]);
      for (const [, href] of [...READS, SEATS]) {
        expect(document.querySelector(`a[href="${href}"]`)).toBeNull();
      }
    },
  );

  test('with no board session above it, only Board Hub is offered', () => {
    expect(renderLinks(null, 'treasurer')).toEqual([HUB]);
  });
});

/* The rule above is only right while the pages keep the gates it was read
   from. These read the pages' own source, so a gate or a title that changes
   turns this red and the row is looked at again. A source read: it shows what
   the page files say, not what a browser is served. */
describe('the row matches the pages it opens (source read)', () => {
  const page = (relative: string) => readFileSync(path.resolve(__dirname, '..', relative), 'utf8');

  test.each([
    [HUB[0], 'board/page.tsx'],
    [READS[0][0], 'board/aggregates/page.tsx'],
    [READS[1][0], 'board/escalation-monitoring/page.tsx'],
    [READS[2][0], 'board/compliance-monitoring/page.tsx'],
    [SEATS[0], 'admin/board-seats/page.tsx'],
  ])('"%s" is the title of the page it opens', (label, file) => {
    expect(page(file)).toContain(`>${label}</h1>`);
  });

  test.each([
    'board/aggregates/page.tsx',
    'board/escalation-monitoring/page.tsx',
    'board/compliance-monitoring/page.tsx',
  ])('%s admits the board role alone, so only a board session is linked to it', (file) => {
    expect(page(file)).toContain("<RoleSessionGate allowedRoles={['board']}>");
  });

  test('Board Seats admits the gym admin and the board role, and not the platform owner', () => {
    expect(page('admin/board-seats/page.tsx')).toContain("<RoleSessionGate allowedRoles={['admin', 'board']}>");
  });
});
