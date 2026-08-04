'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import type { RabbitHoleLessonItem } from '@/components/RabbitHole';
import {
  ANCHOR_KEY_OPTIONS,
  ANCHOR_TYPE_LABELS,
  AUTHORABLE_ANCHOR_TYPES,
  RABBIT_HOLE_AUDIENCE_OPTIONS,
  anchorLabel,
  audienceLabel,
  type AuthorableAnchorType,
} from '@/components/rabbitHoleAnchorLabels';
import { isOrganizationAdminSessionRole, usePilotSession } from '@/components/usePilotSession';
import { apiBase } from '@/lib/apiBase';

// The authoring view of one lesson: what a reader gets, plus the three fields
// only the people who write them need.
interface AuthoredLesson extends RabbitHoleLessonItem {
  anchor_type: string;
  anchor_key: string;
  audience: string;
  status: 'published' | 'retired';
  author_account_id: string | null;
  created_at: string;
  updated_at: string;
}

/* Law 3: publication state carries a glyph and an uppercase label. Published
   is a live queue outcome and rides the ladder; retired is inert, so it wears
   a neutral chip rather than a saturated rung. */
const STATUS_BADGES: Record<AuthoredLesson['status'], { className: string; glyph: string; label: string }> = {
  published: { className: 'badge badge--cleared', glyph: '✓', label: 'Published' },
  retired: {
    className:
      'inline-flex items-center gap-[var(--s2)] rounded-[var(--r-pill)] border border-[color:var(--hide-500)] bg-[rgba(0,0,0,.26)] px-[var(--s3)] py-[var(--s1)] font-mono text-[length:var(--t-xs)] font-bold uppercase tracking-[0.1em] text-[color:var(--bone-400)] [&_i]:not-italic',
    glyph: '◌',
    label: 'Retired',
  },
};

const EMPTY_DRAFT = {
  title: '',
  concept: '',
  homework: '',
  audience: 'all',
};

function formatWrittenTime(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }

  try {
    return new Date(parsed).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return value;
  }
}

async function readLessons(body: Record<string, unknown>, signal?: AbortSignal): Promise<AuthoredLesson[]> {
  const response = await fetch(`${apiBase()}/api/pilot/rabbit-holes/get`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ view: 'authoring', ...body }),
    signal,
  });

  if (!response.ok) {
    throw new Error('Unable to load rabbit holes. Nothing below is the full list.');
  }

  const payload = (await response.json()) as { rabbit_holes?: AuthoredLesson[] };
  return payload.rabbit_holes ?? [];
}

function RabbitHoleAuthoringPage() {
  const session = usePilotSession();
  const [anchorType, setAnchorType] = useState<AuthorableAnchorType>('gap_type');
  const [anchorKey, setAnchorKey] = useState<string>(ANCHOR_KEY_OPTIONS.gap_type[0].key);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [authorName, setAuthorName] = useState('');
  const [anchorLessons, setAnchorLessons] = useState<AuthoredLesson[]>([]);
  const [anchorLoadError, setAnchorLoadError] = useState('');
  const [allLessons, setAllLessons] = useState<AuthoredLesson[]>([]);
  const [loadError, setLoadError] = useState('');
  const [isPublishing, setIsPublishing] = useState(false);
  const [message, setMessage] = useState('');
  const [reloadNonce, setReloadNonce] = useState(0);
  const publishingRef = useRef(false);

  const keyOptions = ANCHOR_KEY_OPTIONS[anchorType];

  // What this gym has already written against the anchor being drafted. Two
  // coaches writing the same lesson twice is the failure this read exists to
  // stop, so it is scoped to the anchor rather than to the author.
  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const lessons = await readLessons(
          { anchor_type: anchorType, anchor_key: anchorKey },
          controller.signal,
        );
        setAnchorLessons(lessons);
        setAnchorLoadError('');
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return;
        }
        setAnchorLessons([]);
        setAnchorLoadError(
          error instanceof Error ? error.message : 'Unable to load what is already written here.',
        );
      }
    })();

    return () => controller.abort();
  }, [anchorType, anchorKey, reloadNonce]);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const lessons = await readLessons({ limit: 100 }, controller.signal);
        setAllLessons(lessons);
        setLoadError('');
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return;
        }
        setAllLessons([]);
        setLoadError(error instanceof Error ? error.message : 'Unable to load rabbit holes.');
      }
    })();

    return () => controller.abort();
  }, [reloadNonce]);

  // An administrator may take down anything their gym published; a coach may
  // change only what they wrote. The control is drawn on exactly that
  // boundary, so the surface never offers a button the server will refuse.
  const canManage = useMemo(() => {
    const isAdmin = isOrganizationAdminSessionRole(session.role);
    return (lesson: AuthoredLesson) =>
      isAdmin || (lesson.author_account_id !== null && lesson.author_account_id === session.accountId);
  }, [session.role, session.accountId]);

  const publishedHere = anchorLessons.filter((lesson) => lesson.status === 'published');
  const canPublish =
    draft.title.trim().length > 0 && draft.concept.trim().length > 0 && authorName.trim().length > 0;

  function selectAnchorType(value: string) {
    const nextType = value as AuthorableAnchorType;
    setAnchorType(nextType);
    setAnchorKey(ANCHOR_KEY_OPTIONS[nextType][0].key);
  }

  async function publish() {
    if (publishingRef.current) {
      return;
    }

    publishingRef.current = true;
    setIsPublishing(true);

    try {
      const response = await fetch(`${apiBase()}/api/pilot/rabbit-holes/post`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          anchor_type: anchorType,
          anchor_key: anchorKey,
          audience: draft.audience,
          title: draft.title.trim(),
          concept: draft.concept.trim(),
          homework: draft.homework.trim() || null,
          author_display_name: authorName.trim(),
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || 'Unable to publish.');
      }

      setDraft({ ...EMPTY_DRAFT, audience: draft.audience });
      setMessage('Published. It is on every surface that shows this anchor.');
      setReloadNonce((value) => value + 1);
    } finally {
      publishingRef.current = false;
      setIsPublishing(false);
    }
  }

  async function setStatus(rabbitHoleId: string, status: AuthoredLesson['status']) {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/rabbit-holes/update`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rabbit_hole_id: rabbitHoleId, status }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        rabbit_hole?: AuthoredLesson;
      };
      if (!response.ok || !payload.rabbit_hole) {
        throw new Error(payload.error || 'Unable to change this lesson.');
      }

      const updated = payload.rabbit_hole;
      const replace = (current: AuthoredLesson[]) =>
        current.map((lesson) => (lesson.rabbit_hole_id === updated.rabbit_hole_id ? updated : lesson));
      setAllLessons(replace);
      setAnchorLessons(replace);
      setMessage(
        status === 'retired'
          ? 'Retired. It no longer renders anywhere, and nothing was deleted.'
          : 'Published again.',
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to change this lesson.');
    }
  }

  return (
    /* Law 6: authoring is coach/admin work -- ink leather, the front-office
       desk, not the family canvas this page wore before. */
    <main className="room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <div className="mx-auto w-full max-w-[1200px] px-[var(--s5)] py-[var(--s6)]">
        <header className="border-b-2 border-[color:var(--brass-700)] pb-[var(--s5)]">
          <p className="t-eyebrow">Gym Coaching</p>
          <h1 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-2xl)' }}>
            Rabbit Holes
          </h1>
          <p className="t-body mt-[var(--s4)] max-w-[72ch]">
            A rabbit hole is a concept worth understanding and something to go and do with it. Pick the term it is
            about, write it, and it appears inside every card that already names that term.
          </p>
          {/* The claim this surface must never let an author make by accident.
              Evidence tiers mean retrieved and cited; this is a person writing. */}
          <p className="t-body mt-[var(--s3)] max-w-[72ch]">
            What you write here is the gym&apos;s own coaching, published under your name. It is not research, it
            carries no SHADOW evidence tier, and readers are told both.
          </p>
          {loadError ? (
            <div role="alert" className="mt-[var(--s4)]">
              <span className="badge badge--locked">
                <i>✕</i>Load Failed
              </span>
              <p className="t-body mt-[var(--s2)]">{loadError}</p>
            </div>
          ) : null}
        </header>

        <section className="mat-leather mt-[var(--s5)] space-y-[var(--s4)] rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>What Is It About?</h2>
          <p className="t-body">
            A lesson attaches to a term the platform already uses, never to a card. The card&apos;s wording can
            change; the term does not.
          </p>
          <div className="grid gap-[var(--s4)] md:grid-cols-2">
            <label className="field">
              <span className="t-label">Kind of term</span>
              <select
                value={anchorType}
                onChange={(event) => selectAnchorType(event.target.value)}
                className="select"
              >
                {AUTHORABLE_ANCHOR_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {ANCHOR_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="t-label">Term</span>
              <select
                value={anchorKey}
                onChange={(event) => setAnchorKey(event.target.value)}
                className="select"
              >
                {keyOptions.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
            <h3 className="t-label">Already Written For {anchorLabel(anchorType, anchorKey)}</h3>
            {anchorLoadError ? (
              <p className="t-body mt-[var(--s3)]">{anchorLoadError}</p>
            ) : publishedHere.length === 0 ? (
              <p className="t-muted mt-[var(--s3)]">
                Nothing is published against this term yet.
              </p>
            ) : (
              <ul className="mt-[var(--s3)] space-y-[var(--s3)]">
                {publishedHere.map((lesson) => (
                  <li key={lesson.rabbit_hole_id} className="t-body">
                    <span className="font-semibold text-[color:var(--bone-100)]">{lesson.title}</span> - by{' '}
                    {lesson.author_display_name}, for {audienceLabel(lesson.audience)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="mat-leather mt-[var(--s5)] space-y-[var(--s4)] rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Write</h2>
          <label className="field">
            <span className="t-label">Title of the lesson</span>
            <input
              value={draft.title}
              onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
              placeholder="Title of the lesson"
              className="input"
            />
          </label>
          <label className="field">
            <span className="t-label">Concept</span>
            <textarea
              value={draft.concept}
              onChange={(event) => setDraft((current) => ({ ...current, concept: event.target.value }))}
              placeholder="Concept - why this works the way it does"
              className="textarea h-[144px]"
            />
          </label>
          <label className="field">
            <span className="t-label">Homework (optional)</span>
            <textarea
              value={draft.homework}
              onChange={(event) => setDraft((current) => ({ ...current, homework: event.target.value }))}
              placeholder="Homework (optional) - something to go and do with it"
              className="textarea h-[89px]"
            />
          </label>
          <div className="grid gap-[var(--s4)] md:grid-cols-2">
            <label className="field">
              <span className="t-label">Who reads it</span>
              <select
                value={draft.audience}
                onChange={(event) => setDraft((current) => ({ ...current, audience: event.target.value }))}
                className="select"
              >
                {RABBIT_HOLE_AUDIENCE_OPTIONS.map((audience) => (
                  <option key={audience} value={audience}>
                    {audienceLabel(audience)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="t-label">Your name, as readers will see it</span>
              <input
                value={authorName}
                onChange={(event) => setAuthorName(event.target.value)}
                placeholder="Your name, as readers will see it"
                className="input"
              />
            </label>
          </div>
          <button
            type="button"
            disabled={isPublishing || !canPublish}
            onClick={() =>
              void publish().catch((error) =>
                setMessage(error instanceof Error ? error.message : 'Unable to publish.'),
              )
            }
            className="btn disabled:cursor-not-allowed disabled:opacity-60 disabled:grayscale"
          >
            {isPublishing ? 'Publishing...' : 'Publish'}
          </button>
          {message ? <p role="status" className="t-body font-semibold text-[color:var(--brass-300)]">{message}</p> : null}
        </section>

        <section className="mat-leather mt-[var(--s5)] space-y-[var(--s4)] rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Everything This Gym Has Written</h2>
          {allLessons.length === 0 && !loadError ? (
            <p className="t-muted">
              No rabbit holes have been written for this gym yet.
            </p>
          ) : null}
          <div className="grid gap-[var(--s4)]">
            {allLessons.map((lesson) => {
              const statusBadge = STATUS_BADGES[lesson.status];
              return (
                <article
                  key={lesson.rabbit_hole_id}
                  className="mat-leather--raised grid gap-[var(--s4)] rounded-[var(--r-md)] p-[var(--s5)] md:grid-cols-[1fr_auto] md:items-start"
                >
                  <div>
                    <div className="flex flex-wrap items-center gap-[var(--s3)]">
                      <span className={statusBadge.className}>
                        <i>{statusBadge.glyph}</i>
                        {statusBadge.label}
                      </span>
                      <span className="t-eyebrow">
                        {anchorLabel(lesson.anchor_type, lesson.anchor_key)}
                      </span>
                      <span className="t-label">
                        {audienceLabel(lesson.audience)}
                      </span>
                    </div>
                    <p className="t-body mt-[var(--s3)] font-semibold text-[color:var(--bone-100)]">{lesson.title}</p>
                    <p className="t-body mt-[var(--s2)]">{lesson.concept}</p>
                    {lesson.homework ? (
                      <p className="t-body mt-[var(--s3)] border-l-2 border-[color:var(--brass-600)] pl-[var(--s3)]">
                        Homework: {lesson.homework}
                      </p>
                    ) : null}
                    {/* Law 4: authorship and time are the record -- mono voice. */}
                    <p className="t-data mt-[var(--s3)] text-[color:var(--bone-400)]">
                      By {lesson.author_display_name} - {formatWrittenTime(lesson.created_at)}
                    </p>
                  </div>
                  {canManage(lesson) ? (
                    <button
                      type="button"
                      onClick={() =>
                        void setStatus(lesson.rabbit_hole_id, lesson.status === 'published' ? 'retired' : 'published')
                      }
                      className="btn btn--ghost"
                    >
                      {lesson.status === 'published' ? 'Retire' : 'Restore'}
                    </button>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>

        <div className="mt-[var(--s6)]">
          <Link href="/coach/progression-intelligence" className="btn btn--ghost">
            Back to Progression Intelligence
          </Link>
        </div>
      </div>
    </main>
  );
}

export default function RabbitHolesPage() {
  // Coaches and organization administrators, matching
  // assertCanAuthorRabbitHoles. Neither the platform owner nor the board may
  // write one: a lesson speaks to the gym in the gym's voice.
  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <RabbitHoleAuthoringPage />
    </RoleSessionGate>
  );
}
