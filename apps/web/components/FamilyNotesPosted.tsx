'use client';

import { useEffect, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { formatCalendarDay } from '@/lib/calendarDay';
import { formatGymDateTime, formatGymDateTimeShort } from '@/src/lib/gymTime';

// The moment from which a family's open is recorded (F-174); the line above the list shows it in gym time, not "this release".
export const OPENS_COUNTED_FROM = '2026-10-15T03:34:25Z';

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
 * Each failed read has Check again, which re-runs that read only: a reload
 * would throw away every unsent draft on the page (UXB-05).
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
 * above the list says how opens are recorded, and since when (F-174).
 * OPENS_COUNTED_FROM is when the recording reached production: #1589 (FC-05)
 * deployed by deploy-production run 38675987960, finished 2026-10-15T03:34:25Z
 * (2026-10-14, 11:34 PM gym time). A parent message opened earlier left no row.
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
 * is. Replies are still recorded as seen. That line's Check again re-runs the
 * panel's reads. A failed write is not shown and is tried again when the panel
 * next reloads.
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
  // Replies a newer watch saw while their read was still on its way (a reload
  // came in between). If that read fails, the reply is watched afresh, so a
  // reply still on screen is sent again without waiting for it to move.
  const seenWhileSendingRef = useRef<Set<string>>(new Set());
  // Which watch sent each read in flight: only a newer watch's sighting counts
  // above, so one batch naming a reply twice never re-arms it.
  const sentByRef = useRef<Map<string, IntersectionObserver>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);
  // What this staff member had seen when they opened this athlete: a reload
  // after a post keeps it, so New stays for the visit.
  const visitRef = useRef<{ athleteId: string; seen: Set<string> | null }>({ athleteId: '', seen: null });
  // Bumped by Check again on the notes: the same reads, nothing else on the page.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!athleteId) return;
    const mine = ++seq.current;
    if (visitRef.current.athleteId !== athleteId) {
      visitRef.current = { athleteId, seen: null };
      readsSentRef.current = new Set();
      seenWhileSendingRef.current = new Set();
      sentByRef.current = new Map();
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
  }, [athleteId, refreshKey, attempt]);

  /* Check again on the replies or the opens: that one read, again, landing
     only on the notes it was asked for. */
  function recheckReplies() {
    const mine = seq.current;
    const forAthlete = athleteId;
    setRead((held) => (held.state === 'loaded' && held.athleteId === forAthlete ? { ...held, replies: 'loading' } : held));
    void readReplies(forAthlete).then((replies) => {
      if (mine !== seq.current) return;
      setRead((held) => (held.state === 'loaded' && held.athleteId === forAthlete ? { ...held, replies } : held));
    });
  }
  function recheckOpened() {
    const mine = seq.current;
    const forAthlete = athleteId;
    setRead((held) => (held.state === 'loaded' && held.athleteId === forAthlete ? { ...held, opened: 'loading' } : held));
    void readOpened(forAthlete).then((opened) => {
      if (mine !== seq.current) return;
      setRead((held) => (held.state === 'loaded' && held.athleteId === forAthlete ? { ...held, opened } : held));
    });
  }

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
        if (!replyId) continue;
        if (readsSentRef.current.has(replyId)) {
          if (sentByRef.current.get(replyId) !== observer) seenWhileSendingRef.current.add(replyId);
          continue;
        }
        readsSentRef.current.add(replyId);
        sentByRef.current.set(replyId, observer);
        observer.unobserve(entry.target);
        const sent = readsSentRef.current;
        const seenWhileSending = seenWhileSendingRef.current;
        const sentBy = sentByRef.current;
        const failed = () => {
          sent.delete(replyId);
          sentBy.delete(replyId);
          if (!seenWhileSending.delete(replyId) || sent !== readsSentRef.current) return;
          // Watched afresh: observing again hands the watch the reply's place on screen now.
          const watching = observerRef.current;
          const element = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-read-reply]') ?? [])]
            .find((candidate) => candidate.dataset.readReply === replyId);
          if (!watching || !element) return;
          watching.unobserve(element);
          watching.observe(element);
        };
        void fetch(`${apiBase()}/api/pilot/coach/family-reply-reads`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reply_id: replyId }),
        })
          .then((response) => {
            if (!response.ok) failed();
          })
          .catch(failed);
      }
    // Every 1%: a tall reply changes its visible share only a little as it
    // scrolls, so coarse steps could miss it filling half the screen.
    }, { threshold: Array.from({ length: 101 }, (_, step) => step / 100) });
    listRef.current.querySelectorAll<HTMLElement>('[data-read-reply]').forEach((element) => {
      if (seenAtLoad instanceof Set && seenAtLoad.has(element.dataset.readReply ?? '')) return;
      observer.observe(element);
    });
    observerRef.current = observer;
    return () => {
      observer.disconnect();
      if (observerRef.current === observer) observerRef.current = null;
    };
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
        <div role="alert" className="mt-[var(--s2)]">
          <p className="t-body">Posted notes could not be loaded. This is not a statement that nothing was posted.</p>
          <button type="button" className="btn btn--ghost mt-[var(--s2)]" onClick={() => setAttempt((n) => n + 1)}>
            Check again
          </button>
        </div>
      ) : shown.items.length === 0 ? (
        <p className="t-muted mt-[var(--s2)]">Nothing has been posted to this family yet.</p>
      ) : (
        <>
        {shown.replies === null ? (
          <div role="alert" className="mt-[var(--s2)]">
            <p className="t-body">
              The family&apos;s replies could not be loaded. This is not a statement that nobody replied.
            </p>
            <button type="button" className="btn btn--ghost mt-[var(--s2)]" onClick={recheckReplies}>
              Check again
            </button>
          </div>
        ) : shown.replies === 'loading' ? (
          <p className="t-muted mt-[var(--s2)]">Loading the family&apos;s replies…</p>
        ) : null}
        {shown.opened instanceof Map ? (
          <p className="t-muted mt-[var(--s2)]">
            {/* PROPOSED copy (F-174): "no open" is not "not opened". */}
            Opens are counted from {formatGymDateTime(OPENS_COUNTED_FROM)}, when a message is shown on the family&apos;s Messages tab.
            A message the family saw before then, or anywhere other than the Messages tab, shows no open here. Ticking a task on the
            Parent Floor is not counted as opening it.
          </p>
        ) : null}
        {shown.opened === null ? (
          <div role="alert" className="mt-[var(--s2)]">
            <p className="t-body">
              Whether the family opened these could not be loaded. This is not a statement that they did not.
            </p>
            <button type="button" className="btn btn--ghost mt-[var(--s2)]" onClick={recheckOpened}>
              Check again
            </button>
          </div>
        ) : null}
        {shown.seen === null && Array.isArray(shown.replies) && shown.replies.length > 0 ? (
          // PROPOSED copy. Check again re-runs the panel's reads (UXB-05: never Reload).
          <div className="mt-[var(--s2)]">
            <p className="t-muted">
              Which replies are new to you could not be loaded. This is not a statement that there are none.
            </p>
            <button type="button" className="btn btn--ghost mt-[var(--s2)]" onClick={() => setAttempt((n) => n + 1)}>
              Check again
            </button>
          </div>
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
