import type { ReactNode } from 'react';

import KioskSurface from '@/components/KioskSurface';

/* The class screen (lane U2-6a): run on a tablet on the gym floor, so 55px controls and the kiosk
   type floor, as the other Gym Floor pages are (app scrub CF-24; lane U1, SC2-2).
   kioskTapFloor.test.tsx holds the list of pages that must carry this. */
export default function CoachClassLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <KioskSurface>{children}</KioskSurface>;
}
