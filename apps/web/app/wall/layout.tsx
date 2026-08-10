import type { ReactNode } from 'react';

/**
 * Marks everything under /wall as the WALL surface.
 *
 * Same device as app/athlete/layout.tsx's [data-surface="kiosk"]: an attribute
 * on a container the whole section already passes through, so the rules in
 * globals.css apply to what is here now and to whatever gets added next, rather
 * than to whichever elements somebody remembered to mark.
 *
 * The room is .room--floor -- brick and caged lamps. Rooms are chosen by what
 * the screen IS rather than by who is looking, and this one is bolted to the
 * gym floor. .wall-room strips the room's default padding, because a
 * television is full bleed: there is no browser chrome around it and no margin
 * to breathe into.
 *
 * Unlike the kiosk marker this is NOT display:contents -- the room paints a
 * wall and hangs light on it, and an element with no box paints nothing.
 */
export default function WallLayout({ children }: { readonly children: ReactNode }) {
  return (
    <div data-surface="wall" className="room room--floor room--lit-center wall-room">
      {children}
    </div>
  );
}
