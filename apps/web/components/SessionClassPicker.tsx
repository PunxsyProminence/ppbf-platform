'use client';

import { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { formatGymTimeOfDay } from '@/src/lib/gymTime';
import { type ClassChoice, type TieableClassView, defaultClassChoice, instantMs } from '@/src/shared/sessionClassChoice';

// Which class a session is for (D4, OD-2026-10-21-002): today's classes the coach may tie, plus
// "No class (open gym)". Until the coach picks, it shows the default (the one class under way, or
// no class when there is none today; otherwise nothing, and the coach must pick:
// sessionClassChoice.ts), worked out again every 30 seconds so a page left open does not keep a
// class that has ended. A class another live session already runs is shown but cannot be picked.
// Wording PROPOSED.

export function classTimes(item: Pick<TieableClassView, 'start_at' | 'end_at'>): string {
  const start = formatGymTimeOfDay(new Date(instantMs(item.start_at)));
  const end = formatGymTimeOfDay(new Date(instantMs(item.end_at)));
  return start && end ? `${start}-${end}` : '';
}

/** Today's classes the caller may tie. Gives up after 8 seconds, so a start is never held by a slow read. */
export async function fetchTieableClasses(): Promise<TieableClassView[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${apiBase()}/api/pilot/session-scripts/runs?classes=today`, {
      credentials: 'include',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('classes');
    return ((await response.json()) as { classes?: TieableClassView[] }).classes ?? [];
  } finally {
    clearTimeout(timer);
  }
}

/** What the picker knows when it reports a choice: whether the coach picked it, and the list it came from. */
export interface ClassChoiceInfo {
  readonly picked: boolean;
  readonly classes: readonly TieableClassView[];
}

export default function SessionClassPicker({
  value,
  onChange,
  name = 'session-class',
  mode = 'start',
}: {
  readonly value: ClassChoice;
  readonly onChange: (choice: ClassChoice, info: ClassChoiceInfo) => void;
  readonly name?: string;
  /** 'start': a session about to start; 'tie': a live session being tied. Only the wording differs. */
  readonly mode?: 'start' | 'tie';
}) {
  const [classes, setClasses] = useState<TieableClassView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      const list = await fetchTieableClasses().catch(() => null);
      if (!live) return;
      // Nothing to tie to that can be shown: open gym, and the screen says so.
      setFailed(list === null);
      setClasses(list ?? []);
      onChange(list ? defaultClassChoice(list, Date.now()) : null, { picked: false, classes: list ?? [] });
    })();
    return () => {
      live = false;
    };
    // Read once per mount; the parent's handler is not a reason to read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Until the coach picks, the default follows the clock.
  useEffect(() => {
    if (picked || !classes) return undefined;
    const timer = setInterval(() => onChange(defaultClassChoice(classes, Date.now()), { picked: false, classes }), 30_000);
    return () => clearInterval(timer);
  }, [picked, classes, onChange]);

  if (classes === null) return <p className="t-body text-[color:var(--bone-300)]">Loading today&apos;s classes...</p>;

  const pick = (choice: ClassChoice) => {
    setPicked(true);
    onChange(choice, { picked: true, classes });
  };

  return (
    <fieldset className="space-y-[var(--s2)]">
      <legend className="t-label">{mode === 'tie' ? 'Which class is this session running?' : 'Which class is this session for?'}</legend>
      {failed && (
        <p role="status" className="t-body text-[color:var(--bone-300)]">
          {mode === 'tie'
            ? "Today's classes could not be loaded. Try again in a moment."
            : "Today's classes could not be loaded, so this session starts without a class."}
        </p>
      )}
      {!failed && classes.length === 0 && (
        <p className="t-body text-[color:var(--bone-300)]">You have no class on the schedule today.</p>
      )}
      {classes.map((item) => (
        <label key={item.class_id} className="flex min-h-[var(--tap)] items-center gap-[var(--s2)]">
          <input
            type="radio"
            name={name}
            checked={value === item.class_id}
            disabled={item.held_by_other_session}
            onChange={() => pick(item.class_id)}
          />
          <span className="t-body">
            {item.title}
            {classTimes(item) ? `, ${classTimes(item)}` : ''}
            {item.held_by_other_session ? ' (another live session is running it)' : ''}
          </span>
        </label>
      ))}
      {mode === 'start' && (
        <label className="flex min-h-[var(--tap)] items-center gap-[var(--s2)]">
          <input type="radio" name={name} checked={value === null} onChange={() => pick(null)} />
          <span className="t-body">No class (open gym)</span>
        </label>
      )}
      {mode === 'start' && value === undefined && (
        <p className="t-body text-[color:var(--brass-300)]">Choose the class, or No class, to start.</p>
      )}
    </fieldset>
  );
}
