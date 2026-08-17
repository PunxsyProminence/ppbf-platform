import FloorOperationsDesk from '@/src/components/coach/FloorOperationsDesk';
import { requirePageRole } from '@/src/server/pilot/pageGuard';

export const dynamic = 'force-dynamic';

/**
 * /coach/operations — THE FLOOR OPERATIONS DESK, and the room it stands in.
 *
 * ---------------------------------------------------------------------------
 * THE ROOM
 * ---------------------------------------------------------------------------
 * Law 6: every screen is a room, chosen by what the screen IS rather than who
 * is looking at it. This one is `.room--floor` — brick and mortar in offset
 * courses, lit by caged lamps — and of the six rooms it is the most literal
 * match on the platform: a coach reading this page is physically standing on
 * the gym floor. Clearance, attendance and matchmaking are floor work.
 *
 * TWO CLASSES, BOTH LOAD-BEARING. `.room--floor` alone is a wall with no light
 * on it: it swaps the background for brick and declares the room's shadow
 * direction (`--sx: 0` — straight down, because the fixtures are overhead), but
 * the light itself lives on the base `.room` class, whose ::before paints the
 * two caged fixtures' pools. Most pages in this app carry `room--floor` alone
 * and are consequently unlit; `WallOfNames` carries both, and both is correct.
 *
 * The lit pools land on bare wall only. `.room > *` gives every direct child
 * `z-index: 1`, so the panels paint over the light rather than through it —
 * the lamps frame the work instead of washing it out. That is the property
 * that makes a lit room safe behind a dense operational table.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 * The page owns the room and the ground ink, and nothing else. Every panel,
 * material, fixture and rule lives in the component, because those are
 * furniture and furniture belongs to the desk. That split is the pattern the
 * other five consoles should copy: one line of room on <main>, everything
 * physical in the component.
 *
 * `minHeight` is an inline style on purpose. Tailwind v4 ships its utilities
 * inside `@layer utilities` and ppbf.css is imported unlayered, so an unlayered
 * `.room { min-height: 100% }` beats `min-h-screen` — and `100%` of an auto
 * height is not a screen. Same cascade fact means `.room`'s own padding wins
 * over any `p-*`, so none is set here. The `<main>` previously carried
 * `bg-[#09090b] font-mono text-slate-300`: a raw hex ground, off-palette grey
 * type, and the mono voice spent on prose — Law 4 gives mono to IDs, figures
 * and anything auditable, not to sentences.
 */
export default async function CoachOperationsPage() {
  await requirePageRole(['coach']);

  return (
    <main
      className="room room--floor bg-[var(--hide-950)] text-[color:var(--bone-200)]"
      style={{ minHeight: '100vh' }}
    >
      <FloorOperationsDesk />
    </main>
  );
}
