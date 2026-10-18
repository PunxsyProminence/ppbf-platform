'use client';

/**
 * THE CEREMONY, FOR ACHIEVEMENTS THAT ARE NOT A COUNT.
 *
 * milestoneCeremony.ts solves the hard part of this and its reasoning is the
 * reasoning here: a React component sees a STATE ("13 sessions"), not an EVENT
 * ("the 13th just landed"), and it sees that state again on every render, tab
 * switch and reload — so what gets written down is WHAT HAS ALREADY BEEN
 * CELEBRATED, and a crossing is something earned now that is not on that list.
 * Read that file first; this one does not restate the argument.
 *
 * WHY A SECOND FILE RATHER THAN A CHANGE TO THAT ONE. Its whole surface is
 * numeric — `milestones.filter(m => count >= m)`, a record of numbers, one
 * `Math.max` to pick the furthest of several crossed at once. Everything this
 * file celebrates is identified by a KEY: a goal somebody wrote in their own
 * words, "a full round without stopping", "helped somebody new". There is no
 * count to compare and no ordering to take a maximum of. Making the existing
 * hook generic would have meant loosening the one thing that makes it safe —
 * that it can only ever see a cumulative number.
 *
 * WHAT IS SHARED IS THE THING THAT MATTERS: the ceremony itself. The seal comes
 * down under --e-stamp, a line of type says what was earned, and the bell rings
 * for anyone who turned sound on. Same CSS, same voice, same rules. There is
 * one celebration in this application and reaching a goal you set for yourself
 * gets the same one as the session count.
 *
 * FIRST SIGHTING SEEDS, IT DOES NOT CELEBRATE. Same rule. An athlete opening
 * their achievements on a new phone has crossed nothing; they are looking at
 * history.
 *
 * THE RECORD ONLY GROWS, and nothing here can observe a gap, a date, an
 * absence, or a rate. The only input is the SET of things earned, which never
 * shrinks. See TrainingCard.tsx lines 19-24 for why that is load-bearing.
 *
 * ONE EXCEPTION, AND IT IS NOT OBSERVED: THE ATHLETE'S OWN UNDO. An athlete may
 * take back their own "I did it" for ten minutes (OD-2026-10-17-003). The press
 * that slipped rang the bell and went on the record, so without this the real
 * reach later would not ring at all (F-134). forgetCelebrated takes that one key
 * off, and it is called only by an Undo the server accepted -- never because a
 * key left the earned set, which would re-ring a session count corrected down
 * and back up. A device that saw the slip but not the Undo keeps the key: the
 * same honest cost as a milestone crossed on the office tablet not ringing on
 * the athlete's phone.
 */

import { useEffect, useRef, useState } from 'react';

export const ACHIEVEMENT_CEREMONY_PREFIX = 'ppbf.achievements.sealed';

/** A gym tablet is shared; without the athlete on the key the first card opened silences the next. */
export function achievementCeremonyKey(athleteId?: string): string {
  const who = (athleteId ?? '').trim();
  return `${ACHIEVEMENT_CEREMONY_PREFIX}.${who || 'unknown'}`;
}

/**
 * The in-memory copy, which is the primary read. localStorage throws in private
 * mode and in some kiosk webviews, and a tablet that cannot store anything
 * would otherwise treat every render as a first sighting and never celebrate.
 */
const remembered = new Map<string, readonly string[]>();

function readStored(key: string): string[] | null {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.filter((value): value is string => typeof value === 'string' && value.length > 0);
  } catch {
    // Unreadable is treated as "never seen", which seeds silently. The failure
    // mode of this function is a ceremony that does not happen, never one that
    // happens twice.
    return null;
  }
}

export function readCelebrated(key: string): string[] | null {
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

export function writeCelebrated(key: string, record: readonly string[]): void {
  const sorted = [...record].sort();
  remembered.set(key, sorted);
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(sorted));
  } catch {
    // The in-memory copy above still holds for the rest of this visit.
  }
}

/**
 * Takes one key back off an athlete's record, so a later real reach of the same
 * thing rings. ONLY for an Undo the server accepted (see the note at the top):
 * nothing else in the application shrinks this record.
 */
export function forgetCelebrated(athleteId: string | undefined, key: string): void {
  const storageKey = achievementCeremonyKey(athleteId);
  const known = readCelebrated(storageKey);
  if (known === null || !known.includes(key)) {
    return;
  }
  writeCelebrated(storageKey, known.filter((held) => held !== key));
}

/** Test seam, and the only way to forget within one page life. */
export function resetAchievementCeremonyMemory(): void {
  remembered.clear();
}

export interface AchievementCeremonyDecision {
  /** The key to press and ring for now, or null for silence. */
  readonly celebrate: string | null;
  /** Everything to write down as celebrated. Never shrinks. */
  readonly record: readonly string[];
  readonly seeded: boolean;
  readonly changed: boolean;
}

/**
 * The whole crossing rule, as a pure function so it can be tested without a
 * DOM, a clock, or a render.
 *
 * @param earned  every achievement key held right now, in the order the caller
 *                wants them celebrated — the LAST newly-earned one wins when
 *                several land at once, which for a catalogue in path order
 *                means the furthest along.
 * @param known   what has already been celebrated, or null on first sight.
 */
export function decideAchievementCeremony(
  earned: readonly string[],
  known: readonly string[] | null,
): AchievementCeremonyDecision {
  const held = [...new Set(earned)];

  if (known === null) {
    // Always worth persisting, even when empty: "seen this athlete, nothing
    // earned yet" is what a brand new athlete's first observation writes down.
    // Without it, every later observation reads as another first sighting and
    // the first real achievement never rings.
    return { celebrate: null, record: held, seeded: true, changed: true };
  }

  const knownSet = new Set(known);
  const fresh = held.filter((key) => !knownSet.has(key));
  // ONE bell, for the last of several — rule 5 of the sound system, and right
  // visually too: two seals pressing at once reads as a glitch.
  const celebrate = fresh.length > 0 ? fresh[fresh.length - 1] : null;
  const record = [...new Set([...known, ...held])].sort();

  return { celebrate, record, seeded: false, changed: record.length !== known.length };
}

export interface AchievementCeremonyOptions {
  /** Every key held right now. A set, never a rate and never a run length. */
  readonly earned: readonly string[];
  /** Scopes the record. A shared tablet holds several athletes. */
  readonly athleteId?: string;
  /**
   * False while nothing has been read from the server yet. An empty list is not
   * "nothing earned" — it is "nobody has said yet", and seeding from it would
   * make the first real read look like a dozen achievements landing at once.
   */
  readonly active: boolean;
  /** Fired once per crossing, inside the effect that detects it. */
  readonly onCross?: (key: string) => void;
}

/**
 * Returns the key whose seal should be shown coming down, or null.
 *
 * Deliberately NOT cleared on a timer, for the same reason the session-count
 * ceremony is not: the press is a one-shot CSS animation that ends in the
 * resting state, and the note stays up for the rest of the visit, which is what
 * a stamp on paper does.
 */
export function useAchievementCeremony({
  earned,
  athleteId,
  active,
  onCross,
}: AchievementCeremonyOptions): string | null {
  const [pressed, setPressed] = useState<string | null>(null);

  // Held in a ref so an inline callback at the call site cannot re-run the
  // detection effect on every render.
  const onCrossRef = useRef(onCross);
  useEffect(() => {
    onCrossRef.current = onCross;
  });

  // The array identity changes on every render at most call sites, so the
  // effect below depends on the CONTENT rather than the reference. Without
  // this, a parent re-rendering for an unrelated reason would re-run the
  // detection — harmless for the record, but a needless read every keystroke.
  // Carried as JSON, which needs no separator: no key can be cut in two, and
  // nothing invisible sits in this file.
  const fingerprint = JSON.stringify(earned);

  useEffect(() => {
    if (!active) {
      return;
    }

    const key = achievementCeremonyKey(athleteId);
    const held = JSON.parse(fingerprint) as string[];
    const decision = decideAchievementCeremony(held, readCelebrated(key));
    if (decision.changed) {
      writeCelebrated(key, decision.record);
    }
    if (decision.celebrate === null) {
      return;
    }

    /* Same exemption the session-count ceremony documents: the persisted record
       IS an external system, this effect is subscribing to it, and the state
       below is what came back. It cannot be derived during render either —
       detecting a crossing WRITES the record and rings a bell, and a render
       React discards or replays must not do either. */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPressed(decision.celebrate);
    onCrossRef.current?.(decision.celebrate);
  }, [active, athleteId, fingerprint]);

  return pressed;
}
