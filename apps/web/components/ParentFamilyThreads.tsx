'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { formatGymDateTimeShort } from '@/src/lib/gymTime';

/**
 * WRITE TO THE COACH (W4 item 4, scrub FAM-09; Jason, OW27-24: "A: A message box
 * on the Parent Hub (Recommended)"; Q4.1 A, the Messages tab).
 *
 * A guardian writes to the coach about the child chosen in the hub's picker,
 * then reads their own messages with the gym's replies under them, and may
 * write again under a message they started (Overwatch Q2 A on #2161). Only
 * they and the gym's staff see it: the other guardian does not
 * (OD-2026-10-12-024), nor the child.
 *
 * Read from GET /api/pilot/parent/family-threads once the hub opens
 * (`useParentFamilyThreads`), so the summary tile can count unseen replies;
 * the panel shows on the Messages tab. A failed read says so; it is never
 * shown as "no messages". A reply from the gym this guardian had not seen
 * carries "New" for the visit and is recorded as seen when at least half of it
 * is on screen (FC-05 Q-1 A); a failed write is not repeated at once, and the
 * next read watches it again.
 */

export interface GuardianThreadPostView {
  post_id: string;
  from: 'you' | 'staff';
  staff_name: string | null;
  text: string;
  created_at: string;
  new_to_me: boolean;
}

export interface GuardianThreadView {
  thread_id: string;
  athlete_id: string;
  created_at: string;
  posts: GuardianThreadPostView[];
}

type ThreadsRead =
  | { state: 'loading' }
  | { state: 'failed' }
  // newIds: the gym's replies new to this guardian on this visit, so far ("New" stays for the visit).
  | { state: 'loaded'; items: GuardianThreadView[]; newIds: ReadonlySet<string> };

export interface ParentFamilyThreadsState {
  read: ThreadsRead;
  reload: () => void;
  /** The gym's replies recorded as seen on this visit. */
  seen: ReadonlySet<string>;
  markSeen: (postId: string) => void;
  /** Per child, the gym's replies not yet seen; null until the read answers. */
  unseenByChild: ReadonlyMap<string, number> | null;
}

export function useParentFamilyThreads(): ParentFamilyThreadsState {
  const [read, setRead] = useState<ThreadsRead>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  const seq = useRef(0);
  const newThisVisit = useRef<Set<string>>(new Set());

  useEffect(() => {
    const mine = ++seq.current;
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/parent/family-threads`, { credentials: 'include' });
        const payload = (await response.json().catch(() => ({}))) as { items?: unknown };
        if (mine !== seq.current) return;
        if (!response.ok || !Array.isArray(payload.items)) {
          // A re-read that fails keeps what is on screen; only a first read is shown as failed.
          setRead((held) => (held.state === 'loaded' ? held : { state: 'failed' }));
          return;
        }
        const items = payload.items as GuardianThreadView[];
        for (const post of items.flatMap((thread) => thread.posts)) {
          if (post.from === 'staff' && post.new_to_me) newThisVisit.current.add(post.post_id);
        }
        setRead({ state: 'loaded', items, newIds: new Set(newThisVisit.current) });
      } catch {
        if (mine === seq.current) setRead((held) => (held.state === 'loaded' ? held : { state: 'failed' }));
      }
    })();
  }, [attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const markSeen = useCallback((postId: string) => {
    setSeen((held) => (held.has(postId) ? held : new Set([...held, postId])));
  }, []);

  let unseenByChild: Map<string, number> | null = null;
  if (read.state === 'loaded') {
    unseenByChild = new Map();
    for (const thread of read.items) {
      for (const post of thread.posts) {
        if (post.from === 'staff' && post.new_to_me && !seen.has(post.post_id)) {
          unseenByChild.set(thread.athlete_id, (unseenByChild.get(thread.athlete_id) ?? 0) + 1);
        }
      }
    }
  }
  return { read, reload, seen, markSeen, unseenByChild };
}

function when(at: string): string {
  return formatGymDateTimeShort(at) ?? at;
}

export default function ParentFamilyThreads({
  threads,
  childNames,
  activeChildId,
}: Readonly<{
  threads: ParentFamilyThreadsState;
  /** The guardian's children, id to name, from the hub's roster. */
  childNames: ReadonlyMap<string, string>;
  activeChildId: string | null;
}>) {
  const { read, reload, markSeen } = threads;
  // Drafts and sends are keyed: '' for a new message (about the chosen child), else the thread id.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const listRef = useRef<HTMLDivElement>(null);
  // Reads sent on this visit; a failed write leaves the set, so the next read watches it again.
  const sentRef = useRef<Set<string>>(new Set());

  /* SEEING A REPLY FROM THE GYM: at least half of it on screen, or, for one
     taller than the screen, half the screen filled with it. */
  useEffect(() => {
    if (read.state !== 'loaded' || !listRef.current || typeof IntersectionObserver === 'undefined') return;
    const sent = sentRef.current;
    const unseen = new Set(
      read.items.flatMap((thread) => thread.posts)
        .filter((post) => post.from === 'staff' && post.new_to_me && !sent.has(post.post_id))
        .map((post) => post.post_id),
    );
    if (unseen.size === 0) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const fillsHalfTheScreen = entry.rootBounds !== null
          && entry.intersectionRect.height >= 0.5 * entry.rootBounds.height;
        if (!entry.isIntersecting || (entry.intersectionRatio < 0.5 && !fillsHalfTheScreen)) continue;
        const postId = (entry.target as HTMLElement).dataset.readPost;
        if (!postId || sent.has(postId)) continue;
        sent.add(postId);
        observer.unobserve(entry.target);
        // Not watched again at once: a refusal would only come back again, in a loop.
        const failed = () => {
          sent.delete(postId);
        };
        void fetch(`${apiBase()}/api/pilot/parent/family-thread-reads`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ post_id: postId }),
        })
          .then((response) => {
            if (response.ok) markSeen(postId);
            else failed();
          })
          .catch(failed);
      }
    // Every 1%: a tall reply changes its visible share only a little as it scrolls.
    }, { threshold: Array.from({ length: 101 }, (_, step) => step / 100) });
    listRef.current.querySelectorAll<HTMLElement>('[data-read-post]').forEach((element) => {
      if (unseen.has(element.dataset.readPost ?? '')) observer.observe(element);
    });
    return () => observer.disconnect();
  }, [read, markSeen]);

  async function send(key: string, body: { athlete_id: string } | { thread_id: string }) {
    const text = (drafts[key] ?? '').trim();
    if (!text) {
      setNotes((held) => ({ ...held, [key]: 'Write a message before sending.' }));
      return;
    }
    setSending((held) => ({ ...held, [key]: true }));
    setNotes((held) => ({ ...held, [key]: '' }));
    try {
      const response = await fetch(`${apiBase()}/api/pilot/parent/family-threads`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, text }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: unknown };
        // The server's own words only for a refusal of this request (4xx), never a server fault.
        const reason = response.status < 500 && typeof payload.error === 'string' ? ` ${payload.error}` : '';
        setNotes((held) => ({ ...held, [key]: `Not sent; your words are still in the box.${reason}` }));
        return;
      }
      setDrafts((held) => ({ ...held, [key]: '' }));
      setNotes((held) => ({ ...held, [key]: 'Sent. The coach’s reply will show under it.' }));
      reload();
    } catch {
      setNotes((held) => ({ ...held, [key]: 'Not sent; your words are still in the box. Check the connection and send again.' }));
    } finally {
      setSending((held) => ({ ...held, [key]: false }));
    }
  }

  const activeName = activeChildId ? childNames.get(activeChildId) ?? 'your child' : null;
  const nameOf = (athleteId: string) => childNames.get(athleteId) ?? 'Your child';

  return (
    <section className="mat-paper rounded-[var(--r-md)] p-[var(--s4)]" aria-label="Write to the coach">
      <h3 className="t-command text-[length:var(--t-lg)]">Write to the coach</h3>
      <p className="t-muted mt-[var(--s1)]">
        Only you and the gym&apos;s staff see what you write here, and the replies.
      </p>
      {activeChildId ? (
        <form
          className="mt-[var(--s3)] space-y-[var(--s2)]"
          onSubmit={(event) => {
            event.preventDefault();
            void send('', { athlete_id: activeChildId });
          }}
        >
          <label className="field block">
            <span className="t-label">Your message about {activeName}</span>
            <textarea
              value={drafts[''] ?? ''}
              onChange={(event) => setDrafts((held) => ({ ...held, '': event.target.value }))}
              maxLength={2000}
              className="textarea min-h-[56px]"
            />
          </label>
          <button type="submit" className="btn btn--ghost" disabled={sending['']}>
            {sending[''] ? 'Sending…' : 'Send to the coach'}
          </button>
          {notes[''] ? <p role="status" className="t-body">{notes['']}</p> : null}
        </form>
      ) : (
        <p className="t-body mt-[var(--s3)]">Choose your child above to write to the coach.</p>
      )}

      <div ref={listRef} className="mt-[var(--s4)]">
        <h4 className="t-label">Your messages to the coach</h4>
        {read.state === 'loading' ? (
          <p className="working mt-[var(--s2)]">Reading your messages to the coach</p>
        ) : read.state === 'failed' ? (
          <div role="alert" className="mt-[var(--s2)]">
            <p className="t-body">
              Your messages to the coach could not be loaded. This is not a statement that you have written none.
            </p>
            <button type="button" className="btn btn--ghost mt-[var(--s2)]" onClick={reload}>
              Check for your messages again
            </button>
          </div>
        ) : read.items.length === 0 ? (
          <p className="t-muted mt-[var(--s2)]">You have not written to the coach yet.</p>
        ) : (
          <ul aria-label="Your messages to the coach" className="mt-[var(--s2)] space-y-[var(--s3)]">
            {read.items.map((thread) => (
              <li key={thread.thread_id} className="rounded-[var(--r-md)] border border-[color:rgba(0,0,0,.14)] p-[var(--s3)]">
                <p className="t-body font-semibold">
                  About {nameOf(thread.athlete_id)}
                  <span className="t-muted font-normal"> · started {when(thread.created_at)}</span>
                </p>
                <ul aria-label={`Your message about ${nameOf(thread.athlete_id)}`} className="mt-[var(--s2)] space-y-[var(--s2)]">
                  {thread.posts.map((post) => (
                    <li key={post.post_id} data-read-post={post.from === 'staff' ? post.post_id : undefined}>
                      <p className="t-label">
                        {post.from === 'you' ? 'You' : post.staff_name ?? 'The gym'}
                        <span className="t-muted"> · {when(post.created_at)}</span>
                        {post.from === 'staff' && read.newIds.has(post.post_id) ? (
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
                    void send(thread.thread_id, { thread_id: thread.thread_id });
                  }}
                >
                  <label className="field block">
                    <span className="t-label">Write again about {nameOf(thread.athlete_id)}</span>
                    <span className="sr-only"> (message started {when(thread.created_at)})</span>
                    <textarea
                      value={drafts[thread.thread_id] ?? ''}
                      onChange={(event) => setDrafts((held) => ({ ...held, [thread.thread_id]: event.target.value }))}
                      maxLength={2000}
                      className="textarea min-h-[56px]"
                    />
                  </label>
                  <button
                    type="submit"
                    className="btn btn--ghost"
                    disabled={sending[thread.thread_id]}
                    aria-label={`${sending[thread.thread_id] ? 'Sending' : 'Send'} again about ${nameOf(thread.athlete_id)} (message started ${when(thread.created_at)})`}
                  >
                    {sending[thread.thread_id] ? 'Sending…' : 'Send'}
                  </button>
                  {notes[thread.thread_id] ? <p role="status" className="t-body">{notes[thread.thread_id]}</p> : null}
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
