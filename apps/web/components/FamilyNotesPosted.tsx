'use client';

import { useEffect, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { formatCalendarDay } from '@/lib/calendarDay';
import { formatGymDateTimeShort } from '@/src/lib/gymTime';

/**
 * ON THE FAMILY'S PAGE (#1542, FC-01; audit F-041).
 *
 * Under "Post to the Family's Page" on /coach/decision-loop: every note the gym
 * has posted to the selected athlete's family, newest first, with who posted
 * it, when (gym time), its due date if it has one, and whether the family
 * marked it done and when. Before this the coach posted and then saw nothing.
 *
 * Read from GET /api/pilot/coach/family-notes (staff only; the server leaves
 * out which guardian ticked it). A failed read says so; it is never shown as
 * "nothing posted". `refreshKey` changes after a post, so the new note appears.
 *
 * FAMILY REPLIES (FC-03): under each note, what the family wrote back, oldest
 * first, with the guardian's name and the time (gym time). Read from GET
 * /api/pilot/coach/family-message-replies alongside the notes; a failed replies
 * read says so and leaves the notes showing.
 */
export interface FamilyNoteRow {
  note_id: string;
  note_text: string;
  posted_at: string;
  posted_by_name: string;
  task: { due_date: string | null; completed_at: string | null } | null;
}

export interface FamilyReplyRow {
  reply_id: string;
  note_id: string;
  reply_text: string;
  created_at: string;
  author_name: string;
}

type ReadState =
  | { state: 'loading' }
  | { state: 'failed'; athleteId: string }
  | { state: 'loaded'; athleteId: string; items: FamilyNoteRow[]; replies: FamilyReplyRow[] | null };

async function readReplies(athleteId: string): Promise<FamilyReplyRow[] | null> {
  try {
    const response = await fetch(
      `${apiBase()}/api/pilot/coach/family-message-replies?athlete_id=${encodeURIComponent(athleteId)}`,
      { credentials: 'include' },
    );
    const payload = (await response.json().catch(() => ({}))) as { items?: unknown };
    return response.ok && Array.isArray(payload.items) ? (payload.items as FamilyReplyRow[]) : null;
  } catch {
    return null;
  }
}

export default function FamilyNotesPosted({
  athleteId,
  refreshKey,
}: Readonly<{ athleteId: string; refreshKey: number }>) {
  const [read, setRead] = useState<ReadState>({ state: 'loading' });
  // Only the newest read lands: switching athletes while a read is slow must
  // not leave one child's notes under another's name.
  const seq = useRef(0);

  useEffect(() => {
    if (!athleteId) return;
    const mine = ++seq.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRead({ state: 'loading' });
    void (async () => {
      try {
        const repliesRead = readReplies(athleteId);
        const response = await fetch(
          `${apiBase()}/api/pilot/coach/family-notes?athlete_id=${encodeURIComponent(athleteId)}`,
          { credentials: 'include' },
        );
        const payload = (await response.json().catch(() => ({}))) as { items?: unknown };
        const replies = await repliesRead;
        if (mine !== seq.current) return;
        if (!response.ok || !Array.isArray(payload.items)) {
          setRead({ state: 'failed', athleteId });
          return;
        }
        setRead({ state: 'loaded', athleteId, items: payload.items as FamilyNoteRow[], replies });
      } catch {
        if (mine === seq.current) setRead({ state: 'failed', athleteId });
      }
    })();
  }, [athleteId, refreshKey]);

  if (!athleteId) return null;
  // What is on screen belongs to the athlete selected now, or it reads as
  // loading: the render after a switch must not show the last child's notes.
  const shown: ReadState = read.state !== 'loading' && read.athleteId !== athleteId ? { state: 'loading' } : read;

  return (
    <div className="mt-[var(--s4)]">
      <h3 className="t-label">On the family&apos;s page</h3>
      {shown.state === 'loading' ? (
        <p className="t-muted mt-[var(--s2)]">Loading what was posted…</p>
      ) : shown.state === 'failed' ? (
        <p role="alert" className="t-body mt-[var(--s2)]">
          Posted notes could not be loaded. This is not a statement that nothing was posted. Reload to retry.
        </p>
      ) : shown.items.length === 0 ? (
        <p className="t-muted mt-[var(--s2)]">Nothing has been posted to this family yet.</p>
      ) : (
        <>
        {shown.replies === null ? (
          <p role="alert" className="t-body mt-[var(--s2)]">
            The family&apos;s replies could not be loaded. This is not a statement that nobody replied. Reload to retry.
          </p>
        ) : null}
        <ul className="mt-[var(--s2)] space-y-[var(--s3)]">
          {shown.items.map((note) => {
            const replies = shown.replies?.filter((reply) => reply.note_id === note.note_id) ?? [];
            const done = note.task?.completed_at ?? null;
            // A due date is a calendar day, not an instant: printed as the day it is.
            const due = note.task?.due_date ? formatCalendarDay(note.task.due_date) : null;
            return (
              <li key={note.note_id} className="rounded-[var(--r-md)] mat-leather--raised p-[var(--s3)]">
                <p className="t-body">{note.note_text}</p>
                <p className="t-muted mt-[var(--s1)]">
                  {note.posted_by_name} · {formatGymDateTimeShort(note.posted_at) ?? note.posted_at}
                  {due ? ` · Due ${due}` : ''}
                </p>
                {note.task ? (
                  <span className={`badge mt-[var(--s2)] ${done ? 'badge--cleared' : 'badge--monitor'}`}>
                    {done ? `Done ${formatGymDateTimeShort(done) ?? done}` : 'Still to do'}
                  </span>
                ) : null}
                {replies.length > 0 ? (
                  <ul aria-label="Family replies" className="mt-[var(--s2)] space-y-[var(--s2)] border-l-2 border-[color:var(--brass-600)] pl-[var(--s3)]">
                    {replies.map((reply) => (
                      <li key={reply.reply_id}>
                        <p className="t-label">
                          {reply.author_name} replied · {formatGymDateTimeShort(reply.created_at) ?? reply.created_at}
                        </p>
                        <p className="t-body whitespace-pre-wrap">{reply.reply_text}</p>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
        </>
      )}
    </div>
  );
}
