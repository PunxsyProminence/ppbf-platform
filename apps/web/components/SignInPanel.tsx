'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import AnnouncementBanner from '@/components/AnnouncementBanner';
import RefusalStamp from '@/components/RefusalStamp';
import { apiBase } from '@/lib/apiBase';
import {
  clearRoleSession,
  persistAuthoritativeRoleSession,
  loadAuthoritativeRoleSession,
} from '@/components/roleSession';
import { createMicrosoftSignInHandler } from '@/src/client/loginPageHelpers';
import { DEFAULT_PIN_LENGTH } from '@/src/server/pilot/pinPolicy';

type LoginMethod = 'microsoft' | 'pin' | 'magic_link';

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
  // Microsoft, not PIN. PIN sign-in admits only athletes -- credentialPolicy
  // says so and loginWithAccountIdAndPin enforces it -- and athletes have their
  // own door at /athlete/sign-in. Opening on the PIN tab meant every coach,
  // parent and staff member met a form that could not authenticate them, and a
  // refusal that blamed their credential instead of the door.
  const [selectedMethod, setSelectedMethod] = useState<LoginMethod>('microsoft');
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

  const authErrorMessage = (() => {
    const error = searchParams.get('error');
    if (!error) {
      return '';
    }

    if (error === 'not-invited') {
      return 'This Microsoft account is not invited or not active.';
    }

    if (error === 'auth-state-expired') {
      return 'Your sign-in session expired or the browser blocked the login cookies. Please try again.';
    }

    if (error === 'auth-forbidden') {
      return 'This account signed in, but its role has no workspace yet. Ask your organization admin to finish setting it up.';
    }

    // RoleSessionGate emits these two; without a case they fell through to the
    // Microsoft message even when the user had signed in with a PIN.
    if (error === 'privileged_auth_required') {
      return 'That area requires a Microsoft sign-in. Please continue with Microsoft.';
    }

    if (error === 'unsupported_role') {
      return 'Your account role cannot open that area.';
    }

    return 'Microsoft sign-in failed. Please try again.';
  })();

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

  /* Law 1: a selected tab is a control in the "on" position — chassis state,
     not a claim about anybody. The chosen method wears brass; the other wears
     the ghost treatment. This is what the red used to do, and the red is the
     safety gate's colour (Law 2), so it cannot also mean "you tapped this". */
  const methodButton = (method: LoginMethod) =>
    `btn ${selectedMethod === method ? '' : 'btn--ghost'} grow justify-center text-center sm:grow-0`;

  return (
    <div className="relative">
      {/* THE BOARD, NOT A CARD.
          A sign-in screen that is a white rectangle in the middle of a page is
          a slide. This is the gym's own board: a lamp over it, a brass frame
          around it, studs holding it together, and a stamp across the corner.
          Every piece here already existed in ppbf.css and had never been
          composed -- .rivet--patina had zero usages in the app.

          The lamp is standalone-only. In the /public popover the panel is
          already inside a modal with its own backdrop, and a light fixture
          hanging inside a dialog reads as a bug, not as a room. */}
      {!embedded && (
        <span className="lamp left-1/2 -translate-x-1/2" aria-hidden="true" />
      )}

      <div className={`frame relative ${embedded ? '' : 'mt-[42px]'}`}>
        {/* Eight studs, not four. Four corners read as a rounded rectangle
            with dots; studs down the long edges read as something bolted
            together. --patina rather than brass so they sit back from the
            frame's own brass instead of competing with it. */}
        <span className="rivet rivet--patina rivet--tl" />
        <span className="rivet rivet--patina rivet--tr" />
        <span className="rivet rivet--patina rivet--bl" />
        <span className="rivet rivet--patina rivet--br" />
        <span className="rivet rivet--patina absolute left-1/2 top-[8px] -translate-x-1/2" />
        <span className="rivet rivet--patina absolute bottom-[8px] left-1/2 -translate-x-1/2" />
        <span className="rivet rivet--patina absolute left-[8px] top-1/2 -translate-y-1/2" />
        <span className="rivet rivet--patina absolute right-[8px] top-1/2 -translate-y-1/2" />

        {/* mat-wood--dark, not mat-paper. The ground flip is safe without an
            ink pass: every type voice pins a bone or brass rung tuned for dark
            material, and it was .mat-paper that was overriding them. Removing
            it returns each voice to its native reading rather than needing a
            new one. The one paper element inside (the activation note) stays
            paper deliberately -- a note pinned to a board has depth that a
            panel of uniform cards does not. */}
        <div className="frame-in mat-wood--dark" style={{ padding: 'var(--s6)' }}>
        <header className="mb-[var(--s6)] flex flex-wrap items-start justify-between gap-[var(--s4)]">
          <div>
            <div className="t-eyebrow">Punxsy Prominence &middot; Member Access</div>
            <h1 className="t-painted mt-[var(--s3)]" style={{ fontSize: 'var(--t-2xl)' }}>
              The Bell
            </h1>
            {/* The gym's own words, on the gym's own door.
                This first read OBSERVE. DECIDE. EXECUTE. -- which is the
                SHADOW UI tagline (CLAUDE.md line 14, and four docs under
                docs/shadow-ui/). SHADOW is the coaching intelligence and it
                lives in After Hours. Putting its motto on a signed-out family
                surface is the same voice mistake as titling this screen after
                SHADOW, which was already declined: the person reading this is
                a parent, a kid, or a volunteer who has not signed in yet.

                "Not fancy, just tough" is what a free youth boxing program in
                a rural steel town actually sounds like, and it sets the brief
                for everything else on this screen. Nothing here should read as
                ornament: the studs hold the board together, the lamp is a bare
                caged bulb, the stamp is ink on wood. If a future change to
                this page could be called decorative, it is wrong.

                On a brass plaque because that is what a gym screws a motto to,
                and because a plaque is a different OBJECT from the text around
                it -- the kind of variation a page of equal paragraphs in equal
                cards never gets. */}
            <p className="mat-brass--dark t-eyebrow mt-[var(--s4)] inline-block rounded-[var(--r-sm)] px-[var(--s4)] py-[var(--s2)]">
              NOT FANCY. JUST TOUGH.
            </p>
            <p className="t-body mt-[var(--s4)] max-w-[52ch]">
              Sign in with Account ID/PIN or Microsoft. You will land on the right dashboard for your role.
            </p>
          </div>
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
        </header>

        {/* Sign-in failures arrive as a full-page redirect, which resets the
            tab to PIN. While this banner lived inside the Microsoft panel a
            rejected user saw an empty PIN form and no reason at all. */}
        {/* Law 3: the glyph and the uppercase label carry the state, so a
            refusal still reads in greyscale and to a colour-blind user —
            the red is the third channel, never the only one. This replaces
            an emoji, which is neither a system glyph nor legible at 11px. */}
        {authErrorMessage && (
          <div
            className="mb-[var(--s5)] rounded-[var(--r-md)] border-2 border-[color:var(--locked)] bg-[rgba(168,30,34,0.06)] p-[var(--s4)]"
            role="alert"
          >
            <span className="badge badge--locked">
              <i>✕</i>Sign-in refused
            </span>
            <p className="t-body mt-[var(--s3)]">{authErrorMessage}</p>
          </div>
        )}

        <fieldset className="mb-[var(--s6)] border-0 p-0">
          <legend className="t-label mb-[var(--s4)]">Choose Sign-In Method</legend>
          {/* Was `grid sm:grid-cols-3` -- three identical cells with an
              identical gutter, which is the single most PowerPoint-shaped
              thing on the page. These are three different objects: a wrap
              flex lets each plate take the width of its own label, so the row
              reads as switches screwed to a board rather than as slide
              bullets. They still stack to full width below sm. */}
          <div className="flex flex-wrap gap-[var(--s4)]">
            <button
              type="button"
              onClick={() => setSelectedMethod('microsoft')}
              aria-pressed={selectedMethod === 'microsoft'}
              className={methodButton('microsoft')}
            >
              {selectedMethod === 'microsoft' ? '✓ ' : ''}Microsoft
            </button>
            <button
              type="button"
              onClick={() => setSelectedMethod('magic_link')}
              aria-pressed={selectedMethod === 'magic_link'}
              className={methodButton('magic_link')}
            >
              {selectedMethod === 'magic_link' ? '✓ ' : ''}Email Link
            </button>
            <button
              type="button"
              onClick={() => setSelectedMethod('pin')}
              aria-pressed={selectedMethod === 'pin'}
              className={methodButton('pin')}
            >
              {selectedMethod === 'pin' ? '✓ ' : ''}Account ID / PIN
            </button>
          </div>
        </fieldset>

        {selectedMethod === 'microsoft' && (
          <div className="grid gap-[var(--s5)]">
            <div>
              <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
                Microsoft Sign In
              </h2>
              <p className="t-body mt-[var(--s3)]">
                Continue below to sign in securely with your Microsoft account. Your organization admin manages who can access the platform.
              </p>
            </div>
            <button type="button" onClick={microsoftSignIn} className="btn btn--kiosk">
              Continue With Microsoft
            </button>
          </div>
        )}

        {selectedMethod === 'magic_link' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void requestMagicLink();
            }}
            className="grid gap-[var(--s5)]"
          >
            <div>
              <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
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
        )}

        {selectedMethod === 'pin' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void loginWithPin();
            }}
            className="grid gap-[var(--s5)]"
          >
            <div>
              <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
                Account PIN Sign In
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
              <div className="field">
                <label className="t-label" htmlFor="login-pin">
                  PIN ({DEFAULT_PIN_LENGTH} digits)
                </label>
                <input
                  id="login-pin"
                  type="password"
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
                  className="input input--kiosk"
                />
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
        )}
      </div>

        {/* THE THING THAT BREAKS THE FRAME.
            Slides are strictly flat and strictly inside their own edges, and
            that containment is most of why a screen reads as a slide. This
            stamp is rotated by .stamp's own rule, sits on top of the board,
            and hangs off its bottom-right corner -- one element that refuses
            the rectangle.

            aria-hidden and pointer-events-none: it is a mark on the board, not
            a control and not a status. Law 7 reserves a real stamp for a real
            refusal; this one says nothing a screen reader needs, and a person
            using one must not be told there is a button here. */}
        <span
          aria-hidden="true"
          className="stamp pointer-events-none absolute -bottom-[18px] right-[24px] select-none"
        >
          Enter The Gym
        </span>
      </div>

      {/* Help and gym notices sit outside the frame: the framed board is the
          thing you fill in, and this is what's tacked up next to it. They are
          a sibling of the board now -- this comment said "outside the frame"
          while the markup had them inside the brass border. Kept in
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
    </div>
  );
}
