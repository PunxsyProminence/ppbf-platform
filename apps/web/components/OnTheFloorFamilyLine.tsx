'use client';

import { useEffect, useState } from 'react';
import { apiBase } from '@/lib/apiBase';

/**
 * THE "ON THE FLOOR NOW" LINE, for a parent and an athlete (lane W4-3, FN-2;
 * W4 item 3, Jason Q3.2 A and Q3.4 A). It reads GET /api/pilot/on-the-floor
 * (onTheFloor.ts, onTheFloorForFamily) once, when the page opens; a refresh of
 * the page reads it again. Nothing polls and nothing is pushed live (FN0-Q2 A).
 *
 * THE WORDS are Jason's (FN0-Q2 A, OD-2026-11-25-002) and App Overwatch's QA A
 * (#2192, 7164371671):
 *   parent:  "[first name] is on the floor now." for each own child who counts,
 *            and nothing for a child who does not: no mark is not absence (F4);
 *   athlete: "You're on the floor now." or "You're not counted on the floor
 *            right now." (Q3.4 A: their own status either way);
 *   loading: "Checking whether [first name] is on the floor..." /
 *            "Checking whether you're on the floor...";
 *   failed:  "Whether [first name] is on the floor could not be checked just
 *            now." / "Whether you're on the floor could not be checked just now."
 * A failed or unfinished read never reads as "not on the floor" (FN-0 F15).
 *
 * The server gives a parent ids and an athlete a yes or no, nothing else (F1);
 * the names are the hub's own. Nothing from the line is kept on the device
 * (F10). One neutral line each, no warning colour (OW25-35 A's shape).
 */

export interface FloorChild {
  readonly id: string;
  /** The hub's own label for the child: first name, or full name where two share one. */
  readonly name: string;
}

type Props =
  | { readonly reader: 'parent'; readonly childList: readonly FloorChild[] }
  | { readonly reader: 'athlete'; readonly visible?: boolean };

type ReadState =
  | { readonly state: 'loading' }
  | { readonly state: 'failed' }
  | { readonly state: 'read'; readonly onTheFloor: readonly string[] | boolean };

export const ON_THE_FLOOR_FAMILY_WORDS = {
  childOn: (name: string) => `${name} is on the floor now.`,
  childChecking: (name: string) => `Checking whether ${name} is on the floor...`,
  childFailed: (name: string) => `Whether ${name} is on the floor could not be checked just now.`,
  youOn: "You're on the floor now.",
  youNot: "You're not counted on the floor right now.",
  youChecking: "Checking whether you're on the floor...",
  youFailed: "Whether you're on the floor could not be checked just now.",
} as const;

function answerFits(reader: Props['reader'], value: unknown): value is readonly string[] | boolean {
  if (reader === 'athlete') return typeof value === 'boolean';
  return Array.isArray(value) && value.every((id) => typeof id === 'string');
}

export default function OnTheFloorFamilyLine(props: Props) {
  const { reader } = props;
  const [read, setRead] = useState<ReadState>({ state: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/on-the-floor`, {
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
        });
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (controller.signal.aborted) return;
        const onTheFloor = payload.on_the_floor;
        if (!response.ok || payload.ok !== true || !answerFits(reader, onTheFloor)) {
          setRead({ state: 'failed' });
          return;
        }
        setRead({ state: 'read', onTheFloor });
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
        setRead({ state: 'failed' });
      }
    })();
    return () => controller.abort();
  }, [reader]);

  let lines: string[];
  if (props.reader === 'athlete') {
    if (props.visible === false) return null;
    if (read.state === 'loading') lines = [ON_THE_FLOOR_FAMILY_WORDS.youChecking];
    else if (read.state === 'failed') lines = [ON_THE_FLOOR_FAMILY_WORDS.youFailed];
    else lines = [read.onTheFloor === true ? ON_THE_FLOOR_FAMILY_WORDS.youOn : ON_THE_FLOOR_FAMILY_WORDS.youNot];
  } else {
    const children = props.childList;
    if (read.state === 'loading') lines = children.map((child) => ON_THE_FLOOR_FAMILY_WORDS.childChecking(child.name));
    else if (read.state === 'failed') lines = children.map((child) => ON_THE_FLOOR_FAMILY_WORDS.childFailed(child.name));
    else {
      const counted = new Set(read.onTheFloor as readonly string[]);
      lines = children.filter((child) => counted.has(child.id)).map((child) => ON_THE_FLOOR_FAMILY_WORDS.childOn(child.name));
    }
  }
  if (lines.length === 0) return null;

  return (
    <section aria-label="On the floor" className="rounded-[var(--r-lg)] p-[var(--s4)]" aria-live="polite" aria-busy={read.state === 'loading'}>
      {lines.map((line, index) => (
        <p key={index} className="t-body" style={{ fontSize: 'var(--t-md)' }}>
          {line}
        </p>
      ))}
    </section>
  );
}
