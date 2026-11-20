import type { ReactNode } from 'react';

import KioskSurface from '@/components/KioskSurface';

/* A gym-floor page: 55px controls and the kiosk type floor, as its sibling
   clinic pages are (app scrub CS-11, lane AS-5). kioskTapFloor.test.tsx holds
   the list of pages that must carry this. */
export default function SparringCapsLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <KioskSurface>{children}</KioskSurface>;
}
