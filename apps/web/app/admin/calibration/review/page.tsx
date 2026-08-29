'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { formatDurationMs, formatMediaOffset } from '@/src/lib/clipTime';

/**
 * WHERE THE TWO COACHES DISAGREED. One clip, both readings, side by side.
 *
 * READ-ONLY, AND THAT IS THE WHOLE DESIGN. There is no control on this page
 * that changes anything: no adjudication, no "accept A", no gold nomination,
 * no re-open. Every one of those is a decision with its own record, its own
 * gate and its own migration, and putting a button for one here before that
 * exists would either do nothing or do something nobody agreed to. The only
 * links are navigation.
 *
 * WHAT IS DELIBERATELY NOT SHOWN.
 *
 *   1. ANY SINGLE NUMBER FOR HOW WELL THEY AGREED. No rate, no kappa, no
 *      score, no percentage. comparison.ts refuses to compute one because the
 *      weights nobody has measured would decide the answer, and because the
 *      number would be read instantly as a verdict on two coaches. A page that
 *      divided the counts below by anything would put it back without the
 *      argument, so the counts are shown as counts and the denominator is left
 *      to whoever is asking.
 *   2. ANYTHING ABOUT THE ATHLETE. This screen measures the annotation
 *      process. Two coaches disagreeing about a punch is a fact about the
 *      vocabulary, the footage and the two people, in some mixture nothing
 *      here can separate. It says nothing about whoever is in the frame.
 *   3. A VERDICT ON WHO WAS RIGHT. An action only one coach recorded is not
 *      evidence the action did not happen -- only that it was not annotated.
 *      The table says that in as many words rather than leaving the reader to
 *      supply the inference.
 *
 * The server refuses this read entirely until BOTH annotators have submitted,
 * so there is no partial state for this page to render and no "waiting on the
 * other coach" progress to leak. See the route's own header for why it loads
 * through blinding.ts rather than through the unblinded org-scoped loaders.
 */

/* ------------------------------------------------------------------ *
 * Wire shapes, declared here rather than imported from the calibration
 * modules: those import ./db, and importing one as a VALUE into a
 * 'use client' component would pull the Postgres driver into the browser
 * bundle. Same reason app/coach/calibration/page.tsx restates them.
 * ------------------------------------------------------------------ */

interface CalibrationClip {
  calibration_clip_id: string;
  clip_code: string;
  start_ms: number;
  end_ms: number;
  primary_sampling_reason: string;
}

interface AnnotationEvent {
  event_id: string;
  event_class: string;
  actor_track: string;
  start_ms: number;
  end_ms: number;
  punch_type: string | null;
  defense_type: string | null;
  visibility: string;
  certainty: string;
}

interface Disagreement {
  category: string;
  field: string;
  valueA: string | null;
  valueB: string | null;
  deltaMs?: number;
}

interface EventPairing {
  outcome: 'MATCHED' | 'MATCH_AMBIGUOUS' | 'ONLY_IN_A' | 'ONLY_IN_B';
  eventA: AnnotationEvent | null;
  eventB: AnnotationEvent | null;
  candidateCount: number;
  disagreements: Disagreement[];
}

interface Comparison {
  calibrationClipId: string;
  annotationSetIdA: string;
  annotationSetIdB: string;
  annotatorAccountIdA: string;
  annotatorAccountIdB: string;
  ontologyVersion: string;
  matchingPolicy: {
    policyVersion: string;
    calibrationState: string;
    overlapToleranceMs: number;
  };
  pairings: EventPairing[];
}

interface ComparisonResponse {
  ok?: boolean;
  error?: string;
  clip?: CalibrationClip;
  comparison?: Comparison;
  disagreement_counts?: Record<string, number>;
}

/** What each pairing outcome MEANS, in the words the module's own docblock
 *  uses. Not a judgement, and never "A was right". */
function outcomeLabel(pairing: EventPairing): string {
  switch (pairing.outcome) {
    case 'MATCHED':
      return 'Paired';
    case 'MATCH_AMBIGUOUS':
      return `No honest pairing (overlaps ${pairing.candidateCount} on the other side)`;
    case 'ONLY_IN_A':
      return 'Recorded by A only';
    default:
      return 'Recorded by B only';
  }
}

/** One annotator's reading of one moment, or an explicit absence. */
function readingText(event: AnnotationEvent | null): string {
  if (!event) return 'Not recorded';
  const span = `${formatMediaOffset(event.start_ms)} – ${formatMediaOffset(event.end_ms)}`;
  const kind = event.punch_type ?? event.defense_type ?? event.event_class;
  return `${span} · ${kind} · ${event.actor_track} · ${event.visibility}/${event.certainty}`;
}

function differenceText(disagreement: Disagreement): string {
  const values = `${disagreement.valueA ?? '—'} vs ${disagreement.valueB ?? '—'}`;
  return disagreement.deltaMs === undefined
    ? `${disagreement.category} · ${disagreement.field}: ${values}`
    : `${disagreement.category} · ${disagreement.field}: ${values} (${disagreement.deltaMs > 0 ? '+' : ''}${disagreement.deltaMs}ms)`;
}

function CalibrationReviewTable() {
  const searchParams = useSearchParams();
  const clipId = searchParams.get('calibration_clip_id')?.trim() ?? '';

  const [payload, setPayload] = useState<ComparisonResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(clipId !== '');

  useEffect(() => {
    if (!clipId) return undefined;

    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `${apiBase()}/api/pilot/calibration/comparison?calibration_clip_id=${encodeURIComponent(clipId)}`,
          { credentials: 'include', signal: controller.signal },
        );
        const body = (await response.json()) as ComparisonResponse;
        if (controller.signal.aborted) return;

        if (!response.ok) {
          // The server's own words. Its refusals were written for an
          // organization administrator to read -- "this clip is not ready for
          // adjudication" is the answer, and replacing it with a house style
          // message would tell them less than the platform knows.
          setErrorMessage(body.error ?? 'This comparison could not be loaded.');
          setPayload(null);
        } else {
          setPayload(body);
          setErrorMessage(null);
        }
        setLoading(false);
      } catch (error) {
        // An aborted load is the page unmounting, not a failure to report.
        if (controller.signal.aborted) return;
        setErrorMessage(
          error instanceof Error ? error.message : 'This comparison could not be loaded.',
        );
        setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [clipId]);

  const comparison = payload?.comparison;
  const clip = payload?.clip;
  const counts = payload?.disagreement_counts;

  return (
    <main className="min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
      {/* This surface paints no room of its own. Rooms were retired as a VISUAL
          concept by owner decision on 2026-08-23: buildingMapRooms.test.ts no
          longer requires a page to paint one, and legacyVisualVocabulary.test.ts
          caps the class family at its frozen count and fails on an increase --
          measured as raw occurrences, so writing the class name in a comment
          here would spend one of them. The door in buildingMap.ts still files
          this surface under 'office' as structural metadata, which is the half
          of the taxonomy that decision kept. */}
      <div className="mx-auto w-full max-w-5xl">
        <header className="mb-[var(--s5)]">
          <p className="t-eyebrow">Front Office · Calibration</p>
          <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>
            Where the two coaches disagreed
          </h1>
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
            Both independent readings of one study clip, side by side. Read-only: nothing on this
            page settles anything, and no action recorded by one coach and not the other is
            evidence that it did not happen — only that it was not annotated.
          </p>
        </header>

        {!clipId && (
          <div className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
            <p className="t-body">
              No clip named. Open this screen with a <code>calibration_clip_id</code> in the
              address, from the clip it belongs to.
            </p>
          </div>
        )}

        {/* alert--warning and ▲, never alert--critical and ✕. The safeguarding
            red (#A81E22) is reserved for the top of the safety ladder -- a
            person who may not participate (owner decision 2026-08-19). A clip
            that is not ready for review, or a fetch that failed, is emphatically
            not that, and spending the reservation on it would blunt the one
            signal that has to keep meaning what it says.
            src/design/safeguardingRedReservation.test.ts enforces this, and it
            named this file when the first draft reached for the red. */}
        {errorMessage && (
          <div className="alert alert--warning" role="alert">
            <span className="alert-icon" aria-hidden="true">▲</span>
            <div className="alert-body">
              <p className="alert-title">Not shown</p>
              <p className="alert-msg">{errorMessage}</p>
            </div>
          </div>
        )}

        {loading && !errorMessage && (
          <div className="flex justify-center py-[var(--s7)]">
            <span className="working">Loading both readings…</span>
          </div>
        )}

        {comparison && clip && (
          <>
            <section className="mat-leather mb-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s4)]">
              <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>
                Clip {clip.clip_code}
              </h2>
              <p className="t-data mt-[var(--s2)]" style={{ fontSize: 'var(--t-xs)' }}>
                {formatDurationMs(clip.end_ms - clip.start_ms)} · sampled for{' '}
                {clip.primary_sampling_reason} · vocabulary {comparison.ontologyVersion}
              </p>
              {/* The matching rule travels with every comparison and is stated
                  here rather than assumed, because it decides which two marks
                  count as the same moment -- and it is not calibrated. */}
              <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
                Pairing rule: {comparison.matchingPolicy.policyVersion}, tolerance{' '}
                {comparison.matchingPolicy.overlapToleranceMs}ms —{' '}
                {comparison.matchingPolicy.calibrationState}. Two marks are the same moment only
                when the spans the coaches actually drew overlap.
              </p>
              <p className="t-data mt-[var(--s3)]" style={{ fontSize: 'var(--t-xs)' }}>
                A: {comparison.annotatorAccountIdA} · B: {comparison.annotatorAccountIdB}
              </p>
            </section>

            <section className="mat-paper overflow-x-auto rounded-[var(--r-lg)] p-[var(--s5)]">
              <table className="ledger">
                <caption className="text-left">Every action either coach marked</caption>
                <thead>
                  <tr>
                    <th scope="col">Pairing</th>
                    <th scope="col">Coach A read</th>
                    <th scope="col">Coach B read</th>
                    <th scope="col">What differs</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.pairings.map((pairing) => (
                    <tr key={pairing.eventA?.event_id ?? pairing.eventB?.event_id}>
                      <td>{outcomeLabel(pairing)}</td>
                      <td>{readingText(pairing.eventA)}</td>
                      <td>{readingText(pairing.eventB)}</td>
                      <td>
                        {pairing.disagreements.length === 0 ? (
                          pairing.outcome === 'MATCHED'
                            ? 'Nothing — both readings agree on every field'
                            : 'Not comparable field by field'
                        ) : (
                          <ul>
                            {pairing.disagreements.map((disagreement) => (
                              <li key={`${disagreement.category}-${disagreement.field}`}>
                                {differenceText(disagreement)}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {comparison.pairings.length === 0 && (
                <p className="t-body mt-[var(--s3)]">
                  Both coaches submitted and neither marked anything on this clip.
                </p>
              )}
            </section>

            {counts && (
              <section className="mat-paper mt-[var(--s5)] overflow-x-auto rounded-[var(--r-lg)] p-[var(--s5)]">
                <table className="ledger">
                  <caption className="text-left">
                    Disagreements by category — counts, with no denominator
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Category</th>
                      <th scope="col">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(counts).map(([category, count]) => (
                      <tr key={category}>
                        <td>{category}</td>
                        {/* Every category is listed even at zero, so a zero is
                            a measured zero rather than a missing row somebody
                            has to guess about. */}
                        <td>{count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
                  There is no overall agreement figure here, and that is deliberate. A rate needs
                  a decision about what it is a rate of, and the weights that would collapse
                  fifteen categories into one number have not been measured.
                </p>
              </section>
            )}
          </>
        )}

        <div className="mt-[var(--s6)]">
          <Link href="/admin" className="btn btn--ghost">Back to the Front Office</Link>
        </div>
      </div>
    </main>
  );
}

export default function CalibrationReviewPage() {
  return (
    // useSearchParams needs a Suspense boundary to prerender -- the same
    // pattern app/admin/payments/page.tsx uses.
    <RoleSessionGate allowedRoles={['admin']}>
      <Suspense
        fallback={(
          <main className="min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
            <p className="t-body">Loading the calibration review…</p>
          </main>
        )}
      >
        <CalibrationReviewTable />
      </Suspense>
    </RoleSessionGate>
  );
}
