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
  const promptRef = useRef<HTMLHeadingElement | null>(null);

  const segment = segments[index];
  const atEnd = segment?.kind === 'complete';

  /** Focus the prompt after a move, so a keyboard coach lands on what to say. */
  function focusPrompt() {
    if (typeof window === 'undefined') return;
    window.requestAnimationFrame(() => promptRef.current?.focus());
  }

  function goTo(next: number) {
    setIndex(next);
    focusPrompt();
  }

  function startAt(chosen: DeliveryLevel) {
    setLevel(chosen);
    setIndex(0);
    setPaused(false);
    setResumeIndex(null);
    setRevealed({});
    setSelfReport({});
    setCoachObservation('');
    focusPrompt();
  }

  function next() {
    if (paused || atEnd) return;
    setResumeIndex(null);
    goTo(Math.min(index + 1, segments.length - 1));
  }

  function rebuildPicture() {
    if (index === 0) {
      focusPrompt();
      return;
    }
    setResumeIndex(index);
    goTo(0);
  }

  function returnToFight() {
    if (resumeIndex === null) return;
    const back = resumeIndex;
    setResumeIndex(null);
    goTo(back);
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
          ) : !segment ? (
            <div className="mat-leather rounded-[var(--r-lg)]">
              <div className="empty">
                <div className="empty-title">No scenario to run</div>
                <p className="empty-msg mx-auto">
                  This exposure has no authored prompts, so there is nothing to deliver. That is a
                  content problem, not a session you can run.
                </p>
              </div>
            </div>
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
                  <p role="status" className="t-label mt-[var(--s3)] text-[color:var(--bone-300)]">
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
                      <>
                        <p className="t-label text-[color:var(--bone-300)]">{segment.onRequest.label}</p>
                        <ul className="mt-[var(--s3)] list-disc space-y-[var(--s2)] pl-[var(--s5)] text-[color:var(--bone-100)]">
                          {segment.onRequest.items.map((item) => (
                            <li key={item} className="t-body">{item}</li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <>
                        <p className="t-body text-[color:var(--bone-300)]">{segment.onRequest.rule}</p>
                        <button
                          type="button"
                          className="btn btn--ghost mt-[var(--s3)]"
                          onClick={() => setRevealed((prev) => ({ ...prev, [segment.key]: true }))}
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
                {resumeIndex === null ? (
                  <button type="button" className="btn btn--ghost" onClick={rebuildPicture}>
                    Rebuild the picture
                  </button>
                ) : (
                  <button type="button" className="btn btn--ghost" onClick={returnToFight}>
                    Back to {segments[resumeIndex]?.phase}
                  </button>
                )}
                {!atEnd && (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setPaused((was) => !was)}
                  >
                    {paused ? 'Resume' : 'Pause'}
                  </button>
                )}
                {atEnd && (
                  <button type="button" className="btn btn--ghost" onClick={() => setLevel(null)}>
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
