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
