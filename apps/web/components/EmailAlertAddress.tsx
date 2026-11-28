import React, { useEffect, useId, useRef, useState } from 'react';

/**
 * AN ADULT ATHLETE'S ALERT ADDRESS on /profile (lane W4-1, EM-2b-3), inside
 * EmailAlertSwitch, which sends the requests and handles every answer. OW27-38
 * B: the address typed is used only after the code emailed to it is entered.
 * GO condition 3: the code field shows only while GET says a code can still
 * be entered. Default 9: no address is ever shown back; the field holds only
 * what is typed, emptied once an address is confirmed. Default 5: the
 * confirmed address stays in use while a new one waits for its code.
 *
 * No 'use client': only EmailAlertSwitch, a client module, renders this, and
 * it takes function props, which a client entry point may not.
 */

/** What GET says of the address: never the address itself (default 9). */
export interface AddressState {
  readonly confirmed: boolean;
  readonly codePending: boolean;
}

interface EmailAlertAddressProps {
  readonly state: AddressState;
  readonly saving: boolean;
  /** Saving or signed out: a press sends nothing. aria-disabled, so focus stays. */
  readonly unavailable: boolean;
  readonly helpClass: string;
  /** Each resolves true only when the step is known to have landed. */
  readonly onSendCode: (address: string) => Promise<boolean>;
  readonly onConfirm: (code: string) => Promise<boolean>;
}

export default function EmailAlertAddress({
  state, saving, unavailable, helpClass, onSendCode, onConfirm,
}: EmailAlertAddressProps) {
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [changing, setChanging] = useState(false);
  // A fresh object per step, so each runs the focus effect once.
  const [focusAfter, setFocusAfter] = useState<{ readonly to: 'code' | 'lost' } | null>(null);
  const formId = useId();
  const addressInput = useRef<HTMLInputElement | null>(null);
  const codeInput = useRef<HTMLInputElement | null>(null);
  const addressForm = useRef<HTMLFormElement | null>(null);
  const changeButton = useRef<HTMLButtonElement | null>(null);

  // After any answer, focus never drops to the page: a code just sent takes
  // it to the code field; if the answer took the pressed control away (or a
  // click left none, as Safari's does), to the code field, the address field
  // or "Change address", the first drawn -- never to On.
  useEffect(() => {
    if (!focusAfter) return;
    const active = document.activeElement;
    const lost = !active || active === document.body;
    if (focusAfter.to === 'code' && (lost || addressForm.current?.contains(active))) codeInput.current?.focus();
    else if (lost) (codeInput.current ?? addressInput.current ?? changeButton.current)?.focus();
  }, [focusAfter]);

  const sendCode = async () => {
    const landed = await onSendCode(address);
    if (landed) setCode(''); // the old code is void once a new one is sent
    setFocusAfter({ to: landed ? 'code' : 'lost' });
  };
  const confirm = async () => {
    if (await onConfirm(code)) {
      setAddress('');
      setCode('');
      setChanging(false);
    }
    setFocusAfter({ to: 'lost' });
  };
  // A real form, so Enter sends; noValidate, so the server judges the address.
  const submit = (step: () => Promise<void>) => (event: React.FormEvent) => {
    event.preventDefault();
    if (!unavailable) void step();
  };

  const showForm = !state.confirmed || state.codePending || changing;
  return (
    <div className="space-y-[var(--s4)]" role="group" aria-label="Alert address" aria-busy={saving}>
      {state.confirmed && !state.codePending && (
        <button
          ref={changeButton}
          type="button"
          className="btn btn--ghost"
          aria-expanded={changing}
          aria-controls={formId}
          aria-disabled={unavailable}
          onClick={() => { if (!unavailable) setChanging(!changing); }}
        >
          Change address
        </button>
      )}
      <div id={formId} className="space-y-[var(--s4)]">
        {showForm && (
          <>
            <p className={helpClass}>
              The app emails a six-digit code to the address you type. The address is used only
              after you enter that code here.
              {state.confirmed && ' Until then, the address you confirmed before stays in use.'}
            </p>
            <form ref={addressForm} className="flex flex-wrap items-end gap-[var(--s3)]" noValidate onSubmit={submit(sendCode)}>
              <label className="field">
                <span className="t-label">Email address for alerts</span>
                <input
                  ref={addressInput}
                  className="input input--kiosk"
                  type="email"
                  autoComplete="email"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                />
              </label>
              <button
                type="submit"
                className={state.codePending ? 'btn btn--ghost' : 'btn'}
                aria-disabled={unavailable}
              >
                {state.codePending ? 'Send a new code' : 'Send code'}
              </button>
            </form>
            {state.codePending && (
              <form className="flex flex-wrap items-end gap-[var(--s3)]" noValidate onSubmit={submit(confirm)}>
                <label className="field">
                  <span className="t-label">Six-digit code from the email</span>
                  <input
                    ref={codeInput}
                    className="input input--kiosk"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                  />
                </label>
                <button type="submit" className="btn" aria-disabled={unavailable}>Confirm</button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}
