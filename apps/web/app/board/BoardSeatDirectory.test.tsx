/**
 * @jest-environment jsdom
 */

// Lane BT, BOA-06: the seat directory words its refusal by the viewer's own
// access ("Not your seat"), not by whether anyone holds the seat. Which seats
// open is resolveBoardSeatAccess, unchanged; this pins the words and that the
// refusal and the way in still go to the same cards.

import type { ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';

import { useBoardSession } from '@/components/BoardRoleGate';
import BoardSeatDirectory from './BoardSeatDirectory';
import { boardSeatConfigs } from './boardWorkspaceConfig';

jest.mock('@/components/BoardRoleGate', () => ({
  __esModule: true,
  useBoardSession: jest.fn(),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, className }: { readonly children: ReactNode; readonly href: string; readonly className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

const mockUseBoardSession = jest.mocked(useBoardSession);

afterEach(() => {
  jest.clearAllMocks();
});

function card(seatLabel: string): HTMLElement {
  return screen.getByRole('heading', { name: seatLabel }).closest('article') as HTMLElement;
}

test('a seat the viewer does not hold reads "Not your seat", never an occupancy claim', () => {
  mockUseBoardSession.mockReturnValue({ role: 'board', seats: ['treasurer'] });
  render(<BoardSeatDirectory />);

  const treasurer = boardSeatConfigs.find((seat) => seat.slug === 'treasurer');
  const secretary = boardSeatConfigs.find((seat) => seat.slug === 'secretary');
  if (!treasurer || !secretary) throw new Error('seat catalogue changed');

  const own = within(card(treasurer.seatLabel));
  expect(own.getByRole('link', { name: 'Open Your Workspace' }).getAttribute('href')).toBe('/board/treasurer');
  expect(own.queryByText('Not your seat')).toBeNull();

  const other = within(card(secretary.seatLabel));
  expect(other.queryByRole('link')).toBeNull();
  expect(other.getByText('Not your seat')).toBeTruthy();
  expect(other.getByText('The president and chair can open any workspace; every other seat opens its own.')).toBeTruthy();

  // Every refused card says the same, and none says the seat is held.
  const refused = screen.getAllByText('Not your seat');
  expect(refused).toHaveLength(boardSeatConfigs.length - 1);
  expect(document.body.textContent).not.toMatch(/Seat held|Held by another seat/);
});

test('the president opens every workspace, so no card is refused', () => {
  mockUseBoardSession.mockReturnValue({ role: 'board', seats: ['president'] });
  render(<BoardSeatDirectory />);

  expect(screen.queryByText('Not your seat')).toBeNull();
  expect(screen.getAllByRole('link')).toHaveLength(boardSeatConfigs.length);
});
