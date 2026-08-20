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
 * So the behaviour tests come first and are the point. The composition tests
 * are second and they pin the two things that would be silently wrong rather
 * than visibly wrong: the stamp must not be announced, and the lamp must not
 * hang inside the modal.
 */

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import SignInPanel from './SignInPanel';

const searchParams = { get: () => null };
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

describe('every way in still works', () => {
  test('offers all three sign-in methods', async () => {
    await renderPanel();

    expect(screen.getByRole('button', { name: /^(\u2713 )?Microsoft$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^(\u2713 )?Email Link$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^(\u2713 )?Account ID \/ PIN$/ })).toBeTruthy();
  });

  test('opens on Microsoft, the method most staff use', async () => {
    await renderPanel();

    expect(screen.getByRole('button', { name: /^(\u2713 )?Microsoft$/ }).getAttribute('aria-pressed')).toBe('true');
  });

  /* aria-pressed is the whole accessible answer to "which one am I on" --
     the check glyph is decoration on top of it. */
  test('switching method moves the pressed state with it', async () => {
    await renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^(\u2713 )?Account ID \/ PIN$/ }));
    });

    expect(screen.getByRole('button', { name: /^(\u2713 )?Account ID \/ PIN$/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /^(\u2713 )?Microsoft$/ }).getAttribute('aria-pressed')).toBe('false');
  });

  test('the PIN method reveals a way to enter a PIN', async () => {
    const { container } = await renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^(\u2713 )?Account ID \/ PIN$/ }));
    });

    expect(container.querySelector('input[type="password"], input[inputmode="numeric"]')).toBeTruthy();
  });

  test('a first-time member can still reach activation', async () => {
    const { container } = await renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^(\u2713 )?Account ID \/ PIN$/ }));
    });

    expect(container.querySelector('a[href="/activate"]')).toBeTruthy();
  });

  test('someone who has forgotten a PIN is not left without a door', async () => {
    const { container } = await renderPanel();

    expect(container.querySelector('a[href="/athlete/sign-in"]')).toBeTruthy();
  });
});

describe('the board is a board and not a card', () => {
  test('stands on wood inside a brass frame, not on a paper card', async () => {
    const { container } = await renderPanel();

    expect(container.querySelector('.frame .frame-in.mat-wood--dark')).toBeTruthy();
    expect(container.querySelector('.frame-in.mat-paper')).toBeNull();
  });

  test('is bolted together down its edges, not only at its corners', async () => {
    const { container } = await renderPanel();

    expect(container.querySelectorAll('.rivet').length).toBeGreaterThan(4);
  });

  test('speaks in the gym\'s voice, not the coaching system\'s', async () => {
    await renderPanel();

    expect(screen.getByText(/NOT FANCY\. JUST TOUGH\./)).toBeTruthy();
  });

  /* OBSERVE. DECIDE. EXECUTE. REPEAT. is SHADOW's tagline (CLAUDE.md line 14).
     SHADOW lives in After Hours; this is a signed-out family surface, and the
     person reading it has not signed in. Same voice boundary that keeps the
     screen from being titled after SHADOW. */
  test('does not borrow the SHADOW tagline for a signed-out door', async () => {
    const { container } = await renderPanel();

    expect(container.textContent).not.toMatch(/OBSERVE\. DECIDE\. EXECUTE/i);
  });

  /* The row was `grid sm:grid-cols-3`: three identical cells, identical
     gutter. That shape is the thing being fixed, so a regression back to it
     should fail rather than merely look familiar. */
  test('does not lay the methods out as three identical cells', async () => {
    const { container } = await renderPanel();

    const row = container.querySelector('fieldset > div');
    expect(row?.className).not.toMatch(/grid-cols-3/);
  });
});

describe('the marks on it are marks, not controls', () => {
  /* A rubber stamp that announces itself is a screen-reader user being told
     there is something here to press. Law 7 keeps a spoken stamp for a real
     refusal. */
  test('the stamp is hidden from assistive technology', async () => {
    const { container } = await renderPanel();

    const stamp = container.querySelector('.stamp');
    expect(stamp).toBeTruthy();
    expect(stamp?.getAttribute('aria-hidden')).toBe('true');
  });

  test('the stamp cannot be clicked', async () => {
    const { container } = await renderPanel();

    expect(container.querySelector('.stamp')?.className).toMatch(/pointer-events-none/);
  });

  test('the lamp is hidden from assistive technology too', async () => {
    const { container } = await renderPanel();

    expect(container.querySelector('.lamp')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('the popover is the same door in a smaller room', () => {
  /* A light fixture hanging inside a modal dialog reads as a rendering bug. */
  test('hangs no lamp inside the modal', async () => {
    const { container } = await renderPanel({ embedded: true });

    expect(container.querySelector('.lamp')).toBeNull();
  });

  test('but is still the same board', async () => {
    const { container } = await renderPanel({ embedded: true });

    expect(container.querySelector('.frame-in.mat-wood--dark')).toBeTruthy();
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
