'use client';

import { Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';

import { persistAuthoritativeRoleSession, loadAuthoritativeRoleSession } from '@/components/roleSession';
import { apiBase } from '@/lib/apiBase';
import { PASSWORD_RULE_SUMMARY } from '@/src/server/pilot/passwordPolicy';

/**
 * The page a sign-in link opens.
 *
 * The emailed URL lands here, and this page POSTs the token to the consume
 * route. It would be simpler for the link to hit the API directly -- and it
 * would break for exactly the people whose mail is best protected. Outlook Safe
 * Links, Defender and corporate gateways all GET the URLs in a message to check
 * them, which would burn a single-use token before the human ever clicked.
 * Scanners do not POST. That is why this page exists at all.
 *
 * The POST fires automatically on load rather than behind a button. A scanner
 * running JavaScript and posting a form is not a threat model anyone has; a
 * parent facing an unexplained "Continue" button is a real drop-off.
 */

const REASON_COPY: Record<string, string> = {
  TOKEN_EXPIRED: 'That link has expired. Sign-in links last 15 minutes -- ask for a new one.',
  TOKEN_ALREADY_USED: 'That link has already been used. Ask for a new one.',
  TOKEN_INVALIDATED: 'A newer sign-in link was sent. Use the most recent email, or ask for another.',
  TOKEN_UNKNOWN: 'That link is not valid. Ask for a new one.',
  ACCOUNT_INACTIVE: 'That account is not active. Contact the gym.',
  ACCOUNT_NOT_MAGIC_LINK: 'That account signs in a different way. Return to the sign-in page.',
  EMAIL_CHANGED: 'The email address on that account changed after the link was sent. Ask for a new one.',
  RATE_LIMITED: 'Too many attempts. Wait a few minutes and try again.',
  TOKEN_MISSING: 'That link is incomplete. Open it directly from the email.',
};

/**
 * "Make a password", offered after the link has already signed the parent in.
 *
 * Skippable (OD-2026-10-01-002 section 3 item 1): "Not Now" goes where the
 * link went before this prompt existed. The parent is signed in whatever
 * happens here, so no outcome below strands them.
 *
 * The server decides every rule. This form checks only that something was
 * typed and that the two boxes agree; the sentence beside the field is the
 * server's own (PASSWORD_RULE_SUMMARY) and a refused password shows the
 * server's own message. The password is sent as typed -- a space at either end
 * is part of it -- and is never logged or shown.
 */
function PasswordPrompt({ onDone }: { onDone: () => void }) {
  // Read from the boxes when Save is pressed and held nowhere else: not in
  // state, and so not in a `value` attribute either.
  const passwordBox = useRef<HTMLInputElement>(null);
  const againBox = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [linkTooOld, setLinkTooOld] = useState(false);
  const [saved, setSaved] = useState(false);
  // A second request that overlaps a successful one meets the route's
  // one-second pause and answers 429. The password WAS saved, so once a 200
  // has been seen no later answer may put an error on the screen.
  const savedOnce = useRef(false);
  // The form, and the button that had focus, are gone once the prompt has an
  // answer. Focus moves to what replaced them rather than back to the top.
  const answerPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (saved || linkTooOld) answerPanel.current?.focus();
  }, [saved, linkTooOld]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const password = passwordBox.current?.value ?? '';
    if (password === '') {
      setProblem('Type a password first.');
      return;
    }
    if (password !== (againBox.current?.value ?? '')) {
      setProblem('Those two don’t match. Type them again.');
      return;
    }

    setBusy(true);
    setProblem('');
    let outcome = 'Could not save the password right now. You can skip this and try from a new link later.';
    let tooOld = false;
    try {
      const response = await fetch(`${apiBase()}/api/pilot/auth/password/set`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: unknown; code?: unknown };

      if (response.ok && payload.ok) {
        savedOnce.current = true;
        setSaved(true);
        return;
      }

      const code = typeof payload.code === 'string' ? payload.code : '';
      if (response.status === 403 && code === 'PASSWORD_SETUP_LINK_REQUIRED') {
        tooOld = true;
      } else if (response.status === 429) {
        outcome = 'Too many tries. Wait a minute and try again.';
      } else if (response.status === 400 && code.startsWith('PASSWORD_') && typeof payload.error === 'string') {
        // Written by the server for the parent to read (passwordPolicy.ts).
        outcome = payload.error;
      }
    } catch {
      // Falls through to the "could not save" line.
    } finally {
      setBusy(false);
    }

    if (savedOnce.current) return;
    if (tooOld) {
      setLinkTooOld(true);
      return;
    }
    setProblem(outcome);
  }

  if (saved) {
    return (
      <section ref={answerPanel} tabIndex={-1} className="grid gap-[var(--s5)]">
        <div className="rounded-[var(--r-md)] border-2 border-[color:var(--proven)] p-[var(--s4)]" role="status">
          <p className="t-body">
            Password saved. Next time, sign in with your email and this password in any browser.
          </p>
        </div>
        <button type="button" onClick={onDone} className="btn btn--kiosk">
          Continue
        </button>
      </section>
    );
  }

  if (linkTooOld) {
    return (
      <section ref={answerPanel} tabIndex={-1} className="grid gap-[var(--s5)]">
        <p className="t-body" role="alert">
          That sign-in link is too old to set a password with. You&rsquo;re still signed in. Ask for a new link
          from the sign-in page when you want to set one.
        </p>
        <button type="button" onClick={onDone} className="btn btn--kiosk">
          Continue
        </button>
        {/* /login sends a signed-in visitor straight on to their dashboard
            (SignInPanel), so the plain address would never show the "email me
            a link" form. ?logout=true is that panel's own way in: it signs
            this browser out and stays on the form. */}
        <Link href="/login?logout=true" className="btn btn--ghost">
          Back To Sign In
        </Link>
      </section>
    );
  }

  return (
    <form className="grid gap-[var(--s5)]" aria-labelledby="link-password-heading" onSubmit={save}>
      <div>
        <h2 id="link-password-heading" className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
          Make A Password
        </h2>
        <p className="t-body mt-[var(--s3)]">
          You&rsquo;re signed in. Want a password for next time? It works in any browser, so you won&rsquo;t need
          to wait for an email.
        </p>
      </div>
      <div className="field">
        <label className="t-label" htmlFor="link-password">
          Password
        </label>
        <input
          ref={passwordBox}
          id="link-password"
          type="password"
          autoComplete="new-password"
          className="input input--kiosk"
          aria-describedby="link-password-rules"
        />
        <p id="link-password-rules" className="t-muted mt-[var(--s3)]" style={{ fontSize: 'var(--t-sm)' }}>
          {PASSWORD_RULE_SUMMARY}
        </p>
      </div>
      <div className="field">
        <label className="t-label" htmlFor="link-password-again">
          Type it again
        </label>
        <input
          ref={againBox}
          id="link-password-again"
          type="password"
          autoComplete="new-password"
          className="input input--kiosk"
        />
      </div>
      {problem && (
        <p className="t-body" role="alert">
          {problem}
        </p>
      )}
      <button type="submit" disabled={busy} className="btn btn--kiosk">
        Save Password
      </button>
      {/* Not while a save is out: leaving then would set the password behind
          a parent who believes they skipped. */}
      <button type="button" onClick={onDone} disabled={busy} className="btn btn--ghost">
        Not Now
      </button>
    </form>
  );
}

/** How long a spent link waits to learn whether this browser is signed in. */
const SPENT_LINK_SESSION_CHECK_MS = 8000;

/**
 * Whether this browser already holds a session, asked of the server and of
 * nothing else. Null on a refusal, an error, or no answer in time.
 */
async function sessionAlreadyHere() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SPENT_LINK_SESSION_CHECK_MS);
  try {
    const resolution = await loadAuthoritativeRoleSession(`${apiBase()}/api/pilot/auth/session`, {
      signal: controller.signal,
    });
    return resolution.ok ? resolution : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function LinkPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState('');
  // Set once the link has signed the parent in AND the server offered a
  // password: where "Not Now" and "Continue" go, which is where the link
  // itself would have gone.
  const [offerDestination, setOfferDestination] = useState<string | null>(null);
  // Guards against React 18 StrictMode running effects twice in development,
  // which would POST the token twice -- the second attempt losing the race
  // against the first and showing a spurious "already used".
  const attempted = useRef(false);
  const token = searchParams.get('token');

  useEffect(() => {
    if (attempted.current) return;
    // Nothing to do without a token, and nothing to set: the missing case is
    // derived at render below. Calling setState synchronously in an effect
    // triggers a cascading render, and lint refuses it -- rightly, since the
    // value was knowable before the effect ever ran.
    if (!token) return;
    attempted.current = true;

    (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/auth/magic-link/consume`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });

        const payload = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          reason?: string;
          password_setup?: unknown;
        };

        if (!response.ok || !payload.ok) {
          // A spent link reopened in a browser that is still signed in: a
          // phone reloading this page while the password prompt is up is the
          // common way here. The link grants nothing on this path. Only a
          // session the server confirms for this browser moves anyone on, to
          // that session's own destination, and no password is offered --
          // nothing says the link was this account's. Anything short of that
          // is the refusal it has always been.
          if (payload.reason === 'TOKEN_ALREADY_USED') {
            const existing = await sessionAlreadyHere();
            if (existing) {
              persistAuthoritativeRoleSession(existing.session);
              router.replace(existing.destination);
              return;
            }
          }
          setError(REASON_COPY[payload.reason ?? ''] ?? 'That sign-in link did not work. Ask for a new one.');
          return;
        }

        // The session cookie is set; ask the server who we are rather than
        // trusting the response body, the same way every other sign-in path
        // here does.
        const resolution = await loadAuthoritativeRoleSession(`${apiBase()}/api/pilot/auth/session`);
        if (!resolution.ok) {
          setError('Signed in, but the session could not be confirmed. Try the sign-in page.');
          return;
        }

        persistAuthoritativeRoleSession(resolution.session);
        // Only the server's own 'offer' shows the prompt; anything else, or
        // nothing, goes straight on as it always has.
        if (payload.password_setup === 'offer') {
          setOfferDestination(resolution.destination);
          return;
        }
        router.replace(resolution.destination);
      } catch {
        setError('Could not reach the gym right now. Try that link again in a moment.');
      }
    })();
  }, [router, token]);

  // A link opened without a token never had one, so this is a render-time
  // fact rather than an effect outcome.
  const displayedError = token ? error : REASON_COPY.TOKEN_MISSING;

  return (
    <main className="mx-auto max-w-[42rem] p-[var(--s6)]">
      <h1 className="t-h1 mb-[var(--s4)]">The Bell</h1>
      {/* A sign-in link that did not work is an authentication fact, not a
          medical one. This panel wore --locked on its border and the seed red
          itself -- #A81E22, in its rgba spelling -- as its ground: the same
          red the clinic uses for MEDICALLY_NOT_ALLOWED, a child who may not
          participate (owner decision 2026-08-19). An expired link, a link
          already used, a rate limit: not one of those is a claim about a
          person.

          It takes the restricted rung instead, the precedented substitution
          (#576, and PR #609 on /schedule for this exact panel shape): border
          and badge move to --restricted, the ground moves to that rung's own
          colour, the glyph goes ✕ -> ▲. The copy does not move -- the panel
          said "Sign-in refused" before and says it now -- because what
          changed is which severity the colour claims, not what happened.

          --locked is left to mean a child is in danger. Red itself is not
          reserved (OD-2026-09-29-001). */}
      {displayedError ? (
        <div
          className="rounded-[var(--r-md)] border-2 border-[color:var(--restricted)] bg-[rgba(192,90,30,0.10)] p-[var(--s4)]"
          role="alert"
        >
          <span className="badge badge--restricted">
            <i>▲</i>Sign-in refused
          </span>
          <p className="t-body mt-[var(--s3)]">{displayedError}</p>
          <Link href="/login" className="btn btn--kiosk mt-[var(--s4)] inline-block">
            Back To Sign In
          </Link>
        </div>
      ) : offerDestination !== null ? (
        <PasswordPrompt onDone={() => router.replace(offerDestination)} />
      ) : (
        <p className="t-body" role="status">
          Signing you in…
        </p>
      )}
    </main>
  );
}

export default function MagicLinkPage() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-[42rem] p-[var(--s6)]"><p className="t-body">Signing you in…</p></main>}>
      <LinkPageContent />
    </Suspense>
  );
}
