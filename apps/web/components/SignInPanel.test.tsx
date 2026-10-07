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
    expect(screen.getByRole('button', { name: /^email me a link instead$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeTruthy();
  });

  test('a way to enter a PIN is on the page from the start', async () => {
    const { container } = await renderPanel();

    // By its id: the parent password box is an input[type="password"] too,
    // and would satisfy a looser selector with the PIN field gone.
    expect(container.querySelector('#login-pin')).toBeTruthy();
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

/**
 * THE PARENT PASSWORD (OD-2026-10-01-002 section 3 item 4): a password box
 * under the email box, and two buttons, "Sign In" and "Email Me A Link
 * Instead". The emailed link is still there for everyone it was there for.
 */
describe('email, with a password or with a link', () => {
  type Reply = { status: number; body?: unknown };

  /** Answers by path; anything unlisted is the mount-time session check finding nobody. */
  function answer(replies: Record<string, Reply>) {
    const calls: Array<{ path: string; body: unknown }> = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const reply = replies[path] ?? { status: 401, body: {} };
      return {
        ok: reply.status >= 200 && reply.status < 300,
        status: reply.status,
        json: async () => reply.body ?? {},
      };
    }) as unknown as typeof fetch;
    return calls;
  }

  const LOGIN = '/api/pilot/auth/password/login';
  const LINK = '/api/pilot/auth/magic-link/request';

  function type(container: HTMLElement, selector: string, value: string) {
    fireEvent.change(container.querySelector(selector)!, { target: { value } });
  }

  const passwordButton = () => screen.getByRole('button', { name: /sign in with password/i }) as HTMLButtonElement;
  const linkButton = () => screen.getByRole('button', { name: /email me a link instead/i }) as HTMLButtonElement;

  test('the password box sits under the email box, and both buttons carry the owner’s words', async () => {
    const { container } = await renderPanel();

    const email = container.querySelector('#magic-link-email')!;
    const password = container.querySelector('#magic-link-password')!;
    expect(password.getAttribute('type')).toBe('password');
    expect(email.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(passwordButton().textContent).toBe('Sign In');
    expect(linkButton().textContent).toBe('Email Me A Link Instead');
  });

  test('no longer says there is no password to remember', async () => {
    const { container } = await renderPanel();

    expect(container.textContent).not.toMatch(/no password to remember/i);
  });

  test('Sign In waits for both an email and a password; the link button does not', async () => {
    const { container } = await renderPanel();

    expect(passwordButton().disabled).toBe(true);
    expect(linkButton().disabled).toBe(false);

    await act(async () => { type(container, '#magic-link-email', 'parent@example.com'); });
    expect(passwordButton().disabled).toBe(true);

    await act(async () => { type(container, '#magic-link-password', 'three small boats'); });
    expect(passwordButton().disabled).toBe(false);
  });

  test('Sign In posts the email and the password exactly as typed, and no link is asked for', async () => {
    const { container } = await renderPanel();
    const calls = answer({ [LOGIN]: { status: 200, body: { ok: true, role: 'parent' } } });

    await act(async () => {
      type(container, '#magic-link-email', '  parent@example.com ');
      type(container, '#magic-link-password', '  three small boats ');
    });
    await act(async () => { fireEvent.click(passwordButton()); });

    // The email is trimmed. The password is not: a space is part of it.
    expect(calls.find((call) => call.path === LOGIN)?.body)
      .toEqual({ email: 'parent@example.com', password: '  three small boats ' });
    expect(calls.some((call) => call.path === LINK)).toBe(false);
    // And the server is asked who that is, rather than the reply being trusted.
    expect(calls[calls.length - 1].path).toBe('/api/pilot/auth/session');
  });

  test('a refusal says one thing whatever the reason, in brass, and points at the link', async () => {
    const { container } = await renderPanel();
    answer({ [LOGIN]: { status: 401, body: { error: 'Invalid credentials' } } });

    await act(async () => {
      type(container, '#magic-link-email', 'parent@example.com');
      type(container, '#magic-link-password', 'not the password');
    });
    await act(async () => { fireEvent.click(passwordButton()); });

    expect(container.querySelector('[data-refusal-stamp]')?.getAttribute('data-refusal-stamp')).toBe('cannot_be_done');
    expect(container.textContent).toContain('Email or password not recognised. Try again, or use Email Me A Link Instead');
    expect(container.innerHTML).not.toMatch(/--locked/);
    expect(router.replace).not.toHaveBeenCalled();
  });

  test('being made to wait is a wait, not a refusal', async () => {
    const { container } = await renderPanel();
    answer({ [LOGIN]: { status: 429, body: { error: 'Too many sign-in attempts. Please wait a few minutes.' } } });

    await act(async () => {
      type(container, '#magic-link-email', 'parent@example.com');
      type(container, '#magic-link-password', 'three small boats');
    });
    await act(async () => { fireEvent.click(passwordButton()); });

    expect(container.querySelector('[data-refusal-stamp]')?.getAttribute('data-refusal-stamp')).toBe('wait');
  });

  test('both buttons are off while a sign-in is in flight, so it cannot be sent twice', async () => {
    const { container } = await renderPanel();
    let finish!: (value: unknown) => void;
    const calls: string[] = [];
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      calls.push(new URL(String(input), 'http://localhost').pathname);
      return new Promise((resolve) => { finish = resolve; });
    }) as unknown as typeof fetch;

    await act(async () => {
      type(container, '#magic-link-email', 'parent@example.com');
      type(container, '#magic-link-password', 'three small boats');
    });
    // Held by reference: while a request is out, each button's name changes.
    const signIn = passwordButton();
    const link = linkButton();
    await act(async () => { fireEvent.click(signIn); });

    expect(signIn.disabled).toBe(true);
    expect(link.disabled).toBe(true);
    // And a screen reader is told so: the label does not hide the busy text.
    expect(screen.getByRole('button', { name: 'Signing In…' })).toBe(signIn);
    await act(async () => { fireEvent.click(signIn); });
    await act(async () => {
      fireEvent.keyDown(container.querySelector('#magic-link-password')!, { key: 'Enter' });
    });
    expect(calls).toEqual([LOGIN]);

    await act(async () => { finish({ ok: false, status: 401, json: async () => ({}) }); });
    expect(signIn.disabled).toBe(false);
  });

  test('Email Me A Link Instead still asks for the link, and sends no password', async () => {
    const { container } = await renderPanel();
    const calls = answer({ [LINK]: { status: 202, body: { ok: true } } });

    await act(async () => {
      type(container, '#magic-link-email', 'coach@example.com');
      type(container, '#magic-link-password', 'typed and then thought better of');
    });
    await act(async () => { fireEvent.click(linkButton()); });

    expect(calls.find((call) => call.path === LINK)?.body).toEqual({ email: 'coach@example.com' });
    expect(calls.some((call) => call.path === LOGIN)).toBe(false);
    expect(container.textContent).toMatch(/a sign-in link is on its way/i);
  });

  test('a correct sign-in lands on the dashboard the server names for that session', async () => {
    const { container } = await renderPanel();
    answer({
      [LOGIN]: { status: 200, body: { ok: true, role: 'parent' } },
      '/api/pilot/auth/session': {
        status: 200,
        body: { authenticated: true, account_id: 'parent@example.com', role: 'parent', organization_id: 'org-1', auth_provider: 'microsoft' },
      },
    });

    await act(async () => {
      type(container, '#magic-link-email', 'parent@example.com');
      type(container, '#magic-link-password', 'three small boats');
    });
    await act(async () => { fireEvent.click(passwordButton()); });

    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith('/parent/dashboard');
    expect(container.querySelector('[data-refusal-stamp]')).toBeNull();
  });

  /* The password was accepted and the session check after it never answers.
     Each request hangs until its own signal aborts it, as a real fetch does;
     one given no signal hangs for good. */
  test.each([
    ['the sign-in request', LOGIN],
    ['the session check after a correct sign-in', '/api/pilot/auth/session'],
  ])('%s never answering gives the buttons back after ten seconds', async (_label, hangingPath) => {
    const { container } = await renderPanel();
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path !== hangingPath) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, role: 'parent' }) });
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
        });
      });
    }) as unknown as typeof fetch;

    await act(async () => {
      type(container, '#magic-link-email', 'parent@example.com');
      type(container, '#magic-link-password', 'three small boats');
    });
    const signIn = passwordButton();
    const link = linkButton();

    jest.useFakeTimers();
    try {
      await act(async () => { fireEvent.click(signIn); });
      expect(signIn.disabled).toBe(true);
      expect(link.disabled).toBe(true);

      await act(async () => { jest.advanceTimersByTime(9_000); });
      expect(signIn.disabled).toBe(true);

      await act(async () => { jest.advanceTimersByTime(1_500); });
    } finally {
      jest.useRealTimers();
    }

    expect(signIn.disabled).toBe(false);
    expect(link.disabled).toBe(false);
    expect(container.textContent).toContain('Could not reach the gym right now');
    expect(router.replace).not.toHaveBeenCalled();
  });

  test.each([500, 503])('a %i is the gym not answering, not a password that was not recognised', async (status) => {
    const { container } = await renderPanel();
    answer({ [LOGIN]: { status, body: { error: 'Internal server error' } } });

    await act(async () => {
      type(container, '#magic-link-email', 'parent@example.com');
      type(container, '#magic-link-password', 'three small boats');
    });
    await act(async () => { fireEvent.click(passwordButton()); });

    expect(container.textContent).toContain('Could not reach the gym right now');
    expect(container.textContent).not.toMatch(/not recognised/i);
  });

  /**
   * ONLY A 202 IS "SENT". The route answers 202 for every address, with or
   * without an account; anything else is the gym not answering (a rate-limit
   * store it could not reach, a proxy page, a deploy mid-restart). The panel
   * used to show every one of those as "on its way" -- a link that never
   * existed, to a parent who then waited for it.
   */
  describe('the Email Link door says "sent" only for the answer that means sent', () => {
    // The sentence the password door already uses for the gym not answering.
    // It claims nothing about sending: a gateway's 502 can arrive after the
    // server sent the link, so "not sent" would sometimes be false.
    const NOT_SENT = /Could not reach the gym right now/i;
    const ON_ITS_WAY = /a sign-in link is on its way/i;

    async function askForLink(container: HTMLElement) {
      await act(async () => { type(container, '#magic-link-email', 'parent@example.com'); });
      await act(async () => { fireEvent.click(linkButton()); });
    }

    test('202: on its way, and no refusal', async () => {
      const { container } = await renderPanel();
      answer({ [LINK]: { status: 202, body: { ok: true } } });

      await askForLink(container);

      expect(container.textContent).toMatch(ON_ITS_WAY);
      expect(container.textContent).not.toMatch(NOT_SENT);
      expect(container.querySelector('[data-refusal-stamp]')).toBeNull();
    });

    test.each([200, 204, 404, 500, 502, 503])(
      'a %i is not "sent": the gym-not-answering sentence, as a refusal and not a wait',
      async (status) => {
        const { container } = await renderPanel();
        answer({ [LINK]: { status, body: { ok: true } } });

        await askForLink(container);

        expect(container.textContent).not.toMatch(ON_ITS_WAY);
        expect(container.textContent).toMatch(NOT_SENT);
        expect(container.querySelector('[data-refusal-stamp]')?.getAttribute('data-refusal-stamp')).toBe('cannot_be_done');
      },
    );

    test('the request never leaving the browser is not "sent" either', async () => {
      const { container } = await renderPanel();
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        if (new URL(String(input), 'http://localhost').pathname === LINK) throw new TypeError('Failed to fetch');
        return { ok: false, status: 401, json: async () => ({}) };
      }) as unknown as typeof fetch;

      await askForLink(container);

      expect(container.textContent).not.toMatch(ON_ITS_WAY);
      expect(container.textContent).toMatch(NOT_SENT);
    });

    test('a 429 is still a wait, and a 400 still names the address', async () => {
      const { container } = await renderPanel();
      answer({ [LINK]: { status: 429, body: {} } });
      await askForLink(container);
      expect(container.querySelector('[data-refusal-stamp]')?.getAttribute('data-refusal-stamp')).toBe('wait');
      expect(container.textContent).not.toMatch(ON_ITS_WAY);

      answer({ [LINK]: { status: 400, body: {} } });
      await act(async () => { fireEvent.click(linkButton()); });
      expect(container.textContent).toContain('That does not look like an email address');
      expect(container.textContent).not.toMatch(ON_ITS_WAY);
    });

    test('a later request that fails takes down the "on its way" from an earlier one that succeeded', async () => {
      const { container } = await renderPanel();
      answer({ [LINK]: { status: 202, body: { ok: true } } });
      await askForLink(container);
      expect(container.textContent).toMatch(ON_ITS_WAY);

      answer({ [LINK]: { status: 503, body: {} } });
      await act(async () => { fireEvent.click(linkButton()); });

      expect(container.textContent).not.toMatch(ON_ITS_WAY);
      expect(container.textContent).toMatch(NOT_SENT);
    });

    test('the sentence does not depend on the typed address', async () => {
      // The same status gets the same sentence whatever was typed: the panel
      // has no other input to go by, and must not echo the address into it.
      const seen = new Set<string>();
      for (const email of ['known@example.com', 'nobody-at-all@example.com']) {
        const { container, unmount } = await renderPanel();
        answer({ [LINK]: { status: 500, body: { error: 'Internal server error' } } });
        await act(async () => { type(container, '#magic-link-email', email); });
        await act(async () => { fireEvent.click(linkButton()); });
        seen.add(container.querySelector('[data-refusal-stamp]')!.textContent ?? '');
        unmount();
      }
      expect(seen.size).toBe(1);
    });
  });

  test('a password attempt takes down the "link is on its way" notice from before it', async () => {
    const { container } = await renderPanel();
    answer({ [LINK]: { status: 202, body: { ok: true } }, [LOGIN]: { status: 401, body: {} } });

    await act(async () => { type(container, '#magic-link-email', 'parent@example.com'); });
    await act(async () => { fireEvent.click(linkButton()); });
    expect(container.textContent).toMatch(/a sign-in link is on its way/i);

    await act(async () => { type(container, '#magic-link-password', 'not the password'); });
    await act(async () => { fireEvent.click(passwordButton()); });

    expect(container.textContent).not.toMatch(/a sign-in link is on its way/i);
  });

  test('while a link is being sent, Sign In is off and Enter in the password box does nothing', async () => {
    const { container } = await renderPanel();
    let finish!: (value: unknown) => void;
    const calls: string[] = [];
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      calls.push(new URL(String(input), 'http://localhost').pathname);
      return new Promise((resolve) => { finish = resolve; });
    }) as unknown as typeof fetch;

    await act(async () => {
      type(container, '#magic-link-email', 'parent@example.com');
      type(container, '#magic-link-password', 'three small boats');
    });
    const signIn = passwordButton();
    const link = linkButton();
    await act(async () => { fireEvent.click(link); });

    expect(signIn.disabled).toBe(true);
    expect(link.disabled).toBe(true);
    await act(async () => {
      fireEvent.keyDown(container.querySelector('#magic-link-password')!, { key: 'Enter' });
    });
    await act(async () => { fireEvent.submit(container.querySelector('#magic-link-password')!.closest('form')!); });
    expect(calls).toEqual([LINK]);

    await act(async () => { finish({ ok: true, status: 202, json: async () => ({}) }); });
  });

  /* A shared tablet's browser can fill a saved password into the box. A coach
     who types their email and presses Enter there asked for a link. */
  test('Enter in the EMAIL box asks for the link even with something in the password box', async () => {
    const { container } = await renderPanel();
    const calls = answer({ [LINK]: { status: 202, body: { ok: true } } });

    await act(async () => {
      type(container, '#magic-link-password', 'filled in by the browser');
      type(container, '#magic-link-email', 'coach@example.com');
    });
    await act(async () => {
      fireEvent.keyDown(container.querySelector('#magic-link-email')!, { key: 'Enter' });
    });

    expect(calls.map((call) => call.path)).toEqual([LINK]);
  });

  test('a submit that arrives without the key goes by whether a password is there', async () => {
    const { container } = await renderPanel();
    const calls = answer({ [LINK]: { status: 202, body: { ok: true } }, [LOGIN]: { status: 401, body: {} } });
    const form = container.querySelector('#magic-link-email')!.closest('form')!;

    await act(async () => { type(container, '#magic-link-email', 'parent@example.com'); });
    await act(async () => { fireEvent.submit(form); });
    expect(calls.map((call) => call.path)).toEqual([LINK]);

    await act(async () => { type(container, '#magic-link-password', 'three small boats'); });
    await act(async () => { fireEvent.submit(form); });
    expect(calls.map((call) => call.path)).toEqual([LINK, LOGIN]);
  });

  test('Enter with no password asks for the link, as it did before the password box existed', async () => {
    const { container } = await renderPanel();
    const calls = answer({ [LINK]: { status: 202, body: { ok: true } } });

    await act(async () => { type(container, '#magic-link-email', 'coach@example.com'); });
    await act(async () => {
      fireEvent.keyDown(container.querySelector('#magic-link-email')!, { key: 'Enter' });
    });

    expect(calls.map((call) => call.path)).toEqual([LINK]);
  });

  test('Enter with a password typed signs in', async () => {
    const { container } = await renderPanel();
    const calls = answer({ [LOGIN]: { status: 401, body: {} } });

    await act(async () => {
      type(container, '#magic-link-email', 'parent@example.com');
      type(container, '#magic-link-password', 'three small boats');
    });
    await act(async () => {
      fireEvent.keyDown(container.querySelector('#magic-link-password')!, { key: 'Enter' });
    });

    expect(calls.map((call) => call.path)).toEqual([LOGIN]);
  });
});

describe('the popover is the same door in a smaller room', () => {

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
