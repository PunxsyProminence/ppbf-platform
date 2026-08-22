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
    expect(container.textContent).toMatch(/access logged/i);
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
