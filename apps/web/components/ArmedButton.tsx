'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * THE ARMED SECOND PRESS (UXB-L1; audit UXB-01, UXB-03, UXB-14).
 *
 * The first press arms the button and its words change to say what the next
 * press does ("Press again: lift Ada's hold"); the second press does it. This
 * is the confirm of the action itself, the pattern Cancel Class already used
 * (app/schedule/page.tsx), not a warning or a gate (OD-2026-10-10-007).
 *
 * Things the hand-written copies did not do:
 *   - A second press inside ARM_SETTLE_MS of arming is ignored. A fast double
 *     tap is the failure this exists for (UXB-01: Open, then Acknowledge drawn
 *     where Open was), and it must only arm.
 *   - A press inside ARM_SETTLE_MS of the button first appearing is ignored
 *     too, so a tap meant for whatever was there before does not even arm it.
 *   - A held Enter key repeats clicks; a repeat is not a second press.
 *   - It disarms on its own after ARM_TIMEOUT_MS, on blur, and when `armKey`
 *     changes (another athlete, another status picked), so an armed button is
 *     never left one press from doing something the coach no longer means.
 *   - While `busy` it is locked and shows `busyLabel`; it never fires twice.
 *
 * Always type="button": a submit button would let Enter in a field send the
 * form past the second press. The caller runs the write from `onConfirm`.
 */
export const ARM_SETTLE_MS = 500;
export const ARM_TIMEOUT_MS = 8_000;

export default function ArmedButton({
  children,
  armedLabel,
  busyLabel,
  busy = false,
  disabled = false,
  armKey = '',
  onConfirm,
  className = 'btn',
}: Readonly<{
  children: ReactNode;
  armedLabel: ReactNode;
  busyLabel?: ReactNode;
  busy?: boolean;
  disabled?: boolean;
  armKey?: string;
  onConfirm: () => void;
  className?: string;
}>) {
  const [armedAt, setArmedAt] = useState<{ key: string; at: number } | null>(null);
  /* The same, for a press that arrives before the render that shows it. A
     press confirms only when the ref and the rendered state are the same arm:
     the reset during render below clears only the state, and a stale ref must
     never be one press from firing. */
  const armedRef = useRef<{ key: string; at: number } | null>(null);
  const shownAtRef = useRef<number | null>(null);
  useEffect(() => {
    shownAtRef.current = Date.now();
  }, []);
  function disarm() {
    armedRef.current = null;
    setArmedAt(null);
  }
  // Disarmed in the same render that changes what it would act on.
  if (armedAt && (armedAt.key !== armKey || busy || disabled)) {
    setArmedAt(null);
  }
  const armed = armedAt !== null && armedAt.key === armKey && !busy && !disabled;

  useEffect(() => {
    if (!armedAt) return undefined;
    const timer = setTimeout(() => {
      armedRef.current = null;
      setArmedAt(null);
    }, ARM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [armedAt]);

  return (
    <button
      type="button"
      className={className}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      data-armed={armed ? 'true' : undefined}
      onBlur={disarm}
      onKeyDown={(event) => {
        if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
      }}
      onClick={() => {
        if (busy || disabled) return;
        const now = Date.now();
        if (shownAtRef.current === null || now - shownAtRef.current < ARM_SETTLE_MS) return;
        const held = armedRef.current;
        if (!held || held !== armedAt || held.key !== armKey) {
          armedRef.current = { key: armKey, at: now };
          setArmedAt(armedRef.current);
          return;
        }
        if (now - held.at < ARM_SETTLE_MS) return;
        disarm();
        onConfirm();
      }}
    >
      {busy ? (busyLabel ?? children) : armed ? armedLabel : children}
    </button>
  );
}
