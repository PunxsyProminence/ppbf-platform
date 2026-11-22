import type { ReactNode } from 'react';

import KioskSurface from '@/components/KioskSurface';

/* Workout Templates: the whole page on the kiosk tap floor (55px controls) and
   type floor (19.1px), not only Issue and Make a session plan (app scrub CF-24
   remainder; lane SWP, SWP-2). kioskTapFloor.test.tsx holds the list of pages
   that must carry this. */
export default function WorkoutTemplatesLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <KioskSurface>{children}</KioskSurface>;
}
