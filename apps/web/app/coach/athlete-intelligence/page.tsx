'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { formatGymStamp } from '@/src/lib/gymTime';
import type {
  AthleteIntelligenceReadModel,
  FormulaOutputEntry,
  IntelligenceSourceAvailability,
} from '@/src/server/pilot/athleteIntelligence';

// THE SCREEN THAT READS WHAT THE ENGINE COMPUTES.
//
// pilot.shadow_formula_results has had a reachable writer since
// auto-calculation shipped: an athlete submits the Deep-Track sparring form,
// shadow/formulas/observations stores the observations, and
// detectAndRunCompletedFormulas runs every formula whose input set that
// submission completed. Results were written on every complete submission and
// NOTHING COULD READ THEM BACK -- both routes over them
// (shadow/formulas/results GET, coach/athlete-intelligence GET) had no caller
// in the product. The sparring page's own copy still declines to promise the
// athlete that a coach sees what they submitted, and it was right to.
//
// WHY THIS RENDERS ONE SECTION OF FOUR. GET coach/athlete-intelligence returns
// formula outputs, the attempts ledger, the transfer readout and accepted Film
// Study. Three of those already have their own screens -- /coach/attempt-log,
// /coach/transfer-check, /coach/video-analysis -- and re-rendering them here
// would put a second copy of the same facts on a fourth surface, which is how
// two screens start disagreeing about one record. Only the formula outputs had
// no reader, so only they are rendered. The other three are reported as
// AVAILABILITY ONLY, with a link to the surface that owns each: a coach still
// learns whether there is anything to go and read, and learns it from the same
// payload rather than from a guess.
//
// WHY THIS ROUTE AND NOT shadow/formulas/results. That route's GET uses
// listActiveFormulaResults, which orders by computed_at and takes the newest N
// ROWS -- so a formula that recomputes often buries one that does not, and the
// reader cannot tell that from the buried formula having no value at all
// (repository.ts states this, athleteIntelligence.pg.test.ts measures it).
// This route uses listLatestFormulaResultsPerOutput: one row per
// (formula, output), which is the question a coach is actually asking.
//
// NOTHING HERE WRITES, SCORES, RANKS OR DECIDES, and no gate is changed: the
// route's own two checks (role, then assertActorCanAccessAthlete on the
// caller-supplied athlete_id) remain the authority.

interface AthleteOption {
  athlete_id: string;
  full_name: string;
}

/**
 * Validation state -> badge.
 *
 * `badge--locked` is ABSENT ON PURPOSE. That red is reserved for the top of
 * the safety ladder -- a person who may not participate -- and an invalid
 * formula result is an arithmetic fact about a calculation, not a safeguarding
 * one. `invalid` takes the restricted rung instead.
 */
const VALIDATION_DISPLAY: Record<string, { className: string; glyph: string; label: string }> = {
  valid: { className: 'badge badge--cleared', glyph: '✓', label: 'valid' },
  warning: { className: 'badge badge--monitor', glyph: '◉', label: 'warning' },
  invalid: { className: 'badge badge--restricted', glyph: '✕', label: 'invalid' },
  insufficient: { className: 'badge badge--filed', glyph: '▣', label: 'insufficient' },
  unsupported: { className: 'badge badge--filed', glyph: '▣', label: 'unsupported' },
};

function validationDisplay(state: string) {
  // An unrecognized state is still a state a coach must see, so it falls to
  // the neutral rung rather than disappearing.
  return VALIDATION_DISPLAY[state] ?? { className: 'badge badge--filed', glyph: '▣', label: state };
}

/** `MISSING_RPE` -> `missing rpe`, with the code kept beside it: this is a
 *  staff surface and the exact code is what a coach quotes when they ask why. */
function readableCode(code: string): string {
  return code.replaceAll('_', ' ').toLowerCase();
}

/**
 * Availability, in words that cannot be mistaken for reassurance.
 *
 * `none_recorded` means NOTHING WAS RECORDED. The read model's own header says
 * it does not mean the athlete is fine, improving, or without problems, and
 * this is the only place that wording reaches a person -- so it is said here,
 * not implied by an empty list.
 */
function availabilityLine(availability: IntelligenceSourceAvailability, count: number): string {
  return availability === 'available'
    ? `${count} recorded`
    : 'Nothing recorded — which is not the same as nothing wrong';
}

function FormulaOutputCard({ entry }: { entry: FormulaOutputEntry }) {
  const { result } = entry;
  const display = validationDisplay(result.validation.state);
  const computed = formatGymStamp(result.computedAt);

  return (
    <li className="mat-leather rounded-[var(--r-md)] p-[var(--s3)]">
      <div className="flex flex-wrap items-center gap-[var(--s3)]">
        <span className={display.className}><i aria-hidden="true">{display.glyph}</i>{display.label}</span>
        <span className="t-body font-semibold text-[color:var(--bone-100)]">
          {result.formulaId} · {result.outputKey}
        </span>
        <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
          formula v{result.formulaVersion} · policy {result.policyVersion}
        </span>
      </div>

      {/* THE VALUE, or the named reason there is not one. A null value is never
          shown as 0, blank or a dash on its own: "no value" and "zero" are
          different facts about an athlete's training. */}
      <p className="t-data mt-[var(--s2)] text-[color:var(--bone-100)]" style={{ fontSize: 'var(--t-lg)' }}>
        {result.value === null
          ? <span data-testid="no-value">No value — {result.unavailableReason
              ? `${readableCode(result.unavailableReason)} (${result.unavailableReason})`
              : 'no reason recorded'}</span>
          : <span data-testid="value">{result.value} <span style={{ fontSize: 'var(--t-sm)' }}>{result.unit}</span></span>}
      </p>

      {/* CONFIDENCE NEVER TRAVELS ALONE. MVP-10 can carry confidence
          INSUFFICIENT beside a real value whose validation state is `valid`
          (the engine's confidenceOverride). Read on its own that confidence
          says "insufficient" over a number that is fine, so the state it
          qualifies is repeated in the same sentence rather than left to the
          badge above. */}
      <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }} data-testid="quality-line">
        Validation {result.validation.state} · confidence {result.quality.confidence}
        {' · '}completeness {Math.round(result.quality.completeness * 100)}%
        {result.quality.worstSourceQuality
          ? ` · weakest source ${result.quality.worstSourceQuality}`
          : ' · no source quality recorded'}
      </p>

      {result.validation.hardBlocks.length > 0 && (
        <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>
          Blocked by: {result.validation.hardBlocks.map(readableCode).join(', ')}
        </p>
      )}
      {result.validation.warnings.length > 0 && (
        <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>
          Warnings: {result.validation.warnings.map(readableCode).join(', ')}
        </p>
      )}

      {/* NOT "awaiting review". `humanReviewRequired` is copied from the
          formula DEFINITION at compute time; it is identical on every result
          that formula will ever produce, and nothing anywhere updates
          pilot.shadow_formula_results to clear it. Rendered as a queue state
          it would say "awaiting review" forever, for every result, and teach a
          coach that the words mean nothing. It is a property of the FORMULA
          and is worded as one. There is also no per-result review control
          here: `perResultReviewState` is always null because no column, table
          or writer for it exists, and this screen does not invent a place to
          put one. */}
      {entry.formulaRequiresHumanReview && (
        <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }} data-testid="human-review-note">
          This formula is defined as one whose outputs a human should read before they are
          acted on. It is a standing property of {result.formulaId}, not a review queued
          against this result.
        </p>
      )}

      <p className="t-data mt-[var(--s2)]" style={{ fontSize: 'var(--t-xs)' }}>
        Computed {computed ?? result.computedAt} from {result.inputObservationIds.length}
        {result.inputObservationIds.length === 1 ? ' observation' : ' observations'}
      </p>
    </li>
  );
}

export default function AthleteIntelligencePage() {
  const [athletes, setAthletes] = useState<AthleteOption[]>([]);
  const [athleteId, setAthleteId] = useState('');
  const [model, setModel] = useState<AthleteIntelligenceReadModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/athletes/list`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { items?: AthleteOption[] };
        if (!controller.signal.aborted) setAthletes(payload.items ?? []);
      } catch {
        // Silent: the picker degrades to empty, same as Transfer Check.
      }
    })();
    return () => controller.abort();
  }, []);

  const reload = useCallback(async (id: string, signal?: AbortSignal) => {
    const response = await fetch(
      `${apiBase()}/api/pilot/coach/athlete-intelligence?athlete_id=${encodeURIComponent(id)}`,
      { credentials: 'include', signal },
    );
    if (!response.ok) throw new Error('This athlete’s computed values could not be read.');
    const payload = (await response.json()) as Partial<AthleteIntelligenceReadModel>;
    // A payload without the section is an UNREADABLE result, not an empty one.
    // Defaulting it to [] here would render "nothing computed" over a read that
    // never happened -- the difference between "no formula has run" and "we
    // could not tell", on a screen whose whole job is to say which.
    if (!payload || !payload.formulaOutputs) {
      throw new Error('This athlete’s computed values could not be read.');
    }
    setModel(payload as AthleteIntelligenceReadModel);
  }, []);

  useEffect(() => {
    if (!athleteId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        await reload(athleteId, controller.signal);
        if (controller.signal.aborted) return;
        setErrorMessage(null);
        setLoading(false);
      } catch (error) {
        if (controller.signal.aborted) return;
        setModel(null);
        setErrorMessage(error instanceof Error
          ? error.message
          : 'This athlete’s computed values could not be read.');
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [athleteId, reload]);

  const outputs = model?.formulaOutputs;

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      {/* THIS SCREEN PAINTS NO ROOM CLASS, DELIBERATELY -- and this note avoids
          spelling the class prefix, because legacyVisualVocabulary.test.ts
          counts raw occurrences and does not skip comments, so explaining the
          rule in the token's own letters breaks it.

          Rooms were retired as a visual concept by owner decision on
          2026-08-23. That guard freezes the family at its reset count and says
          it in as many words: "a screen written from here on does not paint
          one", and the ceiling "may not go up". The peer coach surfaces beside
          this one all paint theirs; that is frozen debt, not a pattern to copy.
          buildingMapRooms.test.ts no longer requires the paint to match the
          door, and the door in buildingMap.ts still files this page under
          `room: 'floor'` -- kept by that same decision as STRUCTURAL METADATA,
          which is routing, not appearance. */}
      <main className="min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl">
          <header className="mb-[var(--s5)]">
            <p className="t-eyebrow">Coach Workspace</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Athlete Intelligence</h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              The latest computed value of every formula output for one athlete, with what
              qualifies it — validation, confidence, completeness and the weakest source
              behind it. These are computed automatically when a submission completes a
              formula&rsquo;s inputs. Read-only: nothing here scores, ranks, compares one
              athlete to another, or decides anything.
            </p>
          </header>

          {errorMessage && (
            <div className="mat-leather rounded-[var(--r-md)] p-[var(--s3)]" role="alert">
              <p className="t-body font-semibold text-[color:var(--bone-100)]">{errorMessage}</p>
              <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>
                Nothing is shown below, because a failed read is not an empty record.
              </p>
            </div>
          )}

          <div className="field mb-[var(--s5)] md:max-w-sm">
            <label className="t-label" htmlFor="intelligence-athlete">Athlete</label>
            <select id="intelligence-athlete" className="select" value={athleteId}
              onChange={(e) => { setLoading(e.target.value !== ''); setAthleteId(e.target.value); }}>
              <option value="">Select an athlete…</option>
              {athletes.map((athlete) => (
                <option key={athlete.athlete_id} value={athlete.athlete_id}>{athlete.full_name}</option>
              ))}
            </select>
          </div>

          {athleteId && loading && (
            <div className="flex justify-center py-[var(--s6)]">
              <span className="working">Reading computed values...</span>
            </div>
          )}

          {athleteId && !loading && outputs && (
            <>
              <section aria-labelledby="formula-outputs-heading">
                <h2 id="formula-outputs-heading" className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
                  Formula outputs
                </h2>
                {outputs.availability === 'none_recorded' ? (
                  <div className="mat-leather mt-[var(--s3)] rounded-[var(--r-lg)]">
                    <div className="empty">
                      <div className="empty-title">Nothing has been computed for this athlete</div>
                      <p className="empty-msg mx-auto">
                        That is not a clean bill of health. It means no formula has had a
                        complete set of inputs yet — absence of evidence is not evidence.
                      </p>
                    </div>
                  </div>
                ) : (
                  <ul className="mt-[var(--s3)] space-y-[var(--s2)]">
                    {outputs.items.map((entry) => (
                      <FormulaOutputCard
                        key={`${entry.result.formulaId}:${entry.result.outputKey}:${entry.result.resultId}`}
                        entry={entry}
                      />
                    ))}
                  </ul>
                )}
              </section>

              {/* AVAILABILITY, NOT A SECOND COPY. Each of these is fully
                  rendered on the surface that owns it; saying here whether
                  there is anything to go and read costs one line and creates
                  no second version of the record to disagree with. */}
              <section aria-labelledby="elsewhere-heading" className="mt-[var(--s5)]">
                <h2 id="elsewhere-heading" className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
                  Read on their own screens
                </h2>
                <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>
                  The same read carries three more sources. They are shown where they belong
                  rather than repeated here, so one record never has two screens telling
                  different stories about it.
                </p>
                <ul className="mt-[var(--s3)] space-y-[var(--s2)]">
                  <li className="mat-leather rounded-[var(--r-md)] p-[var(--s3)]">
                    <span className="t-body font-semibold text-[color:var(--bone-100)]">Training attempts</span>
                    <span className="t-body"> — {availabilityLine(
                      model.trainingAttempts.availability, model.trainingAttempts.items.length)}.</span>
                    {' '}<Link href="/coach/attempt-log" className="btn btn--ghost">Attempt Log</Link>
                  </li>
                  <li className="mat-leather rounded-[var(--r-md)] p-[var(--s3)]">
                    <span className="t-body font-semibold text-[color:var(--bone-100)]">
                      Metric transfer, last {model.metricTransfer.windowDays} days
                    </span>
                    <span className="t-body"> — {availabilityLine(
                      model.metricTransfer.availability, model.metricTransfer.items.length)}.</span>
                    {' '}<Link href="/coach/transfer-check" className="btn btn--ghost">Transfer Check</Link>
                  </li>
                  <li className="mat-leather rounded-[var(--r-md)] p-[var(--s3)]">
                    <span className="t-body font-semibold text-[color:var(--bone-100)]">
                      Film Study a coach has accepted
                    </span>
                    <span className="t-body"> — {availabilityLine(
                      model.reviewedFilmStudy.availability, model.reviewedFilmStudy.items.length)}.</span>
                    {' '}<Link href="/coach/video-analysis" className="btn btn--ghost">Video Analysis</Link>
                  </li>
                </ul>
              </section>

              <p className="t-data mt-[var(--s5)]" style={{ fontSize: 'var(--t-xs)' }}>
                Read taken {formatGymStamp(model.generatedAt) ?? model.generatedAt}. Every item above
                carries its own timestamp; this one is only when the page asked.
              </p>
            </>
          )}

          <div className="mt-[var(--s5)]">
            <Link href="/coach/transfer-check" className="btn btn--ghost">Transfer Check</Link>{' '}
            <Link href="/coach/intelligence" className="btn btn--ghost">The Morning Read</Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
