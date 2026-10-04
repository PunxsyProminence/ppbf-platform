'use client';

import { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { formatGymDateNumeric } from '@/src/lib/gymTime';

/**
 * The athlete's injury record, read-only, for the athlete (no athleteId: the
 * route uses the signed-in athlete) and for a linked guardian (athleteId of
 * the child). Owner decision 2026-10-04. It shows only what
 * /api/pilot/athlete/injuries sends -- no staff note ever reaches this
 * audience -- and a failed read says so instead of reading as "no injuries".
 */

interface FamilyInjury {
  injury_id: string;
  injury_date: string;
  body_area: string;
  injury_type: string;
  context: string;
  reported_by: string;
  expected_return_date: string | null;
  returned_on: string | null;
}

const TYPES: Record<string, string> = {
  sprain_strain: 'Sprain / strain', cut: 'Cut', fracture: 'Fracture', head_injury: 'Head injury', other: 'Other',
};
const REPORTED_BY: Record<string, string> = {
  athlete: 'Reported by the athlete', parent_guardian: 'Reported by a parent or guardian',
  coach_observed: 'Seen by a coach', clinician: 'Stated by a clinician',
};

function words(value: string): string {
  const text = value.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function day(value: string): string {
  return formatGymDateNumeric(`${value.slice(0, 10)}T12:00:00Z`) ?? value;
}

export default function MyInjuries({ athleteId }: { readonly athleteId?: string }) {
  const [injuries, setInjuries] = useState<FamilyInjury[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // Each mount reads one athlete; a parent page mounts one per child.
    let live = true;
    const query = athleteId ? `?athlete_id=${encodeURIComponent(athleteId)}` : '';
    void (async () => {
      try {
        const res = await fetch(`${apiBase()}/api/pilot/athlete/injuries${query}`, { credentials: 'include' });
        const payload = res.ok ? ((await res.json()) as { injuries?: unknown } | null) : null;
        if (!payload || !Array.isArray(payload.injuries)) throw new Error('unreadable');
        if (live) setInjuries(payload.injuries as FamilyInjury[]);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [athleteId]);

  return (
    <section aria-label="Injury record" className="mt-[var(--s4)]">
      <p className="t-label">Injury record</p>
      {failed ? (
        <p className="t-body mt-[var(--s2)]">The injury record could not be read right now. Ask your coach.</p>
      ) : injuries === null ? (
        <p className="working mt-[var(--s2)]">Loading...</p>
      ) : injuries.length === 0 ? (
        <p className="t-body mt-[var(--s2)] text-[color:var(--bone-400)]">No injuries on record.</p>
      ) : (
        <ul className="mt-[var(--s2)] flex flex-col gap-[var(--s2)]">
          {injuries.map((i) => (
            <li key={i.injury_id} className="text-[length:var(--t-sm)]">
              <p>
                {day(i.injury_date)} · {words(i.body_area)} · {TYPES[i.injury_type] ?? words(i.injury_type)} ·{' '}
                {i.context === 'competition' ? 'Competition' : 'Training'}
              </p>
              <p className="text-[color:var(--bone-400)]">
                {REPORTED_BY[i.reported_by] ?? words(i.reported_by)}
                {i.returned_on
                  ? ` · Back ${day(i.returned_on)}`
                  : i.expected_return_date
                    ? ` · Expected back ${day(i.expected_return_date)}`
                    : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
