import type { ReactNode } from 'react';

import KioskSurface from '@/components/KioskSurface';

/* A gym-floor page (Stopped Coming, a coach door; lane W4-6, SC-2): 55px controls and the kiosk
   type floor, as Passbook Gaps is. kioskTapFloor.test.tsx holds the list of pages that must carry this. */
export default function StoppedComingLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <KioskSurface>{children}</KioskSurface>;
}
