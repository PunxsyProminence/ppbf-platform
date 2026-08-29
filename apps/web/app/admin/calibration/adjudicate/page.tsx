'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';

import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { formatDurationMs, formatMediaOffset } from '@/src/lib/clipTime';

/**
 * SETTLING A DISAGREEMENT. One clip, one decision at a time.
 *
 * This is the write half of the calibration review pair. The read half shows
 * WHERE two coaches disagreed; this screen records WHAT the disagreement
 * actually was -- whose reading is accepted, whether the two were equivalent
 * after all, whether an action only one coach marked really happened, or that
 * the footage cannot settle it.
 *
 * ---------------------------------------------------------------------------
 * NOTHING ON THIS PAGE DECIDES ANYTHING BY ITSELF, and the server refuses
 * every request it cannot justify. The route behind it loads through
 * blinding.ts, so a clip where either coach is still working is refused
 * outright -- there is no partial state for this form to submit against and no
 * "waiting on the other coach" progress to leak.
 *
 * WHAT IS DELIBERATELY NOT HERE.
 *
 *   1. NO EDIT AND NO DELETE. An adjudication is a record of a decision, and
 *      the module behind this screen offers record and read and nothing else.
 *      A control that appeared to revise one would either do nothing or do
 *      something nobody agreed to.
 *   2. NO WAY TO TOUCH EITHER READING. The two annotations are the
 *      measurement. They are frozen by trigger after submission and there is
 *      no code path from here to them -- a reviewer who could edit them would
 *      be destroying the data in the act of interpreting it.
 *   3. NO SCORE, NO AGREEMENT FIGURE, NO RANKING. Not of the clip, not of the
 *      two coaches. Counting how often a reviewer sided with one of them would
 *      be an accuracy figure by another name, and the weights that would make
 *      it mean anything have not been measured.
 *   4. NOTHING ABOUT THE ATHLETE. This screen measures the annotation process.
 *      Two coaches disagreeing about a punch is a fact about the vocabulary,
 *      the footage and the two people, in some mixture nothing here can
 *      separate.
 *
 * ---------------------------------------------------------------------------
 * THE VOCABULARIES COME FROM THE SERVER, and are not retyped into <option>
 * tags here. adjudication.ts imports ./db, so importing its arrays as values
 * into a 'use client' component would pull the Postgres driver into the
 * browser bundle -- the same reason coach/calibration/page.tsx restates its
 * wire shapes and imports only ontology.ts, which has no imports at all.
 * Retyping five controlled vocabularies is how a vocabulary drifts the moment
 * a second surface renders it, so the GET carries them instead.
 *
 * NO RULE IS RE-STATED IN THIS FILE EITHER. A missed-event verdict only
 * applies where one annotator recorded nothing, and a new_adjudicated_value
 * must carry a value -- both are enforced by the module and the database, and
 * a copy of them in a form is a copy that drifts. The controls are always
 * offered, the notes say what each is for, and a refusal is shown in the
 * server's own words.
 */

/* ------------------------------------------------------------------ *
 * Wire shapes, declared here rather than imported from the calibration
 * modules, for the bundle reason above.
 * ------------------------------------------------------------------ */

interface CalibrationClip {
  calibration_clip_id: string;
  clip_code: string;
  start_ms: number;
  end_ms: number;
  primary_sampling_reason: string;
}

interface AnnotationSet {
  annotation_set_id: string;
  annotator_account_id: string;
  ontology_version: string;
  status: string;
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

interface AdjudicatedField {
  adjudicated_field_id: string;
  field_name: string;
  disagreement_category: string;
  resolved_from: string;
  resolved_value: string | null;
  unresolved: boolean;
}

interface Adjudication {
  adjudication_id: string;
  source_event_id_a: string | null;
  source_event_id_b: string | null;
  resolution_type: string;
  missed_event_verdict: string | null;
  adjudicator_account_id: string;
  adjudicated_at: string;
  notes: string | null;
  fields?: AdjudicatedField[];
}

interface Vocabularies {
  resolution_types: string[];
  missed_event_verdicts: string[];
  resolved_from_sources: string[];
  disagreement_categories: string[];
}

interface DeskResponse {
  ok?: boolean;
  error?: string;
  clip?: CalibrationClip;
  sets?: { a: AnnotationSet; b: AnnotationSet };
  events?: { a: AnnotationEvent[]; b: AnnotationEvent[] };
  adjudications?: Adjudication[];
  vocabularies?: Vocabularies;
}

/** One field decision as the form holds it, before it is posted. */
interface FieldDraft {
  key: string;
  fieldName: string;
  disagreementCategory: string;
  resolvedFrom: string;
  resolvedValue: string;
  unresolved: boolean;
}

/** One annotator's reading of one moment. Never "A was right". */
function readingText(event: AnnotationEvent): string {
  const span = `${formatMediaOffset(event.start_ms)} – ${formatMediaOffset(event.end_ms)}`;
  const kind = event.punch_type ?? event.defense_type ?? event.event_class;
  return `${span} · ${kind} · ${event.actor_track} · ${event.visibility}/${event.certainty}`;
}

function ReadingTable({
  caption,
  events,
}: {
  readonly caption: string;
  readonly events: AnnotationEvent[];
}) {
  return (
    <section className="mat-paper overflow-x-auto rounded-[var(--r-lg)] p-[var(--s4)]">
      <table className="ledger">
        <caption className="text-left">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Mark</th>
            <th scope="col">What was recorded</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.event_id}>
              <td>{event.event_id}</td>
              <td>{readingText(event)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {events.length === 0 && (
        <p className="t-body mt-[var(--s3)]">
          This coach submitted and marked nothing on this clip.
        </p>
      )}
    </section>
  );
}

function AdjudicationDesk() {
  const searchParams = useSearchParams();
  const clipId = searchParams.get('calibration_clip_id')?.trim() ?? '';

  const [payload, setPayload] = useState<DeskResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(clipId !== '');

  const [sourceEventIdA, setSourceEventIdA] = useState('');
  const [sourceEventIdB, setSourceEventIdB] = useState('');
  const [resolutionType, setResolutionType] = useState('');
  const [missedEventVerdict, setMissedEventVerdict] = useState('');
  const [notes, setNotes] = useState('');
  const [fields, setFields] = useState<FieldDraft[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [recordedId, setRecordedId] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(
      `${apiBase()}/api/pilot/calibration/adjudication?calibration_clip_id=${encodeURIComponent(clipId)}`,
      { credentials: 'include', signal },
    );
    const body = (await response.json()) as DeskResponse;
    if (signal?.aborted) return;

    if (!response.ok) {
      // The server's own words. Its refusals were written for an organization
      // administrator to read -- "this clip is not ready for adjudication" is
      // the answer, and replacing it with a house-style message would tell
      // them less than the platform knows.
      setErrorMessage(body.error ?? 'This clip could not be loaded.');
      setPayload(null);
    } else {
      setPayload(body);
      setErrorMessage(null);
    }
    setLoading(false);
  }, [clipId]);

  useEffect(() => {
    if (!clipId) return undefined;

    const controller = new AbortController();
    void (async () => {
      try {
        await load(controller.signal);
      } catch (error) {
        // An aborted load is the page unmounting, not a failure to report.
        if (controller.signal.aborted) return;
        setErrorMessage(
          error instanceof Error ? error.message : 'This clip could not be loaded.',
        );
        setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [clipId, load]);

  const vocabularies = payload?.vocabularies;
  const sets = payload?.sets;
  const events = payload?.events;
  const clip = payload?.clip;

  function addField() {
    setFields((current) => [
      ...current,
      {
        key: `${current.length}-${Date.now()}`,
        fieldName: '',
        disagreementCategory: '',
        resolvedFrom: '',
        resolvedValue: '',
        unresolved: false,
      },
    ]);
  }

  function updateField(key: string, patch: Partial<FieldDraft>) {
    setFields((current) => current.map((f) => (f.key === key ? { ...f, ...patch } : f)));
  }

  function removeField(key: string) {
    setFields((current) => current.filter((f) => f.key !== key));
  }

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    setRecordedId(null);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/calibration/adjudication`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        /* WHAT IS NOT IN THIS BODY, on purpose: the two annotation set ids,
           the adjudicator, the vocabulary version and the row's primary key.
           Every one of them is derived on the server from what the blinding
           gate returned, so a page cannot claim which pair of readings was
           weighed or file a decision under another person's name. */
        body: JSON.stringify({
          calibration_clip_id: clipId,
          source_event_id_a: sourceEventIdA,
          source_event_id_b: sourceEventIdB,
          resolution_type: resolutionType,
          missed_event_verdict: missedEventVerdict,
          notes,
          fields: fields.map((field) => ({
            field_name: field.fieldName,
            disagreement_category: field.disagreementCategory,
            resolved_from: field.resolvedFrom,
            resolved_value: field.resolvedValue,
            unresolved: field.unresolved,
          })),
        }),
      });
      const body = (await response.json()) as { error?: string; adjudication?: Adjudication };

      if (!response.ok) {
        setSubmitError(body.error ?? 'This decision could not be recorded.');
      } else {
        setRecordedId(body.adjudication?.adjudication_id ?? null);
        setFields([]);
        setNotes('');
        // Re-read, so the settled list below shows the decision that was just
        // made rather than the page's own optimistic idea of it.
        await load();
      }
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : 'This decision could not be recorded.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
      {/* This surface paints no ground of its own. The visual taxonomy was
          retired as a VISUAL concept by owner decision on 2026-08-23 --
          buildingMapRooms.test.ts no longer requires a page to paint one, and
          legacyVisualVocabulary.test.ts caps that class family at its frozen
          count measured as RAW OCCURRENCES, so writing the class name here
          even inside a comment would spend one of them. The door in
          buildingMap.ts still files this surface under 'office' as structural
          metadata, which is the half of the taxonomy that decision kept. */}
      <div className="mx-auto w-full max-w-5xl">
        <header className="mb-[var(--s5)]">
          <p className="t-eyebrow">Front Office · Calibration</p>
          <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>
            Settle a disagreement
          </h1>
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
            Record what a disagreement between the two coaches actually was. Neither reading is
            changed by anything here — an adjudication is a new record of a decision, carrying who
            made it, when, and under which vocabulary. Unresolvable is a real answer.
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
            red (#A81E22) is reserved for the top of the safety ladder — a
            person who may not participate (owner decision 2026-08-19). A clip
            that is not ready to be settled, or a decision the server refused,
            is emphatically not that, and spending the reservation on it would
            blunt the one signal that has to keep meaning what it says.
            src/design/safeguardingRedReservation.test.ts enforces it. */}
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

        {clip && sets && events && vocabularies && (
          <>
            <section className="mat-leather mb-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s4)]">
              <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>
                Clip {clip.clip_code}
              </h2>
              <p className="t-data mt-[var(--s2)]" style={{ fontSize: 'var(--t-xs)' }}>
                {formatDurationMs(clip.end_ms - clip.start_ms)} · sampled for{' '}
                {clip.primary_sampling_reason} · vocabulary {sets.a.ontology_version}
              </p>
              <p className="t-data mt-[var(--s3)]" style={{ fontSize: 'var(--t-xs)' }}>
                A: {sets.a.annotator_account_id} · B: {sets.b.annotator_account_id}
              </p>
            </section>

            <div className="grid gap-[var(--s4)] md:grid-cols-2">
              <ReadingTable caption="Coach A marked" events={events.a} />
              <ReadingTable caption="Coach B marked" events={events.b} />
            </div>

            <section className="mat-leather mt-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s4)]">
              <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>
                Record a decision
              </h2>

              <div className="mt-[var(--s4)] grid gap-[var(--s3)] md:grid-cols-2">
                <div className="field">
                  <label className="t-label" htmlFor="source-a">Coach A&apos;s mark</label>
                  <select
                    id="source-a"
                    className="select w-full"
                    value={sourceEventIdA}
                    onChange={(e) => setSourceEventIdA(e.target.value)}
                  >
                    <option value="">Coach A recorded nothing here</option>
                    {events.a.map((event) => (
                      <option key={event.event_id} value={event.event_id}>
                        {readingText(event)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label className="t-label" htmlFor="source-b">Coach B&apos;s mark</label>
                  <select
                    id="source-b"
                    className="select w-full"
                    value={sourceEventIdB}
                    onChange={(e) => setSourceEventIdB(e.target.value)}
                  >
                    <option value="">Coach B recorded nothing here</option>
                    {events.b.map((event) => (
                      <option key={event.event_id} value={event.event_id}>
                        {readingText(event)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label className="t-label" htmlFor="resolution">What was concluded</label>
                  <select
                    id="resolution"
                    className="select w-full"
                    value={resolutionType}
                    onChange={(e) => setResolutionType(e.target.value)}
                  >
                    <option value="">Choose an outcome</option>
                    {vocabularies.resolution_types.map((value) => (
                      <option key={value} value={value}>{value}</option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label className="t-label" htmlFor="verdict">Did it happen at all</label>
                  <select
                    id="verdict"
                    className="select w-full"
                    value={missedEventVerdict}
                    onChange={(e) => setMissedEventVerdict(e.target.value)}
                  >
                    <option value="">Not applicable</option>
                    {vocabularies.missed_event_verdicts.map((value) => (
                      <option key={value} value={value}>{value}</option>
                    ))}
                  </select>
                  <p className="t-muted mt-[var(--s2)]">
                    Only for a mark one coach recorded and the other did not. Two coaches may each
                    have seen a real, different action — that is what both_distinct records, and it
                    is there so a true observation is never deleted to tidy a disagreement.
                  </p>
                </div>
              </div>

              <div className="mt-[var(--s4)]">
                <h3 className="t-label">Field decisions</h3>
                <p className="t-muted mt-[var(--s2)]">
                  One row per field. Two coaches who agree about everything except the target zone
                  should not force a whole-event choice — that would manufacture agreement on every
                  field nobody actually considered.
                </p>

                {fields.map((field) => (
                  <div
                    key={field.key}
                    className="mt-[var(--s3)] grid gap-[var(--s2)] md:grid-cols-2"
                  >
                    <div className="field">
                      <label className="t-label" htmlFor={`field-name-${field.key}`}>
                        Field
                      </label>
                      <input
                        id={`field-name-${field.key}`}
                        className="input w-full"
                        value={field.fieldName}
                        onChange={(e) => updateField(field.key, { fieldName: e.target.value })}
                      />
                    </div>
                    <div className="field">
                      <label className="t-label" htmlFor={`field-category-${field.key}`}>
                        Kind of disagreement
                      </label>
                      <select
                        id={`field-category-${field.key}`}
                        className="select w-full"
                        value={field.disagreementCategory}
                        onChange={(e) =>
                          updateField(field.key, { disagreementCategory: e.target.value })}
                      >
                        <option value="">Choose a category</option>
                        {vocabularies.disagreement_categories.map((value) => (
                          <option key={value} value={value}>{value}</option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label className="t-label" htmlFor={`field-source-${field.key}`}>
                        Where the accepted value came from
                      </label>
                      <select
                        id={`field-source-${field.key}`}
                        className="select w-full"
                        value={field.resolvedFrom}
                        onChange={(e) => updateField(field.key, { resolvedFrom: e.target.value })}
                      >
                        <option value="">Choose a source</option>
                        {vocabularies.resolved_from_sources.map((value) => (
                          <option key={value} value={value}>{value}</option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label className="t-label" htmlFor={`field-value-${field.key}`}>
                        Accepted value
                      </label>
                      <input
                        id={`field-value-${field.key}`}
                        className="input w-full"
                        value={field.resolvedValue}
                        disabled={field.unresolved}
                        onChange={(e) => updateField(field.key, { resolvedValue: e.target.value })}
                      />
                      <label className="t-label mt-[var(--s2)] flex items-center gap-[var(--s2)]">
                        <input
                          type="checkbox"
                          checked={field.unresolved}
                          onChange={(e) => updateField(field.key, {
                            unresolved: e.target.checked,
                            // An unresolved field carries no value. Cleared
                            // here so the control cannot hold a value the
                            // server would then refuse.
                            resolvedValue: e.target.checked ? '' : field.resolvedValue,
                          })}
                        />
                        This field cannot be settled from the footage
                      </label>
                      <button
                        type="button"
                        className="btn btn--ghost mt-[var(--s2)]"
                        onClick={() => removeField(field.key)}
                      >
                        Remove this field
                      </button>
                    </div>
                  </div>
                ))}

                <button type="button" className="btn btn--ghost mt-[var(--s3)]" onClick={addField}>
                  Add a field decision
                </button>
              </div>

              <div className="field mt-[var(--s4)]">
                <label className="t-label" htmlFor="notes">Notes</label>
                <textarea
                  id="notes"
                  className="textarea w-full"
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>

              {submitError && (
                <div className="alert alert--warning mt-[var(--s4)]" role="alert">
                  <span className="alert-icon" aria-hidden="true">▲</span>
                  <div className="alert-body">
                    <p className="alert-title">Not recorded</p>
                    <p className="alert-msg">{submitError}</p>
                  </div>
                </div>
              )}

              {recordedId && (
                <div className="alert alert--info mt-[var(--s4)]" role="status">
                  <div className="alert-body">
                    <p className="alert-title">Recorded</p>
                    <p className="alert-msg">Decision {recordedId} is on the record.</p>
                  </div>
                </div>
              )}

              <button
                type="button"
                className="btn mt-[var(--s4)]"
                disabled={submitting}
                onClick={() => void submit()}
              >
                {submitting ? 'Recording…' : 'Record this decision'}
              </button>
            </section>

            <section className="mat-paper mt-[var(--s5)] overflow-x-auto rounded-[var(--r-lg)] p-[var(--s5)]">
              <table className="ledger">
                <caption className="text-left">
                  Already settled on this clip
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Between</th>
                    <th scope="col">Concluded</th>
                    <th scope="col">Field decisions</th>
                    <th scope="col">Recorded by</th>
                  </tr>
                </thead>
                <tbody>
                  {(payload?.adjudications ?? []).map((adjudication) => (
                    <tr key={adjudication.adjudication_id}>
                      <td>
                        {adjudication.source_event_id_a ?? 'nothing from A'} /{' '}
                        {adjudication.source_event_id_b ?? 'nothing from B'}
                      </td>
                      <td>
                        {adjudication.resolution_type}
                        {adjudication.missed_event_verdict
                          ? ` · ${adjudication.missed_event_verdict}`
                          : ''}
                      </td>
                      <td>
                        {(adjudication.fields ?? []).length === 0 ? (
                          'None'
                        ) : (
                          <ul>
                            {(adjudication.fields ?? []).map((field) => (
                              <li key={field.adjudicated_field_id}>
                                {field.field_name}: {field.unresolved
                                  ? 'not settled'
                                  : `${field.resolved_value ?? '—'} (${field.resolved_from})`}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td>{adjudication.adjudicator_account_id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {(payload?.adjudications ?? []).length === 0 && (
                <p className="t-body mt-[var(--s3)]">
                  Nothing has been settled on this clip yet.
                </p>
              )}

              {/* Stated rather than left to be discovered. Nothing marks one
                  decision as superseding another, so a second decision about
                  the same pair of marks sits beside the first with only its
                  timestamp separating them. Which is the decision of record is
                  an owner question, and this screen does not answer it by
                  hiding either one. */}
              <p className="t-muted mt-[var(--s3)]">
                A decision is never edited or removed. Recording a second one about the same pair
                of marks adds a row beside the first; nothing here marks either as superseding the
                other.
              </p>
            </section>
          </>
        )}

        <div className="mt-[var(--s6)]">
          <Link href="/admin" className="btn btn--ghost">Back to the Front Office</Link>
        </div>
      </div>
    </main>
  );
}

export default function CalibrationAdjudicationPage() {
  return (
    // useSearchParams needs a Suspense boundary to prerender -- the same
    // pattern app/admin/payments/page.tsx uses.
    //
    // allowedRoles is ['admin'] and NOT ['admin', 'platform_owner']: the route
    // behind this screen refuses platform_owner by name, because settling a
    // disagreement between an organization's own two annotators is not a
    // platform-wide role's to do.
    <RoleSessionGate allowedRoles={['admin']}>
      <Suspense
        fallback={(
          <main className="min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
            <p className="t-body">Loading the adjudication desk…</p>
          </main>
        )}
      >
        <AdjudicationDesk />
      </Suspense>
    </RoleSessionGate>
  );
}
