import type { ReactNode } from 'react';

import KioskSurface from '@/components/KioskSurface';

/* A gym-floor page (app scrub CS-11, lane AS-5): marks the subtree so the
   kiosk floors reach it -- buttons at 55px and the type voices at 19.1px.
   NOT yet at the floor here: ContactCapPanel's `.select`/`.input` fields (46px
   without input--kiosk), its inline smaller text, the "Cap history" summary,
   and the page's alert lines. kioskTapFloor.test.tsx holds the list of pages
   that must carry this. */
export default function SparringCapsLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <KioskSurface>{children}</KioskSurface>;
}
