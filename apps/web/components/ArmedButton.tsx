'use client';

import { useEffect, useState, type ReactNode } from 'react';

/**
 * THE ARMED SECOND PRESS (UXB-L1; audit UXB-01, UXB-03, UXB-14).
 *
 * The first press arms the button and its words change to say what the next
 * press does ("Press again: lift Ada's hold"); the second press does it. This
 * is the confirm of the action itself, the pattern Cancel Class already used
 * (app/schedule/page.tsx), not a warning or a gate (OD-2026-10-10-007).
 *
 * Three things the hand-written copies did not do:
 *   - A second press inside ARM_SETTLE_MS of arming is ignored. A fast double
 *     tap is the failure this exists for (UXB-01: Open, then Acknowledge drawn
 *     under the same finger), and it must only arm.
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
  // Disarmed in the same render that changes what it would act on.
  if (armedAt && (armedAt.key !== armKey || busy || disabled)) setArmedAt(null);
  const armed = armedAt !== null && armedAt.key === armKey && !busy && !disabled;

  useEffect(() => {
    if (!armedAt) return undefined;
    const timer = setTimeout(() => setArmedAt(null), ARM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [armedAt]);

  return (
    <button
      type="button"
      className={className}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      data-armed={armed ? 'true' : undefined}
      onBlur={() => setArmedAt(null)}
      onClick={() => {
        if (busy || disabled) return;
        if (!armed || !armedAt) {
          setArmedAt({ key: armKey, at: Date.now() });
          return;
        }
        if (Date.now() - armedAt.at < ARM_SETTLE_MS) return;
        setArmedAt(null);
        onConfirm();
      }}
    >
      {busy ? (busyLabel ?? children) : armed ? armedLabel : children}
    </button>
  );
}
