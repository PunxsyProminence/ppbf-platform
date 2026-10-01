import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/* THE BROWSER TAB IS THE OTHER HALF OF KNOWING WHICH ROOM YOU ARE IN.
 *
 * The owner's 2026-09-26 ruling asks for both: the rail inside the room, and the
 * tab outside it. Until now every surface in this application shared one title
 * and one favicon, so a coach with the drill cabinet, the floor board and the
 * scheduler open read three identical tabs and had to click to find out which
 * was which.
 *
 * A LAYOUT, BECAUSE THE PAGE CANNOT DO IT. page.tsx is a client component and
 * Next.js only reads `metadata` from a server module, so the title has to live
 * beside it rather than in it. This layout adds no element and no gate -- the
 * page keeps its own RoleSessionGate -- it exists purely to carry the two pieces
 * of chrome identity.
 *
 * The root template is "%s | PPBF Platform" (app/layout.tsx), so this renders as
 * "Drill Cabinet | PPBF Platform" and the room's name is the part that survives
 * a narrow tab strip, which is the whole point.
 *
 * The favicon is `icon.svg` in this folder -- the first per-route icon in the
 * app. Next.js resolves the nearest one, so every other surface keeps the
 * platform seal and nothing else moves.
 */
export const metadata: Metadata = {
  title: 'Drill Cabinet',
  description: 'The drill reference, the drills this gym runs, and the bench where a new one is written.',
};

export default function DrillCabinetLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return children;
}
