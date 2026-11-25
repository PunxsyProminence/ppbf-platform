'use client';

import { useEffect, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { formatGymDateTimeShort } from '@/src/lib/gymTime';

/**
 * MESSAGES FROM THE FAMILY (W4 item 4, scrub FAM-09; Overwatch Q4 A on #2161).
 *
 * Under "From the family" on /coach/decision-loop: the messages a guardian
 * started to the coach about the selected athlete, newest first, each with the
 * guardian's name and the time (gym time), every reply under it, and a reply
 * box. Only the guardian who started a message sees it and the replies under
 * it (OD-2026-10-12-024); the panel says so.
 *
 * Read from GET /api/pilot/coach/family-threads (staff only). A failed read
 * says so, with Check again, which re-runs this read only (UXB-05); it is never
 * shown as "no messages".
 *
 * NEW TO ME: a guardian post this staff member had not seen when the panel
 * first loaded carries "New", kept for the visit. It is recorded as seen when
 * at least half of it is on screen (FC-05 Q-1 A, as FC-09b's replies), once
 * per visit; a failed write is tried again when the post is next on screen.
 * The panel is mounted per athlete (key), so nothing carries across children.
 */

export interface StaffThreadPostView {
  post_id: string;
  from: 'guardian' | 'staff';
  staff_name: string | null;
  text: string;
  created_at: string;
  new_to_me: boolean;
}

export interface StaffThreadView {
  thread_id: string;
  athlete_id: string;
  created_at: string;
  guardian_name: string;
  posts: StaffThreadPostView[];
}

// newIds: the guardian posts new to this staff member on this visit, so far.
type ReadState = { state: 'loading' } | { state: 'failed' } | { state: 'loaded'; items: StaffThreadView[]; newIds: ReadonlySet<string> };

function when(at: string): string {
  return formatGymDateTimeShort(at) ?? at;
}

export default function FamilyThreadsForStaff({ athleteId }: Readonly<{ athleteId: string }>) {
  const [read, setRead] = useState<ReadState>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<string | null>(null);
  const [replyErrors, setReplyErrors] = useState<Record<string, string>>({});
  const seq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  // Guardian posts that were new to this staff member on this visit: New stays after a reload.
  const newThisVisit = useRef<Set<string>>(new Set());
  // Reads sent on this visit; a failed write leaves the set, so it is sent again.
  const readsSent = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!athleteId) return;
    const mine = ++seq.current;
    // A re-read after a reply keeps the list on screen; only the first read says Loading.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRead((held) => (held.state === 'loaded' ? held : { state: 'loading' }));
    void (async () => {
      try {
        const response = await fetch(
          `${apiBase()}/api/pilot/coach/family-threads?athlete_id=${encodeURIComponent(athleteId)}`,
          { credentials: 'include' },
        );
        const payload = (await response.json().catch(() => ({}))) as { items?: unknown };
        if (mine !== seq.current) return;
        if (!response.ok || !Array.isArray(payload.items)) {
          setRead({ state: 'failed' });
          return;
        }
        const items = payload.items as StaffThreadView[];
        for (const thread of items) {
          for (const post of thread.posts) {
            if (post.from === 'guardian' && post.new_to_me) newThisVisit.current.add(post.post_id);
          }
        }
        setRead({ state: 'loaded', items, newIds: new Set(newThisVisit.current) });
      } catch {
        if (mine === seq.current) setRead({ state: 'failed' });
      }
    })();
  }, [athleteId, attempt]);

  /* SEEING A GUARDIAN'S POST: at least half of it on screen, or, for a post
     taller than the screen, half the screen filled with it. */
  useEffect(() => {
    if (read.state !== 'loaded' || !listRef.current || typeof IntersectionObserver === 'undefined') return;
    const unseen = new Set(
      read.items.flatMap((thread) => thread.posts)
        .filter((post) => post.from === 'guardian' && post.new_to_me && !readsSent.current.has(post.post_id))
        .map((post) => post.post_id),
    );
    if (unseen.size === 0) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const fillsHalfTheScreen = entry.rootBounds !== null
          && entry.intersectionRect.height >= 0.5 * entry.rootBounds.height;
        if (!entry.isIntersecting || (entry.intersectionRatio < 0.5 && !fillsHalfTheScreen)) continue;
        const postId = (entry.target as HTMLElement).dataset.readPost;
        if (!postId || readsSent.current.has(postId)) continue;
        readsSent.current.add(postId);
        observer.unobserve(entry.target);
        const target = entry.target;
        const failed = () => {
          readsSent.current.delete(postId);
          // Watched again: if it is still on screen, it is sent again.
          if (target.isConnected) observer.observe(target);
        };
        void fetch(`${apiBase()}/api/pilot/coach/family-thread-reads`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ post_id: postId }),
        })
          .then((response) => {
            if (!response.ok) failed();
          })
          .catch(failed);
      }
    // Every 1%: a tall post changes its visible share only a little as it scrolls.
    }, { threshold: Array.from({ length: 101 }, (_, step) => step / 100) });
    listRef.current.querySelectorAll<HTMLElement>('[data-read-post]').forEach((element) => {
      if (unseen.has(element.dataset.readPost ?? '')) observer.observe(element);
    });
    return () => observer.disconnect();
  }, [read]);

  async function sendReply(threadId: string) {
    const text = (drafts[threadId] ?? '').trim();
    if (!text) {
      setReplyErrors((held) => ({ ...held, [threadId]: 'Write a reply before sending.' }));
      return;
    }
    setSending(threadId);
    setReplyErrors((held) => ({ ...held, [threadId]: '' }));
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/family-threads`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thread_id: threadId, text }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: unknown };
        // The server's own words only for a refusal of this request (4xx), never a server fault.
        const reason = response.status < 500 && typeof payload.error === 'string' ? ` ${payload.error}` : '';
        setReplyErrors((held) => ({ ...held, [threadId]: `Your reply was not sent; it is still in the box.${reason}` }));
        return;
      }
      setDrafts((held) => ({ ...held, [threadId]: '' }));
      setAttempt((n) => n + 1);
    } catch {
      setReplyErrors((held) => ({ ...held, [threadId]: 'Your reply was not sent; it is still in the box. Check the connection and send again.' }));
    } finally {
      setSending(null);
    }
  }

  if (!athleteId) return null;

  return (
    <div ref={listRef} className="mt-[var(--s4)]">
      <h3 className="t-label">Messages from the family</h3>
      <p className="t-muted mt-[var(--s1)]">
        Messages a guardian started to the coach. Only the guardian who wrote one sees it and the replies under it.
      </p>
      {read.state === 'loading' ? (
        <p className="t-muted mt-[var(--s2)]">Loading messages from the family…</p>
      ) : read.state === 'failed' ? (
        <div role="alert" className="mt-[var(--s2)]">
          <p className="t-body">
            Messages from the family could not be loaded. This is not a statement that there are none.
          </p>
          <button type="button" className="btn btn--ghost mt-[var(--s2)]" onClick={() => setAttempt((n) => n + 1)}>
            Check again
          </button>
        </div>
      ) : read.items.length === 0 ? (
        <p className="t-muted mt-[var(--s2)]">No messages from the family yet.</p>
      ) : (
        <ul aria-label="Messages from the family" className="mt-[var(--s2)] space-y-[var(--s3)]">
          {read.items.map((thread) => (
            <li key={thread.thread_id} className="rounded-[var(--r-md)] mat-leather--raised p-[var(--s3)]">
              <ul aria-label={`Message from ${thread.guardian_name}`} className="space-y-[var(--s2)]">
                {thread.posts.map((post) => (
                  <li key={post.post_id} data-read-post={post.from === 'guardian' ? post.post_id : undefined}>
                    <p className="t-label">
                      {post.from === 'guardian' ? thread.guardian_name : post.staff_name ?? 'Staff'}
                      <span className="t-muted"> · {when(post.created_at)}</span>
                      {post.from === 'guardian' && read.newIds.has(post.post_id) ? (
                        <span className="badge badge--filed ml-[var(--s2)]"><i aria-hidden="true">◉</i><span>New</span></span>
                      ) : null}
                    </p>
                    <p className="t-body mt-[var(--s1)] whitespace-pre-wrap">{post.text}</p>
                  </li>
                ))}
              </ul>
              <form
                className="mt-[var(--s3)] space-y-[var(--s2)]"
                onSubmit={(event) => {
                  event.preventDefault();
                  void sendReply(thread.thread_id);
                }}
              >
                <label className="field block">
                  <span className="t-label">Reply to {thread.guardian_name}</span>
                  <textarea
                    value={drafts[thread.thread_id] ?? ''}
                    onChange={(event) => setDrafts((held) => ({ ...held, [thread.thread_id]: event.target.value }))}
                    maxLength={2000}
                    className="textarea min-h-[56px]"
                  />
                </label>
                <button type="submit" className="btn btn--ghost" disabled={sending !== null}>
                  {sending === thread.thread_id ? 'Sending…' : 'Send reply'}
                </button>
                {replyErrors[thread.thread_id] ? (
                  <p role="alert" className="t-body">{replyErrors[thread.thread_id]}</p>
                ) : null}
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type UnseenState = { state: 'loading' } | { state: 'failed' } | { state: 'loaded'; items: Array<{ athlete_id: string; unseen: number }> };

/**
 * One line under the Athlete picker (Q4.4 A, Q4.5 A): the athletes with guardian
 * messages this staff member has not seen, and how many. A tap chooses that
 * athlete (`onChoose`, the page's own selection). Read from GET
 * /api/pilot/coach/family-threads/unread whenever `refreshKey` changes; names
 * come from the page's roster, and an athlete not on it is left out. Nothing
 * shows when there is nothing new; a failed read says so.
 */
export function FamilyThreadsUnread({
  athletes,
  refreshKey,
  onChoose,
}: Readonly<{
  athletes: ReadonlyArray<{ athlete_id: string; full_name?: string | null }>;
  refreshKey: string;
  onChoose: (athleteId: string) => void;
}>) {
  const [read, setRead] = useState<UnseenState>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/coach/family-threads/unread`, { credentials: 'include' });
        const payload = (await response.json().catch(() => ({}))) as { items?: unknown };
        if (mine !== seq.current) return;
        setRead(response.ok && Array.isArray(payload.items)
          ? { state: 'loaded', items: payload.items as Array<{ athlete_id: string; unseen: number }> }
          : { state: 'failed' });
      } catch {
        if (mine === seq.current) setRead({ state: 'failed' });
      }
    })();
  }, [refreshKey, attempt]);

  if (read.state === 'loading') return null;
  if (read.state === 'failed') {
    return (
      <div className="mt-[var(--s3)] flex flex-wrap items-center gap-[var(--s3)]">
        <p className="t-muted">New messages from families could not be checked.</p>
        {/* Its own name: the picker's section has the records' Check again too. */}
        <button type="button" className="btn btn--ghost" onClick={() => setAttempt((n) => n + 1)}>
          Check for new messages again
        </button>
      </div>
    );
  }
  const named = read.items.flatMap((item) => {
    const athlete = athletes.find((candidate) => candidate.athlete_id === item.athlete_id);
    return athlete && item.unseen > 0
      ? [{ athleteId: item.athlete_id, name: athlete.full_name?.trim() || 'Unnamed athlete', unseen: item.unseen }]
      : [];
  });
  if (named.length === 0) return null;
  return (
    <div className="mt-[var(--s3)] flex flex-wrap items-center gap-[var(--s2)]">
      <p className="t-body">New messages from families:</p>
      {named.map((item) => (
        <button key={item.athleteId} type="button" className="btn btn--ghost" onClick={() => onChoose(item.athleteId)}>
          {item.name} ({item.unseen} new)
        </button>
      ))}
    </div>
  );
}
