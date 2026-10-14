'use client';

import { useEffect, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { formatGymDateTimeShort } from '@/src/lib/gymTime';
import { OBSERVATION_CATEGORIES, type ParentObservationItem } from '@/src/shared/parentObservations';

/**
 * FROM THE FAMILY (F-073; #1542's track).
 *
 * Under "On the family's page" on /coach/decision-loop: what the selected
 * athlete's family recorded at home, newest first -- the category, the 1-10
 * rating when they gave one, their words, and when (gym time). Written by "a
 * guardian": staff are not told which one, as with a guardian's barrier report.
 *
 * Read from GET /api/pilot/coach/family-observations (staff only). A failed
 * read says so; it is never shown as "nothing recorded".
 */
type ReadState =
  | { state: 'loading' }
  | { state: 'failed'; athleteId: string }
  | { state: 'loaded'; athleteId: string; items: ParentObservationItem[] };

export default function FamilyObservations({ athleteId }: Readonly<{ athleteId: string }>) {
  const [read, setRead] = useState<ReadState>({ state: 'loading' });
  // Only the newest read lands: switching athletes while a read is slow must
  // not leave one child's observations under another's name.
  const seq = useRef(0);

  useEffect(() => {
    if (!athleteId) return;
    const mine = ++seq.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRead({ state: 'loading' });
    void (async () => {
      try {
        const response = await fetch(
          `${apiBase()}/api/pilot/coach/family-observations?athlete_id=${encodeURIComponent(athleteId)}`,
          { credentials: 'include' },
        );
        const payload = (await response.json().catch(() => ({}))) as { items?: unknown };
        if (mine !== seq.current) return;
        if (!response.ok || !Array.isArray(payload.items)) {
          setRead({ state: 'failed', athleteId });
          return;
        }
        setRead({ state: 'loaded', athleteId, items: payload.items as ParentObservationItem[] });
      } catch {
        if (mine === seq.current) setRead({ state: 'failed', athleteId });
      }
    })();
  }, [athleteId]);

  if (!athleteId) return null;
  // What is on screen belongs to the athlete selected now, or it reads as loading.
  const shown: ReadState = read.state !== 'loading' && read.athleteId !== athleteId ? { state: 'loading' } : read;

  return (
    <div className="mt-[var(--s4)]">
      <h3 className="t-label">From the family</h3>
      {shown.state === 'loading' ? (
        <p className="t-muted mt-[var(--s2)]">Loading what the family recorded…</p>
      ) : shown.state === 'failed' ? (
        <p role="alert" className="t-body mt-[var(--s2)]">
          The family&apos;s observations could not be loaded. This is not a statement that they recorded nothing. Reload to
          retry.
        </p>
      ) : shown.items.length === 0 ? (
        <p className="t-muted mt-[var(--s2)]">No observations from the family yet.</p>
      ) : (
        <ul aria-label="Family observations" className="mt-[var(--s2)] space-y-[var(--s3)]">
          {shown.items.map((item) => (
            <li key={item.note_id} className="rounded-[var(--r-md)] mat-leather--raised p-[var(--s3)]">
              <p className="t-label">
                {OBSERVATION_CATEGORIES[item.category] ?? item.category}
                {item.rating !== null ? ` · ${item.rating} out of 10` : ''}
              </p>
              <p className="t-body mt-[var(--s1)] whitespace-pre-wrap">{item.notes}</p>
              <p className="t-muted mt-[var(--s1)]">
                A guardian · {formatGymDateTimeShort(item.created_at) ?? item.created_at}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
