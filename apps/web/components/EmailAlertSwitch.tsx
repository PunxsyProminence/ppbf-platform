'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiBase } from '@/lib/apiBase';

/**
 * EMAIL ALERTS: each person's own switch on /profile (lane W4-1, EM-2).
 * OD-2026-11-19-019: an opt-in email that says only "open the app"; OW27-10 A:
 * one switch on each person's own settings page.
 *
 * WHO SEES IT. Only someone GET /api/pilot/email-alerts/me offers a switch to
 * (`offered: true`), and of those only staff and parents. An athlete 18 or over
 * is offered one by the route, but their switch arrives with the address and
 * code it needs in EM-2b, so it is not shown here (GO on #2159, condition 3: no
 * control that does nothing). Anyone else -- an athlete under 18, a 'staff' or
 * 'volunteer' login (403), a first read that fails -- gets nothing at all on
 * this page: no panel, no message, no warning (L1 rule).
 *
 * After a save: a refusal (403), or an answer that says no switch is offered,
 * takes the panel away at once, whoever is signed in by then, with nothing said
 * (a minor in a stale tab sees nothing new). A signed-out save (401), or a
 * signed-out read after a failed save, says so, and the choices then send
 * nothing until the page is reloaded. Any other failure -- a dropped
 * connection, a server error, a 409, or a success whose answer cannot be read
 * (a lost body, a captive portal's page) -- reads the setting again and shows
 * that: no error if the change did land, "not saved" only if it did not. An
 * unknown setting never looks like off: after a save and a read that both
 * failed, neither choice is pressed and the panel says so.
 *
 * The route is self-scoped: nothing here names an account, and the PUT body is
 * exactly { switched_on }.
 */

type UserType = 'staff' | 'parent' | 'adult_athlete';

interface ShownSwitch {
  readonly userType: UserType;
  /** null: not known (a save and the read after it both failed). */
  readonly switchedOn: boolean | null;
}

type Read = ShownSwitch | 'hidden' | 'signed_out' | 'failed';

/** Shown here; adult_athlete waits for EM-2b. */
const SHOWN_TO: readonly UserType[] = ['staff', 'parent'];

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
  const body = payload as { ok?: unknown; offered?: unknown; user_type?: unknown; switched_on?: unknown };
  if (body.ok !== true || body.offered !== true || typeof body.switched_on !== 'boolean') return 'hidden';
  const userType = SHOWN_TO.find((shown) => shown === body.user_type);
  return userType ? { userType, switchedOn: body.switched_on } : 'hidden';
}

const SIGNED_OUT = 'You are signed out. Sign in again to see or change this.';

async function readSwitch(): Promise<Read> {
  try {
    const response = await fetch(`${apiBase()}/api/pilot/email-alerts/me`, { credentials: 'include' });
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);

  useEffect(() => {
    void readSwitch().then((read) => {
      if (read !== 'hidden' && read !== 'signed_out' && read !== 'failed') setCurrent(read);
    });
  }, []);

  const save = useCallback(async (userType: UserType, switchedOn: boolean) => {
    setSaving(true);
    setError(null);
    let status: number | null = null;
    let saved: ShownSwitch | 'hidden' | null = null;
    try {
      const response = await fetch(`${apiBase()}/api/pilot/email-alerts/me`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ switched_on: switchedOn }),
      });
      status = response.status;
      // A success whose answer cannot be read is not known to be saved: it is
      // read again below, never taken as "not offered".
      const body: unknown = response.ok ? await response.json().catch(() => undefined) : undefined;
      if (body !== undefined) saved = fromPayload(body);
    } catch {
      saved = null;
    }
    if (saved && saved !== 'hidden') {
      setCurrent(saved);
    } else if (saved === 'hidden' || status === 403) {
      // Refused, or answered as not offered: no switch for whoever is signed
      // in now, so the panel goes, and nothing more is said (L1 rule).
      setCurrent(null);
    } else if (status === 401) {
      // Nothing was saved, and with no session the setting cannot be read.
      setCurrent({ userType, switchedOn: null });
      setError(SIGNED_OUT);
      setSignedOut(true);
    } else {
      // Not known to be saved: show what the server holds now, not what was
      // asked for, and say "not saved" only if it really was not.
      const read = await readSwitch();
      if (read === 'hidden') {
        setCurrent(null);
      } else if (read === 'signed_out') {
        setCurrent({ userType, switchedOn: null });
        setError(SIGNED_OUT);
        setSignedOut(true);
      } else if (read === 'failed') {
        setCurrent({ userType, switchedOn: null });
        setError('That change may not have been saved, and your setting could not be read. Try again.');
      } else {
        setCurrent(read);
        if (read.switchedOn !== switchedOn) setError('That change was not saved.');
      }
    }
    setSaving(false);
  }, []);

  if (!current) return null;

  // The state in words, saving or not, so the pressed colour is never the
  // only thing that says which choice is in force.
  const inForce = current.switchedOn === null
    ? 'Your setting could not be read.'
    : current.switchedOn ? 'Email alerts are on.' : 'Email alerts are off.';
  const status = saving ? `Saving… ${inForce}` : inForce;

  return (
    <section className={styles.panel} aria-labelledby="email-alerts-heading">
      <h2 id="email-alerts-heading" className={styles.heading}>Email alerts</h2>
      <p className={styles.help}>
        Off unless you turn it on. When it is on, an email can go to the address you sign in with
        when certain new things arrive for you in the app. It says only &ldquo;open the
        app&rdquo;, with the gym&rsquo;s name. It never says what happened or who it is about.
      </p>
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
              if (!saving && !signedOut && current.switchedOn !== on) void save(current.userType, on);
            }}
          >
            {on ? 'On' : 'Off'}
          </button>
        ))}
      </div>
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
