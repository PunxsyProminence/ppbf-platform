'use client';

import { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { formatGymTimeOfDay } from '@/src/lib/gymTime';
import { type ClassChoice, type TieableClassView, defaultClassChoice, instantMs } from '@/src/shared/sessionClassChoice';

// Which class a session is for (D4, OD-2026-10-21-002): today's classes the coach may tie, plus
// "No class (open gym)". It opens on the one class under way, or on no class when there is none
// today, and otherwise leaves the choice to the coach (sessionClassChoice.ts). A class another live
// session already runs is shown but cannot be picked. Wording PROPOSED.

export function classTimes(item: Pick<TieableClassView, 'start_at' | 'end_at'>): string {
  const start = formatGymTimeOfDay(new Date(instantMs(item.start_at)));
  const end = formatGymTimeOfDay(new Date(instantMs(item.end_at)));
  return start && end ? `${start}-${end}` : '';
}

export async function fetchTieableClasses(): Promise<TieableClassView[]> {
  const response = await fetch(`${apiBase()}/api/pilot/session-scripts/runs?classes=today`, { credentials: 'include' });
  if (!response.ok) throw new Error('classes');
  return ((await response.json()) as { classes?: TieableClassView[] }).classes ?? [];
}

export default function SessionClassPicker({
  value,
  onChange,
  name = 'session-class',
}: {
  readonly value: ClassChoice;
  readonly onChange: (choice: ClassChoice) => void;
  readonly name?: string;
}) {
  const [classes, setClasses] = useState<TieableClassView[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const list = await fetchTieableClasses();
        if (!live) return;
        setClasses(list);
        onChange(defaultClassChoice(list, Date.now()));
      } catch {
        if (!live) return;
        // Nothing to tie to that can be shown: a session starts as open gym, and says so.
        setFailed(true);
        setClasses([]);
        onChange(null);
      }
    })();
    return () => {
      live = false;
    };
    // Read once per mount; the parent's handler is not a reason to read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (classes === null) return <p className="t-body text-[color:var(--bone-300)]">Loading today&apos;s classes...</p>;

  return (
    <fieldset className="space-y-[var(--s2)]">
      <legend className="t-label">Which class is this session for?</legend>
      {failed && (
        <p role="status" className="t-body text-[color:var(--bone-300)]">
          Today&apos;s classes could not be loaded, so this session starts without a class.
        </p>
      )}
      {classes.map((item) => (
        <label key={item.class_id} className="flex min-h-[var(--tap)] items-center gap-[var(--s2)]">
          <input
            type="radio"
            name={name}
            checked={value === item.class_id}
            disabled={item.held_by_other_session}
            onChange={() => onChange(item.class_id)}
          />
          <span className="t-body">
            {item.title}
            {classTimes(item) ? `, ${classTimes(item)}` : ''}
            {item.held_by_other_session ? ' (another live session is running it)' : ''}
          </span>
        </label>
      ))}
      <label className="flex min-h-[var(--tap)] items-center gap-[var(--s2)]">
        <input type="radio" name={name} checked={value === null} onChange={() => onChange(null)} />
        <span className="t-body">No class (open gym)</span>
      </label>
      {value === undefined && (
        <p className="t-body text-[color:var(--brass-300)]">Choose the class, or No class, to start.</p>
      )}
    </fieldset>
  );
}
