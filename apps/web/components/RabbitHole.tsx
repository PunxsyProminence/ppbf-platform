'use client';

import { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';

// Mirrors RABBIT_HOLE_ANCHOR_TYPES in src/server/pilot/rabbitHoles.ts and the
// anchor_type check constraint behind it. Declared here as well because this
// module is client-side and must not pull the database layer into the bundle;
// rabbitHole.test.tsx asserts the two lists stay identical.
export const RABBIT_HOLE_ANCHOR_TYPES = [
  'gap_type',
  'severity',
  'formula_id',
  'board_seat',
  'evidence_tier',
  'readiness_band',
  'compliance_rule',
  'drill',
] as const;

export type RabbitHoleAnchorType = (typeof RABBIT_HOLE_ANCHOR_TYPES)[number];

/**
 * The vocabulary term a lesson is attached to.
 *
 * An anchor is a stable key -- a gap type, a formula id, a board seat -- never a
 * display card. A lesson keyed to a card would detach the moment somebody
 * rewrote the card's copy, and would leave no way to tell that it had.
 */
export interface RabbitHoleAnchor {
  anchorType: RabbitHoleAnchorType;
  anchorKey: string;
}

export interface RabbitHoleLessonItem {
  rabbit_hole_id: string;
  title: string;
  concept: string;
  homework: string | null;
  author_display_name: string;
  // Present only when the lesson points at a Library document that is still
  // approved, verified and indexed in this gym. An unresolved pointer arrives
  // as null and nothing renders in its place.
  citation: { document_id: string; document_name: string } | null;
}

interface RabbitHoleProps {
  anchor: RabbitHoleAnchor;
  className?: string;
}

/**
 * Authored deep-dive lessons, expanded from inside the thing they explain.
 *
 * THE THREE RULES THIS COMPONENT EXISTS TO KEEP:
 *
 * 1. Nothing renders when there is no lesson. The knowledge base starts empty
 *    and will stay sparse -- an empty expander on every card would be worse
 *    than no feature at all, and an empty state is not a finding.
 * 2. A failed read renders nothing and never breaks the surface around it. A
 *    rabbit hole sits on top of whatever the page is really for.
 * 3. Every lesson says it is GYM COACHING and names its author. It never
 *    carries an evidence tier: PROVEN / EMERGING / EXPERIMENTAL /
 *    RESEARCH_NEEDED mean retrieved-and-cited SHADOW evidence, and hand-written
 *    teaching must not borrow that authority. A lesson that points at an
 *    approved Library document shows that citation; one that does not makes no
 *    evidence claim at all.
 */
export function RabbitHole({ anchor, className }: Readonly<RabbitHoleProps>) {
  // The anchor is stored WITH its lessons so content from a previous anchor is
  // filtered out at render rather than cleared by a setState in the effect
  // body -- which cascades a render before the fetch has even started.
  const [loaded, setLoaded] = useState<{ anchorKey: string; lessons: RabbitHoleLessonItem[] }>(
    { anchorKey: '', lessons: [] },
  );
  const [expanded, setExpanded] = useState(false);

  const { anchorType, anchorKey } = anchor;

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/rabbit-holes/get`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ anchor_type: anchorType, anchor_key: anchorKey }),
          signal: controller.signal,
        });

        if (!response.ok) {
          setLoaded({ anchorKey, lessons: [] });
          return;
        }

        const payload = (await response.json()) as {
          ok?: boolean;
          rabbit_holes?: RabbitHoleLessonItem[];
        };

        if (payload.ok !== true || !Array.isArray(payload.rabbit_holes)) {
          setLoaded({ anchorKey, lessons: [] });
          return;
        }

        setLoaded({ anchorKey, lessons: payload.rabbit_holes });
      } catch {
        setLoaded({ anchorKey, lessons: [] });
      }
    })();

    return () => controller.abort();
  }, [anchorType, anchorKey]);

  // Content from a previous anchor is ignored rather than flashed: until the
  // fetch for THIS anchor returns, there is nothing to show.
  const lessons = loaded.anchorKey === anchorKey ? loaded.lessons : [];

  if (lessons.length === 0) {
    return null;
  }

  const heading = lessons.length === 1 ? 'GO DEEPER (1 LESSON)' : `GO DEEPER (${lessons.length} LESSONS)`;

  return (
    <section
      aria-label="Rabbit hole"
      data-testid="rabbit-hole"
      className={className ?? 'border-l-4 border-[color:color-mix(in_srgb,currentColor_26%,transparent)]  p-3'}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="font-mono text-xs font-bold uppercase tracking-[0.1em]">
          {heading}
        </span>
        <span className="text-xl">{expanded ? '−' : '+'}</span>
      </button>

      {expanded && (
        <div className="mt-3 space-y-3">
          {lessons.map((lesson) => (
            <article
              key={lesson.rabbit_hole_id}
              data-testid="rabbit-hole-lesson"
              className="border border-[color:color-mix(in_srgb,currentColor_26%,transparent)] p-3 text-sm opacity-80"
            >
              {/* Provenance before content: the reader learns who is talking and
                  on what authority before they read the claim. */}
              <p className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-[color:var(--brass-600)]">
                Gym coaching · Written by {lesson.author_display_name}
              </p>
              <h4 className="mt-1 text-sm font-semibold">{lesson.title}</h4>
              <p className="mt-2">
                <span className="font-semibold">Concept: </span>
                {lesson.concept}
              </p>
              {lesson.homework ? (
                <p className="mt-2 border-l-2 border-[color:var(--brass-600)] pl-2">
                  <span className="font-semibold">Homework: </span>
                  {lesson.homework}
                </p>
              ) : null}
              {lesson.citation ? (
                <p className="mt-2 text-xs opacity-80">
                  <span className="font-semibold">Library source: </span>
                  {lesson.citation.document_name}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export default RabbitHole;
