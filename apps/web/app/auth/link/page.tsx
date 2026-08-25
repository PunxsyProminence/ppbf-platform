'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';

import { persistAuthoritativeRoleSession, loadAuthoritativeRoleSession } from '@/components/roleSession';
import { apiBase } from '@/lib/apiBase';

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

function LinkPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState('');
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
        };

        if (!response.ok || !payload.ok) {
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

          Red is left to mean a child is in danger. */}
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
