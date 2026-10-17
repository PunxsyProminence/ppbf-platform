import type { ReactNode } from 'react';

/**
 * Marks a route's subtree as a gym-floor surface, so the 55px tap floor and the
 * kiosk type floor (Law 5) reach it. Same hook as app/athlete/layout.tsx: the
 * stylesheet targets [data-surface="kiosk"], and `display: contents` keeps the
 * marker out of layout, so no page gains a box it was not designed inside.
 *
 * Used from a route's layout.tsx rather than a page's own <main>, so every
 * state the page can render (loading, refused, failed, ready) is covered
 * without anyone having to remember each branch (UXB-08).
 */
export default function KioskSurface({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div data-surface="kiosk" className="contents">
      {children}
    </div>
  );
}
