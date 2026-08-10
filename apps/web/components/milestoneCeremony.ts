'use client';

/**
 * THE MILESTONE CEREMONY — detecting a CROSSING, not a state.
 *
 * The training card draws a seal at every milestone and greys out the ones not
 * yet reached. Crossing one produced nothing: the seal an athlete earns at 13
 * sessions was already sitting in the DOM at 12, one opacity step away. There
 * was no moment.
 *
 * The moment has to fire ONCE, on the crossing. That is the whole difficulty,
 * because a React component sees a STATE ("13 sessions"), not an EVENT ("the
 * 13th session just landed"), and it sees that state again on every render, on
 * every tab switch, on every reload. `completed >= 13` is true forever after.
 *
 * SO WHAT IS WRITTEN DOWN IS WHAT HAS ALREADY BEEN CELEBRATED, and a crossing
 * is a milestone that is earned now and is not on that list.
 *
 * FIRST SIGHTING SEEDS, IT DOES NOT CELEBRATE. An athlete who has trained for
 * a year and opens their card on a new phone has crossed nothing — they are
 * looking at history. So the first observation of a card writes down every
 * milestone already earned and rings nothing. Only a later increase is a
 * crossing. The cost is honest and small: a milestone crossed on the office
 * tablet is not re-celebrated on the athlete's phone. The alternative — treat
 * first sight as a crossing — would ring the bell for 233 sessions on every
 * cleared cache, which is a lie told loudly.
 *
 * THE RECORD ONLY GROWS. If a session row is corrected away and the count
 * falls back below a milestone, the milestone stays celebrated, so returning
 * to it later does not ring twice. This is the same principle as the card
 * itself: nothing an athlete has earned is taken back off them.
 *
 * NO STREAKS ARE POSSIBLE HERE. The only input is a cumulative count. Nothing
 * in this file can observe a gap, a reset, or an absence, so nothing in it can
 * punish one — see the argument in TrainingCard.tsx, which is load-bearing.
 *
 * THAT INVARIANT CONSTRAINS WHAT MAY BE ADDED TO THIS FILE, and it is the
 * reason the anniversary mark and the before-dawn line live in gymNotices.ts
 * instead. Both of those read a CLOCK, and a file that can read a clock can
 * subtract two of them, and a file that can subtract two clocks can notice
 * that somebody has not been in for three weeks. Nothing here may acquire that
 * ability, so nothing here takes a date. The only number this file has ever
 * been handed is a count that never goes down.
 */

import { useEffect, useRef, useState } from 'react';

export const CEREMONY_STORAGE_PREFIX = 'ppbf.tcard.sealed';

/**
 * A gym tablet is shared. Without the athlete on the key, the first card opened
 * on it would seed the record for everyone who used it afterwards and silence
 * every one of their first milestones.
 */
export function ceremonyStorageKey(athleteId?: string): string {
  const who = (athleteId ?? '').trim();
  return `${CEREMONY_STORAGE_PREFIX}.${who || 'unknown'}`;
}

/**
 * The in-memory copy, which is the primary read.
 *
 * localStorage throws in private mode and in some embedded webviews, and a
 * kiosk that cannot store anything would otherwise treat every render as a
 * first sighting and never celebrate at all. With this, the crossing that
 * happens while the athlete is standing in front of the tablet still works;
 * only the memory of it across visits is lost.
 */
const remembered = new Map<string, readonly number[]>();

function readStored(key: string): number[] | null {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  } catch {
    // Unreadable or unparseable is treated as "never seen", which seeds
    // silently. That is the safe direction: the failure mode of this function
    // is a ceremony that does not happen, never one that happens twice.
    return null;
  }
}

/** What has already been celebrated for this card, or null if never seen. */
export function readSealed(key: string): number[] | null {
  const held = remembered.get(key);
  if (held) {
    return [...held];
  }
  const stored = readStored(key);
  if (stored) {
    remembered.set(key, stored);
  }
  return stored;
}

export function writeSealed(key: string, record: readonly number[]): void {
  const sorted = [...record].sort((a, b) => a - b);
  remembered.set(key, sorted);
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(sorted));
  } catch {
    // The in-memory copy above still holds for the rest of this visit.
  }
}

/** Test seam, and the only way to forget within one page life. */
export function resetCeremonyMemory(): void {
  remembered.clear();
}

export interface CeremonyDecision {
  /** The milestone to press and ring for now, or null for silence. */
  readonly celebrate: number | null;
  /** Everything to write down as celebrated. Never shrinks. */
  readonly record: readonly number[];
  /** True when this observation only wrote down history. */
  readonly seeded: boolean;
  /** Whether `record` differs from what was known, i.e. worth persisting. */
  readonly changed: boolean;
}

/**
 * The whole crossing rule, as a pure function so it can be tested without a
 * DOM, a clock, or a render.
 *
 * @param count       completed sessions on the card right now
 * @param known       what has already been celebrated, or null on first sight
 * @param milestones  the card's milestone series
 */
export function decideCeremony(
  count: number,
  known: readonly number[] | null,
  milestones: readonly number[],
): CeremonyDecision {
  const earned = milestones.filter((m) => count >= m);

  if (known === null) {
    // Always worth persisting, even when the record is empty: "seen this card,
    // nothing earned yet" is exactly what a brand new athlete's first
    // observation has to write down. Without it, every later observation would
    // read as another first sighting and the fifth session would never ring.
    return { celebrate: null, record: earned, seeded: true, changed: true };
  }

  const fresh = earned.filter((m) => !known.includes(m));
  // A backfill can cross two milestones at once. One bell, for the furthest
  // one reached — rule 5 of the sound system, and the right thing visually too:
  // two seals pressing at once reads as a glitch, not as a ceremony.
  const celebrate = fresh.length > 0 ? Math.max(...fresh) : null;
  const record = [...new Set([...known, ...earned])].sort((a, b) => a - b);

  return {
    celebrate,
    record,
    seeded: false,
    changed: record.length !== known.length,
  };
}

/* ---------------------------------------------------------------------------
   THE NUMBERS THAT MEAN SOMETHING IN A BOXING GYM

   The Fibonacci ladder above is the system's arithmetic — 5, 13, 34, 89, 233 —
   and it is the right ladder because it descends from φ like every other
   measurement here (Law 8). But it is arithmetic, and two numbers in a boxing
   gym are not arithmetic:

     3   the rounds in an amateur bout. The first time the count says 3, the
         athlete has logged the length of a fight.
     12  championship distance. Nobody in this building is fighting twelve
         rounds, which is the joke, and it is the gym's joke rather than the
         software's.

   THIS IS NOT A SECOND MILESTONE SYSTEM. It presses no seal, writes no record,
   rings no bell and cannot be earned twice, because there is nothing to earn:
   it is a REMARK on a number, true exactly while the number is that number and
   gone the day the next session lands. That is why it needs no storage, and
   needing no storage is why it cannot drift into the crossing logic above.

   Neither 3 nor 12 is on the ladder, so a remark and a ceremony can never fire
   on the same count. A test pins that.

   IT TAKES A COUNT AND NOTHING ELSE, which is what keeps this file honest —
   see the NO STREAKS note at the top.
--------------------------------------------------------------------------- */

export interface BoxingNumberNote {
  /** The count this remark belongs to. */
  readonly count: number;
  /** The remark. One line, dry, and said once. */
  readonly line: string;
}

/**
 * The remark for a session count, or null — which is the answer for almost
 * every number, and is meant to be.
 *
 * Deliberately exact rather than "3 or more": at 4 sessions the athlete has
 * not just done a bout's worth of rounds, they did that last time. The remark
 * is only true on the day.
 */
export function boxingNumberNote(count: number): BoxingNumberNote | null {
  if (count === 3) {
    return { count: 3, line: 'Three. The rounds in an amateur bout — you have logged a whole fight.' };
  }
  if (count === 12) {
    return { count: 12, line: 'Twelve. Championship distance. Nobody here is fighting twelve rounds, but still.' };
  }
  return null;
}

export interface MilestoneCeremonyOptions {
  /** Completed sessions. Cumulative, never a streak. */
  readonly count: number;
  readonly milestones: readonly number[];
  /** Scopes the record. A shared tablet holds several athletes' cards. */
  readonly athleteId?: string;
  /**
   * False while the ledger has not been read yet. An empty card is not a count
   * of zero — it is "nobody has said yet", and seeding a record from it would
   * make the first real read look like five milestones crossing at once.
   */
  readonly active: boolean;
  /** Fired once per crossing, inside the effect that detects it. */
  readonly onCross?: (milestone: number) => void;
}

/**
 * Returns the milestone whose seal should be shown coming down, or null.
 *
 * Deliberately NOT cleared on a timer: the press is a one-shot CSS animation
 * that ends in the resting state, so there is nothing to undo, and a state
 * update landing 300ms later for no visible reason is a render nobody asked
 * for. The note stays up for the rest of the visit, which is what a stamp on
 * paper does.
 */
export function useMilestoneCeremony({
  count,
  milestones,
  athleteId,
  active,
  onCross,
}: MilestoneCeremonyOptions): number | null {
  const [pressed, setPressed] = useState<number | null>(null);

  // Held in a ref so an inline callback at the call site cannot re-run the
  // detection effect on every render.
  const onCrossRef = useRef(onCross);
  useEffect(() => {
    onCrossRef.current = onCross;
  });

  useEffect(() => {
    if (!active) {
      return;
    }

    const key = ceremonyStorageKey(athleteId);
    const decision = decideCeremony(count, readSealed(key), milestones);
    if (decision.changed) {
      writeSealed(key, decision.record);
    }
    if (decision.celebrate === null) {
      return;
    }

    /* The rule this suppresses is the right rule and this is the case it
       exempts: the persisted record IS an external system, the effect is
       subscribing to it, and the state below is what came back. It cannot be
       derived during render either — detecting a crossing WRITES the record
       and rings a bell, and a render that React discards or replays must not
       do either. It cascades exactly one render, once per milestone in an
       athlete's career. */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPressed(decision.celebrate);
    onCrossRef.current?.(decision.celebrate);
  }, [active, athleteId, count, milestones]);

  return pressed;
}
