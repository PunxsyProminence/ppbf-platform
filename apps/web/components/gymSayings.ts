/**
 * ============================================================================
 * WORDS ON THE WALL — THE GYM'S OWN SAYINGS
 * ============================================================================
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  THIS FILE SHIPPED EMPTY UNTIL THE OWNER FILLED IT. THAT WAS NEVER A       │
 * │  PLACEHOLDER STATE — IT WAS THE POINT.                                    │
 * │                                                                          │
 * │  The lines below are the ones the owner confirmed 2026-08-19 (Drive doc   │
 * │  2026-08-19_EGGS-LOAD-FIRST-12.md). Nobody who has not stood on that      │
 * │  floor could have written them, and this file did not pretend otherwise   │
 * │  by borrowing somebody else's in the meantime.                            │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * WHY NOT JUST PUT SOME BOXING QUOTES IN AND SWAP THEM LATER
 *
 * Because they would never be swapped, and because the whole platform is an
 * argument against exactly that. Every other surface here is a real record: the
 * training card cannot flatter anybody because each stamp is one row from the
 * session log; the wall of names carries names the gym actually has; the
 * refusal stamps say what really refused and why. A painted sign that quotes
 * something scraped off the internet — Ali, Tyson, a poster in a chain gym —
 * would be the first thing on the wall that is not true, hung in the largest
 * type on the screen, in the voice of a coach who never said it.
 *
 * A child reading "everybody has a plan until they get punched in the mouth"
 * on their own training card learns that the gym's voice is decoration. A child
 * reading something their own coach says in the corner learns the opposite. The
 * difference is the entire point, and it cannot be added afterwards.
 *
 * So the module is built, tested, and wired, and it renders NOTHING until the
 * lines exist. An empty wall is honest. A wall of stock quotes is not.
 *
 * ---------------------------------------------------------------------------
 * FOR THE OWNER — HOW TO ADD REAL LINES
 * ---------------------------------------------------------------------------
 *
 * Add entries to GYM_SAYINGS at the bottom of this file. Each one needs:
 *
 *   line         What is actually said. Short enough to paint on a wall —
 *                roughly twelve words. It gets set in the display voice at
 *                sign size, so a paragraph will not fit and should not.
 *
 *   said_by      Who says it. A coach's name, "the wall", "Coach Mike's dad" —
 *                whatever is true. Shown in small type under the line, the way
 *                a signature sits under painted lettering.
 *
 *   shown        WHERE it is allowed to appear. This is the field that keeps
 *                the module from becoming wallpaper — see the note below.
 *                One or more of:
 *                  'after-hard-session'  someone just logged a heavy session
 *                  'at-a-milestone'      a seal came down on the card
 *                  'anywhere'            either of the above
 *
 * Example of the shape (COMMENTED OUT — it is a shape, not a saying, and it
 * must never render):
 *
 *   // { line: '<something Coach ___ actually says>',
 *   //   said_by: '<who says it>',
 *   //   shown: ['after-hard-session'] },
 *
 * ---------------------------------------------------------------------------
 * THE RULE THAT MAKES A SIGN A SIGN AND NOT A BANNER
 * ---------------------------------------------------------------------------
 *
 * These are shown CONTEXTUALLY and never permanently. A line that is on the
 * screen every time you open it is wallpaper within a week — the eye stops
 * seeing it, and then it is worse than nothing because the gym said something
 * and nobody heard. WordsOnTheWall renders only when a context is passed to
 * it, and the two contexts are both moments: a hard session was just logged, or
 * a milestone just landed. There is no 'always'.
 *
 * The selection is DETERMINISTIC, not random: the same milestone shows the same
 * line every time it is looked at. A sign that changes when you blink is a slot
 * machine, and it also means a screen reader and a printout disagree with the
 * screen.
 */

/** Where a saying is allowed to appear. There is deliberately no 'always'. */
export type SayingContext = 'after-hard-session' | 'at-a-milestone' | 'anywhere';

export interface GymSaying {
  /** What is actually said, in the coach's words. */
  readonly line: string;
  /** Who says it. Shown small, under the line, like a signature. */
  readonly said_by: string;
  /** The moments this line may appear in. */
  readonly shown: readonly SayingContext[];
}

/**
 * THE SOURCE. Owner-approved 2026-08-19 — the gym's own first 12 lines.
 *
 * A test asserts every entry here is attributable and free of stock boxing
 * quotes, so a scraped-off-the-internet line cannot arrive in a later patch
 * without somebody deliberately deleting the test that says it must not.
 */
export const GYM_SAYINGS: readonly GymSaying[] = [
  { line: 'OBSERVE. DECIDE. EXECUTE. REPEAT.', said_by: 'the wall', shown: ['anywhere'] },
  { line: "POOR MAN'S SPORT", said_by: 'the wall', shown: ['anywhere'] },
  { line: 'SAFETY FIRST. KIDS FIRST.', said_by: 'the wall', shown: ['anywhere'] },
  { line: 'SHOW UP. DO THE WORK. GO HOME BETTER.', said_by: 'the wall', shown: ['after-hard-session'] },
  { line: "THE WORK DOESN'T LIE", said_by: 'the wall', shown: ['after-hard-session'] },
  { line: 'KEEP THE STANDARD. KEEP THE KIDS.', said_by: 'the wall', shown: ['anywhere'] },
  { line: 'HANDS UP. HEAD CLEAR.', said_by: 'the wall', shown: ['after-hard-session'] },
  { line: 'NO HYPE. JUST WORK.', said_by: 'the wall', shown: ['anywhere'] },
  { line: 'SHADOW NOTICES THE PATTERN', said_by: 'the wall', shown: ['at-a-milestone'] },
  { line: 'CHECK IN. THEN WORK.', said_by: 'the wall', shown: ['anywhere'] },
  { line: 'STEEL TOWN. STEADY HANDS.', said_by: 'the wall', shown: ['anywhere'] },
  { line: 'WE BUILD PEOPLE, NOT JUST FIGHTERS.', said_by: 'the wall', shown: ['at-a-milestone'] },
];

/**
 * The sayings eligible for a moment. 'anywhere' matches every context; a line
 * tagged only 'at-a-milestone' never shows up after a hard session.
 */
export function sayingsFor(context: SayingContext, source: readonly GymSaying[] = GYM_SAYINGS): GymSaying[] {
  return source.filter((s) => s.shown.includes(context) || s.shown.includes('anywhere'));
}

/**
 * Pick one, deterministically, from a seed the caller already has (a milestone
 * number, a session id). The same seed always yields the same line, so the
 * sign does not shuffle on every render, every tab focus, or every reload.
 *
 * Returns null when there is nothing to say, which is the shipped state and a
 * perfectly good state — the caller renders nothing at all.
 */
export function pickSaying(
  context: SayingContext,
  seed: string | number,
  source: readonly GymSaying[] = GYM_SAYINGS,
): GymSaying | null {
  const eligible = sayingsFor(context, source);
  if (eligible.length === 0) {
    return null;
  }

  // FNV-1a, 32-bit. Any stable hash would do; this one is four lines and has
  // no dependency, which matters on a kiosk that loads off a cold cache.
  const text = String(seed);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return eligible[hash % eligible.length];
}
