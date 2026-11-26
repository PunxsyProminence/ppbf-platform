import React, { useEffect, useRef, useState } from 'react';

/**
 * AN ADULT ATHLETE'S ALERT ADDRESS on /profile (lane W4-1, EM-2b-3), drawn
 * inside EmailAlertSwitch, which sends the requests and handles every answer.
 * OW27-38 B: the athlete types an address, and it is used only after they
 * enter the code the app emails to it.
 *
 * GO condition 3, no control that does nothing: the code field shows only
 * while GET says a code can still be entered (code_pending), and On waits for
 * a confirmed address (EmailAlertSwitch). Default 9: the server never returns
 * an address, so nothing here shows one back; the address field holds only
 * what the athlete types, and is emptied once an address is confirmed.
 * Default 5: while a new address waits for its code, the confirmed one stays
 * in use.
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
  /** Each resolves true only when the server answered with the new state. */
  readonly onSendCode: (address: string) => Promise<boolean>;
  readonly onConfirm: (code: string) => Promise<boolean>;
}

export default function EmailAlertAddress({
  state, saving, unavailable, helpClass, onSendCode, onConfirm,
}: EmailAlertAddressProps) {
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [changing, setChanging] = useState(false);
  const changeButton = useRef<HTMLButtonElement | null>(null);
  const focusChange = useRef(false);

  // A confirm takes away the button that was pressed: focus goes to "Change
  // address" once it is drawn, never to On (confirming never switches on).
  useEffect(() => {
    if (focusChange.current && changeButton.current) {
      focusChange.current = false;
      changeButton.current.focus();
    }
  });

  const sendCode = async () => {
    // The old code is void once a new one is sent.
    if (await onSendCode(address)) setCode('');
  };
  const confirm = async () => {
    if (!(await onConfirm(code))) return;
    setAddress('');
    setCode('');
    setChanging(false);
    focusChange.current = true;
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
          aria-disabled={unavailable}
          onClick={() => { if (!unavailable) setChanging(!changing); }}
        >
          Change address
        </button>
      )}
      {showForm && (
        <>
          <p className={helpClass}>
            The app emails a six-digit code to the address you type. The address is used only
            after you enter that code here.
            {state.confirmed && ' Until then, the address you confirmed before stays in use.'}
          </p>
          {state.codePending && (
            <div className="flex flex-wrap items-end gap-[var(--s3)]">
              <label className="field">
                <span className="t-label">Six-digit code from the email</span>
                <input
                  className="input input--kiosk"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="btn"
                aria-disabled={unavailable}
                onClick={() => { if (!unavailable) void confirm(); }}
              >
                Confirm
              </button>
            </div>
          )}
          <div className="flex flex-wrap items-end gap-[var(--s3)]">
            <label className="field">
              <span className="t-label">Email address for alerts</span>
              <input
                className="input input--kiosk"
                type="email"
                autoComplete="email"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
              />
            </label>
            <button
              type="button"
              className={state.codePending ? 'btn btn--ghost' : 'btn'}
              aria-disabled={unavailable}
              onClick={() => { if (!unavailable) void sendCode(); }}
            >
              {state.codePending ? 'Send a new code' : 'Send code'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
