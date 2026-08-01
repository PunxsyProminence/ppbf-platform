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

const STATUS_TONE: Record<AuthoredLesson['status'], string> = {
  published: 'border-[var(--status-ready)] bg-[#dce7ca]',
  retired: 'border-[var(--gray-medium)] bg-[var(--canvas-tan)]',
};

const STATUS_LABELS: Record<AuthoredLesson['status'], string> = {
  published: 'PUBLISHED',
  retired: 'RETIRED',
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
    <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
      <div className="mx-auto w-full max-w-6xl px-6 py-10 lg:px-10">
        <header className="space-y-3 border-b-[3px] border-[var(--black)] pb-6">
          <p className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--red-primary)]">Gym Coaching</p>
          <h1 className="font-display text-4xl font-black">Rabbit Holes</h1>
          <p className="max-w-4xl text-sm leading-6 text-[var(--gray-dark)]">
            A rabbit hole is a concept worth understanding and something to go and do with it. Pick the term it is
            about, write it, and it appears inside every card that already names that term.
          </p>
          {/* The claim this surface must never let an author make by accident.
              Evidence tiers mean retrieved and cited; this is a person writing. */}
          <p className="max-w-4xl text-sm leading-6 text-[var(--gray-dark)]">
            What you write here is the gym&apos;s own coaching, published under your name. It is not research, it
            carries no SHADOW evidence tier, and readers are told both.
          </p>
          {loadError ? <p className="text-sm text-[var(--red-primary)]">{loadError}</p> : null}
        </header>

        <section className="mt-6 space-y-3 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <h2 className="text-lg font-bold">What Is It About?</h2>
          <p className="text-sm leading-6 text-[var(--gray-dark)]">
            A lesson attaches to a term the platform already uses, never to a card. The card&apos;s wording can
            change; the term does not.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--gray-dark)]">
              Kind of term
              <select
                value={anchorType}
                onChange={(event) => selectAnchorType(event.target.value)}
                className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 text-sm font-normal normal-case tracking-normal text-[var(--black)]"
              >
                {AUTHORABLE_ANCHOR_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {ANCHOR_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--gray-dark)]">
              Term
              <select
                value={anchorKey}
                onChange={(event) => setAnchorKey(event.target.value)}
                className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 text-sm font-normal normal-case tracking-normal text-[var(--black)]"
              >
                {keyOptions.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-3">
            <h3 className="text-sm font-bold">Already Written For {anchorLabel(anchorType, anchorKey)}</h3>
            {anchorLoadError ? (
              <p className="mt-2 text-sm text-[var(--red-primary)]">{anchorLoadError}</p>
            ) : publishedHere.length === 0 ? (
              <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
                Nothing is published against this term yet.
              </p>
            ) : (
              <ul className="mt-2 space-y-2">
                {publishedHere.map((lesson) => (
                  <li key={lesson.rabbit_hole_id} className="text-sm leading-6 text-[var(--gray-dark)]">
                    <span className="font-semibold text-[var(--black)]">{lesson.title}</span> - by{' '}
                    {lesson.author_display_name}, for {audienceLabel(lesson.audience)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="mt-6 space-y-3 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <h2 className="text-lg font-bold">Write</h2>
          <input
            value={draft.title}
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
            placeholder="Title of the lesson"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <textarea
            value={draft.concept}
            onChange={(event) => setDraft((current) => ({ ...current, concept: event.target.value }))}
            placeholder="Concept - why this works the way it does"
            className="h-32 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-2"
          />
          <textarea
            value={draft.homework}
            onChange={(event) => setDraft((current) => ({ ...current, homework: event.target.value }))}
            placeholder="Homework (optional) - something to go and do with it"
            className="h-24 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-2"
          />
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--gray-dark)]">
              Who reads it
              <select
                value={draft.audience}
                onChange={(event) => setDraft((current) => ({ ...current, audience: event.target.value }))}
                className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 text-sm font-normal normal-case tracking-normal text-[var(--black)]"
              >
                {RABBIT_HOLE_AUDIENCE_OPTIONS.map((audience) => (
                  <option key={audience} value={audience}>
                    {audienceLabel(audience)}
                  </option>
                ))}
              </select>
            </label>
            <input
              value={authorName}
              onChange={(event) => setAuthorName(event.target.value)}
              placeholder="Your name, as readers will see it"
              className="h-11 w-full self-end border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
            />
          </div>
          <button
            type="button"
            disabled={isPublishing || !canPublish}
            onClick={() =>
              void publish().catch((error) =>
                setMessage(error instanceof Error ? error.message : 'Unable to publish.'),
              )
            }
            className="h-11 border-2 border-[var(--black)] bg-[var(--red-primary)] px-4 text-sm font-black uppercase tracking-[0.12em] text-[var(--white)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPublishing ? 'Publishing...' : 'Publish'}
          </button>
          {message ? <p className="text-sm font-semibold text-[var(--red-primary)]">{message}</p> : null}
        </section>

        <section className="mt-6 space-y-3 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <h2 className="text-lg font-bold">Everything This Gym Has Written</h2>
          {allLessons.length === 0 && !loadError ? (
            <p className="text-sm leading-6 text-[var(--gray-dark)]">
              No rabbit holes have been written for this gym yet.
            </p>
          ) : null}
          <div className="grid gap-3">
            {allLessons.map((lesson) => (
              <article
                key={lesson.rabbit_hole_id}
                className="grid gap-3 border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4 md:grid-cols-[1fr_auto] md:items-start"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`border-2 px-2 py-0.5 text-[10px] font-mono font-bold uppercase ${STATUS_TONE[lesson.status]}`}>
                      {STATUS_LABELS[lesson.status]}
                    </span>
                    <span className="text-xs font-mono uppercase tracking-[0.12em] text-[var(--red-primary)]">
                      {anchorLabel(lesson.anchor_type, lesson.anchor_key)}
                    </span>
                    <span className="text-xs font-mono uppercase tracking-[0.12em] text-[var(--gray-dark)]">
                      {audienceLabel(lesson.audience)}
                    </span>
                  </div>
                  <p className="mt-2 text-sm font-semibold leading-6 text-[var(--black)]">{lesson.title}</p>
                  <p className="mt-1 text-sm leading-6 text-[var(--gray-dark)]">{lesson.concept}</p>
                  {lesson.homework ? (
                    <p className="mt-2 border-l-2 border-[var(--red-primary)] pl-2 text-sm leading-6 text-[var(--gray-dark)]">
                      Homework: {lesson.homework}
                    </p>
                  ) : null}
                  <p className="mt-2 text-[11px] font-mono uppercase tracking-[0.08em] text-[var(--gray-medium)]">
                    By {lesson.author_display_name} - {formatWrittenTime(lesson.created_at)}
                  </p>
                </div>
                {canManage(lesson) ? (
                  <button
                    type="button"
                    onClick={() =>
                      void setStatus(lesson.rabbit_hole_id, lesson.status === 'published' ? 'retired' : 'published')
                    }
                    className="h-11 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 text-xs font-bold uppercase tracking-[0.08em]"
                  >
                    {lesson.status === 'published' ? 'Retire' : 'Restore'}
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        </section>

        <div className="mt-8">
          <Link
            href="/coach/progression-intelligence"
            className="inline-flex min-h-[44px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 text-xs font-bold uppercase tracking-[0.08em]"
          >
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
