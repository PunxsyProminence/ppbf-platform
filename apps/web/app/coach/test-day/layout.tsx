import type { ReactNode } from 'react';

import KioskSurface from '@/components/KioskSurface';

/* A gym-floor page: 55px controls and the kiosk type floor (UXB-08).
   kioskTapFloor.test.tsx holds the list of pages that must carry this. */
export default function TestDayLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <KioskSurface>{children}</KioskSurface>;
}
