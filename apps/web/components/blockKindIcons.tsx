import type { ReactNode } from 'react';

import type { SessionScriptBlockKind } from '@/src/server/pilot/sessionScripts';

/**
 * ONE PICTOGRAM PER SESSION BLOCK KIND (lane L39; Jason 2026-10-17, drill icons "Both": icons now
 * for the block kinds the app already has, a coach-set station field later).
 *
 * The kinds are the session script's own (sessionScripts.ts SessionScriptBlockKind), so an icon
 * says what the plan says and nothing a free-text label would have to be guessed from. Each one is
 * drawn here as a plain object with no lettering and no person, in currentColor, and the word is
 * ALWAYS printed beside it: the icon is never the only way to tell one block from another.
 *
 * Words are the coach screens' own where they exist (Drill, Reset, Teaching, Conditioning,
 * Reflection: SessionScriptLiveDelivery.tsx NOTABLE_KINDS); the other five name the kind as the
 * plan does. A kind this file does not know (one added to the plan later) gets no icon and no word,
 * and the block's own label still shows.
 */
export const BLOCK_KIND_WORDS: Readonly<Record<SessionScriptBlockKind, string>> = {
  arrival: 'Arrival',
  instruction: 'Instruction',
  demonstration: 'Demo',
  drill_round: 'Drill',
  reset_minute: 'Reset',
  teaching_minute: 'Teaching',
  transition: 'Transition',
  conditioning: 'Conditioning',
  reflection: 'Reflection',
  close: 'Close',
};

/** Stroke paths on a 24-unit grid. */
const BLOCK_KIND_DRAWINGS: Readonly<Record<SessionScriptBlockKind, ReactNode>> = {
  // An open door.
  arrival: (
    <>
      <path d="M5 21V3h10v18" />
      <path d="M15 3l5 2v14l-5 2" />
      <path d="M3 21h18" />
      <circle cx="17.5" cy="12" r="0.8" />
    </>
  ),
  // A clipboard.
  instruction: (
    <>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <rect x="9" y="2" width="6" height="4" rx="1" />
      <path d="M8 11h8M8 15h8M8 18.5h5" />
    </>
  ),
  // An eye: watch this.
  demonstration: (
    <>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  // A boxing glove.
  drill_round: (
    <>
      <path d="M7 17V8a5 5 0 0 1 10 0v5a4 4 0 0 1-4 4H7z" />
      <path d="M7 11.5H5.5A1.5 1.5 0 0 0 4 13v1a3 3 0 0 0 3 3" />
      <rect x="7" y="17" width="10" height="4" rx="1" />
    </>
  ),
  // An hourglass.
  reset_minute: (
    <>
      <path d="M6 2h12M6 22h12" />
      <path d="M7 2c0 5 10 5 10 10s-10 5-10 10" />
      <path d="M17 2c0 5-10 5-10 10s10 5 10 10" />
    </>
  ),
  // A chalkboard on legs.
  teaching_minute: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="1" />
      <path d="M8 16l-2 5M16 16l2 5" />
      <path d="M7 9.5l3 3 5-5" />
    </>
  ),
  // An arrow.
  transition: (
    <>
      <path d="M3 12h16" />
      <path d="M13 6l6 6-6 6" />
    </>
  ),
  // A kettlebell.
  conditioning: (
    <>
      <path d="M8.5 10V7a3.5 3.5 0 0 1 7 0v3" />
      <circle cx="12" cy="15" r="6" />
    </>
  ),
  // A notebook and pencil.
  reflection: (
    <>
      <rect x="3" y="3" width="11" height="18" rx="1" />
      <path d="M6 8h5M6 12h5M6 16h3" />
      <path d="M17 7l3 3-6 8h-3v-3z" />
    </>
  ),
  // The bell.
  close: (
    <>
      <path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </>
  ),
};

function isKnownKind(kind: string): kind is SessionScriptBlockKind {
  return Object.prototype.hasOwnProperty.call(BLOCK_KIND_WORDS, kind);
}

/** The word for a block kind, or null for a kind this screen does not know. */
export function blockKindWord(kind: string): string | null {
  return isKnownKind(kind) ? BLOCK_KIND_WORDS[kind] : null;
}

/**
 * The pictogram for a block kind, decorative (aria-hidden): the word beside it is what a reader and
 * the room are told. Nothing for an unknown kind.
 */
export function BlockKindIcon({ kind, className = '' }: { kind: string; className?: string }) {
  if (!isKnownKind(kind)) return null;
  return (
    <svg
      className={className}
      data-kind={kind}
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {BLOCK_KIND_DRAWINGS[kind]}
    </svg>
  );
}
