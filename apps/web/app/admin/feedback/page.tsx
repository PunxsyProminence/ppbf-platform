"use client";

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { FEEDBACK_ACKNOWLEDGEMENT } from '@/lib/feedbackWording';
import { formatGymStamp } from '@/src/lib/gymTime';

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
  // Null on the cross-gym view for every safeguarding row -- the server
  // withholds it deliberately. Declared honestly so a consumer cannot be
  // written assuming there is always text.
  body: string | null;
  route: 'product' | 'safeguarding';
  triage_status: TriageStatus;
  triage_note?: string | null;
  created_at: string;
}

type Scope = 'organization' | 'platform';

function formatWhen(value: string): string {
  const parsed = Date.parse(value);
  return formatGymStamp(parsed) ?? value;
}

/**
 * Presentation only: the triage vocabulary mapped onto the badge ladder so the
 * state carries a glyph and a label (Law 3), never colour alone. `new` is the
 * rung that demands attention; `done` is the cleared outcome; `declined` is a
 * closed refusal; the two in-between states are being watched.
 */
function triageBadge(status: TriageStatus): { className: string; glyph: string } {
  if (status === 'done') return { className: 'badge badge--cleared', glyph: '✓' };
  if (status === 'declined') return { className: 'badge badge--locked', glyph: '✕' };
  if (status === 'new') return { className: 'badge badge--restricted', glyph: '▲' };
  return { className: 'badge badge--monitor', glyph: '◉' };
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

  const statusBadge = triageBadge(item.triage_status);

  return (
    <article
      className={
        isSafeguarding
          ? 'mat-leather--raised rounded-[var(--r-lg)] border border-[color:var(--restricted)] p-[var(--s4)]'
          : 'mat-leather rounded-[var(--r-lg)] border border-[color:var(--hide-700)] p-[var(--s4)]'
      }
    >
      {isSafeguarding ? (
        <p className="mb-[var(--s3)]">
          <span className="badge badge--restricted"><i>▲</i>Safeguarding — a person must read this</span>
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-[var(--s2)] font-mono text-[length:var(--t-xs)] uppercase tracking-[0.12em] text-[color:var(--bone-400)]">
        <span className="rounded-[var(--r-sm)] border border-[color:var(--hide-600)] bg-[var(--hide-900)] px-[var(--s2)] py-[var(--s1)] text-[color:var(--bone-300)]">
          {item.submitted_by_role}
        </span>
        <span className="rounded-[var(--r-sm)] border border-[color:var(--hide-600)] bg-[var(--hide-900)] px-[var(--s2)] py-[var(--s1)] text-[color:var(--bone-300)]">
          {item.kind}
        </span>
        {scope === 'platform' && item.organization_name ? (
          <span className="rounded-[var(--r-sm)] border border-[color:var(--hide-600)] bg-[var(--hide-900)] px-[var(--s2)] py-[var(--s1)] text-[color:var(--bone-300)]">
            {item.organization_name}
          </span>
        ) : null}
        {scope === 'organization' && item.submitter_name ? (
          <span className="rounded-[var(--r-sm)] border border-[color:var(--hide-600)] bg-[var(--hide-900)] px-[var(--s2)] py-[var(--s1)] text-[color:var(--bone-300)]">
            {item.submitter_name}
          </span>
        ) : null}
        <span className="t-data text-[color:var(--bone-400)]">{formatWhen(item.created_at)}</span>
        <span className={statusBadge.className}><i>{statusBadge.glyph}</i>{item.triage_status}</span>
      </div>

      {/*
        A safeguarding body is nulled by the query for the cross-gym view, on
        purpose: what a child disclosed belongs to the gym handling it, not to
        whoever is looking across gyms. The withholding is correct. Rendering it
        as an empty card was not -- it reads as a submission with no text, or as
        a page that failed to load, and it invites someone to go looking for the
        text somewhere it should not be found.
      */}
      {item.body === null || item.body === '' ? (
        <p className="mt-[var(--s3)] border-l-2 border-[color:var(--hide-600)] bg-[var(--hide-900)] px-[var(--s3)] py-[var(--s2)] text-[length:var(--t-sm)] leading-6 text-[color:var(--bone-400)]">
          Withheld. This was routed to a person at {item.organization_name ?? 'the gym'}, and what the
          submitter wrote stays with them. Nothing failed to load and there is nothing to open.
        </p>
      ) : (
        <p className="t-body mt-[var(--s3)] whitespace-pre-wrap">{item.body}</p>
      )}

      {item.triage_note ? (
        <p className="mt-[var(--s3)] border-l-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] px-[var(--s3)] py-[var(--s2)] text-[length:var(--t-sm)] leading-6 text-[color:var(--bone-300)]">
          {item.triage_note}
        </p>
      ) : null}

      {scope === 'organization' ? (
        <div className="mt-[var(--s4)] space-y-[var(--s2)] border-t border-[color:var(--hide-600)] pt-[var(--s3)]">
          <label className="t-label block">
            Status
            <select
              aria-label={`Status for submission ${item.submission_id}`}
              value={status}
              onChange={(event) => setStatus(event.target.value as TriageStatus)}
              className="select mt-[var(--s2)] normal-case tracking-normal"
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
            className="textarea h-20"
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
            className="btn w-full disabled:cursor-not-allowed disabled:opacity-50"
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
      <main className="room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-5xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          <header className="space-y-[var(--s3)] border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
            <p className="t-eyebrow">Admin Workspace</p>
            <h1 className="t-command" style={{ fontSize: 'var(--t-2xl)' }}>What People Told Us</h1>
            <p className="t-body max-w-3xl">
              {scope === 'platform'
                ? 'Every gym, with the person who wrote each one reduced to their role and their gym. This view shows whether a frustration is one person or a pattern; the gym that received a submission is the one that works it.'
                : 'Everything this gym has been told, newest first, with anything an athlete wrote about being hurt or frightened at the top.'}
            </p>
            {errorMessage ? <p className="text-[length:var(--t-sm)] font-semibold text-[color:var(--locked-ink)]">{errorMessage}</p> : null}
          </header>

          {safeguarding.length > 0 ? (
            <section className="mt-[var(--s5)]">
              <div className="mat-leather--raised rounded-[var(--r-lg)] border border-[color:var(--restricted)] px-[var(--s4)] py-[var(--s3)]">
                <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
                  {safeguarding.length === 1
                    ? '1 submission needs a person today'
                    : `${safeguarding.length} submissions need a person today`}
                </h2>
                <p className="t-body mt-[var(--s2)]">
                  An athlete wrote about being hurt, frightened, or not wanting to be here. All they were
                  told is: &ldquo;{FEEDBACK_ACKNOWLEDGEMENT}&rdquo; They were not promised a reply or a
                  conversation, so they do not know one is coming.
                </p>
              </div>
              <div className="mt-[var(--s4)] grid gap-[var(--s4)]">
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
            <section className="mt-[var(--s6)]">
              <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
                Bugs, frustrations and ideas
              </h2>
              <div className="mt-[var(--s4)] grid gap-[var(--s4)]">
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
            <p className="t-body mt-[var(--s6)]">Nobody has sent anything yet.</p>
          ) : null}

          {message ? <p className="mt-[var(--s5)] text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-100)]">{message}</p> : null}

          <div className="mt-[var(--s6)]">
            <Link href="/operations" className="btn btn--ghost">
              Back to Mission Control
            </Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
