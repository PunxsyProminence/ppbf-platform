'use client';

import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { apiBase } from '@/lib/apiBase';
import { isGymTabletMarked, subscribeGymTabletMark } from '@/src/lib/gymTabletMark';
import type { EmailAlertSwitchStyles } from './EmailAlertSwitch';

/**
 * WEB PUSH: "Pop-ups on this device", on /profile (lane W5-WP, WP-3; plan,
 * answers and GO on #2228). Turning it on with a tap on a device is its own
 * opt-in; the email switch does not gate it (QA A). It stays on until it is
 * turned off on that device, the device is marked as a gym tablet, or the
 * person can no longer get alerts (QB A): signing out does not end it.
 *
 * WHO SEES IT. Only someone GET /api/pilot/push/subscription offers push to
 * (`offered: true`: the people the email switch is offered to, once the push
 * keys are set). Anyone else, or a first read that fails, gets nothing at all
 * here, as with the email switch (L1 rule).
 *
 * NO CONTROL THAT DOES NOTHING (QE A). Instead of On and Off, one plain line:
 *   - on a device marked as a gym tablet (OW27-17 B); push is also turned off
 *     in this browser then, in case it was on before the mark;
 *   - in an app window opened from the Home Screen (QJ A, 7210820802): there
 *     the gym-tablet mark may not be readable, so push is not offered at all
 *     (fail closed) until App Overwatch's G3 check on a gym iPad passes;
 *   - in a browser with no service worker or push support;
 *   - when this browser's settings block pop-ups for the app.
 *
 * ON: the tap asks the browser's permission, registers /sw.js (push only, no
 * cache), subscribes with the server's public key, and saves { endpoint, keys }.
 * OFF: removes this browser's row and unsubscribes the browser. An opt-out
 * does not wait on the server: the browser stops taking pushes either way, and
 * a row the server still holds is deleted as gone on its next send
 * (pushAlertSender.ts).
 *
 * WHAT IT SHOWS is read, never assumed: after every press it asks the server
 * whether this browser is on for the person signed in, and says "not saved"
 * only if the aim was not met. A browser on for someone else here shows Off
 * for this person; nothing is saved without their tap.
 */

const ROUTE = '/api/pilot/push/subscription';
const WORKER = '/sw.js';

/** QJ A: false until App Overwatch's G3 iPad check passes and a change records that it did. */
const OFFERED_IN_APP_WINDOW = false;

export const PUSH_LINES = {
  gymTablet: 'Pop-ups are off on gym tablets.',
  appWindow: "Pop-ups can't be turned on in the Home Screen app yet.",
  unsupported:
    "This browser can't show pop-ups from the app. On an iPhone or iPad, add the app to the Home Screen and open it from there.",
  blocked: "Pop-ups are blocked for this app in this browser's settings.",
} as const;

const SIGNED_OUT = 'You are signed out. Sign in again to see or change this.';

type Answer = { readonly status: number; readonly body: Record<string, unknown> | null };

async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', body?: object): Promise<Answer> {
  try {
    const response = await fetch(`${apiBase()}${ROUTE}`, {
      method,
      credentials: 'include',
      cache: 'no-store',
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const answer: unknown = await response.json().catch(() => null);
    const ok = response.ok && answer !== null && typeof answer === 'object' && (answer as { ok?: unknown }).ok === true;
    return { status: response.status, body: ok ? (answer as Record<string, unknown>) : null };
  } catch {
    return { status: 0, body: null };
  }
}

function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** A window opened from the Home Screen, or one this browser cannot place (fail closed). */
function inAppWindow(): boolean {
  try {
    if ((navigator as Navigator & { standalone?: boolean }).standalone === true) return true;
    return !window.matchMedia('(display-mode: browser)').matches;
  } catch {
    return true;
  }
}

function lineFor(marked: boolean): string | null {
  if (marked) return PUSH_LINES.gymTablet;
  if (inAppWindow() && !OFFERED_IN_APP_WINDOW) return PUSH_LINES.appWindow;
  if (!pushSupported()) return PUSH_LINES.unsupported;
  return Notification.permission === 'denied' ? PUSH_LINES.blocked : null;
}

async function browserSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** Whether this browser is on for the caller: true, false, or null (not known); status 401 or 403 too. */
async function readHere(): Promise<{ readonly on: boolean | null; readonly status: number }> {
  try {
    const subscription = await browserSubscription();
    if (!subscription) return { on: false, status: 200 };
    const { status, body } = await call('POST', { endpoint: subscription.endpoint });
    return { on: typeof body?.on === 'boolean' ? body.on : null, status };
  } catch {
    return { on: null, status: 0 };
  }
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
}

function subscribedWith(subscription: PushSubscription, key: Uint8Array): boolean {
  const held = subscription.options.applicationServerKey;
  const bytes = held ? new Uint8Array(held) : new Uint8Array();
  return bytes.length === key.length && bytes.every((byte, index) => byte === key[index]);
}

/** On: permission, worker, subscription, save. The save's status; 0 if it was never sent. */
async function turnOn(publicKey: string): Promise<number> {
  if ((await Notification.requestPermission()) !== 'granted') return 0;
  await navigator.serviceWorker.register(WORKER, { updateViaCache: 'none' });
  const registration = await navigator.serviceWorker.ready;
  const key = keyBytes(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  // Made with another key (the keys were changed): a push to it would be refused.
  if (subscription && !subscribedWith(subscription, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const { endpoint, keys } = subscription.toJSON();
  return (await call('PUT', { endpoint, keys: { p256dh: keys?.p256dh, auth: keys?.auth } })).status;
}

/** Off: this browser's row for the caller, then the browser's subscription. The removal's status. */
async function turnOff(): Promise<number> {
  const subscription = await browserSubscription();
  if (!subscription) return 200;
  const { status } = await call('DELETE', { endpoint: subscription.endpoint });
  await subscription.unsubscribe().catch(() => false);
  return status;
}

/**
 * Turns push off in this browser for everyone: the caller's own row for it,
 * each subscription, and the worker. Called when this device is marked as a
 * gym tablet (OW27-17 B). Never throws; a row of someone else's here is
 * deleted as gone on its next send, since the browser no longer takes it.
 */
export async function turnOffPushInThisBrowser(): Promise<void> {
  try {
    if (!('serviceWorker' in navigator)) return;
    for (const registration of await navigator.serviceWorker.getRegistrations()) {
      const subscription = await registration.pushManager?.getSubscription().catch(() => null);
      if (subscription) {
        await call('DELETE', { endpoint: subscription.endpoint });
        await subscription.unsubscribe().catch(() => false);
      }
      await registration.unregister().catch(() => false);
    }
  } catch {
    // Nothing more this browser lets a page do.
  }
}

export default function PushAlertSwitch({ styles }: { styles: EmailAlertSwitchStyles }) {
  const marked = useSyncExternalStore(subscribeGymTabletMark, isGymTabletMarked, () => false);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  /** undefined: not read yet; null: not known. */
  const [on, setOn] = useState<boolean | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { body } = await call('GET');
      if (cancelled || body?.offered !== true || typeof body.public_key !== 'string') return;
      if (isGymTabletMarked()) void turnOffPushInThisBrowser();
      const here = lineFor(isGymTabletMarked()) ? { on: false, status: 200 } : await readHere();
      if (cancelled || here.status === 403) return;
      setPublicKey(body.public_key);
      setOn(here.on);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const change = useCallback(async (aim: boolean, key: string) => {
    setBusy(true);
    setError(null);
    let status = 0;
    try {
      status = aim ? await turnOn(key) : await turnOff();
    } catch {
      status = 0;
    }
    const here = status === 403 ? { on: null, status } : await readHere();
    if (here.status === 403) {
      // No longer offered: the panel goes, and nothing more is said (L1 rule).
      setPublicKey(null);
    } else if (status === 401 || here.status === 401) {
      setOn(here.on);
      setSignedOut(true);
      setError(SIGNED_OUT);
    } else {
      setOn(here.on);
      if (here.on !== aim) setError(here.on === null ? 'Pop-ups on this device could not be read. Try again.' : 'That change was not saved.');
    }
    setBusy(false);
  }, []);

  if (!publicKey || on === undefined) return null;
  const line = lineFor(marked);
  const inForce = on === null ? 'This setting could not be read.' : on ? 'Pop-ups are on.' : 'Pop-ups are off.';

  return (
    <section className={styles.panel} aria-labelledby="push-alerts-heading">
      <h2 id="push-alerts-heading" className={styles.heading}>Pop-ups on this device</h2>
      {line ? (
        <p className={styles.help}>{line}</p>
      ) : (
        <>
          <p className={styles.help}>A pop-up says only &ldquo;Open the app&rdquo;.</p>
          <div className="flex flex-wrap gap-[var(--s3)]" role="group" aria-label="Pop-ups on this device" aria-busy={busy}>
            {[false, true].map((choice) => (
              <button
                key={choice ? 'on' : 'off'}
                type="button"
                aria-pressed={on === choice}
                // aria-disabled, not disabled, as the email switch: focus stays put.
                aria-disabled={busy || signedOut}
                className={`${styles.choiceBase} ${on === choice ? styles.choiceOn : styles.choiceOff}`}
                onClick={() => {
                  if (!busy && !signedOut && on !== choice) void change(choice, publicKey);
                }}
              >
                {choice ? 'On' : 'Off'}
              </button>
            ))}
          </div>
          <p className={styles.help} aria-live="polite">{busy ? `Saving… ${inForce}` : inForce}</p>
        </>
      )}
      {error && (
        <p role="alert" className="text-[length:var(--t-xs)] text-[color:var(--restricted-ink)]">
          <span aria-hidden="true">▲ </span>
          <span>{error}</span>
        </p>
      )}
    </section>
  );
}
