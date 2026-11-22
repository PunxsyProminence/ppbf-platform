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
    // AS-4 (U2-4c; S2-2 A): Jump is Search.
    expect(screen.getByRole('button', { name: /open search/i }).textContent).toContain('Search');
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

  it('browses All pages by the Room Map\'s rooms before anything is typed', () => {
    render(<CardCatalog />);
    openCatalog();
    expect(screen.getByText('All pages')).toBeTruthy();
    // A coach sees the Drill Cabinet; a coach has no business in the Board Room.
    expect(screen.getByText('Drill Cabinet')).toBeTruthy();
    expect(screen.queryByText('Board Room')).toBeNull();
  });

  it('filters as you type and opens the highlighted card on Enter', () => {
    render(<CardCatalog />);
    openCatalog();
    const field = screen.getByRole('combobox');
    fireEvent.change(field, { target: { value: 'drills' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/coach/drills');
  });

  it('finds a surface by keyword rather than title', () => {
    render(<CardCatalog />);
    openCatalog();
    const field = screen.getByRole('combobox');
    fireEvent.change(field, { target: { value: 'countermovement' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/coach/assessments');
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

  /* THE OPERATIONS HUB, ASKED FOR BY EVERY NAME IT ANSWERS TO.

     The door carried `roles: OPEN` until 2026-08-26, and the catalog searches
     labels, keywords AND hrefs -- so a coach typing "mission control" found
     the hub, and so did a signed-out visitor. The owner decision makes it
     administration; a coach must find it under none of its names. */
  it.each(['operations', 'mission control', 'hub', '/operations'])(
    'does not offer a coach the hub, asked for as %p',
    (query) => {
      role = 'coach';
      render(<CardCatalog />);
      openCatalog();
      fireEvent.change(screen.getByRole('combobox'), { target: { value: query } });

      expect(screen.queryByText('Operations')).toBeNull();
    },
  );

  it('still offers the hub to an admin, so the search is narrowed and not broken', () => {
    role = 'admin';
    render(<CardCatalog />);
    openCatalog();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'mission control' } });

    expect(screen.getByText('Operations')).toBeTruthy();
  });

  it('still offers a coach the two surfaces under the same path prefix', () => {
    // /operations/external-competition and /operations/wrestling-league carry
    // their own ['coach', 'admin'] and are not part of the hub's decision.
    // After it, the catalog and the corridor are a coach's only route to them.
    role = 'coach';
    render(<CardCatalog />);
    openCatalog();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'wrestling' } });

    expect(screen.getByText('Wrestling League')).toBeTruthy();
  });
});

describe('Corridor: the "you are here" plate (AS-4, U2-4c)', () => {
  // S2-2 A: "the Rooms list becomes 'All pages' inside Search". The corridor's
  // menu is gone; its trigger stays as the plate that says where you are, in
  // Search's own rooms, and opens Search there.
  it('names the Room Map room you are standing in, and the page', () => {
    pathname = '/coach/drills';
    render(<Corridor />);
    const plate = screen.getByRole('button', { name: /where you are/i });
    expect(plate.textContent).toContain('Drill Cabinet');
    expect(plate.textContent).toContain('Drill Library');
  });

  it('names Lab for an admin on a Lab page, and the room for a coach on the same page', () => {
    role = 'admin';
    pathname = '/research';
    const { unmount } = render(<Corridor />);
    expect(screen.getByRole('button', { name: /where you are/i }).textContent).toContain('Lab');
    unmount();
    role = 'coach';
    render(<Corridor />);
    expect(screen.getByRole('button', { name: /where you are/i }).textContent).toContain('File Room');
  });

  it('lists no page and holds no link: every page is in Search', () => {
    pathname = '/coach/drills';
    const { container } = render(<Corridor />);
    fireEvent.click(screen.getByRole('button', { name: /where you are/i }));
    expect(container.querySelectorAll('a, [href]')).toHaveLength(0);
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('opens Search at All pages, at the room it names', () => {
    pathname = '/coach/drills';
    const scrolled: string[] = [];
    const proto = window.HTMLElement.prototype as unknown as { scrollIntoView?: () => void };
    const before = proto.scrollIntoView;
    proto.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.getAttribute('data-group') ?? '');
    };
    try {
      render(<><Corridor /><CardCatalog /></>);
      act(() => { fireEvent.click(screen.getByRole('button', { name: /where you are/i })); });
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(screen.getByText('All pages')).toBeTruthy();
      expect(scrolled).toContain('drill-cabinet');
    } finally {
      proto.scrollIntoView = before;
    }
  });
});
