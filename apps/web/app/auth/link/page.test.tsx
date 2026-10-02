/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { PASSWORD_RULE_SUMMARY } from '@/src/server/pilot/passwordPolicy';

import { clearRoleSession, readRoleSession } from '@/components/roleSession';

import MagicLinkPage from './page';

const replace = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams('token=link-token'),
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

const CONSUME = '/api/pilot/auth/magic-link/consume';
const SESSION = '/api/pilot/auth/session';
const SET = '/api/pilot/auth/password/set';

// Spaces at both ends on purpose: they are part of the password.
const PASSWORD = '  three small quiet words  ';

type Answer = { status: number; body: unknown };
const answer = (status: number, body: unknown): Answer => ({ status, body });

let setCalls: Array<{ body: string; init: RequestInit }>;
let sessionCalls: number;
let consoleSpies: jest.SpyInstance[];
const originalFetch = global.fetch;

/**
 * The link's own two requests always succeed for a parent; `setAnswers` are
 * what the set-password route says, in order. An entry may be a function that
 * returns a promise, to hold a request open.
 */
function serve(
  passwordSetup: unknown,
  setAnswers: Array<Answer | (() => Promise<Answer>)> = [],
  link: { consume?: Answer; session?: Answer | ((init?: RequestInit) => Promise<Answer>) } = {},
) {
  const queue = [...setAnswers];
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const reply = (a: Answer) => ({ ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body }) as Response;
    if (url.endsWith(CONSUME)) {
      if (link.consume) return reply(link.consume);
      return reply(answer(200, {
        ok: true,
        account_id: 'parent@example.com',
        role: 'parent',
        organization_id: 'punxsy_prominence',
        ...(passwordSetup === undefined ? {} : { password_setup: passwordSetup }),
      }));
    }
    if (url.endsWith(SESSION)) {
      sessionCalls += 1;
      if (typeof link.session === 'function') return reply(await link.session(init));
      if (link.session) return reply(link.session);
      return reply(answer(200, { authenticated: true, role: 'parent', auth_provider: 'microsoft' }));
    }
    if (url.endsWith(SET)) {
      setCalls.push({ body: String(init?.body), init: init ?? {} });
      const next = queue.shift();
      if (!next) throw new Error('unexpected set-password request');
      return reply(typeof next === 'function' ? await next() : next);
    }
    throw new Error(`unexpected request ${url}`);
  }) as never;
}

beforeEach(() => {
  replace.mockReset();
  setCalls = [];
  sessionCalls = 0;
  clearRoleSession();
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => undefined));
});

afterEach(() => {
  consoleSpies.forEach((spy) => spy.mockRestore());
  global.fetch = originalFetch;
});

async function reachPrompt(setAnswers: Array<Answer | (() => Promise<Answer>)> = []) {
  serve('offer', setAnswers);
  render(<MagicLinkPage />);
  await screen.findByRole('heading', { name: 'Make A Password' });
}

function type(first: string, second: string = first) {
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: first } });
  fireEvent.change(screen.getByLabelText('Type it again'), { target: { value: second } });
}

const saveButton = () => screen.getByRole('button', { name: 'Save Password' });

/** The password must not be readable in the page's markup or in any console line. */
function expectPasswordNowhere() {
  expect(document.body.textContent).not.toContain(PASSWORD.trim());
  // Markup too: no value attribute, aria text or anything else carries it.
  expect(document.body.innerHTML).not.toContain(PASSWORD.trim());
  for (const spy of consoleSpies) {
    expect(JSON.stringify(spy.mock.calls)).not.toContain(PASSWORD.trim());
  }
}

describe('whether the prompt is shown', () => {
  test.each([
    ['none', 'none'],
    ['absent', undefined],
    ['a value that is not the word offer', 'OFFER'],
    ['true', true],
  ])('password_setup %s: no prompt, straight on to where the link lands', async (_label, value) => {
    serve(value);
    render(<MagicLinkPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/parent/dashboard'));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('heading', { name: 'Make A Password' })).toBeNull();
    expect(setCalls).toHaveLength(0);
  });

  test('password_setup offer: the prompt is shown, the parent is already signed in, and nothing has redirected', async () => {
    await reachPrompt();
    expect(replace).not.toHaveBeenCalled();
    expect(readRoleSession()?.role).toBe('parent');
    expect(screen.getByText(PASSWORD_RULE_SUMMARY)).toBeTruthy();
    expect(screen.getByLabelText('Password').getAttribute('type')).toBe('password');
    expect(screen.getByLabelText('Type it again').getAttribute('type')).toBe('password');
    expect(setCalls).toHaveLength(0);
  });
});

test('Not Now skips: no password request, and the parent lands where the link lands', async () => {
  await reachPrompt();
  fireEvent.click(screen.getByRole('button', { name: 'Not Now' }));
  expect(replace).toHaveBeenCalledTimes(1);
  expect(replace).toHaveBeenCalledWith('/parent/dashboard');
  expect(setCalls).toHaveLength(0);
});

describe('saving', () => {
  test('sends the password exactly as typed, to the set route, and shows saved; Continue lands where the link lands', async () => {
    await reachPrompt([answer(200, { ok: true })]);
    type(PASSWORD);
    fireEvent.click(saveButton());

    expect(await screen.findByText('Password saved. Next time, sign in with your email and this password in any browser.')).toBeTruthy();
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].body).toBe(JSON.stringify({ password: PASSWORD }));
    expect(setCalls[0].init.method).toBe('POST');
    expect(setCalls[0].init.credentials).toBe('include');
    // The form, and the typed value with it, is gone.
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(document.querySelectorAll('input')).toHaveLength(0);
    expect(replace).not.toHaveBeenCalled();

    // Focus follows the answer; it is not dropped to the top of the page.
    expect(document.activeElement).toBe(screen.getByRole('status').parentElement);

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(replace).toHaveBeenCalledWith('/parent/dashboard');
    expectPasswordNowhere();
  });

  test('the save button is disabled while a save is in flight, and a second press sends nothing', async () => {
    let release: (a: Answer) => void = () => undefined;
    await reachPrompt([() => new Promise<Answer>((resolve) => { release = resolve; })]);
    type(PASSWORD);
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(saveButton());

    await waitFor(() => expect((saveButton() as HTMLButtonElement).disabled).toBe(true));
    fireEvent.submit(saveButton().closest('form') as HTMLFormElement);
    expect(setCalls).toHaveLength(1);
    // Skipping now would leave while the password is being set.
    const notNow = screen.getByRole('button', { name: 'Not Now' }) as HTMLButtonElement;
    expect(notNow.disabled).toBe(true);
    fireEvent.click(notNow);
    expect(replace).not.toHaveBeenCalled();
    expectPasswordNowhere();

    await act(async () => { release(answer(400, { error: 'Password must be at least 10 characters', code: 'PASSWORD_TOO_SHORT' })); });
    expect((await screen.findByRole('alert')).textContent).toBe('Password must be at least 10 characters');
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Not Now' }) as HTMLButtonElement).disabled).toBe(false);
    // A refused password is still in the box for the parent to change.
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe(PASSWORD);
  });

  test('a 429 that follows a 200 is still saved: no error replaces the saved line', async () => {
    await reachPrompt([answer(200, { ok: true }), answer(429, { error: 'Too many attempts. Please try again later.' })]);
    type(PASSWORD);
    const form = saveButton().closest('form') as HTMLFormElement;
    // Two submits before React has rendered the disabled button: both go out.
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    await waitFor(() => expect(setCalls).toHaveLength(2));
    expect(await screen.findByText(/^Password saved\./)).toBeTruthy();
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/Too many tries/)).toBeNull();
    expect(screen.getByText(/^Password saved\./)).toBeTruthy();
  });
});

describe('refusals', () => {
  test('an empty box is caught here and nothing is sent', async () => {
    await reachPrompt();
    fireEvent.click(saveButton());
    expect((await screen.findByRole('alert')).textContent).toBe('Type a password first.');
    expect(setCalls).toHaveLength(0);
  });

  test('two boxes that differ, even by one trailing space, are caught here and nothing is sent', async () => {
    await reachPrompt();
    type('three small quiet words', 'three small quiet words ');
    fireEvent.click(saveButton());
    expect((await screen.findByRole('alert')).textContent).toBe('Those two don’t match. Type them again.');
    expect(setCalls).toHaveLength(0);
  });

  test('400 with a password code: the server\'s own message is shown and the form stays for another try', async () => {
    await reachPrompt([
      answer(400, { error: 'That password is too easy to guess. Choose something longer or less obvious.', code: 'PASSWORD_TOO_GUESSABLE' }),
      answer(200, { ok: true }),
    ]);
    type(PASSWORD);
    fireEvent.click(saveButton());
    expect((await screen.findByRole('alert')).textContent).toBe('That password is too easy to guess. Choose something longer or less obvious.');
    expect(screen.getByLabelText('Password')).toBeTruthy();

    fireEvent.click(saveButton());
    expect(await screen.findByText(/^Password saved\./)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test.each([
    ['400 with no code', answer(400, { error: 'Missing password' })],
    ['400 with a code that is not a password one', answer(400, { error: 'Request body too large', code: 'BODY_TOO_LARGE' })],
    ['401', answer(401, { error: 'Unauthorized: no session' })],
    ['403 without the link-required code', answer(403, { error: 'Forbidden: something else' })],
    ['500', answer(500, { error: 'Internal server error' })],
    ['200 without ok', answer(200, {})],
  ])('%s: the plain could-not-save line, never the server text, and the form stays', async (_label, response) => {
    await reachPrompt([response]);
    type(PASSWORD);
    fireEvent.click(saveButton());
    expect((await screen.findByRole('alert')).textContent)
      .toBe('Could not save the password right now. You can skip this and try from a new link later.');
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.queryByText(/^Password saved\./)).toBeNull();
    expectPasswordNowhere();
  });

  test('a request that never reaches the server: the plain could-not-save line, and Not Now still works', async () => {
    await reachPrompt([() => Promise.reject(new Error(`socket hang up ${PASSWORD}`))]);
    type(PASSWORD);
    fireEvent.click(saveButton());
    expect((await screen.findByRole('alert')).textContent)
      .toBe('Could not save the password right now. You can skip this and try from a new link later.');
    expectPasswordNowhere();
    fireEvent.click(screen.getByRole('button', { name: 'Not Now' }));
    expect(replace).toHaveBeenCalledWith('/parent/dashboard');
  });

  test('429 with no save before it: wait and try again, not saved, the form stays', async () => {
    await reachPrompt([answer(429, { error: 'Too many attempts. Please try again later.' })]);
    type(PASSWORD);
    fireEvent.click(saveButton());
    expect((await screen.findByRole('alert')).textContent).toBe('Too many tries. Wait a minute and try again.');
    expect(screen.queryByText(/^Password saved\./)).toBeNull();
    expect(screen.getByLabelText('Password')).toBeTruthy();
  });

  test('403 PASSWORD_SETUP_LINK_REQUIRED: says the link is too old, takes the form away, offers the sign-in page and Continue', async () => {
    await reachPrompt([answer(403, {
      error: 'Forbidden: open a new sign-in link from your email to set a password',
      code: 'PASSWORD_SETUP_LINK_REQUIRED',
    })]);
    type(PASSWORD);
    fireEvent.click(saveButton());

    expect((await screen.findByRole('alert')).textContent).toBe(
      'That sign-in link is too old to set a password with. You’re still signed in. Ask for a new link from the sign-in page when you want to set one.',
    );
    expect(document.querySelectorAll('input')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Save Password' })).toBeNull();
    // /login alone would bounce a signed-in parent to the dashboard; this
    // form of it signs out and stays on the "email me a link" form.
    expect(screen.getByRole('link', { name: 'Back To Sign In' }).getAttribute('href')).toBe('/login?logout=true');
    expect(document.activeElement).toBe(screen.getByRole('alert').parentElement);
    expect(replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(replace).toHaveBeenCalledWith('/parent/dashboard');
    expectPasswordNowhere();
  });
});

/* A SPENT LINK, REOPENED.
   ------------------------------------------------------------------------
   The prompt keeps the used token in the address bar for as long as it is
   up, so a phone that reloads the tab posts it again. The link grants
   nothing the second time. What moves a visitor on is a session the server
   confirms for this browser, and only that. */
describe('a link that has already been used', () => {
  const SPENT = answer(401, { ok: false, reason: 'TOKEN_ALREADY_USED' });
  const REFUSAL = 'That link has already been used. Ask for a new one.';

  test('with a session the server confirms: on to that session\'s destination, no prompt, no password request', async () => {
    serve('offer', [], {
      // Everything a refusal could carry that speaks of a parent. None of it
      // may decide anything: the session below is a coach's.
      consume: answer(401, {
        ok: false,
        reason: 'TOKEN_ALREADY_USED',
        role: 'parent',
        account_id: 'parent@example.com',
        password_setup: 'offer',
      }),
      session: answer(200, { authenticated: true, role: 'coach', auth_provider: 'microsoft' }),
    });
    render(<MagicLinkPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    expect(replace).toHaveBeenCalledWith('/coach/environment/intake-router');
    expect(readRoleSession()?.role).toBe('coach');
    expect(screen.queryByRole('heading', { name: 'Make A Password' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(setCalls).toHaveLength(0);
  });

  test.each([
    ['no session (401)', answer(401, { authenticated: false })],
    ['a 200 that does not say authenticated', answer(200, { authenticated: false, role: 'parent', auth_provider: 'microsoft' })],
    ['a session that must change its PIN first', answer(200, { authenticated: true, role: 'athlete', auth_provider: 'ppbf_local', pin_auth_permitted: true, must_change_pin: true })],
    ['a server error', answer(500, { error: 'Internal server error' })],
    ['a local session the server has not attested', answer(200, { authenticated: true, role: 'parent', auth_provider: 'ppbf_local' })],
    ['a role with nowhere to go', answer(200, { authenticated: true, role: 'stranger', auth_provider: 'microsoft' })],
  ])('with %s: the refusal exactly as before, nobody is moved on', async (_label, session) => {
    serve('offer', [], { consume: SPENT, session });
    render(<MagicLinkPage />);
    expect((await screen.findByRole('alert')).textContent).toContain(REFUSAL);
    expect(screen.getByText('Sign-in refused')).toBeTruthy();
    expect(sessionCalls).toBe(1);
    expect(replace).not.toHaveBeenCalled();
    expect(readRoleSession()).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Make A Password' })).toBeNull();
  });

  test('with a session request that fails outright: the refusal', async () => {
    serve('offer', [], { consume: SPENT, session: () => Promise.reject(new Error('network down')) });
    render(<MagicLinkPage />);
    expect((await screen.findByRole('alert')).textContent).toContain(REFUSAL);
    expect(replace).not.toHaveBeenCalled();
  });

  test('with a session request that never answers: the refusal after eight seconds, not a spinner forever', async () => {
    jest.useFakeTimers();
    try {
      let aborted = false;
      serve('offer', [], {
        consume: SPENT,
        session: (init) => new Promise<Answer>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
      });
      render(<MagicLinkPage />);
      await act(async () => { await jest.advanceTimersByTimeAsync(7900); });
      expect(sessionCalls).toBe(1);
      expect(aborted).toBe(false);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('status').textContent).toContain('Signing you in');

      await act(async () => { await jest.advanceTimersByTimeAsync(200); });
      expect(aborted).toBe(true);
      expect(screen.getByRole('alert').textContent).toContain(REFUSAL);
      expect(replace).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test.each([
    ['TOKEN_EXPIRED', 'That link has expired. Sign-in links last 15 minutes -- ask for a new one.'],
    ['TOKEN_INVALIDATED', 'A newer sign-in link was sent. Use the most recent email, or ask for another.'],
    ['TOKEN_UNKNOWN', 'That link is not valid. Ask for a new one.'],
    ['ACCOUNT_INACTIVE', 'That account is not active. Contact the gym.'],
    ['RATE_LIMITED', 'Too many attempts. Wait a few minutes and try again.'],
    ['SOMETHING_NEW', 'That sign-in link did not work. Ask for a new one.'],
    // Near misses: only the exact reason asks for the session.
    ['token_already_used', 'That sign-in link did not work. Ask for a new one.'],
    ['TOKEN_ALREADY_USED_X', 'That sign-in link did not work. Ask for a new one.'],
    ['TOKEN_ALREADY_USED ', 'That sign-in link did not work. Ask for a new one.'],
  ])('any other refusal (%s) never asks for the session and is shown as before', async (reason, words) => {
    serve('offer', [], { consume: answer(401, { ok: false, reason }) });
    render(<MagicLinkPage />);
    expect((await screen.findByRole('alert')).textContent).toContain(words);
    expect(sessionCalls).toBe(0);
    expect(replace).not.toHaveBeenCalled();
  });
});
