"use client";

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

/**
 * The queue an administrator works.
 *
 * Two shapes arrive here and the server decides which: a gym administrator gets
 * their own gym with submitters named and the controls to act; the platform
 * owner gets every gym with the submitter reduced to a role and a gym name, and
 * no controls, because acting on a submission means knowing whose it is.
 *
 * The de-identification is done by the query, not by this file. Nothing here
 * would leak a name it was never sent, and nothing here should be trusted to
 * hide one it was.
 *
 * SAFEGUARDING IS NOT A FILTER YOU HAVE TO REMEMBER TO APPLY. Those submissions
 * arrive first from the server, and they render first, in their own banded
 * section, above everything else on the page.
 */

const TRIAGE_STATUSES = ['new', 'triaged', 'planned', 'declined', 'done'] as const;
type TriageStatus = (typeof TRIAGE_STATUSES)[number];

interface FeedbackItem {
  submission_id: string;
  organization_id: string;
  organization_name?: string | null;
  submitted_by_role: string;
  submitter_name?: string | null;
  kind: string;
  body: string;
  route: 'product' | 'safeguarding';
  triage_status: TriageStatus;
  triage_note?: string | null;
  created_at: string;
}

type Scope = 'organization' | 'platform';

function formatWhen(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString();
}

interface SubmissionCardProps {
  readonly item: FeedbackItem;
  readonly scope: Scope;
  readonly onTriage: (submissionId: string, status: TriageStatus, note: string) => Promise<void>;
}

function SubmissionCard({ item, scope, onTriage }: SubmissionCardProps) {
  const isSafeguarding = item.route === 'safeguarding';
  const [status, setStatus] = useState<TriageStatus>(item.triage_status);
  const [note, setNote] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  return (
    <article
      className={
        isSafeguarding
          ? 'border-[3px] border-[var(--red-primary)] bg-[var(--canvas-tan-light)] p-4 shadow-[var(--shadow-md)]'
          : 'border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4'
      }
    >
      {isSafeguarding ? (
        <p className="mb-3 border-2 border-[var(--black)] bg-[var(--red-primary)] px-2 py-1 text-[11px] font-mono font-bold uppercase tracking-[0.14em] text-[var(--white)]">
          Safeguarding — a person must read this
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--gray-dark)]">
        <span className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 py-1 text-[var(--black)]">
          {item.submitted_by_role}
        </span>
        <span className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 py-1 text-[var(--black)]">
          {item.kind}
        </span>
        {scope === 'platform' && item.organization_name ? (
          <span className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 py-1 text-[var(--black)]">
            {item.organization_name}
          </span>
        ) : null}
        {scope === 'organization' && item.submitter_name ? (
          <span className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 py-1 text-[var(--black)]">
            {item.submitter_name}
          </span>
        ) : null}
        <span>{formatWhen(item.created_at)}</span>
        <span className="text-[var(--red-primary)]">{item.triage_status}</span>
      </div>

      <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-[var(--black)]">{item.body}</p>

      {item.triage_note ? (
        <p className="mt-3 border-l-4 border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-2 text-sm leading-6 text-[var(--gray-dark)]">
          {item.triage_note}
        </p>
      ) : null}

      {scope === 'organization' ? (
        <div className="mt-4 space-y-2 border-t-2 border-[var(--black)] pt-3">
          <label className="block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)]">
            Status
            <select
              aria-label={`Status for submission ${item.submission_id}`}
              value={status}
              onChange={(event) => setStatus(event.target.value as TriageStatus)}
              className="mt-1 h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 text-sm normal-case tracking-normal text-[var(--black)]"
            >
              {TRIAGE_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <textarea
            aria-label={`Note for submission ${item.submission_id}`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="What was done about it"
            className="h-20 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-2 text-sm text-[var(--black)]"
          />
          <button
            type="button"
            disabled={isSaving}
            onClick={() => {
              setIsSaving(true);
              void onTriage(item.submission_id, status, note)
                .then(() => setNote(''))
                .finally(() => setIsSaving(false));
            }}
            className="min-h-[42px] w-full border-2 border-[var(--black)] bg-[var(--red-primary)] px-4 text-xs font-black uppercase tracking-[0.12em] text-[var(--white)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSaving ? 'Saving...' : 'Save Triage'}
          </button>
        </div>
      ) : null}
    </article>
  );
}

export default function FeedbackTriagePage() {
  const [scope, setScope] = useState<Scope>('organization');
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/feedback/list`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 100 }),
        });

        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
          scope?: Scope;
          items?: FeedbackItem[];
        };

        if (!response.ok) {
          throw new Error(payload.error || 'Unable to load submissions.');
        }

        setScope(payload.scope === 'platform' ? 'platform' : 'organization');
        setItems(payload.items ?? []);
        setErrorMessage('');
      } catch (error) {
        setItems([]);
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load submissions.');
      } finally {
        setIsLoaded(true);
      }
    })();
  }, []);

  const safeguarding = useMemo(() => items.filter((item) => item.route === 'safeguarding'), [items]);
  const product = useMemo(() => items.filter((item) => item.route !== 'safeguarding'), [items]);

  async function handleTriage(submissionId: string, status: TriageStatus, note: string) {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/feedback/triage`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submission_id: submissionId, triage_status: status, triage_note: note }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        updated?: boolean;
        submission?: { triage_status: TriageStatus; triage_note: string | null };
      };

      if (!response.ok) {
        throw new Error(payload.error || 'Unable to update this submission.');
      }

      // The route answers 200 with updated=false when no row in this gym
      // carries that id, so an ok response alone does not mean a disclosure
      // was actually picked up.
      if (payload.updated === false || !payload.submission) {
        throw new Error('That submission is no longer in this gym’s queue, so nothing was changed.');
      }

      const submission = payload.submission;
      setItems((current) =>
        current.map((item) =>
          item.submission_id === submissionId
            ? { ...item, triage_status: submission.triage_status, triage_note: submission.triage_note }
            : item,
        ),
      );
      setMessage(`Marked ${status}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to update this submission.');
    }
  }

  return (
    <RoleSessionGate allowedRoles={['admin', 'platform_owner']}>
      <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
        <div className="mx-auto w-full max-w-5xl px-6 py-10 lg:px-10">
          <header className="space-y-3 border-b-[3px] border-[var(--black)] pb-6">
            <p className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--red-primary)]">Admin Workspace</p>
            <h1 className="font-display text-4xl font-black">What People Told Us</h1>
            <p className="max-w-3xl text-sm leading-6 text-[var(--gray-dark)]">
              {scope === 'platform'
                ? 'Every gym, with the person who wrote each one reduced to their role and their gym. This view shows whether a frustration is one person or a pattern; the gym that received a submission is the one that works it.'
                : 'Everything this gym has been told, newest first, with anything an athlete wrote about being hurt or frightened at the top.'}
            </p>
            {errorMessage ? <p className="text-sm text-[var(--red-primary)]">{errorMessage}</p> : null}
          </header>

          {safeguarding.length > 0 ? (
            <section className="mt-6">
              <div className="border-[3px] border-[var(--black)] bg-[var(--red-primary)] px-4 py-3">
                <h2 className="font-display text-xl tracking-tight text-[var(--white)]">
                  {safeguarding.length === 1
                    ? '1 submission needs a person today'
                    : `${safeguarding.length} submissions need a person today`}
                </h2>
                <p className="mt-1 text-sm leading-6 text-[var(--white-off)]">
                  An athlete wrote about being hurt, frightened, or not wanting to be here. They were told a
                  person at the gym would read it and come talk with them.
                </p>
              </div>
              <div className="mt-4 grid gap-4">
                {safeguarding.map((item) => (
                  <SubmissionCard
                    key={item.submission_id}
                    item={item}
                    scope={scope}
                    onTriage={handleTriage}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {product.length > 0 ? (
            <section className="mt-8">
              <h2 className="font-display text-xl tracking-tight text-[var(--black)]">
                Bugs, frustrations and ideas
              </h2>
              <div className="mt-4 grid gap-4">
                {product.map((item) => (
                  <SubmissionCard
                    key={item.submission_id}
                    item={item}
                    scope={scope}
                    onTriage={handleTriage}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {isLoaded && !errorMessage && items.length === 0 ? (
            <p className="mt-8 text-sm leading-6 text-[var(--gray-dark)]">Nobody has sent anything yet.</p>
          ) : null}

          {message ? <p className="mt-6 text-sm font-semibold text-[var(--red-primary)]">{message}</p> : null}

          <div className="mt-8">
            <Link
              href="/operations"
              className="inline-flex min-h-[42px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 text-xs font-bold uppercase tracking-[0.08em]"
            >
              Back to Mission Control
            </Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
