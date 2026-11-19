import type { ReactNode } from 'react';

import KioskSurface from '@/components/KioskSurface';

/* A gym-floor page (Passbook Gaps, a Gym Floor door): 55px controls and the kiosk type
   floor, as Drills and Workout templates are (app scrub CF-24; lane U1, SC2-2).
   kioskTapFloor.test.tsx holds the list of pages that must carry this. */
export default function PassbookGapsLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <KioskSurface>{children}</KioskSurface>;
}
