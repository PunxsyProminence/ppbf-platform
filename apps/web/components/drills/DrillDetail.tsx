'use client';

import { type ReactNode, useEffect, useRef } from 'react';

import {
  executionSteps,
  humanizeContactLevel,
  listItems,
  scaleLevelName,
  setupAndEquipment,
} from '@/src/lib/drillPresentation';

import type { DrillDetailView, DrillStopRuleView } from './drillDetailView';

// LEVEL 2 of OD-2026-09-19-001: the complete, organized drill. LEVEL 1 is the
// summary card a list renders; LEVEL 3 is the <details> expanders below, used
// only where more depth is useful (each scale level, corrections, coach notes).
//
// SAFETY IS NEVER BEHIND AN EXPANDER. Contact level, the coach-authorization
// requirement and the stop rules are the first section and always open, so
// nobody has to go looking for when to stop.
//
// Nothing here writes. There is no completion, logging or assignment control,
// and the only interactive elements are the expanders and whatever `actions`
// the caller passes in.

const SECTION = 'space-y-[var(--s2)]';
const BODY = 'text-[length:var(--t-sm)] leading-relaxed text-[color:var(--bone-300)]';
const LIST = `${BODY} list-disc space-y-[var(--s1)] pl-[var(--s5)]`;
const EXPANDER = 'rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.2)] px-[var(--s3)] py-[var(--s2)]';
// The summary is the tap target, so it carries the 44px floor itself; padding
// on the <details> alone left an ~11px target. It keeps its default display
// (list-item) on purpose: that is what draws the open/closed disclosure marker,
// and without it an expander reads as a plain label.
const EXPANDER_SUMMARY = 't-label min-h-[44px] cursor-pointer py-[var(--s3)]';

export interface DrillDetailProps {
  view: DrillDetailView;
  audience: 'athlete' | 'coach';
  /** Rendered in the header: e.g. the coach's lifecycle state and Promote action. */
  actions?: ReactNode;
  /**
   * Move focus to the drill's heading when it appears. The list that opened it
   * is hidden at that moment, taking the focused button with it; without this,
   * keyboard and screen-reader users are left on <body>.
   */
  focusOnMount?: boolean;
}

export default function DrillDetail({ view, audience, actions, focusOnMount = false }: DrillDetailProps) {
  const headingId = `drill-detail-${view.id}`;
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (focusOnMount) headingRef.current?.focus();
  }, [focusOnMount, view.id]);

  const steps = executionSteps(view.execution);
  // Three groups, because they are three different instructions. A readiness
  // rule ("re-warm before contact after ~20 minutes idle") is something to do
  // BEFORE the drill, not a condition for stopping it.
  const drillSpecificStops = view.stopRules.filter((rule) => rule.scope === 'drill_specific' && rule.kind !== 'warmup_decay');
  const readiness = view.stopRules.filter((rule) => rule.kind === 'warmup_decay');
  const generalStops = view.stopRules.filter((rule) => rule.scope !== 'drill_specific' && rule.kind !== 'warmup_decay');
  const { setup, equipment } = setupAndEquipment(view.setup, view.equipment);
  const coachStatus = view.coach ? referenceStatus(view.coach) : null;
  const good = listItems(view.good);
  const bad = listItems(view.bad);
  const errors = listItems(view.commonErrors);
  const corrections = listItems(view.corrections);

  return (
    <article aria-labelledby={headingId} className="mat-leather--raised space-y-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s5)]">
      <header className="space-y-[var(--s2)]">
        <div className="flex flex-wrap items-baseline justify-between gap-[var(--s3)]">
          <h2 id={headingId} ref={headingRef} tabIndex={-1} className="t-command text-[length:var(--t-lg)]">{view.name}</h2>
          {view.coach && <span className="plaque">{view.coach.difficulty}</span>}
        </div>
        {view.coach && (
          <p className="t-label">{view.coach.discipline} · {view.coach.category}</p>
        )}
        {/* Where the content came from, and whether it is current, sits beside
            the action it informs -- not behind an expander below it. */}
        {coachStatus && <p className={BODY}>{coachStatus}</p>}
        {actions && <div className="flex flex-wrap items-center gap-[var(--s3)]">{actions}</div>}
      </header>

      {/* SAFETY -- first and always open. */}
      <section aria-label="Safety" className={`${SECTION} rounded-[var(--r-md)] border-2 border-[color:var(--brass-700)] p-[var(--s4)]`}>
        <h3 className="t-label">Safety</h3>
        <p className={BODY}>
          <span className="font-semibold text-[color:var(--bone-200)]">Contact:</span> {humanizeContactLevel(view.contactLevel)}
        </p>
        <p className={BODY}>
          <span className="font-semibold text-[color:var(--bone-200)]">Coach authorization:</span>{' '}
          {view.requiresCoachAuthorization
            ? 'Required. Only run this drill with a coach who has approved it.'
            : 'Not required.'}
        </p>
        {drillSpecificStops.length === 0 && generalStops.length === 0 && (
          <p className={BODY}>No stop rules are recorded for this drill.</p>
        )}
        {drillSpecificStops.length > 0 && (
          <StopRuleList heading={"This drill's stop rules"} rules={drillSpecificStops} />
        )}
        {generalStops.length > 0 && (
          <StopRuleList heading="Stop rules for every drill" rules={generalStops} />
        )}
        {readiness.length > 0 && (
          <StopRuleList heading="Before contact or maximal effort" rules={readiness} />
        )}
      </section>

      {view.purpose && (
        <section className={SECTION}>
          <h3 className="t-label">What it is for</h3>
          <p className={BODY}>{view.purpose}</p>
        </section>
      )}

      {/* Setup instructions and equipment each under their true label: in most
          of the corpus the "setup" column holds only the equipment word. */}
      {setup && (
        <section className={SECTION}>
          <h3 className="t-label">Setup</h3>
          <p className={BODY}>{setup}</p>
        </section>
      )}
      {equipment && (
        <section className={SECTION}>
          <h3 className="t-label">Equipment</h3>
          <p className={BODY}>{equipment}</p>
        </section>
      )}

      {steps.length > 0 && (
        <section className={SECTION}>
          <h3 className="t-label">How it runs</h3>
          {steps.length > 1 ? (
            <ol className={`${BODY} list-decimal space-y-[var(--s2)] pl-[var(--s5)]`}>
              {steps.map((step, index) => (
                <li key={`${view.id}-step-${index}`}>{step}</li>
              ))}
            </ol>
          ) : (
            <p className={BODY}>{steps[0]}</p>
          )}
        </section>
      )}

      {good.length > 0 && (
        <section className={SECTION}>
          <h3 className="t-label">What good looks like</h3>
          <ul className={LIST}>
            {good.map((item, index) => <li key={`${view.id}-good-${index}`}>{item}</li>)}
          </ul>
        </section>
      )}

      {(bad.length > 0 || errors.length > 0) && (
        <section className={SECTION}>
          <h3 className="t-label">What to avoid</h3>
          {bad.length > 0 && (
            <ul className={LIST}>
              {bad.map((item, index) => <li key={`${view.id}-bad-${index}`}>{item}</li>)}
            </ul>
          )}
          {errors.length > 0 && (
            <>
              <p className="t-label text-[color:var(--bone-300)]">Common errors</p>
              <ul className={LIST}>
                {errors.map((item, index) => <li key={`${view.id}-error-${index}`}>{item}</li>)}
              </ul>
            </>
          )}
        </section>
      )}

      {view.cues.length > 0 && (
        <section className={SECTION}>
          <h3 className="t-label">Coaching cues</h3>
          <ul className="flex flex-wrap gap-[var(--s2)]">
            {view.cues.map((cue) => (
              <li
                key={`${view.id}-cue-${cue}`}
                className="rounded-[var(--r-sm)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s2)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]"
              >
                {cue}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* LEVEL 3: corrections, when present, one expander deep. */}
      {corrections.length > 0 && (
        <details className={EXPANDER}>
          <summary className={EXPANDER_SUMMARY}>Corrections</summary>
          <ul className={`${LIST} mt-[var(--s2)]`}>
            {corrections.map((item, index) => <li key={`${view.id}-correction-${index}`}>{item}</li>)}
          </ul>
        </details>
      )}

      {view.scaleLevels.length > 0 && (
        <section className={SECTION}>
          <h3 className="t-label">Scaling</h3>
          <div className="space-y-[var(--s2)]">
            {view.scaleLevels.map((level) => (
              // LEVEL 3: each level expands. The starting level opens by default,
              // so the ordinary way to run the drill is visible without a click.
              <details key={`${view.id}-scale-${level.level}`} className={EXPANDER} open={level.isStartingPoint}>
                <summary className={EXPANDER_SUMMARY}>
                  {scaleLevelName(level.level)}
                  {level.isStartingPoint ? ' · where to start' : ''}
                  {level.contactLevel && level.contactLevel !== view.contactLevel
                    ? ` · ${humanizeContactLevel(level.contactLevel)}`
                    : ''}
                  {audience === 'coach' && level.authoringState && level.authoringState !== 'authored'
                    ? ' · draft, not floor-validated'
                    : ''}
                </summary>
                <div className="mt-[var(--s2)] space-y-[var(--s2)]">
                  {level.demand && <p className={BODY}>{level.demand}</p>}
                  {level.constraint && (
                    <p className={BODY}>
                      <span className="font-semibold text-[color:var(--bone-200)]">Constraint:</span> {level.constraint}
                    </p>
                  )}
                  {audience === 'coach' && level.watchPoint && (
                    <p className={BODY}>
                      <span className="font-semibold text-[color:var(--bone-200)]">Watch for:</span> {level.watchPoint}
                    </p>
                  )}
                </div>
              </details>
            ))}
          </div>
        </section>
      )}

      {view.coach && <CoachContext view={view} />}
    </article>
  );
}

function StopRuleList({ heading, rules }: { heading: string; rules: DrillStopRuleView[] }) {
  return (
    <div className="space-y-[var(--s1)]">
      <p className="text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-200)]">{heading}</p>
      <ol className={`${BODY} list-decimal space-y-[var(--s1)] pl-[var(--s5)]`}>
        {rules.map((rule) => (
          <li key={`stop-${rule.ordinal}`}>{rule.text}</li>
        ))}
      </ol>
    </div>
  );
}

/**
 * One line a coach reads before adopting: whether the content is the gym's
 * source manual or an unvalidated draft, and whether this version is current.
 */
function referenceStatus(coach: NonNullable<DrillDetailView['coach']>): string {
  const provenance = coach.fieldProvenance?.trim() || 'Content status not recorded';
  const lifecycle = coach.supersededAt
    ? 'Superseded by a newer version.'
    : coach.active
      ? 'Current version.'
      : 'Retracted.';
  return `Content: ${provenance}. ${lifecycle}`;
}

/** Coach-only: planning context, lifecycle, version and provenance. Never rendered for an athlete. */
function CoachContext({ view }: { view: DrillDetailView }) {
  const coach = view.coach;
  if (!coach) return null;
  const transfer = listItems(coach.transfer);
  const showTarget = coach.targetBehavior && coach.targetBehavior.trim() !== view.purpose.trim();

  return (
    <div className="space-y-[var(--s2)]">
      {(transfer.length > 0 || showTarget) && (
        <details className={EXPANDER}>
          <summary className={EXPANDER_SUMMARY}>Coaching notes</summary>
          <div className="mt-[var(--s2)] space-y-[var(--s2)]">
            {showTarget && (
              <p className={BODY}>
                <span className="font-semibold text-[color:var(--bone-200)]">Target behaviour:</span> {coach.targetBehavior}
              </p>
            )}
            {transfer.length > 0 && (
              <>
                <p className="t-label text-[color:var(--bone-300)]">Transfer</p>
                <ul className={LIST}>
                  {transfer.map((item, index) => <li key={`${view.id}-transfer-${index}`}>{item}</li>)}
                </ul>
              </>
            )}
          </div>
        </details>
      )}

      <details className={EXPANDER}>
        <summary className={EXPANDER_SUMMARY}>Source and version</summary>
        <dl className={`${BODY} mt-[var(--s2)] grid grid-cols-[max-content_minmax(0,1fr)] gap-x-[var(--s3)] gap-y-[var(--s1)] [overflow-wrap:anywhere]`}>
          <dt className="font-semibold text-[color:var(--bone-200)]">Content status</dt>
          <dd>{coach.fieldProvenance || 'Not recorded'}</dd>
          <dt className="font-semibold text-[color:var(--bone-200)]">Content class</dt>
          <dd>{coach.contentClass || 'Not recorded'}</dd>
          <dt className="font-semibold text-[color:var(--bone-200)]">Source</dt>
          <dd>{coach.sourceRef || 'Not recorded'}</dd>
          <dt className="font-semibold text-[color:var(--bone-200)]">Version</dt>
          <dd>
            {coach.version}
            {coach.supersedesDrillId ? ' (replaces an earlier version)' : ''}
            {coach.supersededAt ? ' · superseded by a newer version' : ''}
            {!coach.active && !coach.supersededAt ? ' · retracted' : ''}
          </dd>
          <dt className="font-semibold text-[color:var(--bone-200)]">Skill</dt>
          <dd>
            {coach.skillId || 'Not recorded'}
            {coach.secondarySkills.length > 0 ? ` (also ${coach.secondarySkills.join(', ')})` : ''}
          </dd>
          {coach.groundingClaimIds.length > 0 && (
            <>
              <dt className="font-semibold text-[color:var(--bone-200)]">Grounding claims</dt>
              <dd>{coach.groundingClaimIds.join(', ')}</dd>
            </>
          )}
        </dl>
      </details>
    </div>
  );
}
