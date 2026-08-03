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

const LIFECYCLE_TONE: Record<AnnouncementLifecycle, string> = {
  live: 'border-[color:var(--cleared)] bg-[color-mix(in_srgb,var(--cleared)_14%,transparent)]',
  scheduled: 'border-[color:var(--restricted)] bg-[color-mix(in_srgb,var(--restricted)_14%,transparent)]',
  expired: 'border-[color:rgba(107,78,18,.28)] mat-paper',
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
    <main className="on-canvas min-h-screen">
      <div className="mx-auto w-full max-w-6xl px-6 py-10 lg:px-10">
        <header className="space-y-3 border-b-[3px] border-[color:rgba(107,78,18,.28)] pb-6">
          <p className="text-xs font-mono uppercase tracking-[0.18em] text-[color:var(--brass-800)]">Gym Communications</p>
          <h1 className="font-display text-4xl font-black">Notices and Motivation</h1>
          <p className="max-w-4xl text-sm leading-6 text-[color:var(--hide-800)]">
            Coaches and admins write what the app says. Pick the surface it belongs on, give it a window if it should
            only run for a while, and retire it when it is done.
          </p>
          {loadError ? (
            /* Law 3: the failed load carries a glyph and an uppercase label,
               not the safety red alone. */
            <div role="alert" className="flex flex-wrap items-center gap-[var(--s3)]">
              <span className="badge badge--locked">
                <i>✕</i>Load failed
              </span>
              <p className="text-sm text-[color:var(--hide-950)]">{loadError}</p>
            </div>
          ) : null}
        </header>

        <section className="mt-[var(--s5)] space-y-[var(--s3)] mat-paper rounded-[var(--r-md)] border border-[color:rgba(107,78,18,.28)] p-[var(--s4)]">
          <h2 className="text-lg font-bold">Live Right Now</h2>
          <div className="grid gap-3 md:grid-cols-3">
            {liveByPlacement.map((group) => (
              <article key={group.placement} className="border border-[color:rgba(107,78,18,.28)] rounded-[var(--r-md)] mat-paper p-3">
                <p className="text-xs font-mono uppercase tracking-[0.12em] text-[color:var(--brass-800)]">
                  {PLACEMENT_LABELS[group.placement]}
                </p>
                {group.items.length === 0 ? (
                  <p className="mt-2 text-sm leading-6 text-[color:var(--hide-800)]">Nothing live. This surface shows no banner.</p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {group.items.map((item) => (
                      <li key={item.announcement_id} className="text-sm leading-6 text-[color:var(--hide-800)]">
                        <span className="font-mono text-[length:var(--t-xs)] uppercase tracking-[0.12em] text-[color:var(--hide-950)]">
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

        <section className="mt-6 grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-[var(--s3)] mat-paper rounded-[var(--r-md)] border border-[color:rgba(107,78,18,.28)] p-[var(--s4)]">
            <h2 className="text-lg font-bold">Write</h2>
            <textarea
              value={draft.message}
              onChange={(event) => setDraft((current) => ({ ...current, message: event.target.value }))}
              placeholder="What should this surface say?"
              className="textarea min-h-[89px]"
            />
            <div className="grid gap-3 md:grid-cols-2">
              <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-[color:var(--hide-800)]">
                Placement
                <select
                  value={draft.placement}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, placement: event.target.value as AnnouncementPlacement }))
                  }
                  className="input"
                >
                  {ANNOUNCEMENT_PLACEMENTS.map((placement) => (
                    <option key={placement} value={placement}>
                      {PLACEMENT_LABELS[placement]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-[color:var(--hide-800)]">
                Kind
                <select
                  value={draft.kind}
                  onChange={(event) => setDraft((current) => ({ ...current, kind: event.target.value as AnnouncementKind }))}
                  className="input"
                >
                  {ANNOUNCEMENT_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {KIND_LABELS[kind]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-[color:var(--hide-800)]">
                Starts (optional)
                <input
                  type="datetime-local"
                  value={draft.starts_at}
                  onChange={(event) => setDraft((current) => ({ ...current, starts_at: event.target.value }))}
                  className="input"
                />
              </label>
              <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-[color:var(--hide-800)]">
                Ends (optional)
                <input
                  type="datetime-local"
                  value={draft.ends_at}
                  onChange={(event) => setDraft((current) => ({ ...current, ends_at: event.target.value }))}
                  className="input"
                />
              </label>
            </div>
            <input
              value={authorName}
              onChange={(event) => setAuthorName(event.target.value)}
              placeholder="Your name, as members will see it"
              className="input"
            />
            {session.role === 'board' ? (
              <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-[color:var(--hide-800)]">
                Board seat
                <select
                  value={boardSeat}
                  onChange={(event) => setBoardSeat(event.target.value)}
                  className="input"
                >
                  {BOARD_SEATS.map((seat) => (
                    <option key={seat} value={seat}>
                      {seat}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {windowIsBackwards ? (
              <p className="text-sm text-[color:var(--brass-800)]">The end time must be after the start time.</p>
            ) : null}
            <button
              type="button"
              disabled={isPublishing || !canPublish}
              onClick={() => void publish().catch((error) => setMessage(error instanceof Error ? error.message : 'Unable to publish.'))}
              className="h-11 border border-[color:rgba(107,78,18,.28)] rounded-[var(--r-md)] bg-[var(--accent-strong)] px-4 text-sm font-black uppercase tracking-[0.12em] text-[color:var(--accent-ink)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPublishing ? 'Publishing...' : 'Publish'}
            </button>
            {message ? <p className="text-sm font-semibold text-[color:var(--brass-800)]">{message}</p> : null}
          </div>

          <div className="space-y-[var(--s3)] mat-paper rounded-[var(--r-md)] border border-[color:rgba(107,78,18,.28)] p-[var(--s4)]">
            <h2 className="text-lg font-bold">Preview</h2>
            <p className="text-sm leading-6 text-[color:var(--hide-800)]">
              How it will read on {PLACEMENT_LABELS[draft.placement]}, and when it will be there.
            </p>
            <p className={`inline-block border-2 px-2 py-1 text-[length:var(--t-xs)] font-mono font-bold uppercase ${LIFECYCLE_TONE[draftLifecycle]}`}>
              {LIFECYCLE_LABELS[draftLifecycle]} - {describeWindow(draftStartsAt, draftEndsAt)}
            </p>
            {/* The preview renders on paper, one of the five materials — the
                bg-white card it used to be is not (Law 6) — and its radius
                comes off the Fibonacci scale. */}
            <article className="mat-paper rounded-[var(--r-md)] border border-[color:rgba(0,0,0,0.12)] px-4 py-3">
              <p className="text-sm leading-6 text-[color:var(--hide-950)]">
                {draft.message.trim() || 'Nothing written yet, so this surface would render no banner at all.'}
              </p>
              {draft.kind === 'notice' && draft.message.trim() ? (
                <p className="mt-2 text-[length:var(--t-xs)] font-mono uppercase tracking-[0.08em] text-[color:var(--hide-600)]">
                  By {authorName.trim() || 'your name'} - just now
                </p>
              ) : null}
            </article>
          </div>
        </section>

        <section className="mt-[var(--s5)] space-y-[var(--s3)] mat-paper rounded-[var(--r-md)] border border-[color:rgba(107,78,18,.28)] p-[var(--s4)]">
          <h2 className="text-lg font-bold">Everything Posted</h2>
          {items.length === 0 && !loadError ? (
            <p className="text-sm leading-6 text-[color:var(--hide-800)]">Nothing has been posted for this gym yet.</p>
          ) : null}
          <div className="grid gap-3">
            {items.map((item) => {
              const lifecycle = announcementLifecycle(item);
              return (
                <article key={item.announcement_id} className="grid gap-3 border border-[color:rgba(107,78,18,.28)] rounded-[var(--r-md)] mat-paper p-4 md:grid-cols-[1fr_auto] md:items-start">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`border-2 px-2 py-0.5 text-[length:var(--t-xs)] font-mono font-bold uppercase ${LIFECYCLE_TONE[lifecycle]}`}>
                        {LIFECYCLE_LABELS[lifecycle]}
                      </span>
                      <span className="text-xs font-mono uppercase tracking-[0.12em] text-[color:var(--brass-800)]">
                        {PLACEMENT_LABELS[item.placement]}
                      </span>
                      <span className="text-xs font-mono uppercase tracking-[0.12em] text-[color:var(--hide-800)]">
                        {KIND_LABELS[item.kind]}
                      </span>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-[color:var(--hide-950)]">{item.message}</p>
                    <p className="mt-2 text-[length:var(--t-xs)] font-mono uppercase tracking-[0.08em] text-[color:var(--hide-600)]">
                      By {item.author_name} ({item.author_role}) - {formatAnnouncementTime(item.created_at)} -{' '}
                      {describeWindow(item.starts_at, item.ends_at)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void setActive(item.announcement_id, !item.active)}
                    className="btn btn--ghost"
                  >
                    {item.active ? 'Retire' : 'Restore'}
                  </button>
                </article>
              );
            })}
          </div>
        </section>

        <div className="mt-8">
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
