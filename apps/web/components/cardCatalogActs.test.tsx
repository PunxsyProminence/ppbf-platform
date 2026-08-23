/**
 * @jest-environment jsdom
 */

/**
 * THE PALETTE DOES THINGS NOW, AND THE DANGEROUS PART IS WHICH THINGS.
 *
 * A ⌘K that only navigates cannot hurt anybody: the worst it does is put you
 * on a page you did not want. The moment it runs actions, every row is a
 * loaded control one Enter away, so the tests that matter most here are not
 * "does the bell ring" — they are:
 *
 *   · no act calls an endpoint that does not exist in this repository, and
 *   · coach triage is still not bound, for the reasons written out in
 *     shortcuts.ts.
 *
 * The first is checked STRUCTURALLY, by reading the component's own source and
 * resolving every API path it contains against the app/api tree. A behavioural
 * test cannot catch a typo'd route — fetch is mocked, so a wrong path passes.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const push = jest.fn();
const replace = jest.fn();

/* Which room the drawer is standing in. GlobalRoleHeader mounts this component
   on every route, so the pathname is the only thing that tells it whether it is
   on the gym floor or in the board room -- and half the tests below are about
   what it must NOT offer in the four rooms whose DNA forbids an egg. */
let pathname = '/dashboard';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => pathname,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

let role: string | null = 'coach';
const clearRoleSession = jest.fn();

// useSyncExternalStore compares snapshots by identity: a mock that builds a
// fresh object per call re-renders forever and fails with "Maximum update
// depth exceeded" rather than anything to do with this feature.
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
  clearRoleSession: (...args: unknown[]) => clearRoleSession(...args),
}));

import CardCatalog from './CardCatalog';
import { resetGymSoundForTests } from './useGymSound';
import { readDesignSystemCss } from '../src/design/readDesignSystemCss';

const CATALOG_SOURCE = readFileSync(path.resolve(__dirname, './CardCatalog.tsx'), 'utf8');
const API_ROOT = path.resolve(__dirname, '../app/api');

function openCatalog() {
  act(() => {
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
  });
}

function type(value: string) {
  act(() => {
    fireEvent.change(screen.getByRole('combobox'), { target: { value } });
  });
}

beforeEach(() => {
  push.mockClear();
  replace.mockClear();
  clearRoleSession.mockClear();
  role = 'coach';
  pathname = '/dashboard';
  window.localStorage.clear();
  resetGymSoundForTests();
  (globalThis as { fetch?: unknown }).fetch = jest.fn(() => Promise.resolve({ ok: true }));
});

/* ==========================================================================
   THE ONE THAT MATTERS: NO ACT BINDS TO AN ENDPOINT THAT DOES NOT EXIST
   ========================================================================== */

describe('every endpoint an act calls is real', () => {
  it('resolves every /api/ path in the component against the route tree', () => {
    const paths = [...CATALOG_SOURCE.matchAll(/\/api\/[a-z0-9/_-]+/gi)].map((m) => m[0]);

    // If this ever finds nothing, the regex has drifted away from how the
    // component writes its calls and the test has quietly stopped testing.
    expect(paths.length).toBeGreaterThan(0);

    for (const apiPath of paths) {
      const routeFile = path.join(API_ROOT, apiPath.replace(/^\/api\//, ''), 'route.ts');
      expect({ apiPath, exists: existsSync(routeFile) }).toEqual({ apiPath, exists: true });
    }
  });

  it('calls exactly the one endpoint it is supposed to', () => {
    // A change that adds a second server call to the palette should have to
    // come past this line and think about the role behind it.
    const paths = new Set([...CATALOG_SOURCE.matchAll(/\/api\/[a-z0-9/_-]+/gi)].map((m) => m[0]));
    expect([...paths]).toEqual(['/api/pilot/auth/logout']);
  });
});

/* ==========================================================================
   COACH TRIAGE IS STILL NOT BOUND
   ========================================================================== */

describe('coach triage stays unbound', () => {
  it('is nowhere in the palette', () => {
    // The queue holds intake cases, approval is deliberately gated behind a
    // human document review, and 'promote' carries a whole payload there is no
    // keystroke-sized version of. See the addendum in shortcuts.ts.
    for (const forbidden of ['coach-reviews', 'review-action', 'review-projection', 'intake']) {
      expect(CATALOG_SOURCE).not.toContain(`/api/pilot/${forbidden}`);
      expect(CATALOG_SOURCE).not.toContain(`/api/pilot/shadow/${forbidden}`);
    }
  });

  it('offers no approve, reject or promote row to a coach', () => {
    role = 'coach';
    render(<CardCatalog />);
    openCatalog();
    for (const verb of ['approve', 'reject', 'promote', 'triage', 'deny']) {
      type(verb);
      expect(screen.queryByText(new RegExp(`\\b${verb}`, 'i'))).toBeNull();
    }
  });

  it('is documented in the registry rather than silently absent', () => {
    // A gap nobody wrote down is a gap the next contributor closes by
    // accident. The addendum has to name the endpoint that now exists and say
    // why it is still not bindable.
    const registry = readFileSync(path.resolve(__dirname, './shortcuts.ts'), 'utf8');
    expect(registry).toContain('/api/pilot/intake/review-action');
    expect(registry.toLowerCase()).toContain('document review');
  });
});

/* ==========================================================================
   THE ACTS THEMSELVES
   ========================================================================== */

describe('the acts', () => {
  it('shows what you can do without being asked, and still lists the doors', () => {
    render(<CardCatalog />);
    openCatalog();
    expect(screen.getByText('Things you can do here')).toBeTruthy();
    expect(screen.getByText('Print this page')).toBeTruthy();
  });

  it('draws an act differently from a door, so one is never mistaken for the other', () => {
    render(<CardCatalog />);
    openCatalog();
    type('print');
    const row = screen.getByText('Print this page').closest('li');
    expect(row?.querySelector('.catalog-act-glyph')).toBeTruthy();
    // A door shows its route in mono type; an act must not.
    expect(row?.querySelector('code')).toBeNull();
  });

  it('does not put itself in what it prints', () => {
    // The design system's print block documents that it hides the catalog and
    // never did -- which did not matter until the catalog could start a print.
    const sheet = readDesignSystemCss(
      path.resolve(__dirname, '../../../design-system/ppbf.css'),
    );
    const printBlocks = [...sheet.matchAll(/@media print\s*\{[\s\S]*?\n\}/g)].map((m) => m[0]);
    expect(printBlocks.some((block) => /\.catalog\b/.test(block))).toBe(true);
  });

  it('runs the highlighted act on Enter', () => {
    const print = jest.fn();
    (window as unknown as { print: () => void }).print = print;

    render(<CardCatalog />);
    openCatalog();
    type('print');
    act(() => {
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    });
    expect(print).toHaveBeenCalled();
  });

  it('stays open and reports, rather than vanishing without a word', () => {
    render(<CardCatalog />);
    openCatalog();
    type('copy link');
    act(() => {
      fireEvent.mouseDown(screen.getByText('Copy a link to this page'));
    });
    // A palette that closes the instant you use it leaves a silent action --
    // a bell with the volume down, a copy on a browser with no clipboard --
    // looking exactly like a broken one.
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/copied|clipboard/i);
  });

  it('signs out through the endpoint that exists, with the cookie attached', async () => {
    render(<CardCatalog />);
    openCatalog();
    type('sign out');
    await act(async () => {
      fireEvent.mouseDown(screen.getByText('Sign out'));
    });

    const fetchMock = globalThis.fetch as unknown as jest.Mock;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/pilot/auth/logout');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(clearRoleSession).toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith('/login');
  });

  it('offers no sign out to a session that has none', () => {
    role = null;
    render(<CardCatalog />);
    openCatalog();
    type('sign out');
    expect(screen.queryByText('Sign out')).toBeNull();
  });

  it('still navigates, because it is still a catalog', () => {
    render(<CardCatalog />);
    openCatalog();
    type('bell');
    // The dashboard door is labelled "Bell" -- the act and the door coexist.
    const door = screen.getByText('/dashboard');
    act(() => { fireEvent.mouseDown(door); });
    expect(push).toHaveBeenCalledWith('/dashboard');
  });
});

/* ==========================================================================
   THE BELL — HIDDEN, BUT NOT A PUZZLE
   ========================================================================== */

describe('ringing the bell by hand', () => {
  it('is not advertised in the browse list', () => {
    render(<CardCatalog />);
    openCatalog();
    expect(screen.queryByText('Ring the bell')).toBeNull();
  });

  it('is right there for anybody who wonders and types "bell"', () => {
    // Discoverable by curiosity, not a key combination nobody will ever press.
    render(<CardCatalog />);
    openCatalog();
    type('bell');
    expect(screen.getByText('Ring the bell')).toBeTruthy();
  });

  it('is also found by "ring" and by "gong"', () => {
    render(<CardCatalog />);
    openCatalog();
    for (const word of ['ring', 'gong', 'round']) {
      type(word);
      expect(screen.getByText('Ring the bell')).toBeTruthy();
    }
  });

  it('rings VISIBLY when sound is off, because sound is never the only channel', () => {
    // Rule 2 of the design system's sound engine. jsdom has no AudioContext,
    // which makes it exactly the locked-down-kiosk case: the ring has to be
    // carried entirely by the screen.
    render(<CardCatalog />);
    openCatalog();
    type('bell');
    act(() => {
      fireEvent.mouseDown(screen.getByText('Ring the bell'));
    });
    expect(screen.getByRole('status').textContent).toMatch(/rung/i);
    expect(screen.getByRole('status').textContent).toMatch(/sound is off/i);
  });

  it('never turns sound on by itself — opt-in, and off by default', () => {
    // Rule 1. A bell that switches the speakers on is a bell that surprises a
    // gym floor at session time.
    render(<CardCatalog />);
    openCatalog();
    type('bell');
    act(() => {
      fireEvent.mouseDown(screen.getByText('Ring the bell'));
    });
    expect(window.localStorage.getItem('ppbf.sound.enabled')).not.toBe('1');
  });

  it('offers the sound switch as its own act, so turning it on is deliberate', () => {
    render(<CardCatalog />);
    openCatalog();
    type('sound');
    expect(screen.getByText('Turn the gym sound on')).toBeTruthy();
  });
});

/* ==========================================================================
   THE GYM NOTICING
   ========================================================================== */

describe('the quiet acknowledgments', () => {
  it('nods once when somebody has plainly found the drawer', () => {
    window.localStorage.setItem('ppbf.catalog.opens', '4');
    render(<CardCatalog />);
    openCatalog();
    expect(screen.getByText(/you know where the drawer is/i)).toBeTruthy();
  });

  it('does not nod on the fourth time, or on the sixth', () => {
    window.localStorage.setItem('ppbf.catalog.opens', '2');
    const first = render(<CardCatalog />);
    openCatalog();
    expect(screen.queryByText(/you know where the drawer is/i)).toBeNull();
    first.unmount();

    window.localStorage.setItem('ppbf.catalog.opens', '20');
    render(<CardCatalog />);
    openCatalog();
    expect(screen.queryByText(/you know where the drawer is/i)).toBeNull();
  });

  it('says one dry line to somebody here before dawn', () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 2, 4, 4, 40));
    try {
      render(<CardCatalog />);
      openCatalog();
      expect(screen.getByText(/before six/i)).toBeTruthy();
      // Dry: no exclamation, no ornament.
      expect(screen.getByText(/before six/i).textContent).not.toContain('!');
    } finally {
      jest.useRealTimers();
    }
  });

  it('says nothing at an ordinary hour', () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 2, 4, 14, 0));
    try {
      render(<CardCatalog />);
      openCatalog();
      expect(screen.queryByText(/before six/i)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

/* ==========================================================================
   THE EGGS HAVE A ROOM

   docs/shadow-ui/ROOM-PURPOSE-DNA.md answers "Easter eggs?" for all six rooms.
   Twice it is yes -- the gym floor (their PRIMARY HOME) and the front office.
   Four times it is NEVER, in capitals: board, file, clinic, and after hours on
   a deny. docs/shadow-ui/EGGS-LOAD-FIRST-12.md says it from the other end:
   "Never load onto: board, file, clinic, shadow deny."

   This palette is mounted by GlobalRoleHeader on EVERY route, so before this
   change both of its eggs -- the hidden bell, and the gym's noticing lines --
   were offered in all six. A board member reading a governance screen could
   type "bell" and ring one; an admin working the clearance ladder in the
   clinic got told "Before six. Somebody always is."
   ========================================================================== */

const FORBIDDEN = [
  ['the board room', '/board'],
  ['the file room', '/research'],
  ['the clinic', '/admin/escalations'],
  ['after hours', '/shadow'],
] as const;

const ALLOWED = [
  ['the front office', '/dashboard'],
  ['the gym floor', '/schedule'],
] as const;

describe('the bell knows which room it is in', () => {
  it.each(FORBIDDEN)('is not in %s, however plainly you ask for it', (_room, route) => {
    pathname = route;
    render(<CardCatalog />);
    openCatalog();
    for (const word of ['bell', 'ring', 'gong']) {
      type(word);
      expect(screen.queryByText('Ring the bell')).toBeNull();
    }
  });

  it.each(ALLOWED)('is still there in %s for anybody who wonders', (_room, route) => {
    pathname = route;
    render(<CardCatalog />);
    openCatalog();
    type('bell');
    expect(screen.getByText('Ring the bell')).toBeTruthy();
  });

  it('follows a nested route into the room it belongs to', () => {
    pathname = '/board/treasurer/2026';
    render(<CardCatalog />);
    openCatalog();
    type('bell');
    expect(screen.queryByText('Ring the bell')).toBeNull();
  });

  // The room rule must cost the drawer nothing else: a board member still gets
  // a working command palette, they just do not get a joke in it.
  it.each(FORBIDDEN)('leaves every other act working in %s', (_room, route) => {
    pathname = route;
    render(<CardCatalog />);
    openCatalog();
    expect(screen.getByText('Print this page')).toBeTruthy();
    expect(screen.getByText('Copy a link to this page')).toBeTruthy();
    expect(screen.getByText('Sign out')).toBeTruthy();
    type('sound');
    expect(screen.getByText('Turn the gym sound on')).toBeTruthy();
  });
});

describe('the gym noticing knows it too', () => {
  it.each(FORBIDDEN)('says nothing before dawn in %s', (_room, route) => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 2, 4, 4, 40));
    try {
      pathname = route;
      render(<CardCatalog />);
      openCatalog();
      expect(screen.queryByText(/before six/i)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(ALLOWED)('still says it in %s', (_room, route) => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 2, 4, 4, 40));
    try {
      pathname = route;
      render(<CardCatalog />);
      openCatalog();
      expect(screen.getByText(/before six/i)).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not nod in a forbidden room', () => {
    window.localStorage.setItem('ppbf.catalog.opens', '4');
    pathname = '/board';
    render(<CardCatalog />);
    openCatalog();
    expect(screen.queryByText(/you know where the drawer is/i)).toBeNull();
  });

  /* The nod fires on the fifth open and only ever once, so counting opens in a
     room that can never show it would spend the egg where nobody can see it.
     The count does not move in the board room; the fifth open on the floor is
     still the fifth. */
  it('does not spend the fifth-open nod in a room that could never show it', () => {
    window.localStorage.setItem('ppbf.catalog.opens', '4');
    pathname = '/board';
    const boardRoom = render(<CardCatalog />);
    openCatalog();
    expect(window.localStorage.getItem('ppbf.catalog.opens')).toBe('4');
    boardRoom.unmount();

    pathname = '/schedule';
    render(<CardCatalog />);
    openCatalog();
    expect(screen.getByText(/you know where the drawer is/i)).toBeTruthy();
  });
});
