'use client';

/**
 * THE GYM'S SOUND, WIRED IN.
 *
 * design-system/ppbf-sound.js has been a complete Web Audio engine — bell,
 * stamp, latch, accept, refuse, all synthesized from oscillators, zero assets —
 * with no caller anywhere in the app. This is the seam between it and React.
 *
 * IT ENFORCES THE ENGINE'S FIVE RULES RATHER THAN RESTATING THEM:
 *
 * 1. OFF BY DEFAULT. Nothing here constructs an AudioContext until somebody
 *    clicks the toggle. A first-time visitor makes no noise and is asked
 *    nothing.
 * 2. NEVER THE ONLY CHANNEL. Enforced at the call sites, not here — every
 *    play() in this app sits beside a visible change that already carries the
 *    whole message. play() returning false is therefore never a loss of
 *    information, which is why it is safe to call unconditionally.
 * 3. STATE CHANGES ONLY. This hook arms audio on the first gesture but never
 *    SOUNDS on one: arming is silent. Nothing here is bound to hover or focus.
 * 4. THE FLOOR IS LOUD. The preference is per-browser, so a floor kiosk simply
 *    never has it turned on, and the visual channel carries the whole message
 *    there as it always did.
 * 5. ONE AT A TIME. The engine drops an overlapping call itself.
 *
 * ONE ENGINE, NOT ONE PER COMPONENT. Three components ask for sound (the
 * toggle, the training card, the athlete workspace). Three AudioContexts would
 * be three hardware audio graphs for one tablet speaker, and browsers cap how
 * many a page may open. The engine, the preference and the live state are
 * module state, published through useSyncExternalStore — the same pattern
 * roleSession.ts already uses for the other piece of cross-component browser
 * state in this app.
 *
 * IT NEVER THROWS. A blocked AudioContext, a locked-down kiosk webview, a
 * browser with no Web Audio at all: every one of those degrades to silence and
 * an honest label. None of them is an error worth showing a child mid-session.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';

/* A side-effect import, exactly as ppbf-sound.js documents at its line 45. The
   file is a classic script that defines one global, deliberately — browsers
   block `import` over file:// and every preview in that folder opens by
   double-clicking it off disk. Loading it declares a class and assigns it; it
   touches no window, no document and no AudioContext, so it is inert in the
   server render pass too. */
import '@/../../design-system/ppbf-sound.js';

/** The five voices the design system synthesizes. */
export type GymVoice = 'bell' | 'stamp' | 'latch' | 'accept' | 'refuse';

/** The engine's surface, as this app uses it. */
interface SoundEngine {
  readonly enabled: boolean;
  readonly running: boolean;
  enable(): Promise<boolean>;
  setEnabled(on: boolean): Promise<boolean>;
  play(name: GymVoice): boolean;
}

declare global {
  interface Window {
    PPBFSound?: new (options?: { volume?: number }) => SoundEngine;
  }
}

/**
 * Four states, because "the listener asked for sound" and "sound works" are
 * different facts and a control that conflates them lies.
 *
 *   off          nobody asked. The default, and the only state a first visit has.
 *   arming       asked for, on a page that has not been touched yet. No browser
 *                will start audio outside a user gesture, so this is the honest
 *                state after a reload — not "on".
 *   on           audio is live. play() will actually make a sound.
 *   unavailable  asked for, and this browser refused. Says so instead of
 *                showing an "on" switch that does nothing.
 */
export type GymSoundStatus = 'off' | 'arming' | 'on' | 'unavailable';

export interface GymSoundSnapshot {
  /** What the listener asked for. Persisted across visits. */
  readonly enabled: boolean;
  /** Whether audio is live right now. Never persisted — it cannot be. */
  readonly ready: boolean;
  readonly status: GymSoundStatus;
}

const OFF: GymSoundSnapshot = { enabled: false, ready: false, status: 'off' };

/* The engine's own key (ppbf-sound.js, STORAGE_KEY). Read here so the first
   paint can label the control without constructing anything, and written here
   only for "off" — the engine writes "on" itself, and only on success. */
const PREFERENCE_KEY = 'ppbf.sound.enabled';

let engine: SoundEngine | null = null;
let snapshot: GymSoundSnapshot = OFF;
let hydrated = false;
let armInFlight: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

function publish(next: GymSoundSnapshot): void {
  snapshot = next;
  for (const listener of [...listeners]) {
    listener();
  }
}

function readPreference(): boolean {
  try {
    return globalThis.localStorage?.getItem(PREFERENCE_KEY) === '1';
  } catch {
    // Blocked in private mode and in some embedded webviews. A sound
    // preference is never worth breaking a page over.
    return false;
  }
}

function forgetPreference(): void {
  try {
    globalThis.localStorage?.setItem(PREFERENCE_KEY, '0');
  } catch {
    /* same */
  }
}

/** The one engine. Constructed lazily, and never before it is wanted. */
function getEngine(): SoundEngine | null {
  if (engine) {
    return engine;
  }
  try {
    const Ctor = typeof window === 'undefined' ? undefined : window.PPBFSound;
    engine = Ctor ? new Ctor() : null;
  } catch {
    engine = null;
  }
  return engine;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): GymSoundSnapshot {
  if (!hydrated) {
    hydrated = true;
    if (readPreference()) {
      // Opted in on an earlier visit. Audio is NOT live yet: the stored
      // preference is consent, not a gesture, and only a gesture starts a
      // browser's audio.
      snapshot = { enabled: true, ready: false, status: 'arming' };
    }
  }
  return snapshot;
}

/** The server has no preference and no audio. Both are browser facts. */
function getServerSnapshot(): GymSoundSnapshot {
  return OFF;
}

/**
 * Bring the audio context up. MUST run inside a user gesture — every browser
 * requires one, and the engine's enable() says so in its own doc comment.
 *
 * De-duplicated: several components hold this hook and each arms on the first
 * gesture, which without the guard would be four enable() calls racing for one
 * context.
 */
function arm(): Promise<boolean> {
  if (snapshot.ready) {
    return Promise.resolve(true);
  }
  if (armInFlight) {
    return armInFlight;
  }

  const attempt = (async () => {
    const snd = getEngine();
    let live = false;
    if (snd) {
      try {
        live = await snd.enable();
      } catch {
        live = false;
      }
    }
    if (!snapshot.enabled) {
      // Switched off while this was starting up. The listener's last word
      // wins: do not publish over their "off", and mute what just came up.
      if (live) {
        try {
          await snd?.setEnabled(false);
        } catch {
          /* best effort */
        }
      }
      return false;
    }

    publish(live
      ? { enabled: true, ready: true, status: 'on' }
      : { enabled: true, ready: false, status: 'unavailable' });
    return live;
  })();

  armInFlight = attempt;
  void attempt.then(
    () => { armInFlight = null; },
    () => { armInFlight = null; },
  );
  return attempt;
}

/**
 * Turn sound on or off. MUST be called from inside a click/keydown handler
 * when turning it ON, for the same reason arm() must.
 */
export async function setGymSoundEnabled(on: boolean): Promise<boolean> {
  if (!on) {
    publish(OFF);
    // Written directly as well as through the engine: the engine may never
    // have been constructed on this visit, and a preference left saying "on"
    // after somebody switched it off is the one storage failure that matters.
    forgetPreference();
    try {
      await engine?.setEnabled(false);
    } catch {
      /* muting is best-effort; the preference above is the durable part */
    }
    return false;
  }

  publish({ enabled: true, ready: false, status: 'arming' });
  return arm();
}

/**
 * Fire a voice. Safe to call unconditionally and from anywhere: silent and
 * false when sound is off, unsupported, or still busy with another voice.
 */
export function playGymSound(name: GymVoice): boolean {
  try {
    return engine?.play(name) ?? false;
  } catch {
    return false;
  }
}

/** Test seam. Nothing in the app calls this. */
export function resetGymSoundForTests(): void {
  engine = null;
  snapshot = OFF;
  hydrated = false;
  armInFlight = null;
  listeners.clear();
}

export interface GymSound {
  /** What the listener asked for. */
  readonly enabled: boolean;
  /** Whether a play() call would actually be audible. */
  readonly ready: boolean;
  readonly status: GymSoundStatus;
  /** Safe to call unconditionally. Returns whether a sound was started. */
  play: (name: GymVoice) => boolean;
  /** Call from inside a click/keydown handler — browsers require the gesture. */
  setEnabled: (on: boolean) => Promise<boolean>;
}

export default function useGymSound(): GymSound {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  /* Somebody who opted in on an earlier visit still needs a gesture before a
     browser will start audio. So the first interaction anywhere on the page
     arms the context — and plays nothing. That is not a violation of rule 3:
     rule 3 forbids SOUNDING on hover, focus and keystrokes, and this makes no
     sound at all. Without it the milestone bell could never ring, because the
     ceremony fires after an async re-read of the ledger, long outside the task
     that the athlete's click started. */
  const shouldArm = state.enabled && !state.ready && state.status !== 'unavailable';
  useEffect(() => {
    if (!shouldArm || typeof window === 'undefined') {
      return;
    }

    let cancelled = false;
    const onGesture = () => {
      if (!cancelled) {
        void arm();
      }
    };
    const options = { once: true, capture: true, passive: true } as const;
    window.addEventListener('pointerdown', onGesture, options);
    window.addEventListener('keydown', onGesture, options);

    return () => {
      cancelled = true;
      window.removeEventListener('pointerdown', onGesture, options);
      window.removeEventListener('keydown', onGesture, options);
    };
  }, [shouldArm]);

  const play = useCallback((name: GymVoice) => playGymSound(name), []);
  const setEnabled = useCallback((on: boolean) => setGymSoundEnabled(on), []);

  return {
    enabled: state.enabled,
    ready: state.ready,
    status: state.status,
    play,
    setEnabled,
  };
}
