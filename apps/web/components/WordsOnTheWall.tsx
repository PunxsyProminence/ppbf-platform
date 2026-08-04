'use client';

import { boxingNumberNote } from './milestoneCeremony';
import { pickSaying, type GymSaying, type SayingContext } from './gymSayings';

/**
 * WORDS ON THE WALL — painted lettering, not a banner.
 *
 * Real gyms have words on the wall. They are painted or stencilled straight
 * onto the plaster by somebody who was not a signwriter, they are short, and
 * they are somebody's actual words. This renders that object.
 *
 * THREE THINGS KEEP IT FROM BECOMING WALLPAPER:
 *
 *   1. IT NEEDS A MOMENT. There is no `context="always"`. The component is
 *      handed 'after-hard-session' or 'at-a-milestone' and renders only then,
 *      so it appears beside something that just happened and is gone the next
 *      time the screen is opened. A permanent motivational banner is invisible
 *      inside a week, which is the failure this constraint exists to prevent.
 *
 *   2. IT NEEDS SOMETHING TRUE TO SAY. gymSayings.ts ships EMPTY on purpose —
 *      the lines belong to this gym's coaches and nobody else can write them.
 *      With no lines, this renders null. An empty wall is honest; a wall of
 *      quotes scraped off the internet is the one untrue thing on a platform
 *      built entirely out of real records.
 *
 *   3. IT IS DETERMINISTIC. The same milestone shows the same line every time.
 *      A sign that reshuffles on every render is a slot machine, and it makes
 *      the screen, the screen reader and a printout disagree with each other.
 *
 * NO MOTION OF ITS OWN. The paint does not fade in, slide, or pulse. It is
 * lettering on a wall — it is simply there, the way it would be if you walked
 * into the room. That also means there is nothing for prefers-reduced-motion to
 * stand down (ppbf.css disables every transition and animation under it
 * globally anyway; this just has none to disable).
 */

export interface WordsOnTheWallProps {
  /**
   * The moment. Required and deliberately not defaulted: a caller that has to
   * name the occasion cannot accidentally leave a banner up.
   */
  readonly context: SayingContext;
  /**
   * Stable input that identifies this occasion — a milestone number, a session
   * id. The same seed always picks the same line.
   */
  readonly seed: string | number;
  /** Test seam. Production callers use the shipped source. */
  readonly source?: readonly GymSaying[];
}

export default function WordsOnTheWall({ context, seed, source }: WordsOnTheWallProps) {
  const saying = pickSaying(context, seed, source);
  if (!saying) {
    // Nothing true to say. Nothing goes on the wall.
    return null;
  }

  return (
    <aside className="wallwords" aria-label="Words on the wall">
      <p className="wallwords-line">{saying.line}</p>
      <p className="wallwords-by">{saying.said_by}</p>
    </aside>
  );
}

/**
 * THE GYM NOTICING A NUMBER.
 *
 * Separate component, same wall, because the two are different objects: a
 * saying is painted and stays painted, whereas this is a remark about a number
 * that is only true today. It is set smaller and without the signature, so it
 * reads as an aside rather than as something anybody painted.
 *
 * The rule for what it may notice is in milestoneCeremony.ts: a cumulative
 * count and nothing else. No date, no gap, no cadence.
 */
export function BoxingNumberNote({ count }: { readonly count: number }) {
  const note = boxingNumberNote(count);
  if (!note) {
    return null;
  }

  /* role="status" rather than an alert: it is worth announcing to a screen
     reader when it arrives, and worth nobody's attention being seized. */
  return (
    <p className="wallwords-aside" role="status">
      {note.line}
    </p>
  );
}

/**
 * A YEAR AT THE GYM.
 *
 * Theirs. No rank, no comparison, no "top 10% of members" — the whole content
 * of this mark is that somebody stayed, and that is not a competition. The rule
 * that computes it is in gymNotices.ts, which is deliberately the only file
 * that reads a clock and is fenced accordingly.
 */
export function AnniversaryNote({ line }: { readonly line: string | null }) {
  if (!line) {
    return null;
  }
  return (
    <p className="wallwords-aside" role="status">
      {line}
    </p>
  );
}
