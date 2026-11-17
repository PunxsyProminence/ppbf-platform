import type { ReactNode } from 'react';

import KioskSurface from '@/components/KioskSurface';

/* A gym-floor page: 55px controls and the kiosk type floor (OD-2026-11-17-009
   ruling 4, Jason's card OW25-37 A), as Class plans and Workout templates are.
   kioskTapFloor.test.tsx holds the list of pages that must carry this. */
export default function DrillsLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <KioskSurface>{children}</KioskSurface>;
}
