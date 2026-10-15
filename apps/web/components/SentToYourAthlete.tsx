'use client';

import { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { formatGymDateTimeShort } from '@/src/lib/gymTime';

/**
 * SENT TO YOUR ATHLETE (#1542, FC-06 Q-2, ruled B).
 *
 * On the parent hub's Messages tab, below the family's own messages: a
 * read-only copy of what the gym's staff wrote to the guardian's children
 * under 18 -- the owner's decision that, for youth, guardians receive a copy
 * of athlete messages. Each shows which child it was sent to, the words, who
 * wrote it and when (gym time). Not a reply surface: the child reads it on
 * their own Dashboard.
 *
 * Read from GET /api/pilot/parent/athlete-messages (the guardian's own linked
 * children, resolved by the server on each request). A failed read says so;
 * it is never shown as "nothing sent". The newest ten show first.
 */
interface GuardianCopy {
  note_id: string;
  athlete_id: string;
  note_text: string;
  created_at: string;
  from_name: string;
}

type ReadState = { state: 'loading' } | { state: 'failed' } | { state: 'loaded'; items: GuardianCopy[] };

const PAGE_SIZE = 10;

export default function SentToYourAthlete({ childNames }: Readonly<{ childNames: Record<string, string> }>) {
  const [read, setRead] = useState<ReadState>({ state: 'loading' });
  const [shownCount, setShownCount] = useState(PAGE_SIZE);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/parent/athlete-messages`, {
          credentials: 'include',
          signal: controller.signal,
        });
        const payload = (await response.json().catch(() => ({}))) as { items?: unknown };
        if (controller.signal.aborted) return;
        setRead(response.ok && Array.isArray(payload.items)
          ? { state: 'loaded', items: payload.items as GuardianCopy[] }
          : { state: 'failed' });
      } catch {
        if (!controller.signal.aborted) setRead({ state: 'failed' });
      }
    })();
    return () => controller.abort();
  }, []);

  return (
    <section aria-label="Sent to your athlete" className="mat-paper rounded-[var(--r-lg)] p-[var(--s4)] space-y-[var(--s3)]">
      <h4 className="t-label">Sent to your athlete</h4>
      <p className="t-muted">A copy of what the gym&apos;s staff wrote to your child. Your child reads it on their own page.</p>
      {read.state === 'loading' ? (
        <p className="t-muted">Loading…</p>
      ) : read.state === 'failed' ? (
        <p role="alert" className="t-body">
          What was sent to your athlete could not be loaded. This is not a statement that nothing was sent.
        </p>
      ) : read.items.length === 0 ? (
        <p className="t-muted">Nothing has been sent to your athlete yet.</p>
      ) : (
        <>
          <ul className="space-y-[var(--s3)]">
            {read.items.slice(0, shownCount).map((item) => (
              <li key={item.note_id} className="rounded-[var(--r-md)] bg-[color:rgba(0,0,0,.05)] p-[var(--s3)]">
                <p className="t-label">To {childNames[item.athlete_id] ?? 'your child'}</p>
                <p className="t-body mt-[var(--s1)] whitespace-pre-wrap break-words">{item.note_text}</p>
                <p className="t-muted mt-[var(--s1)]">
                  {item.from_name} · {formatGymDateTimeShort(item.created_at) ?? item.created_at}
                </p>
              </li>
            ))}
          </ul>
          {read.items.length > shownCount ? (
            <button type="button" className="btn btn--ghost" onClick={() => setShownCount((count) => count + PAGE_SIZE)}>
              Show {Math.min(PAGE_SIZE, read.items.length - shownCount)} more ({read.items.length - shownCount} older)
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
