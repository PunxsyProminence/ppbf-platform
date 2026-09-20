'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { buildGuidedSession, type DeliveryLevel } from '@/src/lib/visualization/guidedSession';
import {
  MANUAL_DELIVERY_RULES,
  PF001_RING_CUTTER,
  VISUALIZATION_CONTENT_SOURCE,
} from '@/src/lib/visualization/pf001Scenario';

/**
 * VIZ-1: one coach-guided scripted shadowboxing visualization exposure.
 *
 * WHAT THIS SURFACE IS. A coach stands on the floor with one trained boxer,
 * picks the delivery level that fits them, and reads ONE authored scenario one
 * prompt at a time, from building the imagined opponent through the authored
 * debrief. The athlete keeps an opponent and a ring in their head and answers
 * authored cues with real movement; the screen is the coach's script.
 *
 * THE LEVEL IS A CHOICE, NOT A LADDER TO CLIMB IN ONE SESSION. Levels 1, 2 and
 * 3 are the manual's three ways to run the whole arc. The coach picks one for
 * the exposure; the page never walks a fed answer and then the cue-only version
 * as if they followed each other.
 *
 * WHAT IT DELIBERATELY IS NOT.
 *  - Not a record. Nothing is saved: no exposure, no completion, no debrief
 *    answer, no observation. What is typed lives in this component's state and
 *    a refresh starts a new unsaved exposure, which the screen says.
 *  - Not a score. No pass, fail, mastery, vividness or progression decision.
 *    What the athlete says they saw, what the coach observed and what the body
 *    did are three different things, and the debrief keeps them apart.
 *  - Not a drill. Technique, safety, scaling and assignment stay in the drill
 *    system (reference drill -> operational drill -> assignment -> completion).
 *    This page copies nothing from it and issues no work.
 *  - Not generated. No SHADOW call, no retrieval, no model: the prompts are the
 *    authored content in src/lib/visualization, in the source's own order.
 */

const SCENARIO = PF001_RING_CUTTER;

const LEVEL_NUMBERS: DeliveryLevel[] = [1, 2, 3];

export default function CoachVisualizationPage() {
  const [level, setLevel] = useState<DeliveryLevel | null>(null);
  const segments = useMemo(() => (level ? buildGuidedSession(SCENARIO, level) : []), [level]);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  // Where the coach was before rebuilding the picture, so going back to the
  // opponent never loses their place in the fight.
  const [resumeIndex, setResumeIndex] = useState<number | null>(null);
  // Authored help the coach asked for, per segment key. Not a setting: the
  // manual says the options are offered only when the athlete needs them.
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  // Transient only, and labelled as such on screen: the athlete's own words and
  // the coach's observation, kept apart because neither proves the other.
  const [selfReport, setSelfReport] = useState<Record<number, string>>({});
  const [coachObservation, setCoachObservation] = useState('');
  // ONE live region for the whole surface, always mounted (see the JSX): a
  // region created together with its text is not reliably announced, and two
  // regions talk over each other. Everything worth hearing is set here.
  const [announcement, setAnnouncement] = useState('');
  const promptRef = useRef<HTMLHeadingElement | null>(null);
  const resourceRef = useRef<HTMLElement | null>(null);

  const segment = segments[index];
  const atEnd = segment?.kind === 'complete';
  const debriefIndex = segments.findIndex((step) => step.kind === 'debrief');

  /** Focus the prompt after a move, so a keyboard coach lands on what to say. */
  function focusPrompt() {
    if (typeof window === 'undefined') return;
    window.requestAnimationFrame(() => promptRef.current?.focus());
  }

  /** What a coach who cannot see the screen needs to hear about a move. */
  function announceStep(at: number, prefix = '') {
    const step = segments[at];
    if (!step) return;
    const where = step.kind === 'complete' || step.kind === 'debrief'
      ? step.title
      : `${step.phase}. ${step.title}. Step ${at + 1} of ${segments.length}`;
    setAnnouncement(prefix ? `${prefix} ${where}` : where);
  }

  function goTo(next: number, prefix = '') {
    setIndex(next);
    announceStep(next, prefix);
    focusPrompt();
  }

  function startAt(chosen: DeliveryLevel) {
    const chosenSegments = buildGuidedSession(SCENARIO, chosen);
    setLevel(chosen);
    setIndex(0);
    setPaused(false);
    setResumeIndex(null);
    setRevealed({});
    setSelfReport({});
    setCoachObservation('');
    setAnnouncement(
      `Level ${chosen}. ${chosenSegments[0].phase}. ${chosenSegments[0].title}. Step 1 of ${chosenSegments.length}`,
    );
    focusPrompt();
  }

  /**
   * Back to the level choice: a new exposure, with nothing carried over. The
   * announcement is replaced rather than left alone, because the region is
   * read on this screen too and the last thing it said was that a session had
   * finished -- which is no longer true of anything.
   */
  function startOver() {
    setLevel(null);
    setIndex(0);
    setPaused(false);
    setResumeIndex(null);
    setRevealed({});
    setSelfReport({});
    setCoachObservation('');
    setAnnouncement('New exposure. Choose how you will deliver it.');
    focusPrompt();
  }

  /**
   * The coach asked for the authored options on this round only.
   *
   * Focus has to move. Revealing replaces the button that was pressed, so a
   * coach working by keyboard or screen reader would otherwise be dropped on
   * `document.body` with the thing they just asked for somewhere off in the
   * page. The destination is the labelled resource region itself, so its name
   * is announced on arrival and its contents are in reading order from there.
   */
  function revealOptions(key: string) {
    setRevealed((prev) => ({ ...prev, [key]: true }));
    // Short on purpose. Moving focus is the signal the coach actually needs,
    // and reciting five instructions and three options into the live region
    // would compete with the region focus just landed on. Some screen readers
    // drop a polite announcement made in the same tick as a focus change, so
    // this sentence is a courtesy, not the mechanism.
    setAnnouncement('Response options offered. Moved to the coach resource.');
    if (typeof window === 'undefined') return;
    window.requestAnimationFrame(() => resourceRef.current?.focus());
  }

  function next() {
    if (paused || atEnd) return;
    const to = Math.min(index + 1, segments.length - 1);
    // The rebuild bookmark survives moving around inside the rebuild: it is
    // spent by returning, or dropped once the coach has walked past the point
    // it would take them back to.
    if (resumeIndex !== null && to >= resumeIndex) setResumeIndex(null);
    goTo(to);
  }

  function rebuildPicture() {
    if (index === 0) {
      focusPrompt();
      return;
    }
    setResumeIndex(index);
    goTo(0, 'Rebuilding the picture.');
  }

  function returnToFight() {
    if (resumeIndex === null) return;
    const back = resumeIndex;
    setResumeIndex(null);
    goTo(back, 'Back in the fight.');
  }

  /** From session complete: the debrief is still there to read and add to. */
  function backToDebrief() {
    if (debriefIndex < 0) return;
    setResumeIndex(null);
    goTo(debriefIndex, 'Back to the debrief.');
  }

  function togglePause() {
    setPaused((was) => {
      setAnnouncement(was ? 'Resumed.' : 'Paused. The fight has not moved on.');
      return !was;
    });
  }

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      {/* The ground is painted with tokens, not with a retired room class:
          src/design/legacyVisualVocabulary.test.ts froze that vocabulary at the
          count it measured, and a screen written from here on adds none.
          data-surface="kiosk" because a coach reads this at arm's length on the
          floor (Law 5). */}
      <main
        className="min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]"
        data-surface="kiosk"
      >
        <div className="mx-auto w-full max-w-3xl">
          {/* The one live region, mounted for the life of the page so a screen
              reader is listening before anything is said into it. */}
          <p role="status" aria-live="polite" className="t-label text-[color:var(--bone-300)]">
            {announcement}
          </p>

          <header className="mb-[var(--s4)]">
            <p className="t-eyebrow">Coach Workspace</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>
              Guided Visualization
            </h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              One scripted shadowboxing exposure, delivered one prompt at a time. You guide it; the
              athlete holds the opponent and the ring in their head and answers with movement.
              Nothing on this page is saved.
            </p>
          </header>

          {!level ? (
            <section className="mat-leather--raised rounded-[var(--r-lg)] p-[var(--s5)]">
              <h2
                ref={promptRef}
                tabIndex={-1}
                className="t-command"
                style={{ fontSize: 'var(--t-lg)' }}
              >
                Choose how you will deliver it
              </h2>
              <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
                These are the manual&apos;s three delivery levels for the whole scenario, not stages
                to climb inside one session. Pick the one that fits this athlete today.
              </p>

              <div className="mt-[var(--s4)] space-y-[var(--s4)]">
                {MANUAL_DELIVERY_RULES.deliveryLevels.map((row, rowIndex) => (
                  <div key={row.level} className="border-t border-[color:var(--brass-700)] pt-[var(--s3)]">
                    <p className="t-label">{row.level}</p>
                    <p className="t-body mt-[var(--s2)] text-[color:var(--bone-100)]">{row.coachGivesTiming}</p>
                    <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">{row.purpose}</p>
                    <button
                      type="button"
                      className="btn mt-[var(--s3)]"
                      onClick={() => startAt(LEVEL_NUMBERS[rowIndex])}
                    >
                      Run at Level {LEVEL_NUMBERS[rowIndex]}
                    </button>
                  </div>
                ))}
              </div>

              <div className="mt-[var(--s5)] border-t border-[color:var(--brass-700)] pt-[var(--s4)]">
                <p className="t-label text-[color:var(--bone-300)]">The visualization rules</p>
                <ul className="mt-[var(--s3)] list-disc space-y-[var(--s2)] pl-[var(--s5)] text-[color:var(--bone-100)]">
                  {MANUAL_DELIVERY_RULES.visualizationRules.map((rule) => (
                    <li key={rule} className="t-body">{rule}</li>
                  ))}
                </ul>
                <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
                  {MANUAL_DELIVERY_RULES.level3Note}
                </p>
              </div>
            </section>
          ) : (
            <>
              <section className="mat-leather--raised rounded-[var(--r-lg)] p-[var(--s5)]">
                <div className="flex flex-wrap items-baseline justify-between gap-[var(--s3)]">
                  <p className="t-label text-[color:var(--bone-300)]">
                    {segment.phase} · Level {level}
                  </p>
                  <p className="t-label text-[color:var(--bone-300)]">
                    Step {index + 1} of {segments.length}
                  </p>
                </div>

                <h2
                  ref={promptRef}
                  tabIndex={-1}
                  id="visualization-prompt"
                  className="t-command mt-[var(--s3)]"
                  style={{ fontSize: 'var(--t-lg)' }}
                >
                  {segment.title}
                </h2>

                {paused && (
                  <p className="t-label mt-[var(--s3)] text-[color:var(--bone-300)]">
                    Paused. Rebuild the picture, then resume. The fight has not moved on.
                  </p>
                )}

                {segment.body.map((paragraph) => (
                  <p key={paragraph} className="t-body mt-[var(--s3)] text-[color:var(--bone-100)]">
                    {paragraph}
                  </p>
                ))}

                {segment.items.length > 0 && segment.kind !== 'debrief' && (
                  <ul className="mt-[var(--s3)] list-disc space-y-[var(--s2)] pl-[var(--s5)] text-[color:var(--bone-100)]">
                    {segment.items.map((item) => (
                      <li key={item} className="t-body">{item}</li>
                    ))}
                  </ul>
                )}

                {segment.note && (
                  <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">{segment.note}</p>
                )}

                {segment.onRequest && (
                  <div className="mt-[var(--s4)] border-t border-[color:var(--brass-700)] pt-[var(--s3)]">
                    {revealed[segment.key] ? (
                      /*
                       * The coach resource, and the focus destination. Both
                       * authored lists live here: the manual's instructions for
                       * USING the options, and the options themselves. Carrying
                       * ruleBullets in the session model and then rendering only
                       * the options dropped five authored instructions on the
                       * floor -- including explaining why an option fits rather
                       * than naming a punch, and continuing after mistakes.
                       *
                       * The headings are structural UI, not content: they mark
                       * which authored text is for the coach and which is the
                       * athlete-facing script, so neither gets read as the other.
                       */
                      <section
                        ref={resourceRef}
                        tabIndex={-1}
                        aria-labelledby={`resource-heading-${segment.key}`}
                        className="rounded-[var(--r-md)] bg-[color:var(--leather-800)] p-[var(--s4)]"
                      >
                        <h3
                          id={`resource-heading-${segment.key}`}
                          className="t-label text-[color:var(--brass-300)]"
                        >
                          Coach resource — {segment.onRequest.label}
                        </h3>

                        <p
                          id={`resource-rules-label-${segment.key}`}
                          className="t-label mt-[var(--s4)] text-[color:var(--bone-300)]"
                        >
                          How the manual says to use them — for you, not lines to read out
                        </p>
                        <ul
                          aria-labelledby={`resource-rules-label-${segment.key}`}
                          className="mt-[var(--s3)] list-disc space-y-[var(--s2)] pl-[var(--s5)] text-[color:var(--bone-100)]"
                        >
                          {segment.onRequest.ruleBullets.map((bullet) => (
                            <li key={bullet} className="t-body">{bullet}</li>
                          ))}
                        </ul>

                        <p
                          id={`resource-options-label-${segment.key}`}
                          className="t-label mt-[var(--s4)] text-[color:var(--bone-300)]"
                        >
                          The authored response options
                        </p>
                        <ul
                          aria-labelledby={`resource-options-label-${segment.key}`}
                          className="mt-[var(--s3)] list-disc space-y-[var(--s2)] pl-[var(--s5)] text-[color:var(--bone-100)]"
                        >
                          {segment.onRequest.items.map((item) => (
                            <li key={item} className="t-body">{item}</li>
                          ))}
                        </ul>
                      </section>
                    ) : (
                      <>
                        <p className="t-body text-[color:var(--bone-300)]">{segment.onRequest.rule}</p>
                        <button
                          type="button"
                          className="btn btn--ghost mt-[var(--s3)]"
                          onClick={() => revealOptions(segment.key)}
                        >
                          {segment.onRequest.label}
                        </button>
                      </>
                    )}
                  </div>
                )}

                {segment.kind === 'debrief' && (
                  <div className="mt-[var(--s4)] space-y-[var(--s4)]">
                    <p className="t-label text-[color:var(--bone-300)]">
                      The athlete answers in their own words. What they say they saw is their report,
                      not proof of what happened — keep your own observation separate. None of this is
                      saved.
                    </p>
                    {segment.items.map((question, questionIndex) => (
                      <div key={question} className="field">
                        {/* The authored question is prose, so it is a paragraph the
                            field points at rather than a label wrapping it. */}
                        <p id={`debrief-question-${questionIndex}`} className="t-body">
                          {question}
                        </p>
                        <textarea
                          aria-labelledby={`debrief-question-${questionIndex}`}
                          className="input"
                          rows={2}
                          value={selfReport[questionIndex] ?? ''}
                          onChange={(event) =>
                            setSelfReport((prev) => ({ ...prev, [questionIndex]: event.target.value }))
                          }
                        />
                      </div>
                    ))}
                    <div className="field">
                      <p id="coach-observation-label" className="t-body">
                        Coach observation — what you saw, in your words
                      </p>
                      <textarea
                        aria-labelledby="coach-observation-label"
                        className="input"
                        rows={2}
                        value={coachObservation}
                        onChange={(event) => setCoachObservation(event.target.value)}
                      />
                    </div>
                  </div>
                )}

                {atEnd && (
                  <div className="mt-[var(--s3)] space-y-[var(--s3)]">
                    <p className="t-body text-[color:var(--bone-100)]">
                      You reached the authored debrief, which is the end of this exposure.
                    </p>
                    <p className="t-body text-[color:var(--bone-300)]">
                      That is all this screen knows. It does not say the athlete has learned to
                      visualize, that their technique improved, that anything transferred, or that
                      they are ready for another level — and nothing here was recorded, so it is not
                      evidence of the session either. What happened is what you and the athlete saw.
                    </p>
                  </div>
                )}
              </section>

              <div className="mt-[var(--s4)] flex flex-wrap gap-[var(--s3)]">
                {!atEnd && (
                  <button type="button" className="btn" onClick={next} disabled={paused}>
                    Next prompt
                  </button>
                )}
                <button type="button" className="btn btn--ghost" onClick={focusPrompt}>
                  Repeat this prompt
                </button>
                {/* At the end the fight is over: rebuilding the picture belongs
                    to the rounds, and what a coach wants there is the debrief
                    they just worked through, still holding what was typed. */}
                {atEnd ? (
                  <button type="button" className="btn btn--ghost" onClick={backToDebrief}>
                    Back to the debrief
                  </button>
                ) : resumeIndex === null ? (
                  <button type="button" className="btn btn--ghost" onClick={rebuildPicture}>
                    Rebuild the picture
                  </button>
                ) : (
                  <button type="button" className="btn btn--ghost" onClick={returnToFight}>
                    Back to {segments[resumeIndex]?.phase}
                  </button>
                )}
                {!atEnd && (
                  <button type="button" className="btn btn--ghost" onClick={togglePause}>
                    {paused ? 'Resume' : 'Pause'}
                  </button>
                )}
                {atEnd && (
                  <button type="button" className="btn btn--ghost" onClick={startOver}>
                    Start a new exposure
                  </button>
                )}
              </div>
            </>
          )}

          <aside className="mt-[var(--s5)] border-t border-[color:var(--brass-700)] pt-[var(--s4)] text-[color:var(--bone-300)]">
            <p className="t-label">Scenario and source</p>
            <p className="t-body mt-[var(--s2)]">
              {SCENARIO.id} · {SCENARIO.title} · {SCENARIO.opponentFamily} · {SCENARIO.difficulty} ·{' '}
              {SCENARIO.positionInFamily}
            </p>
            <p className="t-body mt-[var(--s2)]">{SCENARIO.tacticalProblem}</p>
            <p className="t-body mt-[var(--s2)]">
              {VISUALIZATION_CONTENT_SOURCE.document} · {VISUALIZATION_CONTENT_SOURCE.version} ·{' '}
              {VISUALIZATION_CONTENT_SOURCE.dated}
            </p>
            <p className="t-body mt-[var(--s2)]">
              Prerequisites are handled by you, in person: {SCENARIO.profile.prerequisiteSkills}
            </p>
            <p className="t-body mt-[var(--s2)]">
              A refresh starts a new unsaved exposure. This surface writes nothing and assigns
              nothing — drills, assignments and completions stay where they are.
            </p>
          </aside>

          <p className="mt-[var(--s5)]">
            <Link className="btn btn--ghost" href="/coach/environment/intake-router">
              Back to Coach Workspace
            </Link>
          </p>
        </div>
      </main>
    </RoleSessionGate>
  );
}
