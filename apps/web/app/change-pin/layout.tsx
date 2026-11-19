import type { ReactNode } from 'react';

import KioskSurface from '@/components/KioskSurface';

/* Change PIN (the first PIN after a gym-issued one): the kiosk tap floor (55px controls, app/globals.css) on the gym
   tablet, as the athlete sign-in already has (app scrub ATH-14; lane U1, SC2-4).
   kioskTapFloor.test.tsx holds the list of pages that must carry this. */
export default function ChangePinLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <KioskSurface>{children}</KioskSurface>;
}
