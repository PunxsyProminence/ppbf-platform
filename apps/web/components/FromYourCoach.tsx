'use client';

import { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { formatGymDateTimeShort } from '@/src/lib/gymTime';

/**
 * FROM YOUR COACH (#1542, FC-06).
 *
 * On the athlete's Dashboard: what their coaches wrote to them, newest first,
 * with who and when (gym time). Read only. Separate from Ask SHADOW, which is
 * the athlete's conversation with SHADOW and still does not reach a coach.
 *
 * Read from GET /api/pilot/athlete/coach-messages (the athlete's own, from the
 * session). A failed read says so; it is never shown as "no messages".
 */
interface CoachMessage {
  note_id: string;
  note_text: string;
  created_at: string;
  from_name: string;
}

type ReadState = { state: 'loading' } | { state: 'failed' } | { state: 'loaded'; items: CoachMessage[] };

// The newest ten first; older ones a press away, so a season of notes does
// not bury the Dashboard.
const PAGE_SIZE = 10;

export default function FromYourCoach() {
  const [read, setRead] = useState<ReadState>({ state: 'loading' });
  const [shownCount, setShownCount] = useState(PAGE_SIZE);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/athlete/coach-messages`, {
          credentials: 'include',
          signal: controller.signal,
        });
        const payload = (await response.json().catch(() => ({}))) as { items?: unknown };
        if (controller.signal.aborted) return;
        if (!response.ok || !Array.isArray(payload.items)) {
          setRead({ state: 'failed' });
          return;
        }
        setRead({ state: 'loaded', items: payload.items as CoachMessage[] });
      } catch {
        if (!controller.signal.aborted) setRead({ state: 'failed' });
      }
    })();
    return () => controller.abort();
  }, []);

  return (
    <section aria-label="From your coach" className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
      <h3 className="t-label">From your coach</h3>
      {read.state === 'loading' ? (
        <p className="t-muted mt-[var(--s2)]">Loading messages from your coach…</p>
      ) : read.state === 'failed' ? (
        <p role="alert" className="t-body mt-[var(--s2)]">
          We couldn&apos;t load your coach&apos;s messages, so we can&apos;t tell if there are any. Reload to try again.
        </p>
      ) : read.items.length === 0 ? (
        <p className="t-muted mt-[var(--s2)]">No messages from your coach yet.</p>
      ) : (
        <>
        <ul className="mt-[var(--s2)] space-y-[var(--s3)]">
          {read.items.slice(0, shownCount).map((message) => (
            <li key={message.note_id} className="rounded-[var(--r-md)] mat-leather--raised p-[var(--s3)]">
              <p className="t-body whitespace-pre-wrap break-words">{message.note_text}</p>
              <p className="t-muted mt-[var(--s1)]">
                {message.from_name} · {formatGymDateTimeShort(message.created_at) ?? message.created_at}
              </p>
            </li>
          ))}
        </ul>
        {read.items.length > shownCount ? (
          <button type="button" className="btn btn--ghost mt-[var(--s2)]" onClick={() => setShownCount((count) => count + PAGE_SIZE)}>
            Show {Math.min(PAGE_SIZE, read.items.length - shownCount)} more ({read.items.length - shownCount} older)
          </button>
        ) : null}
        </>
      )}
    </section>
  );
}
