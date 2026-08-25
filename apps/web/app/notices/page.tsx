'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import {
  ANNOUNCEMENT_KINDS,
  ANNOUNCEMENT_PLACEMENTS,
  KIND_LABELS,
  LIFECYCLE_LABELS,
  PLACEMENT_LABELS,
  announcementLifecycle,
  announcementReachesPlacement,
  formatAnnouncementTime,
  type AnnouncementItem,
  type AnnouncementKind,
  type AnnouncementLifecycle,
  type AnnouncementPlacement,
} from '@/components/AnnouncementBanner';
import { roleRoutes } from '@/components/roleRoutes';
import { usePilotSession } from '@/components/usePilotSession';
import { apiBase } from '@/lib/apiBase';

const BOARD_SEATS = [
  'board-president',
  'board-chair',
  'board-vice-chair',
  'board-treasurer',
  'board-secretary',
  'board-safety-director',
  'board-community-director',
  'board-at-large',
] as const;

/**
 * A seat reads as the seat, not as its slug.
 *
 * `board-safety-director` is what /api/pilot/announcements/post stores in
 * author_role and what it keeps storing -- the value is unchanged, only the
 * word a person reads. roleRoutes already carries a label for all eight seats
 * and for coach and admin besides, so this reuses that vocabulary instead of
 * spelling out a second one that can drift from it. Anything roleRoutes has no
 * label for falls back to the raw value rather than to a blank.
 */
function boardSeatLabel(role: string): string {
  return roleRoutes.find((route) => route.role === role)?.label ?? role;
}

const LIFECYCLE_TONE: Record<AnnouncementLifecycle, string> = {
  live: 'border-[color:var(--cleared)] bg-[color-mix(in_srgb,var(--cleared)_14%,transparent)]',
  scheduled: 'border-[color:var(--restricted)] bg-[color-mix(in_srgb,var(--restricted)_14%,transparent)]',
  expired: 'border-[color:rgb(var(--brass-800-rgb)_/_.28)] mat-paper',
  retired: 'border-[color:var(--brass-600)] bg-[color-mix(in_srgb,var(--brass-600)_12%,transparent)]',
};

const EMPTY_DRAFT = {
  message: '',
  placement: 'gym_notices' as AnnouncementPlacement,
  kind: 'notice' as AnnouncementKind,
  starts_at: '',
  ends_at: '',
};

// A datetime-local field carries no offset, so it is converted against the
// author's own clock here. What is stored and compared is the absolute
// instant, not the wall-clock string.
function localInputToIso(value: string): string | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function describeWindow(startsAt: string | null, endsAt: string | null): string {
  if (!startsAt && !endsAt) {
    return 'Always on';
  }
  if (startsAt && !endsAt) {
    return `From ${formatAnnouncementTime(startsAt)}`;
  }
  if (!startsAt && endsAt) {
    return `Until ${formatAnnouncementTime(endsAt)}`;
  }
  return `${formatAnnouncementTime(startsAt as string)} to ${formatAnnouncementTime(endsAt as string)}`;
}

function NoticesAuthoringPage() {
  const session = usePilotSession();
  const [items, setItems] = useState<AnnouncementItem[]>([]);
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState('');
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [authorName, setAuthorName] = useState('');
  const [boardSeat, setBoardSeat] = useState<string>(BOARD_SEATS[0]);
  const [isPublishing, setIsPublishing] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const publishingRef = useRef(false);
  // The empty board's invite has to land on THIS page: an empty state that only
  // points somewhere else is not a front desk.
  const messageRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/announcements/get`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ view: 'authoring', limit: 25 }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error('Unable to load notices. Nothing below is the full list.');
        }

        const payload = (await response.json()) as { announcements?: AnnouncementItem[] };
        setItems(payload.announcements ?? []);
        setLoadError('');
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return;
        }
        setItems([]);
        setLoadError(error instanceof Error ? error.message : 'Unable to load notices.');
      }
    })();

    return () => controller.abort();
  }, [reloadNonce]);

  const liveByPlacement = useMemo(
    () =>
      ANNOUNCEMENT_PLACEMENTS.filter((placement) => placement !== 'everywhere').map((placement) => ({
        placement,
        items: items.filter(
          (item) => announcementLifecycle(item) === 'live' && announcementReachesPlacement(item, placement),
        ),
      })),
    [items],
  );

  const draftStartsAt = localInputToIso(draft.starts_at);
  const draftEndsAt = localInputToIso(draft.ends_at);
  const windowIsBackwards = Boolean(
    draftStartsAt && draftEndsAt && Date.parse(draftEndsAt) <= Date.parse(draftStartsAt),
  );
  const draftLifecycle = announcementLifecycle({
    announcement_id: 'draft',
    message: draft.message,
    author_name: authorName,
    author_role: '',
    created_at: new Date().toISOString(),
    placement: draft.placement,
    kind: draft.kind,
    active: true,
    starts_at: draftStartsAt,
    ends_at: draftEndsAt,
  });

  async function publish() {
    if (publishingRef.current) {
      return;
    }

    publishingRef.current = true;
    setIsPublishing(true);

    try {
      const response = await fetch(`${apiBase()}/api/pilot/announcements/post`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: draft.message.trim(),
          author_name: authorName.trim(),
          author_role: session.role === 'board' ? boardSeat : '',
          placement: draft.placement,
          kind: draft.kind,
          starts_at: draftStartsAt,
          ends_at: draftEndsAt,
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || 'Unable to publish.');
      }

      setDraft(EMPTY_DRAFT);
      setMessage(draftLifecycle === 'scheduled' ? 'Scheduled. It goes live at its start time.' : 'Published.');
      setReloadNonce((value) => value + 1);
    } finally {
      publishingRef.current = false;
      setIsPublishing(false);
    }
  }

  async function setActive(announcementId: string, active: boolean) {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/announcements/update`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ announcement_id: announcementId, active }),
      });

      const payload = (await response.json().catch(() => ({}))) as { error?: string; announcement?: AnnouncementItem };
      if (!response.ok || !payload.announcement) {
        throw new Error(payload.error || 'Unable to change this item.');
      }

      const updated = payload.announcement;
      setItems((current) =>
        current.map((item) => (item.announcement_id === updated.announcement_id ? updated : item)),
      );
      setMessage(active ? 'Restored.' : 'Retired. It no longer renders anywhere.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to change this item.');
    }
  }

  const canPublish = draft.message.trim().length > 0 && authorName.trim().length > 0 && !windowIsBackwards;

  return (
    /* FRONT OFFICE, and this page is named in the room's own Purpose line --
       "notices" -- with "Notice banners" under its Allowed chrome. The room's
       definition pointed here and the page had no room.

       It stood on .on-canvas, the family ground, while being gated to admin,
       coach, platform_owner and board. What kept it there was the ink: the
       header hard-coded --hide-800 and --hide-950, which are #2A1F18 and
       #14100D -- correct on cream, invisible on a plank wall. Converting that
       ink is the work; the class on this line is the last part of it.

       The class is the PAIR. `.room` carries the light (.room::before) and the
       plate (.room::after); `.room--office` only DECLARES the --plate the
       ::after consumes, so the modifier alone is a texture with no lamp and no
       plate -- defect #498. And no descendant below may state a full-viewport
       background: unlayered .room--office beats a layered bg-[...] on the SAME
       element, but a child painting `min-h-screen bg-[...]` covers wall, light
       and plate together. The container below states width and padding only. */
    <main className="room room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <div className="mx-auto w-full max-w-6xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
        <header className="relative space-y-[var(--s3)] border-b-4 border-[color:var(--brass-700)] pb-[var(--s5)] pt-[var(--s5)]">
          {/* The desk lamp over the notice desk. .lamp draws the shade and the
              pool of light under it -- the office's own fixture, hung the way
              /admin and /admin/people hang theirs. */}
          <span className="lamp" aria-hidden="true" style={{ left: '50%', translate: '-50% 0' }} />
          <p className="t-eyebrow">Gym Communications</p>
          <h1 className="t-command" style={{ fontSize: 'var(--t-xl)' }}>Notices and Motivation</h1>
          <p className="t-body max-w-[68ch]">
            Coaches and admins write what the app says. Pick the surface it belongs on, give it a window if it should
            only run for a while, and retire it when it is done.
          </p>
          {loadError ? (
            /* Law 3: the failed load carries a glyph and an uppercase label,
               not the safety red alone. */
            <div role="alert" className="flex flex-wrap items-center gap-[var(--s3)]">
              <span className="badge badge--locked">
                <i aria-hidden="true">✕</i>Load failed
              </span>
              <p className="t-body">{loadError}</p>
            </div>
          ) : null}
        </header>

        {/* Paper, on the plank wall. "Paper forms" is this room's Feel line and
            .mat-paper restates .t-eyebrow, .t-command, .t-body and .t-label for
            a light ground, which is why not one ink below is stated inline. */}
        <section className="mat-paper pap mt-[var(--s5)] space-y-[var(--s3)] rounded-[var(--r-lg)] p-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Live Right Now</h2>
          <div className="grid gap-[var(--s3)] md:grid-cols-3">
            {liveByPlacement.map((group) => (
              <article key={group.placement} className="mat-paper rounded-[var(--r-md)] border border-[color:rgba(51,41,27,.26)] p-[var(--s4)]">
                <p className="t-eyebrow">{PLACEMENT_LABELS[group.placement]}</p>
                {group.items.length === 0 ? (
                  <p className="t-body mt-[var(--s2)]">Nothing live. This surface shows no banner.</p>
                ) : (
                  <ul className="mt-[var(--s2)] space-y-[var(--s2)]">
                    {group.items.map((item) => (
                      <li key={item.announcement_id} className="t-body">
                        <span className="t-label">
                          {KIND_LABELS[item.kind]}
                        </span>{' '}
                        {item.message}
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            ))}
          </div>
        </section>

        <section className="mt-[var(--s5)] grid gap-[var(--s5)] xl:grid-cols-[1.1fr_0.9fr]">
          <div className="mat-paper pap space-y-[var(--s3)] rounded-[var(--r-lg)] p-[var(--s5)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Write</h2>
            <textarea
              ref={messageRef}
              value={draft.message}
              onChange={(event) => setDraft((current) => ({ ...current, message: event.target.value }))}
              placeholder="What should this surface say?"
              className="textarea min-h-[89px]"
            />
            <div className="grid gap-[var(--s3)] md:grid-cols-2">
              <div className="field">
                <label className="t-label" htmlFor="notice-placement">Placement</label>
                <select
                  id="notice-placement"
                  value={draft.placement}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, placement: event.target.value as AnnouncementPlacement }))
                  }
                  className="select"
                >
                  {ANNOUNCEMENT_PLACEMENTS.map((placement) => (
                    <option key={placement} value={placement}>
                      {PLACEMENT_LABELS[placement]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="t-label" htmlFor="notice-kind">Kind</label>
                <select
                  id="notice-kind"
                  value={draft.kind}
                  onChange={(event) => setDraft((current) => ({ ...current, kind: event.target.value as AnnouncementKind }))}
                  className="select"
                >
                  {ANNOUNCEMENT_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {KIND_LABELS[kind]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid gap-[var(--s3)] md:grid-cols-2">
              <div className="field">
                <label className="t-label" htmlFor="notice-starts">Starts (optional)</label>
                <input
                  id="notice-starts"
                  type="datetime-local"
                  value={draft.starts_at}
                  onChange={(event) => setDraft((current) => ({ ...current, starts_at: event.target.value }))}
                  className="input"
                />
              </div>
              <div className="field">
                <label className="t-label" htmlFor="notice-ends">Ends (optional)</label>
                <input
                  id="notice-ends"
                  type="datetime-local"
                  value={draft.ends_at}
                  onChange={(event) => setDraft((current) => ({ ...current, ends_at: event.target.value }))}
                  className="input"
                />
              </div>
            </div>
            <div className="field">
              <label className="t-label" htmlFor="notice-author">Your name</label>
              <input
                id="notice-author"
                value={authorName}
                onChange={(event) => setAuthorName(event.target.value)}
                placeholder="Your name, as members will see it"
                className="input"
              />
            </div>
            {session.role === 'board' ? (
              <div className="field">
                <label className="t-label" htmlFor="notice-seat">Board seat</label>
                <select
                  id="notice-seat"
                  value={boardSeat}
                  onChange={(event) => setBoardSeat(event.target.value)}
                  className="select"
                >
                  {/* The stored value stays the seat slug the announcements
                      route accepts; only what the person reads changes, and it
                      changes to the label roleRoutes already gives that seat
                      rather than to a new spelling invented here. */}
                  {BOARD_SEATS.map((seat) => (
                    <option key={seat} value={seat}>
                      {boardSeatLabel(seat)}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {/* Outcomes inside a paper panel are a badge and a line of prose,
                never .alert: every .alert--* rule pins `color: var(--bone-100)`
                and the sheet restates it for .on-canvas only, so an alert on
                .mat-paper is bone on cream. A badge carries its own dark chip
                and its own ink and reads on any ground -- the same move #514
                made for the needs-review cell. */}
            {windowIsBackwards ? (
              <div role="alert" className="flex flex-wrap items-center gap-[var(--s3)]">
                <span className="badge badge--restricted"><i aria-hidden="true">!</i>Check the window</span>
                <p className="t-body">The end time must be after the start time.</p>
              </div>
            ) : null}
            <button
              type="button"
              disabled={isPublishing || !canPublish}
              onClick={() => void publish().catch((error) => setMessage(error instanceof Error ? error.message : 'Unable to publish.'))}
              className="btn w-full disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPublishing ? 'Publishing...' : 'Publish'}
            </button>
            {message ? (
              <div role="status" className="flex flex-wrap items-center gap-[var(--s3)]">
                <span className="badge badge--filed"><i aria-hidden="true">▣</i>Desk note</span>
                <p className="t-body">{message}</p>
              </div>
            ) : null}
          </div>

          <div className="mat-paper pap space-y-[var(--s3)] rounded-[var(--r-lg)] p-[var(--s5)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Preview</h2>
            <p className="t-body">
              How it will read on {PLACEMENT_LABELS[draft.placement]}, and when it will be there.
            </p>
            <p className={`inline-block border-2 px-2 py-1 text-[length:var(--t-xs)] font-mono font-bold uppercase ${LIFECYCLE_TONE[draftLifecycle]}`}>
              {LIFECYCLE_LABELS[draftLifecycle]} - {describeWindow(draftStartsAt, draftEndsAt)}
            </p>
            {/* The preview renders on paper, one of the five materials — the
                bg-white card it used to be is not (Law 6) — and its radius
                comes off the Fibonacci scale. */}
            <article className="mat-paper rounded-[var(--r-md)] border border-[color:rgba(51,41,27,.26)] px-[var(--s4)] py-[var(--s3)]">
              <p className="t-body">
                {draft.message.trim() || 'Nothing written yet, so this surface would render no banner at all.'}
              </p>
              {draft.kind === 'notice' && draft.message.trim() ? (
                <p className="t-label mt-[var(--s2)]">
                  By {authorName.trim() || 'your name'} - just now
                </p>
              ) : null}
            </article>
          </div>
        </section>

        <section className="mat-paper pap mt-[var(--s5)] space-y-[var(--s3)] rounded-[var(--r-lg)] p-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Everything Posted</h2>
          {items.length === 0 && !loadError ? (
            /* The room's own named empty state, with the invite the DNA names
               beside it. .pap on the panel so .empty takes its paper inks --
               the bone rungs it pins are authored against leather. The invite
               lands on THIS page: an empty board that only points somewhere
               else is not a front desk. */
            <div className="empty">
              <div className="empty-glyph" aria-hidden="true">▤</div>
              <div className="empty-title">Nothing on the board.</div>
              <p className="empty-msg">Nothing has been posted for this gym yet.</p>
              <div className="empty-action">
                <button type="button" className="btn" onClick={() => messageRef.current?.focus()}>
                  Write the first one
                </button>
              </div>
            </div>
          ) : null}
          {items.length > 0 ? (
            /* A register, not a stack of cards. Every row here is auditable --
               who said what, on which surface, and for how long -- which is the
               .ledger's whole brief: ruled paper, mono voice (Law 4). The
               author's stored role is a slug (`coach`, `board-secretary`), so
               it reads as its label and the slug goes to the mono "Filed under"
               column rather than being dropped. */
            <div className="overflow-x-auto">
              <table className="ledger">
                <caption className="text-left">Everything posted for this gym</caption>
                <thead>
                  <tr>
                    <th scope="col">Standing</th>
                    <th scope="col">Shows on</th>
                    <th scope="col">Kind</th>
                    <th scope="col">What it says</th>
                    <th scope="col">Written by</th>
                    <th scope="col">Runs</th>
                    <th scope="col">Filed under</th>
                    <th scope="col">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const lifecycle = announcementLifecycle(item);
                    return (
                      <tr key={item.announcement_id}>
                        <td>
                          <span className={`inline-block border-2 px-2 py-0.5 text-[length:var(--t-xs)] font-mono font-bold uppercase ${LIFECYCLE_TONE[lifecycle]}`}>
                            {LIFECYCLE_LABELS[lifecycle]}
                          </span>
                        </td>
                        <td>{PLACEMENT_LABELS[item.placement]}</td>
                        <td>{KIND_LABELS[item.kind]}</td>
                        <td className="font-bold">{item.message}</td>
                        <td className="whitespace-nowrap">
                          {item.author_name}
                          {item.author_role ? (
                            <span className="ledger-id"> · {boardSeatLabel(item.author_role)}</span>
                          ) : null}
                        </td>
                        <td>{describeWindow(item.starts_at, item.ends_at)}</td>
                        <td className="ledger-id whitespace-nowrap">
                          {[item.author_role, formatAnnouncementTime(item.created_at)].filter(Boolean).join(' · ')}
                        </td>
                        <td>
                          {/* .btn--ghost is bone on a translucent black wash,
                              tuned for leather; ppbf.css documents it as
                              grey-on-grey once it lands on a light ground. A
                              lever brings its own dark surface. */}
                          <button
                            type="button"
                            onClick={() => void setActive(item.announcement_id, !item.active)}
                            className="btn--lever"
                          >
                            {item.active ? 'Retire' : 'Restore'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>

        <div className="mt-[var(--s6)] flex flex-wrap gap-[var(--s3)]">
          {/* The two-second version of this page: the boards as they hang on
              the dashboards, one line each, writable in place. Same table, same
              endpoints, same rows -- see app/chalkboard/page.tsx. The link is
              here because a coach with something to say opens this page, and a
              route nobody can reach is a dead feature.

              These two stand on the WALL, not on paper, so ghost is the right
              secondary here and a lever would be the wrong one. */}
          <Link href="/chalkboard" className="btn btn--ghost">
            The boards, as they hang
          </Link>
          <Link
            href="/operations"
            className="btn btn--ghost"
          >
            Back to Mission Control
          </Link>
        </div>
      </div>
    </main>
  );
}

export default function NoticesPage() {
  return (
    <RoleSessionGate allowedRoles={['admin', 'coach', 'platform_owner', 'board']}>
      <NoticesAuthoringPage />
    </RoleSessionGate>
  );
}
