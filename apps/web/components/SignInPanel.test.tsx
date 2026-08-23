/**
 * @jest-environment jsdom
 */

/**
 * THE FRONT DOOR HAD NO TEST.
 *
 * SignInPanel is the single component behind both /login and the /public
 * sign-in popover -- every person who uses this platform passes through it --
 * and nothing in the repository rendered it. This file exists because the
 * board treatment below touched it, and restyling an untested sign-in flow is
 * how a gym finds out on a Monday that nobody can get in.
 *
 * The board treatment these were written alongside has been reverted -- it
 * rendered dark-on-dark and unreadable. These tests were the valuable half of
 * that work and none of them depended on it: they describe what the door must
 * DO, not what it looks like, so they outlive any number of restyles. Deleting
 * them along with the styling would have put the front door back to having no
 * test at all, which is how it got into this state.
 */

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import SignInPanel from './SignInPanel';

/* The `?error=` a refusal redirect arrives with. A plain mutable value rather
   than a jest mock: `jest.clearAllMocks()` below clears calls but not a queued
   return value, so a mocked `get` would leak the previous test's refusal into
   the next one. This is reset in beforeEach with everything else. */
let authErrorParam: string | null = null;
const searchParams = { get: (key: string) => (key === 'error' ? authErrorParam : null) };
const router = { replace: jest.fn(), push: jest.fn() };

jest.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => searchParams,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

/* Reaches the network on mount and is not what this file is about. */
jest.mock('@/components/AnnouncementBanner', () => ({
  __esModule: true,
  default: () => <div data-testid="announcements" />,
}));

const originalFetch = global.fetch;

beforeEach(() => {
  authErrorParam = null;
  jest.clearAllMocks();
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

async function renderPanel(props: { embedded?: boolean } = {}) {
  const result = render(<SignInPanel {...props} />);
  // The panel checks for an existing session on mount.
  await act(async () => {});
  return result;
}

/**
 * THE PICKER IS GONE (approved layout AF-01 / AF-M02, 2026-08-22).
 *
 * Five of these tests used to click a method tab before asserting anything,
 * because only one method was rendered at a time and a default had to be
 * chosen. All three now stand open on the page together, so the contract they
 * describe gets STRONGER rather than weaker: every way in is not merely
 * reachable, it is present without anybody having to find the tab first.
 * That is the same promise the file was written to keep -- what the door must
 * DO -- restated for a door with three openings instead of one with a switch.
 */
describe('every way in still works', () => {
  test('offers all three sign-in methods at once, with no picker to find', async () => {
    await renderPanel();

    expect(screen.getByRole('button', { name: /continue with microsoft/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /send sign-in link/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeTruthy();
  });

  test('a way to enter a PIN is on the page from the start', async () => {
    const { container } = await renderPanel();

    expect(container.querySelector('input[type="password"], input[inputmode="numeric"]')).toBeTruthy();
  });

  test('a way to enter an email is on the page from the start', async () => {
    const { container } = await renderPanel();

    expect(container.querySelector('input[type="email"]')).toBeTruthy();
  });

  /* A PIN typed wrong on a shared tablet costs a rate-limit lockout, so the
     field can be read back. aria-pressed is the whole accessible answer to
     "is it showing"; the glyph sits on top of it, not instead of it. */
  test('the PIN can be revealed and hidden again', async () => {
    const { container } = await renderPanel();

    const reveal = screen.getByRole('button', { name: /show pin/i });
    expect(reveal.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('#login-pin')?.getAttribute('type')).toBe('password');

    await act(async () => {
      fireEvent.click(reveal);
    });

    expect(container.querySelector('#login-pin')?.getAttribute('type')).toBe('text');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /hide pin/i }));
    });

    expect(container.querySelector('#login-pin')?.getAttribute('type')).toBe('password');
  });

  test('a first-time member can still reach activation', async () => {
    const { container } = await renderPanel();

    expect(container.querySelector('a[href="/activate"]')).toBeTruthy();
  });

  test('someone who has forgotten a PIN is not left without a door', async () => {
    const { container } = await renderPanel();

    expect(container.querySelector('a[href="/athlete/sign-in"]')).toBeTruthy();
  });

  /* The approved mobile board carried "Your PIN is local and never leaves
     your device". The PIN is POSTed to /api/pilot/auth/login, so that line is
     false, and a false security claim on a door used by children is the one
     thing a decoration pass must never ship. This test is what keeps it out. */
  test('claims nothing false about where the PIN goes', async () => {
    const { container } = await renderPanel();

    expect(container.textContent).not.toMatch(/never leaves your device/i);
  });

  /* This assertion used to read `toMatch(/access logged/i)` -- it pinned the
     claim rather than checking it, and the claim was false. Nothing on any of
     the three doors records a refused attempt: PIN 401s before
     auditLoginEvent, magic-link consume 401s before its write, requesting a
     link deliberately writes nothing, and auditEventTypes.ts has no failure
     type to record one with. The panel may therefore promise a record of
     successes and nothing wider. Both directions are asserted, because the
     defect this replaces was a true-sounding line nobody re-derived. */
  test('promises only the sign-in record the system actually keeps', async () => {
    const { container } = await renderPanel();

    expect(container.textContent).toMatch(/successful sign-ins are recorded/i);
    expect(container.textContent).not.toMatch(/access logged/i);
    expect(container.textContent).not.toMatch(/every attempt/i);
  });
});

describe('the popover is the same door in a smaller room', () => {
  /* A light fixture hanging inside a modal dialog reads as a rendering bug. */
  test('hangs no lamp inside the modal', async () => {
    const { container } = await renderPanel({ embedded: true });

    expect(container.querySelector('.lamp')).toBeNull();
  });

  test('but is still the same framed panel', async () => {
    const { container } = await renderPanel({ embedded: true });

    expect(container.querySelector('.frame .frame-in')).toBeTruthy();
  });

  test('offers a way out that the standalone page does not need', async () => {
    await renderPanel({ embedded: true });

    expect(screen.getByRole('button', { name: /close sign in/i })).toBeTruthy();
  });

  test('the standalone page offers the public page instead of a close button', async () => {
    const { container } = await renderPanel();

    expect(screen.queryByRole('button', { name: /close sign in/i })).toBeNull();
    expect(container.querySelector('a[href="/public"]')).toBeTruthy();
  });
});

/**
 * THE REFUSAL AT THE DOOR IS NOT A MEDICAL ONE.
 *
 * A failed Microsoft sign-in comes back as a full-page redirect carrying
 * `?error=`, and this panel used to meet it with a red `--locked` banner --
 * the one treatment the owner's locked art policy of 2026-08-19 reserves for
 * MEDICALLY_NOT_ALLOWED alone, so that an unscoped coach and a same-day
 * medical hold never wear the same colour of "no" (RefusalStamp's header
 * carries the rule). The PIN and magic-link doors on this same panel were
 * already brass; only this one was still red.
 *
 * These tests pin both halves: that each refusal gets the mark that describes
 * it, and that the red does not come back. The colour assertion has been
 * watched to fail — the old panel was reinstated and it went red on
 * `--locked` and on the missing stamp — so it is a guard rather than a
 * hypothesis.
 */
describe('a refused sign-in wears the right kind of "no"', () => {
  const REFUSALS = [
    {
      param: 'not-invited',
      kind: 'get_permission',
      label: 'GET PERMISSION',
      sentence: 'This Microsoft account is not invited or not active.',
    },
    {
      param: 'auth-state-expired',
      kind: 'signed_out',
      label: 'SIGNED OUT',
      sentence:
        'Your sign-in session expired or the browser blocked the login cookies. Please try again.',
    },
    {
      param: 'auth-forbidden',
      kind: 'get_permission',
      label: 'GET PERMISSION',
      sentence:
        'This account signed in, but its role has no workspace yet. Ask your organization admin to finish setting it up.',
    },
    {
      param: 'privileged_auth_required',
      kind: 'wrong_door',
      label: 'WRONG DOOR',
      sentence: 'That area requires a Microsoft sign-in. Please continue with Microsoft.',
    },
    {
      param: 'unsupported_role',
      kind: 'wrong_door',
      label: 'WRONG DOOR',
      sentence: 'Your account role cannot open that area.',
    },
    {
      /* Not a value the app emits -- the point is that an unrecognised one
         still lands somewhere honest instead of blaming Microsoft. */
      param: 'something-nobody-has-written-yet',
      kind: 'cannot_be_done',
      label: 'CANNOT BE DONE',
      sentence: 'Microsoft sign-in failed. Please try again.',
    },
  ] as const;

  test.each(REFUSALS)(
    '?error=$param is stamped $kind, with its own sentence intact',
    async ({ param, kind, label, sentence }) => {
      authErrorParam = param;
      await renderPanel();

      const refusal = screen.getByRole('alert');
      expect(refusal.querySelector('[data-refusal-stamp]')?.getAttribute('data-refusal-stamp')).toBe(
        kind,
      );
      expect(refusal.textContent).toContain(label);
      // The copy is the copy. RefusalStamp appends it to its own standard
      // sentence, so the words the user reads must still be these exact ones.
      expect(refusal.textContent).toContain(sentence);
    },
  );

  /* THE GUARD. The red panel is what this ticket removed, and a test nobody
     has watched go red is a hypothesis -- this one was watched. `--locked` is
     matched with both dashes on purpose: one of the messages above contains
     the word "blocked", which a bare /locked/ would match forever. */
  test('never wears the red reserved for a medical refusal', async () => {
    authErrorParam = 'not-invited';
    const { container } = await renderPanel();

    const refusal = screen.getByRole('alert');
    expect(refusal.querySelector('[data-refusal-stamp]')).toBeTruthy();
    expect(refusal.querySelector('.stamp--brass')).toBeTruthy();
    expect(refusal.querySelector('.badge--locked')).toBeNull();
    expect(refusal.outerHTML).not.toMatch(/badge--locked/);
    expect(refusal.outerHTML).not.toMatch(/--locked/);
    // Nothing anywhere else on the door reintroduces it either.
    expect(container.innerHTML).not.toMatch(/--locked/);
    expect(container.innerHTML).not.toMatch(/badge--locked/);
  });

  /* The refusal is the reason the user was sent back here, so it is announced
     assertively even though RefusalStamp's six non-medical kinds carry
     role="status" on their own. */
  test('announces the refusal assertively', async () => {
    authErrorParam = 'auth-forbidden';
    await renderPanel();

    expect(screen.getByRole('alert')).toBeTruthy();
  });

  test('says nothing at all when nothing was refused', async () => {
    await renderPanel();

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/sign-in refused/i)).toBeNull();
  });
});
