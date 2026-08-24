'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import AnnouncementBanner from '@/components/AnnouncementBanner';
import RefusalStamp, { type RefusalStampKind } from '@/components/RefusalStamp';
import WorkAxis from '@/components/WorkAxis';
import { apiBase } from '@/lib/apiBase';
import {
  clearRoleSession,
  persistAuthoritativeRoleSession,
  loadAuthoritativeRoleSession,
} from '@/components/roleSession';
import { createMicrosoftSignInHandler } from '@/src/client/loginPageHelpers';
import { DEFAULT_PIN_LENGTH } from '@/src/server/pilot/pinPolicy';

/**
 * RefusalStamp's `detail` is appended after the stamp's standard sentence,
 * so a caller-supplied clause that already ends in a period would double up
 * ("...approved — Invalid account ID or PIN. Please try again or contact
 * an admin.."). Trimming one trailing period keeps every existing error
 * string's exact wording while letting it sit naturally inside the stamp's
 * own sentence.
 */
function trimTrailingPeriod(message: string): string {
  return message.endsWith('.') ? message.slice(0, -1) : message;
}

/**
 * The rule between two ways in. Purely a separator, so the word is hidden
 * from the accessibility tree -- each method already carries its own heading,
 * and a screen reader announcing "OR" between two named sections would be
 * reading the furniture.
 */
function MethodRule() {
  return (
    <div className="my-[var(--s6)] flex items-center gap-[var(--s4)]" aria-hidden="true">
      <span className="h-px flex-1 bg-[rgba(0,0,0,0.16)]" />
      <span className="t-label">Or</span>
      <span className="h-px flex-1 bg-[rgba(0,0,0,0.16)]" />
    </div>
  );
}

/**
 * Every refusal this panel can be redirected here with (`?error=`), and the
 * stamp that tells the truth about each one. The kind and the sentence sit in
 * one table because they answer the same question: two switches over the same
 * query parameter is how a mark and its copy drift apart.
 *
 * Not one of them is red, and that is the whole point. The owner's locked art
 * policy of 2026-08-19 (RefusalStamp's header carries it) reserves red and
 * --locked for MEDICALLY_NOT_ALLOWED alone. A sign-in refusal is never
 * medical, so it renders brass/bone like every other non-medical "no".
 *
 * The sentences are unchanged from the copy this table replaced. Each is
 * passed as the stamp's `detail`, which is appended to the stamp's own
 * standard sentence rather than replacing it.
 */
const AUTH_ERROR_REFUSALS: Readonly<
  Record<string, { readonly kind: Exclude<RefusalStampKind, 'training_hold'>; readonly message: string }>
> = {
  // Nothing is wrong with the credential and nothing the user can type fixes
  // it: an org admin has to invite or reactivate the account first.
  'not-invited': {
    kind: 'get_permission',
    message: 'This Microsoft account is not invited or not active.',
  },
  // The half-finished sign-in no longer exists to complete -- its state or its
  // cookie is gone. SIGNED_OUT is literally that, and the way out is to start
  // again rather than to ask anyone for anything.
  'auth-state-expired': {
    kind: 'signed_out',
    message:
      'Your sign-in session expired or the browser blocked the login cookies. Please try again.',
  },
  // The credential was accepted; the account still has nowhere to land until
  // someone else finishes setting it up.
  'auth-forbidden': {
    kind: 'get_permission',
    message:
      'This account signed in, but its role has no workspace yet. Ask your organization admin to finish setting it up.',
  },
  // RoleSessionGate emits these two; without a case they fell through to the
  // Microsoft message even when the user had signed in with a PIN. Both are a
  // WRONG DOOR rather than a hard no -- the person is real and may well be
  // allowed in, just not through the door they used or into that room.
  privileged_auth_required: {
    kind: 'wrong_door',
    message: 'That area requires a Microsoft sign-in. Please continue with Microsoft.',
  },
  unsupported_role: {
    kind: 'wrong_door',
    message: 'Your account role cannot open that area.',
  },
};

/**
 * Anything else that arrives in `?error=`. The panel knows only that the
 * sign-in did not complete, so CANNOT BE DONE is the honest mark: it names no
 * cause, blames no credential, and promises no one who could unblock it.
 */
const UNKNOWN_AUTH_ERROR_REFUSAL: {
  readonly kind: Exclude<RefusalStampKind, 'training_hold'>;
  readonly message: string;
} = {
  kind: 'cannot_be_done',
  message: 'Microsoft sign-in failed. Please try again.',
};

/**
 * THE BELL -- the platform's one sign-in flow, in one place.
 *
 * Extracted from what used to be login/page.tsx's whole body so the popover
 * on /public and the standalone /login route run the exact same auth logic
 * rather than a copy of it -- two auth implementations drifting apart is a
 * security bug waiting to happen, not a styling risk.
 *
 * `embedded` controls only the two things that differ by context: the close
 * affordance (a link back to /public standalone, an actual close button in
 * the popover) and nothing about the auth flow itself.
 *
 * Golden Era V1 (2026-08-24): outer wrapper carries ge-sign-in / ge-bell so
 * the riveted paper desk and brass frame treatment from ppbf-golden-era.css
 * apply. No functional / auth / role change.
 */
export default function SignInPanel({
  embedded = false,
  onClose,
}: {
  embedded?: boolean;
  onClose?: () => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // THERE IS NO LONGER A SELECTED METHOD, and that is the point of the
  // approved layout (AF-01, AF-M02): all three doors stand open on the page at
  // once. The picker this replaces had to choose a default, and every choice
  // was wrong for somebody -- it opened on PIN, so every coach, parent and
  // staff member met a form that could not authenticate them (PIN sign-in
  // admits only athletes: credentialPolicy says so and loginWithAccountIdAndPin
  // enforces it), and the refusal blamed their credential instead of the door.
  // Defaulting to Microsoft moved the same problem onto athletes. Showing all
  // three removes the problem rather than relocating it.
  const [loginAccountId, setLoginAccountId] = useState('');
  const [loginPin, setLoginPin] = useState('');
  const [magicLinkEmail, setMagicLinkEmail] = useState('');
  const [magicLinkBusy, setMagicLinkBusy] = useState(false);
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [magicLinkError, setMagicLinkError] = useState('');
  // Tracks only whether the current magicLinkError came from an HTTP 429.
  // Every other magic-link failure (bad address, unreachable server, and so
  // on) is a genuine refusal, not a WAIT state -- see loginRateLimited below,
  // the same distinction applies here.
  const [magicLinkRateLimited, setMagicLinkRateLimited] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  // A 429 is a WAIT state, not a refusal: the owner's locked art policy
  // reserves red/--locked for medical/safety only, and a rate limit is
  // neither. Every other loginError (wrong PIN length, invalid credentials,
  // timeout, network failure, ...) is a genuine non-medical refusal. This
  // flag is the only thing that tells the render below which of the two
  // RefusalStamp kinds applies -- it is reset at the top of every fresh
  // attempt and set true only in the 429 branch.
  const [loginRateLimited, setLoginRateLimited] = useState(false);
  // A PIN typed on a shared gym tablet with cold hands is worth being able to
  // check before submitting -- the alternative is the rate limiter. Off by
  // default: this is a reveal an athlete asks for, never the resting state.
  const [showPin, setShowPin] = useState(false);

  const authErrorParam = searchParams.get('error');
  const authErrorRefusal = authErrorParam
    ? AUTH_ERROR_REFUSALS[authErrorParam] ?? UNKNOWN_AUTH_ERROR_REFUSAL
    : null;

  useEffect(() => {
    const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
    const shouldLogout = params.get('logout') === 'true' || params.get('reset') === 'true';

    if (shouldLogout) {
      clearRoleSession();
      void fetch(`${apiBase()}/api/pilot/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
      return;
    }

    const controller = new AbortController();

    void (async () => {
      try {
        const resolution = await loadAuthoritativeRoleSession(
          `${apiBase()}/api/pilot/auth/session`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) {
          return;
        }

        if (!resolution.ok) {
          if (resolution.reason === 'pin_change_required') {
            router.replace('/change-pin');
            return;
          }
          if (resolution.reason !== 'server_error') {
            clearRoleSession();
          }
          return;
        }

        persistAuthoritativeRoleSession(resolution.session);
        router.replace(resolution.destination);
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return;
        }
      }
    })();

    return () => controller.abort();
  }, [router]);

  async function requestMagicLink() {
    const email = magicLinkEmail.trim();
    setMagicLinkError('');
    setMagicLinkRateLimited(false);

    if (!email) {
      setMagicLinkError('Enter your email address.');
      return;
    }

    setMagicLinkBusy(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/auth/magic-link/request`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      if (response.status === 429) {
        setMagicLinkRateLimited(true);
        setMagicLinkError('Too many requests. Wait a few minutes and try again.');
        return;
      }
      if (response.status === 400) {
        setMagicLinkError('That does not look like an email address.');
        return;
      }

      // Anything else is treated as sent. The server answers 202 whether or
      // not the address has an account, and the confirmation below says the
      // same thing either way -- reporting a distinction the server refused to
      // make would put the enumeration leak back in the client.
      setMagicLinkSent(true);
    } catch {
      setMagicLinkError('Could not reach the gym right now. Try again in a moment.');
    } finally {
      setMagicLinkBusy(false);
    }
  }

  async function loginWithPin() {
    const acctId = loginAccountId.trim();
    const pinCode = loginPin.trim();
    setLoginRateLimited(false);

    if (!acctId || !pinCode) {
      setLoginError('Account ID and PIN are required.');
      return;
    }

    // Caught here so a wrong-length PIN is named as a wrong length. The server
    // answers every failure with the same "Invalid account ID or PIN", and this
    // label used to read "4+ digits" -- so someone who followed it and entered
    // four was told their PIN was wrong, retried the same four, and hit the
    // rate limiter. The policy is exactly DEFAULT_PIN_LENGTH digits.
    if (!new RegExp(`^\\d{${DEFAULT_PIN_LENGTH}}$`).test(pinCode)) {
      setLoginError(`Your PIN is exactly ${DEFAULT_PIN_LENGTH} digits.`);
      return;
    }

    setLoginBusy(true);
    setLoginError('');

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`${apiBase()}/api/pilot/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: acctId,
          pin: pinCode,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const result = (await response.json().catch(() => ({ error: 'Login failed' }))) as {
        error?: string;
        role?: string;
        has_master_shadow_access?: boolean;
      };

      if (response.status === 429) {
        setLoginRateLimited(true);
        setLoginError('Too many login attempts. Please wait a few minutes before trying again.');
        return;
      }

      if (!response.ok || !result.role) {
        setLoginError(result.error || 'Invalid account ID or PIN. Please try again or contact an admin.');
        return;
      }

      const resolution = await loadAuthoritativeRoleSession(`${apiBase()}/api/pilot/auth/session`);
      if (!resolution.ok) {
        if (resolution.reason === 'pin_change_required') {
          router.replace('/change-pin');
          return;
        }
        if (resolution.reason !== 'server_error') {
          clearRoleSession();
        }
        setLoginError('The server session could not be verified. Please sign in again.');
        return;
      }

      persistAuthoritativeRoleSession(resolution.session);
      router.replace(resolution.destination);
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          setLoginError('Login request timed out. Check your internet connection and try again.');
        } else {
          setLoginError('Network error. Check your connection and try again.');
        }
      } else {
        setLoginError('An unexpected error occurred. Please try again.');
      }
    } finally {
      setLoginBusy(false);
    }
  }

  const microsoftSignIn = createMicrosoftSignInHandler(apiBase());

  return (
    <div className="ge-sign-in ge-bell">
      <div className="frame">
      <span className="rivet rivet--tl" />
      <span className="rivet rivet--tr" />
      <span className="rivet rivet--bl" />
      <span className="rivet rivet--br" />
      <div className="frame-in mat-paper" style={{ padding: 'var(--s6)' }}>
        {/* The eyebrow and the way out stay on the top rail; the masthead is
            centred under them, the way the approved board is laid out. */}
        <div className="flex flex-wrap items-start justify-between gap-[var(--s4)]">
          <div className="t-eyebrow">Member Access</div>
          {embedded ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close sign in"
              className="btn btn--ghost"
            >
              Close
            </button>
          ) : (
            <Link href="/public" className="btn btn--ghost">
              Public Page
            </Link>
          )}
        </div>

        <header className="mb-[var(--s6)] mt-[var(--s5)] text-center">
          {/* The bell itself. Decorative -- the heading directly below says
              the word, so announcing it twice would be noise. Drawn rather
              than set in an emoji or an icon font: neither is a system glyph
              and neither holds its shape at this size. */}
          <svg
            aria-hidden="true"
            viewBox="0 0 48 48"
            className="mx-auto block h-[42px] w-[42px]"
            fill="none"
            stroke="var(--brass-800)"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M24 7c-6.6 0-12 5.4-12 12v8l-3.5 6h31L36 27v-8c0-6.6-5.4-12-12-12Z" />
            <path d="M24 4v3" />
            <path d="M20 37a4 4 0 0 0 8 0" />
          </svg>
          <h1 className="t-painted mt-[var(--s4)]" style={{ fontSize: 'var(--t-2xl)' }}>
            The Bell
          </h1>
          <p className="t-body mt-[var(--s3)]">Sign in to continue.</p>
          <p className="t-muted mx-auto mt-[var(--s3)] max-w-[52ch]" style={{ fontSize: 'var(--t-sm)' }}>
            Any of the three ways below will do. You will land on the right
            dashboard for your role.
          </p>
        </header>

        {/* Sign-in failures arrive as a full-page redirect, which resets the
            tab to PIN. While this banner lived inside the Microsoft panel a
            rejected user saw an empty PIN form and no reason at all. */}
        {/* Brass/bone, never red -- the same treatment the PIN and magic-link
            refusals below already use, and for the same reason. The comment
            that stood here defended the red on Law 3 grounds: the glyph and
            the uppercase label carry the state too, so the colour was never
            the only channel. That reasoning is sound and it is not the rule
            that governs. The locked art policy of 2026-08-19 is NARROWER than
            Law 3 -- red/--locked belongs to medically_not_allowed alone, so
            that an unscoped coach and a same-day medical hold never wear the
            same colour of "no" -- and the narrower rule wins. A sign-in
            refusal is not medical.

            role="alert" stays on this wrapper. RefusalStamp gives its six
            non-medical kinds role="status" (its header explains why), which is
            that component's decision to make rather than this caller's; but a
            refusal the user was redirected here to read is the reason they are
            looking at the page at all, so the wrapper keeps the assertive
            role this panel has always announced with. */}
        {authErrorRefusal && (
          <div className="mb-[var(--s5)]" role="alert">
            <RefusalStamp
              kind={authErrorRefusal.kind}
              detail={trimTrailingPeriod(authErrorRefusal.message)}
            />
          </div>
        )}

        <section className="grid gap-[var(--s5)]" aria-labelledby="signin-microsoft-heading">
          <div>
            <h2 id="signin-microsoft-heading" className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
              Microsoft Sign In
            </h2>
            <p className="t-body mt-[var(--s3)]">
              For coaches, staff and admins. Your organization admin manages who can access the platform.
            </p>
          </div>
          <button type="button" onClick={microsoftSignIn} className="btn btn--kiosk">
            Continue With Microsoft
          </button>
        </section>

        <MethodRule />

        <form
          aria-labelledby="signin-magic-link-heading"
          onSubmit={(e) => {
            e.preventDefault();
            void requestMagicLink();
          }}
          className="grid gap-[var(--s5)]"
        >
          <div>
            <h2 id="signin-magic-link-heading" className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
              Email Link
            </h2>
            <p className="t-body mt-[var(--s3)]">
              For coaches, staff, volunteers and parents. Enter your email and we
              will send a link that signs you in. No password to remember.
            </p>
          </div>
          <div className="field">
            <label className="t-label" htmlFor="magic-link-email">
              Email Address
            </label>
            <input
              id="magic-link-email"
              type="email"
              value={magicLinkEmail}
              onChange={(event) => setMagicLinkEmail(event.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              className="input input--kiosk"
            />
          </div>
          {/* Deliberately the same message whether the address has an
              account or not. The server answers identically for both --
              saying "sent!" for one and "not found" for the other would
              make this form a way to ask which families attend the gym. */}
          {magicLinkSent && (
            <div className="rounded-[var(--r-md)] border-2 border-[color:var(--proven)] p-[var(--s4)]" role="status">
              <p className="t-body">
                If that address has an account, a sign-in link is on its way. It
                works once and expires in 15 minutes.
              </p>
            </div>
          )}
          {/* A 429 here is a WAIT state (kind="wait"), never a refusal --
              red/--locked is reserved for medically_not_allowed alone.
              Every other magic-link failure is a genuine, non-medical
              refusal (kind="cannot_be_done"): brass/bone, same as PIN
              login's own error treatment below, never the clinic-red
              these used to share. */}
          {magicLinkError && (
            <RefusalStamp
              kind={magicLinkRateLimited ? 'wait' : 'cannot_be_done'}
              detail={magicLinkRateLimited ? 'a few minutes' : trimTrailingPeriod(magicLinkError)}
            />
          )}
          <button type="submit" disabled={magicLinkBusy} className="btn btn--kiosk">
            {magicLinkBusy ? 'Sending…' : 'Send Sign-In Link'}
          </button>
        </form>

        <MethodRule />

        <form
          aria-labelledby="signin-pin-heading"
          onSubmit={(e) => {
            e.preventDefault();
            void loginWithPin();
          }}
          className="grid gap-[var(--s5)]"
        >
          <div>
            <h2 id="signin-pin-heading" className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
              Account ID &amp; PIN
            </h2>
            <p className="t-body mt-[var(--s3)]">
              Enter your Account ID and PIN. Ask your coach or admin if you do not have one.
            </p>
            <p className="t-body mt-[var(--s4)] rounded-[var(--r-sm)] border border-[rgba(0,0,0,0.14)] bg-[var(--paper-2)] px-[var(--s4)] py-[var(--s3)]">
              First time here with an activation code?{' '}
              <Link href="/activate" className="font-semibold text-[color:var(--brass-800)] underline">
                Set up your account
              </Link>
            </p>
          </div>
          <div className="grid gap-[var(--s4)]">
            {/* Law 5: --tap and --t-md are the gym-floor floor. An athlete
                signs in on a shared tablet with sweaty hands, so the PIN
                pair gets kiosk sizing even though the desk could go
                smaller — the old 48px/16px pair cleared neither. */}
            <div className="field">
              <label className="t-label" htmlFor="login-account-id">
                Account ID
              </label>
              <input
                id="login-account-id"
                type="text"
                value={loginAccountId}
                onChange={(event) => setLoginAccountId(event.target.value)}
                placeholder="account-001"
                autoComplete="username"
                className="input input--kiosk"
              />
            </div>
            <div className="field relative">
              <label className="t-label" htmlFor="login-pin">
                PIN ({DEFAULT_PIN_LENGTH} digits)
              </label>
              <input
                id="login-pin"
                type={showPin ? 'text' : 'password'}
                inputMode="numeric"
                value={loginPin}
                // Non-digits dropped and the value capped, so the field
                // cannot hold something the policy will reject. The old
                // field took any length and any character, and the server
                // refused it with a message about the wrong thing.
                onChange={(event) =>
                  setLoginPin(event.target.value.replace(/\D/g, '').slice(0, DEFAULT_PIN_LENGTH))
                }
                maxLength={DEFAULT_PIN_LENGTH}
                placeholder={'•'.repeat(DEFAULT_PIN_LENGTH)}
                autoComplete="current-password"
                className="input input--kiosk pr-[var(--s7)]"
              />
              {/* The reveal sits inside the field's own box so it cannot be
                  mistaken for a second control in the form. aria-pressed
                  carries the state; the glyph is on top of it, not instead
                  of it (Law 3). */}
              <button
                type="button"
                onClick={() => setShowPin((shown) => !shown)}
                aria-pressed={showPin}
                aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
                className="absolute bottom-0 right-0 grid h-[var(--tap)] w-[var(--tap)] place-items-center text-[color:var(--brass-800)]"
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  className="h-[21px] w-[21px]"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M1.8 12S5.4 5.4 12 5.4 22.2 12 22.2 12 18.6 18.6 12 18.6 1.8 12 1.8 12Z" />
                  <circle cx="12" cy="12" r="3.1" />
                  {showPin ? <path d="M4.4 19.6 19.6 4.4" /> : null}
                </svg>
              </button>
            </div>
            {/* A 429 is a WAIT state, not a refusal -- the confirmed bug
                this fixes. Everything else here (wrong PIN length, an
                invalid account/PIN pair, a session that failed to verify,
                timeout, network) is a genuine but non-medical refusal, so
                it drops the "Sign-in refused" badge and red/--locked too:
                only medically_not_allowed gets that treatment. */}
            {loginError && (
              <RefusalStamp
                kind={loginRateLimited ? 'wait' : 'cannot_be_done'}
                detail={loginRateLimited ? 'a few minutes' : trimTrailingPeriod(loginError)}
              />
            )}
            <button
              type="submit"
              disabled={loginBusy || !loginAccountId.trim() || !loginPin.trim()}
              /* A brass face at reduced opacity still reads as a live
                 control. Desaturating it too drops it off the chassis
                 entirely, which is what "not yet" should look like. */
              className="btn btn--kiosk disabled:cursor-not-allowed disabled:opacity-60 disabled:grayscale"
            >
              {loginBusy ? 'Signing In…' : 'Sign In'}
            </button>
          </div>
        </form>

        {/* "Access logged" stood here and was false, shipped by the same
            commit that removed "Your PIN is local and never leaves your
            device" for being false (#555). Replacing one false security claim
            with another is the failure that comment was written to prevent.

            No door on this panel records a refusal. PIN returns 401 in
            login/route.ts before auditLoginEvent is reached; magic-link
            consume returns 401 before its own write; requesting a link writes
            nothing by design, because a row keyed to a real account is exactly
            the address-enumeration signal that route exists to suppress. There
            is no vocabulary for a refusal either -- auditEventTypes.ts carries
            'login' and no failure type. Nor is the rate limiter the missing
            record: a successful sign-in DELETES the attempt bucket
            (clearDurableRateLimit in rateLimit.ts).

            So the line claims only what all three doors do: on success they
            write a 'login' row to pilot.audit_events -- login/route.ts,
            magic-link/consume/route.ts and microsoft/callback/route.ts.
            Recording refusals needs a new event type, a widened check
            constraint and a migration; that is an owner decision, not a copy
            fix, and until it is made this line must not imply it.

            The PIN line is still not shipped, for the reason it never was: the
            PIN is POSTed to /api/pilot/auth/login and saying otherwise on a
            sign-in form would be a false security claim to a child. */}
        <p
          className="t-muted mt-[var(--s6)] text-center"
          style={{ fontSize: 'var(--t-sm)' }}
        >
          Secure sign-in · Successful sign-ins are recorded
        </p>
      </div>
    </div>

      {/* Help and gym notices sit outside the frame: the framed paper is the
          thing you fill in, and this is what's tacked up next to it. Kept in
          both contexts (embedded or standalone) -- forgetting a PIN, or
          needing the athlete door, is exactly as real from the popover as
          from the standalone page. */}
      <section className="mt-[var(--s6)] grid gap-[var(--s5)] md:grid-cols-[var(--split-major)_var(--split-minor)]">
        <div>
          <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>
            Need Help?
          </h2>
          <p className="t-body mt-[var(--s3)] max-w-[54ch]">
            If you do not have an Account ID or PIN, or if you have forgotten your PIN, contact your gym admin or
            coach. They can create a new account or reset your PIN.
          </p>
          <Link href="/athlete/sign-in" className="btn btn--ghost mt-[var(--s4)]">
            Open Simple Athlete PIN Sign-In
          </Link>
        </div>
        <div>
          <h2 className="t-label mb-[var(--s3)]">Gym Notice</h2>
          <AnnouncementBanner placement="gym_notices" source="public" limit={3} />
        </div>
      </section>

      {/* The foot of the door, in both mockups that show one. Not rendered in
          the popover: it is the foot of a PAGE, and the popover is a panel
          floating over one that has its own. */}
      {embedded ? null : <WorkAxis className="mt-[var(--s6)]" />}
    </div>
  );
}
