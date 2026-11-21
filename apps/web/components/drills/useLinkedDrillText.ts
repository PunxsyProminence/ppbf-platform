'use client';

import { useEffect, useRef, useState } from 'react';

import type { LinkedDrillText } from '@/src/lib/sessionScriptWords';
import { readReferenceInstruction, type OpenedInstruction } from './drillInstructionRead';

/**
 * The text of the linked drills a session plan falls back to where its own Say,
 * Watch or Fix line is empty (lane U2-6e, Overwatch option A and Q4 = A).
 *
 * Each drill is read ONCE through the read "View instructions" already makes
 * (readReferenceInstruction, GET /api/pilot/drill-library?drill_id=), and kept
 * while the screen is open: a drill version's text does not change, so a block
 * the coach comes back to shows it at once. Reading writes nothing.
 *
 * A drill whose read failed is read again the next time the list of drills
 * changes (another plan opened, the session moved on), never in a loop. Leaving
 * the screen cancels whatever is still loading.
 */
export function useLinkedDrillText(drillIds: readonly string[]): ReadonlyMap<string, LinkedDrillText> {
  const [texts, setTexts] = useState<ReadonlyMap<string, LinkedDrillText>>(() => new Map());
  // What has been asked for, outside render, so the effect below can tell a
  // drill already read or loading from one still to read.
  const asked = useRef(new Map<string, LinkedDrillText['state']>());
  const key = [...new Set(drillIds)].sort().join('\n');

  useEffect(() => {
    const wanted = key === '' ? [] : key.split('\n');
    // The reads this run started. When the list changes or the screen goes,
    // they are cancelled and forgotten, so a drill still wanted is read again
    // rather than left loading.
    const started = new Map<string, AbortController>();
    const known = asked.current;
    for (const drillId of wanted) {
      const state = known.get(drillId);
      if (state === 'loading' || state === 'loaded') continue;
      known.set(drillId, 'loading');
      const controller = new AbortController();
      started.set(drillId, controller);
      const settle = (text: LinkedDrillText) => {
        known.set(drillId, text.state);
        setTexts((previous) => new Map(previous).set(drillId, text));
      };
      setTexts((previous) => new Map(previous).set(drillId, { state: 'loading' }));
      void readReferenceInstruction(drillId, controller.signal)
        .then((opened) => {
          if (!controller.signal.aborted) settle(linkedText(opened));
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          // Logged, not displayed: the screen says the drill's text could not be loaded.
          console.error({ event: 'linked-drill-text-load-failed', drill_id: drillId, error });
          settle({ state: 'failed' });
        });
    }
    return () => {
      for (const [drillId, controller] of started) {
        if (known.get(drillId) === 'loading') known.delete(drillId);
        controller.abort();
      }
    };
  }, [key]);

  return texts;
}

/**
 * Whether the drill's own record says it is a draft: its field_provenance text contains "DRAFT"
 * (the library's drafts read "LITERATURE-GROUNDED DRAFT ..." or "COACHING-CRAFT DRAFT ..."). The
 * drill's own record, so tied to a source, not guessed (Overwatch QA = B on #1991). "Contains", as
 * the ruling says; for every value the column allows it answers as requiresFloorValidation
 * (src/lib/drillFloorValidation.ts) does, which the tests pin.
 */
export function provenanceSaysDraft(fieldProvenance: string | null | undefined): boolean {
  return typeof fieldProvenance === 'string' && fieldProvenance.includes('DRAFT');
}

/**
 * What a plan line can use from one drill read. Anything but an available
 * drill -- a drill this gym cannot read (404), or a read that answered with no
 * drill view -- is "could not be loaded": the line never shows blank.
 *
 * A field's draft state is its label's (true or false). Where no label settles it (null, "draft
 * status not checked"), a drill whose own provenance says DRAFT is a draft: the mark shows. An
 * explicit non-draft label, such as a coach's in-app edit, keeps no mark; provenance only fills
 * the "not checked" gap (Overwatch Q9 = A on #2001). The coach view only: athletes and parents see
 * no draft line (OW25-57).
 */
export function linkedText(opened: OpenedInstruction): LinkedDrillText {
  const view = opened.view;
  if (opened.state !== 'available' || view === null) return { state: 'failed' };
  const drafts = view.coach?.fieldDrafts;
  const byProvenance = provenanceSaysDraft(view.coach?.fieldProvenance) ? true : null;
  return {
    state: 'loaded',
    cues: view.cues,
    good: view.good,
    bad: view.bad,
    corrections: view.corrections,
    drafts: {
      cues: drafts?.cues ?? byProvenance,
      good: drafts?.good ?? byProvenance,
      bad: drafts?.bad ?? byProvenance,
      corrections: drafts?.corrections ?? byProvenance,
    },
  };
}
