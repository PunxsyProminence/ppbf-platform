"use client";

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { plateVariantTokens } from './plateVariant';

/**
 * Puts the route's plate variant where every room in the building can see it.
 *
 * WHY AN ANCESTOR AND NOT THE ROOM ELEMENT ITSELF. The room element is the
 * obvious place for this attribute, and it is out of reach. Measured on
 * 8a08ab7b: 78 non-test surfaces paint a `.room--*` class of their own -- 73 of
 * them `app/**\/page.tsx`, one layout, four shared components -- against 19
 * that hand `room=` to RoleStandaloneView. (familyPlateGround.test.ts records
 * the same ratio from the other side: "only 14 of the ~79 room-bearing surfaces
 * go through that shell".) So wiring the shell alone would cover the MINORITY
 * of the building, and wiring the other 73 is not an option either: they are
 * server components, and a server component cannot know its own route --
 * `usePathname` is a client hook, and reading the path from `headers()` in the
 * root layout would make every page dynamic and break `output: "export"`.
 *
 * One client component high enough to be an ancestor of all of them solves both
 * halves at once. `usePathname()` is server-rendered correctly by the App
 * Router, so the attribute is in the first HTML the browser parses: no flash,
 * no second plate fetched, no hydration-time swap -- which an effect writing to
 * `document.documentElement` would have had, and which is exactly the "the page
 * changed under me" the determinism rule exists to prevent. It also updates on
 * client-side navigation, because `usePathname` re-renders its subscribers.
 *
 * `display: contents` deliberately, and for the reason app/athlete/layout.tsx
 * already gives for its own marker: this element must mark its subtree without
 * appearing in layout. It generates no box, so nothing in the building gains a
 * container it was not designed inside, and the branch that introduced it can
 * promise zero visual change and mean it. Selector matching walks the DOM tree
 * rather than the box tree, so a display:contents ancestor still matches.
 */
export default function PlateVariantGround({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="contents" data-plate-variant={plateVariantTokens(pathname)}>
      {children}
    </div>
  );
}

// Punxsy Prominence Boxing and Fitness, Registered Office: 220 N Jefferson St, Punxsutawney, PA 15767
