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
 *
 * OPENED BY THE FAMILY (FC-05): under each note, "Opened by the family" and
 * when it was first opened (gym time), or "No open recorded on the Messages
 * tab yet" -- not "not opened": an open before this was built, a task ticked
 * on the Parent Floor, or a write that failed leaves no record. One line
 * above the list says how opens are recorded.
 * Never which guardian. Read from GET /api/pilot/coach/family-message-reads on
 * its own, like the replies: a failed read says so once and the notes stay.
 *
 * NEW TO ME (FC-09b): a reply this staff member had not seen when the panel
 * loaded carries a small "New", kept for the visit. "Seen" is each staff
 * member's own (GET /api/pilot/coach/family-reply-reads); one coach seeing a
 * reply does not make it seen for another. A reply is recorded as seen when at
 * least half of it is on screen here (the FC-05 rule) -- loading the panel is
 * not a read. If the seen read fails, no New is drawn and one muted line says
 * it could not be loaded: the panel never claims every reply is new, or none
 * is. Replies are still recorded as seen. A failed write is not shown and is
 * tried again when the panel next reloads.
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
  // replies and opened: 'loading' until their own read settles; null when it failed.
  | {
    state: 'loaded';
    athleteId: string;
    items: FamilyNoteRow[];
    replies: FamilyReplyRow[] | null | 'loading';
    opened: Map<string, string> | null | 'loading';
    // The reply ids this staff member had already seen; null when that read failed.
    seen: Set<string> | null | 'loading';
  };

async function readSeen(athleteId: string): Promise<Set<string> | null> {
  try {
    const response = await fetch(
      `${apiBase()}/api/pilot/coach/family-reply-reads?athlete_id=${encodeURIComponent(athleteId)}`,
      { credentials: 'include' },
    );
    const payload = (await response.json().catch(() => ({}))) as { items?: unknown };
    if (!response.ok || !Array.isArray(payload.items)) return null;
    const ids = (payload.items as Array<{ reply_id?: unknown }>).map((item) => item?.reply_id);
    return ids.every((id): id is string => typeof id === 'string') ? new Set(ids) : null;
  } catch {
    return null;
  }
}

async function readOpened(athleteId: string): Promise<Map<string, string> | null> {
  try {
    const response = await fetch(
      `${apiBase()}/api/pilot/coach/family-message-reads?athlete_id=${encodeURIComponent(athleteId)}`,
      { credentials: 'include' },
    );
    const payload = (await response.json().catch(() => ({}))) as { items?: unknown };
    if (!response.ok || !Array.isArray(payload.items)) return null;
    return new Map((payload.items as Array<{ note_id: string; first_read_at: string }>).map((item) => [item.note_id, item.first_read_at]));
  } catch {
    return null;
  }
}

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
  const listRef = useRef<HTMLDivElement>(null);
  // Replies whose read was sent on this visit; a failed write leaves the set.
  const readsSentRef = useRef<Set<string>>(new Set());
  // What this staff member had seen when they opened this athlete: a reload
  // after a post keeps it, so New stays for the visit.
  const visitRef = useRef<{ athleteId: string; seen: Set<string> | null }>({ athleteId: '', seen: null });

  useEffect(() => {
    if (!athleteId) return;
    const mine = ++seq.current;
    if (visitRef.current.athleteId !== athleteId) {
      visitRef.current = { athleteId, seen: null };
      readsSentRef.current = new Set();
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRead({ state: 'loading' });
    void (async () => {
      try {
        const repliesRead = readReplies(athleteId);
        const openedRead = readOpened(athleteId);
        const seenRead = readSeen(athleteId);
        const response = await fetch(
          `${apiBase()}/api/pilot/coach/family-notes?athlete_id=${encodeURIComponent(athleteId)}`,
          { credentials: 'include' },
        );
        const payload = (await response.json().catch(() => ({}))) as { items?: unknown };
        if (mine !== seq.current) return;
        if (!response.ok || !Array.isArray(payload.items)) {
          setRead({ state: 'failed', athleteId });
          return;
        }
        // The notes show as soon as they answer; the replies fill in when
        // their own read settles, so a slow or failed replies read never
        // holds the notes back.
        setRead({ state: 'loaded', athleteId, items: payload.items as FamilyNoteRow[], replies: 'loading', opened: 'loading', seen: 'loading' });
        // Each fills in when its own read settles, in whichever order they answer.
        void openedRead.then((opened) => {
          if (mine !== seq.current) return;
          setRead((held) => (held.state === 'loaded' && held.athleteId === athleteId ? { ...held, opened } : held));
        });
        void seenRead.then((fetched) => {
          if (mine !== seq.current) return;
          const kept = visitRef.current.athleteId === athleteId ? visitRef.current.seen : null;
          const seen = fetched && kept ? kept : fetched;
          if (seen) visitRef.current = { athleteId, seen };
          setRead((held) => (held.state === 'loaded' && held.athleteId === athleteId ? { ...held, seen } : held));
        });
        const replies = await repliesRead;
        if (mine !== seq.current) return;
        setRead((held) => (held.state === 'loaded' && held.athleteId === athleteId ? { ...held, replies } : held));
      } catch {
        if (mine === seq.current) setRead({ state: 'failed', athleteId });
      }
    })();
  }, [athleteId, refreshKey]);

  /* SEEING A REPLY (FC-09b). The FC-05 rule from the parent hub: at least half
     of the reply on screen -- or, for a reply taller than the screen, half the
     screen filled with it. Watched only once this staff member's earlier reads
     have answered (or failed), so a write cannot race the read that decides
     what is New. Each reply is sent once per visit; the server keeps the
     first time. */
  useEffect(() => {
    if (read.state !== 'loaded' || read.athleteId !== athleteId) return;
    if (!Array.isArray(read.replies) || read.replies.length === 0 || read.seen === 'loading') return;
    if (typeof IntersectionObserver === 'undefined' || !listRef.current) return;
    const seenAtLoad = read.seen;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const fillsHalfTheScreen = entry.rootBounds !== null
          && entry.intersectionRect.height >= 0.5 * entry.rootBounds.height;
        if (!entry.isIntersecting || (entry.intersectionRatio < 0.5 && !fillsHalfTheScreen)) continue;
        const replyId = (entry.target as HTMLElement).dataset.readReply;
        if (!replyId || readsSentRef.current.has(replyId)) continue;
        readsSentRef.current.add(replyId);
        observer.unobserve(entry.target);
        const sent = readsSentRef.current;
        void fetch(`${apiBase()}/api/pilot/coach/family-reply-reads`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reply_id: replyId }),
        })
          .then((response) => {
            if (!response.ok) sent.delete(replyId);
          })
          .catch(() => {
            sent.delete(replyId);
          });
      }
    // Every 1%: a tall reply changes its visible share only a little as it
    // scrolls, so coarse steps could miss it filling half the screen.
    }, { threshold: Array.from({ length: 101 }, (_, step) => step / 100) });
    listRef.current.querySelectorAll<HTMLElement>('[data-read-reply]').forEach((element) => {
      if (seenAtLoad instanceof Set && seenAtLoad.has(element.dataset.readReply ?? '')) return;
      observer.observe(element);
    });
    return () => observer.disconnect();
  }, [read, athleteId]);

  if (!athleteId) return null;
  // What is on screen belongs to the athlete selected now, or it reads as
  // loading: the render after a switch must not show the last child's notes.
  const shown: ReadState = read.state !== 'loading' && read.athleteId !== athleteId ? { state: 'loading' } : read;

  return (
    <div ref={listRef} className="mt-[var(--s4)]">
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
        ) : shown.replies === 'loading' ? (
          <p className="t-muted mt-[var(--s2)]">Loading the family&apos;s replies…</p>
        ) : null}
        {shown.opened instanceof Map ? (
          <p className="t-muted mt-[var(--s2)]">
            An open is recorded when a message is shown on the family&apos;s Messages tab, from this release on.
            Ticking a task on the Parent Floor is not counted as opening it.
          </p>
        ) : null}
        {shown.opened === null ? (
          <p role="alert" className="t-body mt-[var(--s2)]">
            Whether the family opened these could not be loaded. This is not a statement that they did not. Reload to retry.
          </p>
        ) : null}
        {shown.seen === null && Array.isArray(shown.replies) && shown.replies.length > 0 ? (
          // PROPOSED copy
          <p className="t-muted mt-[var(--s2)]">
            Which replies are new to you could not be loaded. This is not a statement that there are none.
          </p>
        ) : null}
        <ul className="mt-[var(--s2)] space-y-[var(--s3)]">
          {shown.items.map((note) => {
            const replies = Array.isArray(shown.replies)
              ? shown.replies.filter((reply) => reply.note_id === note.note_id)
              : [];
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
                {shown.opened instanceof Map ? (
                  <p className="t-muted mt-[var(--s1)]">
                    {shown.opened.has(note.note_id)
                      ? `Opened by the family · ${formatGymDateTimeShort(shown.opened.get(note.note_id)!) ?? shown.opened.get(note.note_id)}`
                      : 'No open recorded on the Messages tab yet'}
                  </p>
                ) : null}
                {note.task ? (
                  <span className={`badge mt-[var(--s2)] ${done ? 'badge--cleared' : 'badge--monitor'}`}>
                    {done ? `Done ${formatGymDateTimeShort(done) ?? done}` : 'Still to do'}
                  </span>
                ) : null}
                {replies.length > 0 ? (
                  <ul aria-label="Family replies" className="mt-[var(--s2)] space-y-[var(--s2)] border-l-2 border-[color:var(--brass-600)] pl-[var(--s3)]">
                    {replies.map((reply) => (
                      <li key={reply.reply_id} data-read-reply={reply.reply_id}>
                        <p className="t-label">
                          {reply.author_name} replied · {formatGymDateTimeShort(reply.created_at) ?? reply.created_at}
                          {shown.seen instanceof Set && !shown.seen.has(reply.reply_id) ? (
                            // PROPOSED copy
                            <span className="badge badge--filed ml-[var(--s2)]"><i aria-hidden="true">◉</i><span>New</span></span>
                          ) : null}
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
