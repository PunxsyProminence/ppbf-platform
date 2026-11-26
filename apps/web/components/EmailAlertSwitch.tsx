'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiBase } from '@/lib/apiBase';
import EmailAlertAddress, { type AddressState } from './EmailAlertAddress';

/**
 * EMAIL ALERTS: each person's own switch on /profile (lane W4-1, EM-2; the
 * adult athlete's part, EM-2b-3). OD-2026-11-19-019: an opt-in email that says
 * only "open the app"; OW27-10 A: one switch on each person's own settings page.
 *
 * WHO SEES IT. Only someone GET /api/pilot/email-alerts/me offers a switch to
 * (`offered: true`): staff, parents, and athletes 18 or over. Anyone else --
 * an athlete under 18 or with no date of birth (OW27-02 C; OD-2026-10-04-010),
 * a 'staff' or 'volunteer' login (403), a first read that fails -- gets
 * nothing at all on this page: no panel, no message, no warning (L1 rule).
 *
 * THE ADULT ATHLETE (EM-2b-3; OW27-38 B). They type an address, the app
 * emails a code to it, and it is used only once they enter that code
 * (EmailAlertAddress). GO condition 3: no On until GET says an address is
 * confirmed (the server answers 409 otherwise). Default 10: confirming never
 * switches on; On stays its own press. Default 9: no answer holds an address,
 * so this panel says only that one is confirmed or that a code is waiting.
 * Their help text says alerts go to the address they confirm, not the one
 * they sign in with (staff's and parents' words are unchanged).
 *
 * After any request: a refusal (403), or an answer that says no switch is
 * offered, takes the panel away at once, whoever is signed in by then, with
 * nothing said (a minor in a stale tab sees nothing new). A signed-out request
 * (401), or a signed-out read after a failed one, says so, and the controls
 * then send nothing until the page is reloaded. Any other failure -- a dropped
 * connection, a server error, a 409, a refused code, or a success whose answer
 * cannot be read (a lost body, a captive portal's page) -- reads the setting
 * again and shows that. For the switch: no error if the change did land, "not
 * saved" only if it did not, and after a save and a read that both failed,
 * neither choice is pressed and the panel says so (an unknown setting never
 * looks like off). For the address and code: the error's fixed words, chosen
 * by its code, never the server's text; the 429 says no more than "too many".
 *
 * The routes are self-scoped: nothing here names an account. The bodies are
 * exactly { switched_on }, { address } and { code }.
 */

type UserType = 'staff' | 'parent' | 'adult_athlete';

interface ShownSwitch {
  readonly userType: UserType;
  /** null: not known (a save and the read after it both failed, or signed out). */
  readonly switchedOn: boolean | null;
  /** Adult athletes only, and always for them. */
  readonly address?: AddressState;
}

type Read = ShownSwitch | 'hidden' | 'signed_out' | 'failed';

const SHOWN_TO: readonly UserType[] = ['staff', 'parent', 'adult_athlete'];

const ROUTE = '/api/pilot/email-alerts/me';

/** One press: the switch (PUT /me), an address to send a code to, or a code. */
type Step =
  | { readonly kind: 'switch'; readonly switchedOn: boolean }
  | { readonly kind: 'address'; readonly address: string }
  | { readonly kind: 'code'; readonly code: string };

function requestFor(step: Step): { path: string; method: 'POST' | 'PUT'; body: object } {
  if (step.kind === 'switch') return { path: ROUTE, method: 'PUT', body: { switched_on: step.switchedOn } };
  return step.kind === 'address'
    ? { path: `${ROUTE}/address`, method: 'POST', body: { address: step.address } }
    : { path: `${ROUTE}/address`, method: 'PUT', body: { code: step.code } };
}

const BUSY_WORDS: Record<Step['kind'], string> = {
  switch: 'Saving…',
  address: 'Sending a code…',
  code: 'Checking the code…',
};

/** Fixed words for each refusal the address route names (me/address/route.ts); never the server's text. */
const ADDRESS_REFUSALS = new Map<string, string>([
  ['EMAIL_ALERT_CODE_WRONG', 'That code is not right. Check the email and try again.'],
  ['EMAIL_ALERT_CODE_EXPIRED', 'That code has expired. Ask for a new one.'],
  ['EMAIL_ALERT_CODE_TRIES_USED', 'That code has had too many tries. Ask for a new one.'],
  // Default 4: one answer for every limit, so these words name none of them.
  ['EMAIL_ALERT_CODE_LIMIT', 'Too many codes asked for. Try again later.'],
  ['EMAIL_ALERT_CODE_NOT_SENT', 'The code email could not be sent. Try again.'],
]);

function addressFailure(step: Step, status: number | null, code: unknown, read: ShownSwitch | null): string {
  // Default 3: a wrong code that used the last try leaves no code to enter (GET says so).
  const named = code === 'EMAIL_ALERT_CODE_WRONG' && read?.address && !read.address.codePending
    ? 'EMAIL_ALERT_CODE_TRIES_USED' : code;
  const refusal = typeof named === 'string' ? ADDRESS_REFUSALS.get(named) : undefined;
  if (refusal) return refusal;
  if (status === 400) return step.kind === 'address' ? 'Enter a valid email address.' : 'Enter the six-digit code from the email.';
  return 'That may not have gone through. Try again if you need to.';
}

export interface EmailAlertSwitchStyles {
  readonly panel: string;
  readonly heading: string;
  readonly help: string;
  readonly choiceBase: string;
  readonly choiceOn: string;
  readonly choiceOff: string;
}

/** The route's answer as a switch shown here, or 'hidden'. */
function fromPayload(payload: unknown): ShownSwitch | 'hidden' {
  if (!payload || typeof payload !== 'object') return 'hidden';
  const body = payload as {
    ok?: unknown; offered?: unknown; user_type?: unknown; switched_on?: unknown;
    address_confirmed?: unknown; code_pending?: unknown;
  };
  if (body.ok !== true || body.offered !== true || typeof body.switched_on !== 'boolean') return 'hidden';
  const userType = SHOWN_TO.find((shown) => shown === body.user_type);
  if (!userType) return 'hidden';
  if (userType !== 'adult_athlete') return { userType, switchedOn: body.switched_on };
  // Without both address fields this panel could not say truly whether On may be offered.
  if (typeof body.address_confirmed !== 'boolean' || typeof body.code_pending !== 'boolean') return 'hidden';
  return {
    userType,
    switchedOn: body.switched_on,
    address: { confirmed: body.address_confirmed, codePending: body.code_pending },
  };
}

const SIGNED_OUT = 'You are signed out. Sign in again to see or change this.';

async function readSwitch(): Promise<Read> {
  try {
    const response = await fetch(`${apiBase()}${ROUTE}`, { credentials: 'include' });
    // A refusal (a role with no switch) is not a fault: there is nothing to show.
    if (response.status === 403) return 'hidden';
    if (response.status === 401) return 'signed_out';
    if (!response.ok) return 'failed';
    return fromPayload(await response.json());
  } catch {
    return 'failed';
  }
}

export default function EmailAlertSwitch({ styles }: { styles: EmailAlertSwitchStyles }) {
  const [current, setCurrent] = useState<ShownSwitch | null>(null);
  const [busy, setBusy] = useState<Step['kind'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);

  useEffect(() => {
    void readSwitch().then((read) => {
      if (read !== 'hidden' && read !== 'signed_out' && read !== 'failed') setCurrent(read);
    });
  }, []);

  /** Sends one press; true only when the answer is the new state, shown. */
  const send = useCallback(async (before: ShownSwitch, step: Step): Promise<boolean> => {
    setBusy(step.kind);
    setError(null);
    let status: number | null = null;
    let saved: ShownSwitch | 'hidden' | null = null;
    let code: unknown;
    try {
      const { path, method, body } = requestFor(step);
      const response = await fetch(`${apiBase()}${path}`, {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      status = response.status;
      // A success whose answer cannot be read is not known to have landed: it
      // is read again below, never taken as "not offered".
      const answer: unknown = await response.json().catch(() => undefined);
      if (response.ok && answer !== undefined) saved = fromPayload(answer);
      if (!response.ok && answer && typeof answer === 'object') code = (answer as { code?: unknown }).code;
    } catch {
      saved = null;
    }
    const signOut = () => {
      // Nothing was saved, and with no session the setting cannot be read.
      setCurrent({ ...before, switchedOn: null });
      setError(SIGNED_OUT);
      setSignedOut(true);
    };
    if (saved && saved !== 'hidden') {
      setCurrent(saved);
    } else if (saved === 'hidden' || status === 403) {
      // Refused, or answered as not offered: no switch for whoever is signed
      // in now, so the panel goes, and nothing more is said (L1 rule).
      setCurrent(null);
    } else if (status === 401) {
      signOut();
    } else {
      // Not known to have landed: show what the server holds now, not what
      // was asked for.
      const read = await readSwitch();
      if (read === 'hidden') {
        setCurrent(null);
      } else if (read === 'signed_out') {
        signOut();
      } else if (step.kind !== 'switch') {
        if (read !== 'failed') setCurrent(read);
        setError(addressFailure(step, status, code, read === 'failed' ? null : read));
      } else if (read === 'failed') {
        setCurrent({ ...before, switchedOn: null });
        setError('That change may not have been saved, and your setting could not be read. Try again.');
      } else {
        setCurrent(read);
        if (read.switchedOn !== step.switchedOn) setError('That change was not saved.');
      }
    }
    setBusy(null);
    return Boolean(saved && saved !== 'hidden');
  }, []);

  if (!current) return null;

  const saving = busy !== null;
  const address = current.address;
  // GO condition 3: an adult athlete gets On only once an address is
  // confirmed; a switch somehow on can always be turned off.
  const showChoices = !address || address.confirmed || current.switchedOn === true;
  // The state in words, saving or not, so the pressed colour is never the
  // only thing that says which choice is in force.
  const inForce = current.switchedOn === null
    ? 'Your setting could not be read.'
    : current.switchedOn ? 'Email alerts are on.' : 'Email alerts are off.';
  // Default 9: whether an address is confirmed or a code waits, never which
  // address. Signed out, it cannot be read, so nothing is said of it.
  const addressWords = !address || signedOut ? null
    : address.confirmed && address.codePending ? 'Your address is confirmed. A code for a new address is waiting.'
      : address.confirmed ? 'Your address is confirmed.'
        : address.codePending ? 'A code was sent. Enter it to confirm your address.' : 'No address is confirmed yet.';
  const status = [busy && BUSY_WORDS[busy], inForce, addressWords].filter(Boolean).join(' ');

  return (
    <section className={styles.panel} aria-labelledby="email-alerts-heading">
      <h2 id="email-alerts-heading" className={styles.heading}>Email alerts</h2>
      <p className={styles.help}>
        Off unless you turn it on. When it is on, an email can go to
        {address ? ' the address you confirm here ' : ' the address you sign in with '}
        when certain new things arrive for you in the app. It says only &ldquo;open the
        app&rdquo;, with the gym&rsquo;s name. It never says what happened or who it is about.
      </p>
      {showChoices && (
        <div className="flex flex-wrap gap-[var(--s3)]" role="group" aria-label="Email alerts" aria-busy={saving}>
          {[false, true].map((on) => (
            <button
              key={on ? 'on' : 'off'}
              type="button"
              aria-pressed={current.switchedOn === on}
              // aria-disabled, not disabled: a disabled button drops the
              // keyboard focus of the person who just pressed it.
              aria-disabled={saving || signedOut}
              className={`${styles.choiceBase} ${current.switchedOn === on ? styles.choiceOn : styles.choiceOff}`}
              onClick={() => {
                // Signed out: a press could only be refused again (no control that does nothing).
                if (!saving && !signedOut && current.switchedOn !== on) void send(current, { kind: 'switch', switchedOn: on });
              }}
            >
              {on ? 'On' : 'Off'}
            </button>
          ))}
        </div>
      )}
      {address && (
        <EmailAlertAddress
          state={address}
          saving={saving}
          unavailable={saving || signedOut}
          helpClass={styles.help}
          onSendCode={(typed) => send(current, { kind: 'address', address: typed })}
          onConfirm={(typed) => send(current, { kind: 'code', code: typed })}
        />
      )}
      <p className={styles.help} aria-live="polite">{status}</p>
      {error && (
        <p role="alert" className="text-[length:var(--t-xs)] text-[color:var(--restricted-ink)]">
          <span aria-hidden="true">▲ </span>
          <span>{error}</span>
        </p>
      )}
    </section>
  );
}
