import type { ReactNode } from 'react';

import KioskSurface from '@/components/KioskSurface';

/* Activate (redeem a gym-issued code and set a PIN): 55px controls and the kiosk type floor on the gym tablet, as the
   athlete sign-in already has (app scrub ATH-14; lane U1, SC2-4).
   kioskTapFloor.test.tsx holds the list of pages that must carry this. */
export default function ActivateLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <KioskSurface>{children}</KioskSurface>;
}
