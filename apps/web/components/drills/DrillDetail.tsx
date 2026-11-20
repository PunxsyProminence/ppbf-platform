'use client';

import { type ReactNode, useEffect, useRef } from 'react';

import {
  executionSteps,
  humanizeContactLevel,
  listItemsOrNotWritten,
  scaleLevelName,
  setupAndEquipment,
} from '@/src/lib/drillPresentation';

import type { GroundingEvidence } from '@/src/server/pilot/drillGroundingEvidence';
import type { DrillMarkedField } from '@/src/server/pilot/drillLibraryV3';
import { AI_DRAFT_MARK, DRAFT_NOT_CHECKED } from '@/src/lib/sessionScriptWords';

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
// On a gym-floor (kiosk) page -- /coach/drills (OD-2026-11-17-009 ruling 4) and
// the athlete pages -- text rises to the 19.1px kiosk floor and expanders to the
// 55px tap floor; desk pages that mount this keep their sizes. `in-data-` is
// Tailwind's ancestor variant: `:where([data-surface="kiosk"]) &`.
const KIOSK_TEXT = 'in-data-[surface=kiosk]:text-[length:var(--t-md)]';
// On /coach/drills this card is light parchment (golden-era `.ge-drillcase
// .mat-leather--raised`, flat background #E3CFAE). The bone inks are for dark
// leather: --bone-300 #DCCFB2 reads at 1.01:1 there and --bone-200 #EFE6D0 at
// 1.22:1, and the source link's --brass-300 #D6B063 at about 1.35:1. Inside
// .ge-drillcase this text inherits the card's own ink (#3A2E1D: 8.69:1 on the
// card, about 5.6:1 inside an expander's 20% black wash); every other page is
// unchanged. OD-2026-11-17-009 rulings 1 and 4 (OW25-34 A, OW25-37 A).
const CARD_INK = 'in-[.ge-drillcase]:text-[color:inherit]';
// Body-weight words inside a .t-label (an expander's summary, a label line) take the card's body ink
// outright: inherited, they get the label ink #4A3B26, 4.07:1 at worst on the wash (lane ED-UI PR3).
const CARD_BODY_INK = 'in-[.ge-drillcase]:text-[color:#3A2E1D]';
const BODY = `text-[length:var(--t-sm)] ${KIOSK_TEXT} leading-relaxed text-[color:var(--bone-300)] ${CARD_INK}`;
const LIST = `${BODY} list-disc space-y-[var(--s1)] pl-[var(--s5)]`;
const EXPANDER = 'rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.2)] px-[var(--s3)] py-[var(--s2)]';
// The summary is the tap target, so it carries the 44px floor itself; padding
// on the <details> alone left an ~11px target. It keeps its default display
// (list-item) on purpose: that is what draws the open/closed disclosure marker,
// and without it an expander reads as a plain label.
const EXPANDER_SUMMARY = 't-label min-h-[44px] in-data-[surface=kiosk]:min-h-[var(--tap)] cursor-pointer py-[var(--s3)]';

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
  /**
   * The scale level a plan chose for this drill (a session plan block's
   * scale_level). That level opens and says so; without one, the starting
   * level opens as before.
   */
  chosenScale?: string | null;
}

export default function DrillDetail({ view, audience, actions, focusOnMount = false, chosenScale = null }: DrillDetailProps) {
  const headingId = `drill-detail-${view.id}`;
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (focusOnMount) headingRef.current?.focus();
  }, [focusOnMount, view.id]);

  // A chosen level the drill has no row for opens nothing of its own: the starting level opens as usual.
  const openLevel = chosenScale !== null && view.scaleLevels.some((level) => level.level === chosenScale) ? chosenScale : null;

  const steps = executionSteps(view.execution);
  // Three groups, because they are three different instructions. A readiness
  // rule ("re-warm before contact after ~20 minutes idle") is something to do
  // BEFORE the drill, not a condition for stopping it, wherever it came from.
  //
  // The other two split by ORIGIN, not by the legacy scope label (owner ruling
  // R3, 2026-09-29): the drill's own rules -- the lines seeded with
  // scope='universal' on every drill included, because R3 says they are not
  // universal -- and the gym's stored-once rules, which are. Grouping by scope
  // put those five generic lines under "Stop rules for every drill", beside the
  // injury rule that really is (drillDetailView.ts, DrillStopRuleView).
  const ownStops = view.stopRules.filter((rule) => rule.origin === 'drill' && rule.kind !== 'warmup_decay');
  const readiness = view.stopRules.filter((rule) => rule.kind === 'warmup_decay');
  const everyDrillStops = view.stopRules.filter((rule) => rule.origin === 'universal' && rule.kind !== 'warmup_decay');
  const { setup, equipment } = setupAndEquipment(view.setup, view.equipment, view.id, view.coach?.lineageId);
  const coachStatus = view.coach ? referenceStatus(view.coach) : null;
  const good = listItemsOrNotWritten(view.good);
  const bad = listItemsOrNotWritten(view.bad);
  const errors = listItemsOrNotWritten(view.commonErrors);
  const corrections = listItemsOrNotWritten(view.corrections);
  // Lane NW-b (PK-197 A): the frozen Backbone's two fields, shown as written or as not written.
  const exitCondition = listItemsOrNotWritten(view.exitCondition);
  const correctionPath = listItemsOrNotWritten(view.correctionPath);
  // THE STAFF AI-DRAFT MARK (OW25-57, OD-2026-11-19-012: coaches and admins only; lane ED-UI PR3).
  // Beside each drafted field; a labelled version's unchecked field says so; a version with no
  // label row says so once, under the header (Q4 = A). Never on an athlete view (coach is null there).
  const drafts = audience === 'coach' ? view.coach?.fieldDrafts ?? null : null;
  const labelled = drafts?.labelled === true;
  const mark = (state: boolean | null | undefined, onDark = false) => (labelled ? <DraftMark state={state} onDark={onDark} /> : null);
  const field = (key: DrillMarkedField) => mark(drafts?.fields[key]);
  // The header (a near-black ground on /coach/drills, Q-PR1-3) keeps a light ink.
  const headerField = (key: DrillMarkedField) => mark(drafts?.fields[key], true);
  // Equipment shows the setup column's word only when equipment is blank and that word is not shown as Setup
  // (setupAndEquipment); otherwise its words are the equipment column's, a blank one's included.
  const equipmentKey: DrillMarkedField = !view.equipment.trim() && setup === null && view.setup.trim() ? 'standard_setup' : 'equipment_needed';

  return (
    <article aria-labelledby={headingId} className="mat-leather--raised space-y-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s5)]">
      <header className="space-y-[var(--s2)]">
        <div className="flex flex-wrap items-baseline justify-between gap-[var(--s3)]">
          <div className="flex flex-wrap items-baseline gap-[var(--s2)]">
            <h2 id={headingId} ref={headingRef} tabIndex={-1} className="t-command text-[length:var(--t-lg)]">{view.name}</h2>
            {headerField('name')}
          </div>
          {view.coach && (
            <span className="flex flex-wrap items-baseline">
              <span className="plaque"><span className={KIOSK_TEXT}>{view.coach.difficulty}</span></span>
              {headerField('difficulty')}
            </span>
          )}
        </div>
        {view.coach && (
          <p className="t-label">{view.coach.discipline}{headerField('discipline')} · {view.coach.category}{headerField('category')}</p>
        )}
        {/* Where the content came from, and whether it is current, sits beside
            the action it informs -- not behind an expander below it. */}
        {coachStatus && <p className={BODY}>{coachStatus}</p>}
        {actions && <div className="flex flex-wrap items-center gap-[var(--s3)]">{actions}</div>}
      </header>
      {/* Under the header (Q4 = A), on the card's own ground. */}
      {drafts && !labelled && <p className={BODY}>({DRAFT_NOT_CHECKED})</p>}

      {/* SAFETY -- first and always open. */}
      <section aria-label="Safety" className={`${SECTION} rounded-[var(--r-md)] border-2 border-[color:var(--brass-700)] p-[var(--s4)]`}>
        <h3 className="t-label">Safety</h3>
        <p className={BODY}>
          <span className="font-semibold text-[color:var(--bone-200)] in-[.ge-drillcase]:text-[color:inherit]">Contact:</span> {humanizeContactLevel(view.contactLevel)}
          {field('contact_level')}
        </p>
        <p className={BODY}>
          <span className="font-semibold text-[color:var(--bone-200)] in-[.ge-drillcase]:text-[color:inherit]">Coach authorization:</span>{' '}
          {view.requiresCoachAuthorization
            ? 'Required. Only run this drill with a coach who has approved it.'
            : 'Not required.'}
          {field('requires_coach_authorization')}
        </p>
        {ownStops.length === 0 && everyDrillStops.length === 0 && (
          <p className={BODY}>No stop rules are recorded for this drill.</p>
        )}
        {ownStops.length > 0 && (
          <StopRuleList heading="Stop rules" rules={ownStops} mark={field('stop_rules')} />
        )}
        {everyDrillStops.length > 0 && (
          <StopRuleList heading="Stop rules for every drill" rules={everyDrillStops} />
        )}
        {readiness.length > 0 && (
          // The drill's own rules here carry the list's mark, each; the gym's stored-once rules are not the drill's.
          <StopRuleList heading="Before contact or maximal effort" rules={readiness} itemMark={(rule) => (rule.origin === 'drill' ? field('stop_rules') : null)} />
        )}
      </section>

      {view.purpose && (
        <section className={SECTION}>
          <Heading mark={field('purpose')}>What it is for</Heading>
          <p className={BODY}>{view.purpose}</p>
        </section>
      )}

      {/* Setup instructions and equipment each under their true label: in most
          of the corpus the "setup" column holds only the equipment word. */}
      {setup && (
        <section className={SECTION}>
          <Heading mark={field('standard_setup')}>Setup</Heading>
          <p className={BODY}>{setup}</p>
        </section>
      )}
      {equipment && (
        <section className={SECTION}>
          <Heading mark={field(equipmentKey)}>Equipment</Heading>
          <p className={BODY}>{equipment}</p>
        </section>
      )}

      {steps.length > 0 && (
        <section className={SECTION}>
          <Heading mark={field('execution')}>How it runs</Heading>
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

      <section className={SECTION}>
        <Heading mark={field('what_good_looks_like')}>What good looks like</Heading>
        <ul className={LIST}>
          {good.map((item, index) => <li key={`${view.id}-good-${index}`}>{item}</li>)}
        </ul>
      </section>

      <section className={SECTION}>
        <Heading mark={field('what_bad_looks_like')}>What to avoid</Heading>
        <ul className={LIST}>
          {bad.map((item, index) => <li key={`${view.id}-bad-${index}`}>{item}</li>)}
        </ul>
        <p className="t-label text-[color:var(--bone-300)]">Common errors{field('common_errors')}</p>
        <ul className={LIST}>
          {errors.map((item, index) => <li key={`${view.id}-error-${index}`}>{item}</li>)}
        </ul>
      </section>

      <section className={SECTION}>
        <Heading mark={field('exit_condition')}>Exit condition</Heading>
        <ul className={LIST}>
          {exitCondition.map((item, index) => <li key={`${view.id}-exit-${index}`}>{item}</li>)}
        </ul>
      </section>

      {view.cues.length > 0 && (
        <section className={SECTION}>
          <Heading mark={field('cues')}>Coaching cues</Heading>
          <ul className="flex flex-wrap gap-[var(--s2)]">
            {view.cues.map((cue) => (
              <li
                key={`${view.id}-cue-${cue}`}
                className={`rounded-[var(--r-sm)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s2)] text-[length:var(--t-xs)] ${KIOSK_TEXT} text-[color:var(--bone-300)] ${CARD_INK}`}
              >
                {cue}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* LEVEL 3: corrections, one expander deep; an unwritten field says so. */}
      <details className={EXPANDER}>
        <summary className={EXPANDER_SUMMARY}>Corrections{field('corrections')}</summary>
        <ul className={`${LIST} mt-[var(--s2)]`}>
          {corrections.map((item, index) => <li key={`${view.id}-correction-${index}`}>{item}</li>)}
        </ul>
        <p className="t-label mt-[var(--s2)] text-[color:var(--bone-300)]">Correction path{field('correction_path')}</p>
        <ul className={LIST}>
          {correctionPath.map((item, index) => <li key={`${view.id}-correction-path-${index}`}>{item}</li>)}
        </ul>
      </details>

      {view.scaleLevels.length > 0 && (
        <section className={SECTION}>
          <h3 className="t-label">Scaling</h3>
          <div className="space-y-[var(--s2)]">
            {view.scaleLevels.map((level) => (
              // LEVEL 3: each level expands. The starting level opens by default,
              // so the ordinary way to run the drill is visible without a click;
              // a level the plan chose opens instead.
              <details
                key={`${view.id}-scale-${level.level}`}
                className={EXPANDER}
                open={openLevel ? level.level === openLevel : level.isStartingPoint}
              >
                <summary className={EXPANDER_SUMMARY}>
                  {scaleLevelName(level.level)}
                  {level.level === openLevel ? ' · chosen for this block' : ''}
                  {level.isStartingPoint ? ' · where to start' : ''}
                  {level.contactLevel && level.contactLevel !== view.contactLevel
                    ? ` · ${humanizeContactLevel(level.contactLevel)}`
                    : ''}
                  {audience === 'coach' && level.authoringState && level.authoringState !== 'authored'
                    ? ' · draft, not floor-validated'
                    : ''}
                  {mark(drafts?.scaleLevels[level.level])}
                </summary>
                <div className="mt-[var(--s2)] space-y-[var(--s2)]">
                  {level.demand && <p className={BODY}>{level.demand}</p>}
                  {level.constraint && (
                    <p className={BODY}>
                      <span className="font-semibold text-[color:var(--bone-200)] in-[.ge-drillcase]:text-[color:inherit]">Constraint:</span> {level.constraint}
                    </p>
                  )}
                  {audience === 'coach' && level.watchPoint && (
                    <p className={BODY}>
                      <span className="font-semibold text-[color:var(--bone-200)] in-[.ge-drillcase]:text-[color:inherit]">Watch for:</span> {level.watchPoint}
                    </p>
                  )}
                </div>
              </details>
            ))}
          </div>
        </section>
      )}

      {view.coach && <CoachContext view={view} field={field} />}
    </article>
  );
}

/** A section heading, with the staff AI-draft mark beside it (not inside: the heading keeps its name). */
function Heading({ children, mark }: { children: ReactNode; mark: ReactNode }) {
  if (!mark) return <h3 className="t-label">{children}</h3>;
  return (
    <div className="flex flex-wrap items-baseline">
      <h3 className="t-label">{children}</h3>
      {mark}
    </div>
  );
}

/** The 6e mark and words (sessionScriptWords.ts), beside one field: a draft, or not checked; nothing when not a draft. */
function DraftMark({ state, onDark = false }: { state: boolean | null | undefined; onDark?: boolean }) {
  if (state === false) return null;
  if (state === true) return <span className="badge badge--filed ml-[var(--s2)]"><i aria-hidden="true">◉</i>{AI_DRAFT_MARK}</span>;
  // As 6e shows it: sentence case, the body face, weight and size (with the kiosk rise), also inside a label or
  // beside a heading. Off the parchment, the design system's lift (--bone-200): the console's lit card is
  // mid-brown. On the parchment card the card's body ink (CARD_BODY_INK); in its dark header the lift again.
  return (
    <span
      className={`ml-[var(--s2)] font-[family-name:var(--font-body)] font-normal normal-case tracking-normal text-[length:var(--t-sm)] ${KIOSK_TEXT} text-[color:var(--bone-200)] ${CARD_BODY_INK}`}
      style={onDark ? { color: 'var(--bone-200)' } : undefined}
    >
      ({DRAFT_NOT_CHECKED})
    </span>
  );
}

function StopRuleList({ heading, rules, mark = null, itemMark }: {
  heading: string;
  rules: DrillStopRuleView[];
  mark?: ReactNode;
  itemMark?: (rule: DrillStopRuleView) => ReactNode;
}) {
  return (
    <div className="space-y-[var(--s1)]">
      <p className={`text-[length:var(--t-sm)] ${KIOSK_TEXT} font-semibold text-[color:var(--bone-200)] in-[.ge-drillcase]:text-[color:inherit]`}>{heading}{mark}</p>
      <ol className={`${BODY} list-decimal space-y-[var(--s1)] pl-[var(--s5)]`}>
        {/* Keyed by origin as well: the readiness list can hold a drill rule
            and a stored-once rule at the same ordinal. */}
        {rules.map((rule) => (
          <li key={`stop-${rule.origin}-${rule.ordinal}`}>{rule.text}{itemMark?.(rule)}</li>
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
function CoachContext({ view, field }: { view: DrillDetailView; field: (key: DrillMarkedField) => ReactNode }) {
  const coach = view.coach;
  if (!coach) return null;
  const transfer = listItemsOrNotWritten(coach.transfer);
  const showTarget = coach.targetBehavior && coach.targetBehavior.trim() !== view.purpose.trim();

  return (
    <div className="space-y-[var(--s2)]">
      <details className={EXPANDER}>
        <summary className={EXPANDER_SUMMARY}>Coaching notes</summary>
        <div className="mt-[var(--s2)] space-y-[var(--s2)]">
          {showTarget && (
            <p className={BODY}>
              <span className="font-semibold text-[color:var(--bone-200)] in-[.ge-drillcase]:text-[color:inherit]">Target behaviour:</span> {coach.targetBehavior}
              {field('target_behavior')}
            </p>
          )}
          <p className="t-label text-[color:var(--bone-300)]">Transfer{field('transfer')}</p>
          <ul className={LIST}>
            {transfer.map((item, index) => <li key={`${view.id}-transfer-${index}`}>{item}</li>)}
          </ul>
        </div>
      </details>

      <details className={EXPANDER}>
        <summary className={EXPANDER_SUMMARY}>Source and version</summary>
        <dl className={`${BODY} mt-[var(--s2)] grid grid-cols-[max-content_minmax(0,1fr)] gap-x-[var(--s3)] gap-y-[var(--s1)] [overflow-wrap:anywhere]`}>
          <dt className="font-semibold text-[color:var(--bone-200)] in-[.ge-drillcase]:text-[color:inherit]">Content status</dt>
          <dd>{coach.fieldProvenance || 'Not recorded'}</dd>
          <dt className="font-semibold text-[color:var(--bone-200)] in-[.ge-drillcase]:text-[color:inherit]">Content class</dt>
          <dd>{coach.contentClass || 'Not recorded'}</dd>
          <dt className="font-semibold text-[color:var(--bone-200)] in-[.ge-drillcase]:text-[color:inherit]">Source</dt>
          <dd>{coach.sourceRef || 'Not recorded'}</dd>
          <dt className="font-semibold text-[color:var(--bone-200)] in-[.ge-drillcase]:text-[color:inherit]">Version</dt>
          <dd>
            {coach.version}
            {coach.supersedesDrillId ? ' (replaces an earlier version)' : ''}
            {coach.supersededAt ? ' · superseded by a newer version' : ''}
            {!coach.active && !coach.supersededAt ? ' · retracted' : ''}
          </dd>
          <dt className="font-semibold text-[color:var(--bone-200)] in-[.ge-drillcase]:text-[color:inherit]">Skill</dt>
          <dd>
            {coach.skillId || 'Not recorded'}
            {coach.secondarySkills.length > 0 ? ` (also ${coach.secondarySkills.join(', ')})` : ''}
          </dd>
        </dl>
      </details>

      {coach.groundingClaimIds.length > 0 && (
        <CitedEvidence claimIds={coach.groundingClaimIds} evidence={coach.groundingEvidence} />
      )}
    </div>
  );
}

/**
 * Each grounding claim id, opened (audit 2026-10-17 item 11). A found claim
 * opens to what it says, who was studied, its limitations and its source; an
 * id the Library cannot serve says so in words. An id is never shown bare, and
 * never as if citing it verified the drill.
 *
 * Population and limitations are always shown with the claim, so evidence from
 * adults does not read as established for children.
 */
function CitedEvidence({ claimIds, evidence }: { claimIds: string[]; evidence: GroundingEvidence[] | null | undefined }) {
  const byId = new Map((evidence ?? []).map((entry) => [entry.claimId, entry]));
  return (
    <details className={EXPANDER}>
      <summary className={EXPANDER_SUMMARY}>Cited evidence ({claimIds.length})</summary>
      <div className={`${SECTION} mt-[var(--s2)]`}>
        <p className={BODY}>
          This drill cites these research claims as a whole. The Library does not record which step each one supports.
        </p>
        {evidence === undefined ? (
          <p className={BODY}>
            Open this drill in the Drill Library to read the {claimIds.length === 1 ? 'research claim' : `${claimIds.length} research claims`} it cites.
          </p>
        ) : (
          <ul className="space-y-[var(--s2)]">
            {claimIds.map((claimId) => (
              <li key={claimId}>
                <CitedClaim claimId={claimId} entry={byId.get(claimId)} loaded={evidence !== null} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

function CitedClaim({ claimId, entry, loaded }: { claimId: string; entry: GroundingEvidence | undefined; loaded: boolean }) {
  if (!loaded) {
    return <p className={BODY}>{claimId}: the evidence for this reference could not be loaded.</p>;
  }
  if (!entry || entry.status === 'not_found') {
    return <p className={BODY}>{claimId}: reference not found in the Library.</p>;
  }
  if (entry.status === 'not_cleared') {
    return (
      <p className={BODY}>
        {claimId}: in the Library but not cleared for use (for example awaiting review or withdrawn), so it is not shown.
      </p>
    );
  }
  const r = entry.record;
  const studied = [r.population ?? 'Population not recorded', r.competitiveLevel, r.sex, r.ageRange ? `age ${r.ageRange}` : 'age not recorded']
    .filter(Boolean)
    .join(' · ');
  const design = [r.studyDesign, r.sampleSize ? `n ${r.sampleSize}` : null].filter(Boolean).join(' · ');
  const strength = [r.evidenceClass, r.evidenceTier, r.confidence ? `${r.confidence} confidence` : null].filter(Boolean).join(' · ');
  const source = [r.sourceTitle, r.sourcePublisher, r.publicationDate?.slice(0, 4)].filter(Boolean).join(' · ');
  return (
    <details className={EXPANDER}>
      <summary className={EXPANDER_SUMMARY}>
        {claimId}: {r.sourceTitle ?? 'research claim'}
      </summary>
      <dl className={`${BODY} mt-[var(--s2)] grid grid-cols-[max-content_minmax(0,1fr)] gap-x-[var(--s3)] gap-y-[var(--s1)] [overflow-wrap:anywhere]`}>
        <dt className="font-semibold text-[color:var(--bone-200)] in-[.ge-drillcase]:text-[color:inherit]">Claim</dt>
        <dd>{r.claim}</dd>
        {r.ppbfImplication && (
          <>
            <dt className="font-semibold text-[color:var(--bone-200)] in-[.ge-drillcase]:text-[color:inherit]">PPBF implication</dt>
            <dd>{r.ppbfImplication}</dd>
          </>
        )}
        <dt className="font-semibold text-[color:var(--bone-200)] in-[.ge-drillcase]:text-[color:inherit]">Who was studied</dt>
        <dd>{studied}</dd>
        {design && (
          <>
            <dt className="font-semibold text-[color:var(--bone-200)] in-[.ge-drillcase]:text-[color:inherit]">Design</dt>
            <dd>{design}</dd>
          </>
        )}
        {r.effect && (
          <>
            <dt className="font-semibold text-[color:var(--bone-200)] in-[.ge-drillcase]:text-[color:inherit]">Effect</dt>
            <dd>{r.effect}</dd>
          </>
        )}
        <dt className="font-semibold text-[color:var(--bone-200)] in-[.ge-drillcase]:text-[color:inherit]">Limitations</dt>
        <dd>{r.limitations ?? 'Not recorded'}</dd>
        {(r.transferStatus || r.boxingSpecificity) && (
          <>
            <dt className="font-semibold text-[color:var(--bone-200)] in-[.ge-drillcase]:text-[color:inherit]">Applies to boxing</dt>
            <dd>{[r.boxingSpecificity, r.transferStatus].filter(Boolean).join(' · ')}</dd>
          </>
        )}
        {strength && (
          <>
            <dt className="font-semibold text-[color:var(--bone-200)] in-[.ge-drillcase]:text-[color:inherit]">Research program class</dt>
            <dd>{strength}</dd>
          </>
        )}
        <dt className="font-semibold text-[color:var(--bone-200)] in-[.ge-drillcase]:text-[color:inherit]">Source</dt>
        <dd>
          {source || 'Not recorded'}
          {r.doiOrPmid ? ` (${r.doiOrPmid})` : ''}
          {r.sourceUrl && (
            <>
              {' '}
              <a
                href={r.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open the source for ${claimId}`}
                className="underline in-[.ge-drillcase]:text-[color:inherit]"
              >
                Open the source
              </a>
            </>
          )}
        </dd>
      </dl>
    </details>
  );
}
