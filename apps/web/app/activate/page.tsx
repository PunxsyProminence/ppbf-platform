'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { apiBase } from '@/lib/apiBase';
import { useFocusOnStepChange } from '@/src/lib/useFocusOnStepChange';
import { DEFAULT_PIN_LENGTH } from '@/src/server/pilot/pinPolicy';

// Single source of truth with the server policy: validatePinPolicy enforces
// this exact length, so a local copy could silently disagree with it.
const PIN_LENGTH = DEFAULT_PIN_LENGTH;
const CODE_LENGTH = 12;
const PIN_PATTERN = /^\d{6}$/;

/* First contact. A family opens this on a phone, in a car park or a kitchen,
   holding a code slip a coach handed them -- so it sits on canvas ground (Law
   6: warm for families, ink for staff) and every target is --tap rather than
   the 52px and 44px it was built at.

   The cards were bg-white with rounded-2xl and rounded-xl fields: white is not
   one of the five materials and neither radius is on the Fibonacci scale. They
   are paper now. The chrome came off the safety gate's red alias, since a
   Continue button is not a safety state. Red survives only on the genuine
   refusal, and the success panel takes the ladder's own --cleared instead of
   the hardcoded material-green hex it used to carry.

   Sizes are set with Tailwind rather than ppbf's .t-* voices on purpose:
   globals.css imports ppbf.css after Tailwind, so .t-body and .t-label pin
   14px and 11px through the `font:` shorthand and silently beat any size
   utility. .t-command carries no font-size, so it still composes. */
const EYEBROW =
  'font-mono text-[length:var(--t-sm)] uppercase tracking-[0.28em] text-[color:var(--brass-800)]';
const LEDE = 'text-[length:var(--t-md)] leading-[1.55] text-[color:var(--hide-800)]';
const CARD =
  'mat-paper flex flex-col gap-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgba(0,0,0,.14)] p-[var(--s6)]';
const FIELD_LABEL =
  'block font-mono text-[length:var(--t-sm)] font-semibold uppercase tracking-[0.14em] text-[color:var(--hide-900)]';
const FIELD_HINT = 'mt-[var(--s3)] text-[length:var(--t-sm)] leading-[1.5] text-[color:var(--hide-700)]';
const PIN_INPUT =
  'input input--kiosk mt-[var(--s3)] text-center tracking-[0.35em] font-[family-name:var(--font-mono)]';
const ALERT =
  'flex items-start gap-[var(--s3)] rounded-[var(--r-sm)] border-2 border-[color:var(--locked)] ' +
  'bg-[color-mix(in_srgb,var(--locked)_12%,var(--paper))] px-[var(--s4)] py-[var(--s4)] ' +
  'text-[length:var(--t-sm)] font-semibold text-[color:var(--hide-950)]';
const STEP_ON = 'font-bold text-[color:var(--brass-800)]';
const STEP_OFF = 'text-[color:var(--hide-600)]';
const DISABLED = 'disabled:cursor-not-allowed disabled:opacity-50';

type Stage = 'code' | 'pin' | 'done';

/**
 * Formats a partially-typed code into the XXXX-XXXX-XXXX shape shown on the
 * printed slip, so what the athlete sees on screen matches what they are
 * reading from. Dashes are cosmetic -- the server canonicalizes them away.
 */
function formatCodeInput(raw: string): string {
  const stripped = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
  const groups: string[] = [];
  for (let index = 0; index < stripped.length; index += 4) {
    groups.push(stripped.slice(index, index + 4));
  }
  return groups.join('-');
}

function countCodeCharacters(formatted: string): number {
  return formatted.replace(/-/g, '').length;
}

function ActivatePageContent() {
  const router = useRouter();

  const [stage, setStage] = useState<Stage>('code');
  // Each stage swaps in a whole new <form> with no focus moved to it -- the
  // fix targets the first field of the new stage (or its heading, for the
  // no-more-fields 'done' stage) so the transition is keyboard-reachable
  // and announced.
  useFocusOnStepChange(stage === 'done' ? 'activation-done-heading' : stage === 'pin' ? 'new-pin' : 'activation-code');
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [signedIn, setSignedIn] = useState(false);

  // The activation code is deliberately NOT accepted from the query string.
  // A one-time credential in a URL leaks into browser and proxy history,
  // Referer headers, and access logs, and is trivially forwarded to someone
  // else. Nothing in the app generates such a link: admin/people copies a bare
  // /activate URL and the code travels separately on the athlete's slip, so
  // requiring it to be entered here costs nothing and closes that exposure.

  const codeComplete = countCodeCharacters(code) === CODE_LENGTH;
  const pinValid = PIN_PATTERN.test(pin);
  const pinsMatch = pin === confirmPin;

  function goToPinStage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');

    if (!codeComplete) {
      setError(`Your code is ${CODE_LENGTH} characters. Check the slip and try again.`);
      return;
    }

    setStage('pin');
  }

  async function submitActivation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');

    if (!pinValid) {
      setError(`Your PIN must be exactly ${PIN_LENGTH} numbers.`);
      return;
    }

    if (!pinsMatch) {
      setError('The two PINs do not match.');
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/auth/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ code, pin }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        code?: string;
        account_id?: string;
        signed_in?: boolean;
      };

      if (!response.ok || !payload.ok) {
        /* A rejected PIN is correctable in place; a rejected code means the
           athlete has to start over with a different slip.

           Told apart by the machine CODE the server sends, not by how the
           message happens to be spelled. The prefix test this replaces missed
           PIN_TRIVIALLY_GUESSABLE -- its message begins "That PIN is too easy
           to guess" -- so an athlete who picked 111111 was thrown back to the
           code screen and shown a PIN error there, with both PIN fields
           cleared, as though the slip in their hand were the problem. */
        const message = payload.error || 'We could not activate your account.';
        const isPinProblem = payload.code?.startsWith('PIN_') ?? false;
        if (!isPinProblem) {
          setStage('code');
          setPin('');
          setConfirmPin('');
        }
        throw new Error(message);
      }

      setAccountId(payload.account_id || '');
      setSignedIn(Boolean(payload.signed_in));
      setStage('done');

      if (payload.signed_in) {
        router.refresh();
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'We could not activate your account.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="on-canvas min-h-screen px-[var(--s5)] py-[var(--s7)]">
      <div className="mx-auto flex w-full max-w-[540px] flex-col gap-[var(--s6)]">
        <header className="flex flex-col gap-[var(--s4)] text-center">
          <p className={EYEBROW}>Set up your account</p>
          <h1 className="t-command text-[length:var(--t-xl)]">Activate your PPBF account</h1>
          {stage !== 'done' && (
            <p className={LEDE}>
              Your gym gave you a one-time code. Enter it, then choose a {PIN_LENGTH}-digit PIN only you know.
            </p>
          )}
        </header>

        {stage !== 'done' && (
          /* The step marker is real sequence -- you cannot choose a PIN before
             the code is accepted -- so numbering it says something true. */
          <ol className="flex items-center justify-center gap-[var(--s4)] font-mono text-[length:var(--t-sm)] uppercase tracking-[0.12em]">
            <li className={stage === 'code' ? STEP_ON : STEP_OFF}>1. Your code</li>
            <li aria-hidden="true" className={STEP_OFF}>→</li>
            <li className={stage === 'pin' ? STEP_ON : STEP_OFF}>2. Your PIN</li>
          </ol>
        )}

        {error && (
          /* Law 3 -- the glyph carries the state alongside the colour, so this
             survives greyscale and colour blindness. Red is correct here: it is
             a genuine refusal, not chrome. */
          <p role="alert" className={ALERT}>
            <span aria-hidden="true" className="font-bold text-[color:var(--locked)]">✕</span>
            <span>{error}</span>
          </p>
        )}

        {stage === 'code' && (
          <form onSubmit={goToPinStage} className={CARD}>
            <div>
              <label htmlFor="activation-code" className={FIELD_LABEL}>
                Activation code
              </label>
              <p className={FIELD_HINT}>
                12 characters, like ABCD-2345-EFGH. Capital letters and numbers only.
              </p>
              <input
                id="activation-code"
                type="text"
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="one-time-code"
                spellCheck={false}
                value={code}
                onChange={(event) => setCode(formatCodeInput(event.target.value))}
                placeholder="ABCD-2345-EFGH"
                className="input input--kiosk mt-[var(--s3)] text-center tracking-[0.15em] font-[family-name:var(--font-mono)]"
              />
              <p className={`${FIELD_HINT} text-right`}>
                {countCodeCharacters(code)} / {CODE_LENGTH}
              </p>
            </div>

            <button type="submit" disabled={!codeComplete} className={`btn btn--kiosk ${DISABLED}`}>
              Continue
            </button>
          </form>
        )}

        {stage === 'pin' && (
          <form onSubmit={submitActivation} className={CARD}>
            <div className="rounded-[var(--r-sm)] border border-[color:rgba(0,0,0,.12)] bg-[var(--paper-2)] px-[var(--s4)] py-[var(--s3)]">
              <p className="text-[length:var(--t-sm)] text-[color:var(--hide-800)]">
                Code <span className="font-mono font-semibold text-[color:var(--hide-950)]">{code}</span>
              </p>
            </div>

            <div>
              <label htmlFor="new-pin" className={FIELD_LABEL}>
                Choose your PIN
              </label>
              <p className={FIELD_HINT}>
                {PIN_LENGTH} numbers. Do not use your birthday. Nobody at the gym can see this.
              </p>
              <input
                id="new-pin"
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                value={pin}
                onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH))}
                placeholder="••••••"
                className={PIN_INPUT}
              />
            </div>

            <div>
              <label htmlFor="confirm-pin" className={FIELD_LABEL}>
                Type it again
              </label>
              <input
                id="confirm-pin"
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                value={confirmPin}
                onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH))}
                placeholder="••••••"
                className={PIN_INPUT}
              />
              {confirmPin.length > 0 && !pinsMatch && (
                /* --restricted on paper is 3.74:1 — under the 4.5:1 AA floor for
                   body text, though comfortably over the 3:1 non-text floor. So
                   the words take dark ink and the ▲ keeps the caution hue: the
                   glyph is the second channel Law 3 asks for, and it is the part
                   the 3:1 rule actually governs. */
                <p className="mt-[var(--s3)] flex items-center gap-[var(--s2)] text-[length:var(--t-sm)] font-semibold text-[color:var(--hide-900)]">
                  <span aria-hidden="true" className="text-[color:var(--restricted)]">▲</span> These do not match yet.
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={submitting || !pinValid || !pinsMatch}
              className={`btn btn--kiosk ${DISABLED}`}
            >
              {submitting ? 'Activating…' : 'Activate my account'}
            </button>

            {/* .btn--ghost on canvas ground -- the combination that rendered
                grey on grey until ppbf.css grew an .on-canvas rule for it. */}
            <button
              type="button"
              onClick={() => {
                setStage('code');
                setError('');
              }}
              className="btn btn--ghost btn--kiosk"
            >
              Back to my code
            </button>
          </form>
        )}

        {stage === 'done' && (
          /* Day one. This is the first thing the platform ever says to a new
             athlete, so it gets the cleared rung rather than the hardcoded
             green hex it used to wear -- the same green the safety gate uses
             when it says you are good to go. */
          <section className="mat-paper flex flex-col gap-[var(--s5)] rounded-[var(--r-lg)] border-2 border-[color:var(--cleared)] p-[var(--s6)] text-center">
            <p className="text-[length:var(--t-3xl)] leading-none text-[color:var(--cleared)]" aria-hidden="true">✓</p>
            <h2 id="activation-done-heading" tabIndex={-1} className="t-command text-[length:var(--t-lg)]">You&rsquo;re all set</h2>

            {accountId && (
              <div className="rounded-[var(--r-sm)] border border-[color:rgba(0,0,0,.12)] bg-[var(--paper-2)] px-[var(--s4)] py-[var(--s4)]">
                <p className="font-mono text-[length:var(--t-sm)] uppercase tracking-[0.14em] text-[color:var(--hide-800)]">
                  Your sign-in ID
                </p>
                <p className="mt-[var(--s3)] break-all font-mono text-[length:var(--t-md)] font-bold text-[color:var(--hide-950)]">
                  {accountId}
                </p>
                <p className={FIELD_HINT}>
                  Write this down. You will need it with your PIN every time you sign in.
                </p>
              </div>
            )}

            {signedIn ? (
              <>
                <p className={LEDE}>You are already signed in.</p>
                <Link href="/athlete/dashboard" className="btn btn--kiosk">
                  Go to my dashboard
                </Link>
              </>
            ) : (
              <>
                <p className={LEDE}>Your PIN is set. Sign in with your ID and your new PIN.</p>
                <Link href="/login" className="btn btn--kiosk">
                  Go to sign in
                </Link>
              </>
            )}
          </section>
        )}

        {stage !== 'done' && (
          <p className="text-center text-[length:var(--t-sm)] leading-[1.6] text-[color:var(--hide-800)]">
            Lost your code or it stopped working? Ask your gym admin for a new one.{' '}
            <Link
              href="/login"
              className="font-semibold text-[color:var(--brass-800)] underline underline-offset-2 hover:text-[color:var(--brass-700)]"
            >
              Already activated? Sign in
            </Link>
          </p>
        )}
      </div>
    </main>
  );
}

export default function ActivatePage() {
  // Suspense boundary kept for static rendering of this client page.
  return (
    <Suspense fallback={null}>
      <ActivatePageContent />
    </Suspense>
  );
}
