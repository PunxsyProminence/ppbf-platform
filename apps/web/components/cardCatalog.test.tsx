/**
 * @jest-environment jsdom
 */

// The catalog is keyboard-first, so the keyboard is what gets tested: the chord
// that opens it, the "/" that must never steal a keystroke from a form, the
// arrows, Enter, Escape, and handing focus back where it came from.

import { render, screen, fireEvent, act } from '@testing-library/react';
import type { ReactNode } from 'react';

const push = jest.fn();
let pathname = '/dashboard';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => pathname,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

let role: string | null = 'coach';

// useSyncExternalStore demands a referentially stable snapshot: returning a
// fresh object on every call spins React until it gives up. The real
// getRoleSessionSnapshot caches by raw string and hands back the same object
// (roleSession.ts), so the mock has to do the same or it tests nothing but its
// own bug.
const sessionCache = new Map<string, { role: string; expiresAt: number }>();
function snapshot() {
  if (!role) return null;
  let cached = sessionCache.get(role);
  if (!cached) {
    cached = { role, expiresAt: 8.64e15 };
    sessionCache.set(role, cached);
  }
  return cached;
}

jest.mock('./roleSession', () => ({
  subscribeRoleSession: () => () => {},
  getRoleSessionSnapshot: () => snapshot(),
}));

import CardCatalog from './CardCatalog';
import Corridor from './Corridor';

function openCatalog() {
  act(() => {
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
  });
}

beforeEach(() => {
  push.mockClear();
  role = 'coach';
  pathname = '/dashboard';
});

describe('CardCatalog', () => {
  it('stays shut until asked, showing only the quiet trigger', () => {
    render(<CardCatalog />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: /open the card catalog/i })).toBeTruthy();
  });

  it('opens on Cmd+K and closes on Escape', () => {
    render(<CardCatalog />);
    openCatalog();
    expect(screen.getByRole('dialog')).toBeTruthy();
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens on a bare "/"', () => {
    render(<CardCatalog />);
    act(() => { fireEvent.keyDown(window, { key: '/' }); });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  // The whole reason "/" is guarded: a coach typing a note must not have the
  // slash swallowed by a palette.
  it('does NOT open on "/" while the user is typing in a field', () => {
    render(
      <>
        <textarea data-testid="note" />
        <CardCatalog />
      </>,
    );
    const note = screen.getByTestId('note');
    act(() => { fireEvent.keyDown(note, { key: '/' }); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('still opens on Cmd+K from inside a field, because the chord is unambiguous', () => {
    render(
      <>
        <input data-testid="field" />
        <CardCatalog />
      </>,
    );
    act(() => { fireEvent.keyDown(screen.getByTestId('field'), { key: 'k', metaKey: true }); });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('browses the building room by room before anything is typed', () => {
    render(<CardCatalog />);
    openCatalog();
    // Coach sees the gym floor; a coach has no business in the board room.
    expect(screen.getByText('Gym Floor')).toBeTruthy();
    expect(screen.queryByText('Board Room')).toBeNull();
  });

  it('filters as you type and opens the highlighted card on Enter', () => {
    render(<CardCatalog />);
    openCatalog();
    const field = screen.getByRole('combobox');
    fireEvent.change(field, { target: { value: 'review' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/coach/review-queue');
  });

  it('finds a surface by keyword rather than title', () => {
    render(<CardCatalog />);
    openCatalog();
    const field = screen.getByRole('combobox');
    fireEvent.change(field, { target: { value: 'layer 10' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/coach/review-queue');
  });

  it('moves the cursor with the arrow keys', () => {
    render(<CardCatalog />);
    openCatalog();
    const field = screen.getByRole('combobox');
    fireEvent.change(field, { target: { value: 'video' } });

    const first = screen.getAllByRole('option')[0];
    expect(first.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(field, { key: 'ArrowDown' });
    const opts = screen.getAllByRole('option');
    expect(opts[0].getAttribute('aria-selected')).toBe('false');
    expect(opts[1].getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(field, { key: 'ArrowUp' });
    expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('true');
  });

  it('does not run off the end of the list with ArrowDown', () => {
    render(<CardCatalog />);
    openCatalog();
    const field = screen.getByRole('combobox');
    fireEvent.change(field, { target: { value: 'review' } });
    const count = screen.getAllByRole('option').length;
    for (let i = 0; i < count + 5; i++) fireEvent.keyDown(field, { key: 'ArrowDown' });
    const selected = screen.getAllByRole('option').filter(
      (o) => o.getAttribute('aria-selected') === 'true',
    );
    expect(selected).toHaveLength(1);
    expect(push).not.toHaveBeenCalled();
  });

  it('says so plainly when nothing is filed under the query', () => {
    render(<CardCatalog />);
    openCatalog();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzzqqq' } });
    expect(screen.getByText(/nothing filed under that/i)).toBeTruthy();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('pressing Enter on an empty result set does nothing rather than throwing', () => {
    render(<CardCatalog />);
    openCatalog();
    const field = screen.getByRole('combobox');
    fireEvent.change(field, { target: { value: 'zzzqqq' } });
    expect(() => fireEvent.keyDown(field, { key: 'Enter' })).not.toThrow();
    expect(push).not.toHaveBeenCalled();
  });

  it('hands focus back to where it came from on Escape', () => {
    render(
      <>
        <button data-testid="origin">origin</button>
        <CardCatalog />
      </>,
    );
    const origin = screen.getByTestId('origin');
    origin.focus();
    expect(document.activeElement).toBe(origin);

    openCatalog();
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(document.activeElement).toBe(origin);
  });

  it('never offers a signed-out visitor a gated surface', () => {
    role = null;
    render(<CardCatalog />);
    openCatalog();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'people' } });
    // /admin/people is admin-gated; it must not appear.
    expect(screen.queryByText('People')).toBeNull();
  });
});

describe('Corridor', () => {
  it('names the room you are standing in', () => {
    pathname = '/coach/review-queue';
    render(<Corridor />);
    expect(screen.getByRole('button', { expanded: false }).textContent).toContain('Gym Floor');
    expect(screen.getByRole('button', { expanded: false }).textContent).toContain('Review Queue');
  });

  it('opens to the rooms the session can enter, and no others', () => {
    render(<Corridor />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByRole('navigation')).toBeTruthy();
    expect(screen.getByText('Gym Floor')).toBeTruthy();
    expect(screen.queryByText('Board Room')).toBeNull();
  });

  it('marks the current room as where you are', () => {
    pathname = '/coach/review-queue';
    render(<Corridor />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText(/you are here/i)).toBeTruthy();
  });

  it('marks the current surface with aria-current', () => {
    pathname = '/coach/review-queue';
    render(<Corridor />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    const link = screen.getByRole('link', { name: 'Review Queue' });
    expect(link.getAttribute('aria-current')).toBe('page');
  });

  it('closes on Escape', () => {
    render(<Corridor />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByRole('navigation')).toBeTruthy();
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('shows a board session its seats and not the admin console', () => {
    role = 'board';
    pathname = '/board';
    render(<Corridor />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByRole('link', { name: 'Treasurer' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Capability Console' })).toBeNull();
  });
});
