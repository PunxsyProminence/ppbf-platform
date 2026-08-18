'use client';

import { useEffect, useState } from 'react';

import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';

// The missing surface for issue #345's submission-review lifecycle. The
// requirement/gap workspace (/research) already lets a curator SUBMIT a
// source against a requirement; nothing before this page let them move that
// submission through its review verdicts. reviewResearchSubmission and its
// PATCH route have existed since that slice shipped -- this panel is the
// first caller.
//
// Deliberately a standalone page rather than a new section on /research:
// that file is large and under concurrent edit by unrelated work (a
// classification-taxonomy axis, staff credentials), and this panel's data
// (open requirements + their submissions) is self-contained enough not to
// need anything else already on that page.

type ApplicabilityState = 'unreviewed' | 'responsive' | 'partially_responsive' | 'not_responsive' | 'duplicate';

const REVIEW_VERDICTS: readonly Exclude<ApplicabilityState, 'unreviewed'>[] = [
  'responsive', 'partially_responsive', 'not_responsive', 'duplicate',
];

const VERDICT_LABEL: Record<Exclude<ApplicabilityState, 'unreviewed'>, string> = {
  responsive: 'Responsive',
  partially_responsive: 'Partially Responsive',
  not_responsive: 'Not Responsive',
  duplicate: 'Duplicate',
};

/* Law 3: a review verdict is a queue outcome -- glyph + uppercase label,
   never colour alone. Matches the vocabulary /evidence and /research already
   use for the same ladder shape. */
const APPLICABILITY_BADGES: Record<ApplicabilityState, { className: string; glyph: string; label: string }> = {
  unreviewed: { className: 'badge badge--monitor', glyph: '◉', label: 'Unreviewed' },
  responsive: { className: 'badge badge--cleared', glyph: '✓', label: 'Responsive' },
  partially_responsive: { className: 'badge badge--restricted', glyph: '▲', label: 'Partially Responsive' },
  not_responsive: { className: 'badge badge--locked', glyph: '✕', label: 'Not Responsive' },
  duplicate: { className: 'badge badge--filed', glyph: '◌', label: 'Duplicate' },
};

const PAPER_LABEL = 'font-mono text-[length:var(--t-xs)] font-bold uppercase tracking-[0.13em] text-[color:var(--hide-600)]';

interface OpenRequirement {
  research_requirement_id: number;
  source_event_name: string;
  research_requirement: string;
  knowledge_gap: string;
  status: 'open' | 'resolved';
}

interface SubmissionRow {
  submission_id: string;
  research_requirement_id: number;
  source_id: string;
  document_id: string | null;
  provenance: Record<string, unknown>;
  submission_note: string;
  applicability_state: ApplicabilityState;
  reviewed_by_account_id: string | null;
  reviewed_at: string | null;
  review_note: string;
  submitted_by_account_id: string;
  created_at: string;
}

interface LibrarySourceOption {
  source_id: string;
  title: string;
  source_type: string;
}

function formatProvenance(provenance: Record<string, unknown>): string | null {
  const entries = Object.entries(provenance).filter(([, value]) => typeof value === 'string' && value.trim());
  if (entries.length === 0) return null;
  return entries.map(([key, value]) => `${key.replaceAll('_', ' ')}: ${String(value)}`).join(' · ');
}

export default function ResearchSubmissionReviewPage() {
  const [requirements, setRequirements] = useState<OpenRequirement[]>([]);
  const [submissionsByRequirement, setSubmissionsByRequirement] = useState<Record<number, SubmissionRow[]>>({});
  const [sourceTitles, setSourceTitles] = useState<Record<string, LibrarySourceOption>>({});
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');
  const [reviewNoteDrafts, setReviewNoteDrafts] = useState<Record<string, string>>({});
  const [busySubmissionId, setBusySubmissionId] = useState<string | null>(null);
  const [submissionMessages, setSubmissionMessages] = useState<Record<string, string>>({});

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const requirementsResponse = await fetch(`${apiBase()}/api/pilot/shadow/research-requirements`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!requirementsResponse.ok) {
          throw new Error('Unable to load research requirements.');
        }
        const requirementsPayload = (await requirementsResponse.json()) as { items?: OpenRequirement[] };
        const openRequirements = (requirementsPayload.items ?? []).filter((item) => item.status === 'open');
        if (controller.signal.aborted) return;
        setRequirements(openRequirements);

        const submissionEntries = await Promise.all(
          openRequirements.map(async (requirement) => {
            const response = await fetch(
              `${apiBase()}/api/pilot/shadow/research-submissions?research_requirement_id=${requirement.research_requirement_id}`,
              { credentials: 'include', signal: controller.signal },
            );
            if (!response.ok) return [requirement.research_requirement_id, []] as const;
            const payload = (await response.json()) as { items?: SubmissionRow[] };
            return [requirement.research_requirement_id, payload.items ?? []] as const;
          }),
        );
        if (controller.signal.aborted) return;
        setSubmissionsByRequirement(Object.fromEntries(submissionEntries));
        setErrorMessage('');
      } catch (error) {
        if (controller.signal.aborted) return;
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load submitted sources.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    // Best-effort title enrichment. A viewer who cannot curate (403 on this
    // read too, since it shares SHADOW_LIBRARY_CURATOR_ROLES) simply sees
    // submissions by source id instead of title -- no different from the
    // requirements/submissions reads above already having failed for them.
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/shadow/library/sources?limit=200`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { sources?: LibrarySourceOption[]; items?: LibrarySourceOption[] };
        const sources = payload.sources ?? payload.items ?? [];
        if (controller.signal.aborted) return;
        setSourceTitles(Object.fromEntries(sources.map((source) => [source.source_id, source])));
      } catch {
        // Enrichment only; the review panel stands without it.
      }
    })();

    return () => controller.abort();
  }, []);

  async function handleReview(submissionId: string, requirementId: number, applicabilityState: Exclude<ApplicabilityState, 'unreviewed'>) {
    setBusySubmissionId(submissionId);
    setSubmissionMessages((current) => ({ ...current, [submissionId]: '' }));
    try {
      const reviewNote = (reviewNoteDrafts[submissionId] ?? '').trim();
      const response = await fetch(`${apiBase()}/api/pilot/shadow/research-submissions`, {
        credentials: 'include',
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          submission_id: submissionId,
          applicability_state: applicabilityState,
          ...(reviewNote ? { review_note: reviewNote } : {}),
        }),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Review failed (${response.status})`);
      }
      const payload = (await response.json()) as { item?: SubmissionRow };
      const updated = payload.item;
      setSubmissionsByRequirement((current) => {
        const forRequirement = current[requirementId] ?? [];
        return {
          ...current,
          [requirementId]: forRequirement.map((submission) =>
            submission.submission_id === submissionId
              ? (updated ?? { ...submission, applicability_state: applicabilityState, review_note: reviewNote })
              : submission,
          ),
        };
      });
      setSubmissionMessages((current) => ({
        ...current,
        [submissionId]: `Marked ${VERDICT_LABEL[applicabilityState]}.`,
      }));
    } catch (error) {
      setSubmissionMessages((current) => ({
        ...current,
        [submissionId]: error instanceof Error ? error.message : 'Unable to record the review.',
      }));
    } finally {
      setBusySubmissionId(null);
    }
  }

  const requirementsWithSubmissions = requirements.filter(
    (requirement) => (submissionsByRequirement[requirement.research_requirement_id] ?? []).length > 0,
  );
  const totalSubmissions = requirementsWithSubmissions.reduce(
    (sum, requirement) => sum + (submissionsByRequirement[requirement.research_requirement_id] ?? []).length,
    0,
  );
  const unreviewedCount = requirementsWithSubmissions.reduce(
    (sum, requirement) =>
      sum + (submissionsByRequirement[requirement.research_requirement_id] ?? [])
        .filter((submission) => submission.applicability_state === 'unreviewed').length,
    0,
  );

  return (
    <RoleStandaloneView
      roleLabel="Research Submission Review"
      routeLabel="/research/review"
      allowedRoles={['admin', 'platform_owner']}
      room="file"
      breadcrumbs={[{ label: 'Research', href: '/research' }, { label: 'Submission Review' }]}
    >
      <div className="space-y-[var(--s5)]">
        <header className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
          <p className="t-eyebrow">SHADOW Research</p>
          <h1 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-xl)' }}>
            Submission Review
          </h1>
          <p className="t-body mt-[var(--s3)] max-w-[64ch]">
            Sources submitted against open research requirements. A submission never resolves a
            requirement by itself -- review it here as responsive, partially responsive, not
            responsive, or a duplicate link.
          </p>
          <div className="mt-[var(--s4)] flex flex-wrap gap-[var(--s3)]">
            <span className="plaque">SUBMISSIONS: {String(totalSubmissions)}</span>
            <span className="plaque">UNREVIEWED: {String(unreviewedCount)}</span>
          </div>
        </header>

        {errorMessage ? (
          <section role="alert" className="mat-leather rounded-[var(--r-md)] border-2 border-[color:var(--locked)] p-[var(--s4)]">
            <span className="badge badge--locked">
              <i>✕</i>Unable to Load
            </span>
            <p className="t-body mt-[var(--s3)]">{errorMessage}</p>
          </section>
        ) : null}

        {!loading && !errorMessage && requirementsWithSubmissions.length === 0 ? (
          <section className="mat-paper note-torn rounded-[var(--r-sm)] p-[var(--s5)]">
            <p className={PAPER_LABEL}>Empty State</p>
            <p className="t-typed mt-[var(--s2)] text-[length:var(--t-sm)]">
              No sources have been submitted against an open requirement yet.
            </p>
          </section>
        ) : null}

        {requirementsWithSubmissions.map((requirement) => {
          const submissions = submissionsByRequirement[requirement.research_requirement_id] ?? [];
          return (
            <section
              key={requirement.research_requirement_id}
              className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)] space-y-[var(--s4)]"
            >
              <div>
                <p className={PAPER_LABEL}>{requirement.source_event_name}</p>
                <h2 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-md)' }}>
                  {requirement.research_requirement}
                </h2>
                <p className="t-muted mt-[var(--s2)]">Gap: {requirement.knowledge_gap}</p>
              </div>

              <div className="space-y-[var(--s3)]">
                {submissions.map((submission) => {
                  const badge = APPLICABILITY_BADGES[submission.applicability_state];
                  const source = sourceTitles[submission.source_id];
                  const provenanceLine = formatProvenance(submission.provenance);
                  const busy = busySubmissionId === submission.submission_id;
                  const message = submissionMessages[submission.submission_id];
                  return (
                    <article
                      key={submission.submission_id}
                      className="mat-paper rounded-[var(--r-sm)] p-[var(--s5)] relative"
                    >
                      <span className="pin pin--brass" aria-hidden="true" />
                      <div className="flex flex-wrap items-start justify-between gap-[var(--s3)]">
                        <div>
                          <p className="t-typed text-[length:var(--t-md)] font-bold">
                            {source ? `${source.title} (${source.source_type})` : `Source ${submission.source_id}`}
                          </p>
                          {submission.submission_note ? (
                            <p className="t-typed mt-[var(--s2)] text-[length:var(--t-sm)]">{submission.submission_note}</p>
                          ) : null}
                          {provenanceLine ? (
                            <p className="t-data mt-[var(--s2)] text-[length:var(--t-xs)] text-[color:var(--hide-700)]">{provenanceLine}</p>
                          ) : null}
                        </div>
                        <span className={badge.className}>
                          <i aria-hidden="true">{badge.glyph}</i>
                          {badge.label}
                        </span>
                      </div>

                      {submission.applicability_state !== 'unreviewed' && submission.review_note ? (
                        <p className="t-muted mt-[var(--s3)]">Review note: {submission.review_note}</p>
                      ) : null}

                      <div className="mt-[var(--s4)] space-y-[var(--s3)] border-t border-[color:rgba(51,41,27,.26)] pt-[var(--s4)]">
                        <label className="field">
                          <span className={PAPER_LABEL}>Review note (optional)</span>
                          <textarea
                            className="textarea h-[55px]"
                            value={reviewNoteDrafts[submission.submission_id] ?? ''}
                            onChange={(event) =>
                              setReviewNoteDrafts((current) => ({ ...current, [submission.submission_id]: event.target.value }))
                            }
                          />
                        </label>
                        <div className="flex flex-wrap gap-[var(--s3)]">
                          {REVIEW_VERDICTS.map((verdict) => (
                            <button
                              key={verdict}
                              type="button"
                              disabled={busy}
                              onClick={() => void handleReview(submission.submission_id, requirement.research_requirement_id, verdict)}
                              className={`${verdict === submission.applicability_state ? 'btn' : 'btn btn--ghost'} disabled:cursor-not-allowed disabled:opacity-60`}
                            >
                              {`Mark ${VERDICT_LABEL[verdict]}`}
                            </button>
                          ))}
                        </div>
                        {busy ? <p className="t-muted" role="status">Saving…</p> : null}
                        {!busy && message ? <p className="t-muted" role="status">{message}</p> : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </RoleStandaloneView>
  );
}
