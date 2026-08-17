'use client';

import { useEffect } from 'react';

/**
 * Multi-step forms (setup wizards, activation flows) that swap which step's
 * markup is visible without ever navigating or remounting the page leave a
 * keyboard/screen-reader user's focus wherever it was on the PREVIOUS step --
 * often a button that just unmounted, dropping focus to <body> with no
 * announcement that anything changed. This moves focus to the new step's
 * heading each time `id` changes (callers compute a per-step id, e.g.
 * `step-${step}-heading`, so the dependency and the lookup target move
 * together), so the transition is both keyboard-reachable and announced.
 *
 * The target element needs `tabIndex={-1}` (headings aren't focusable by
 * default) and the matching `id`.
 */
export function useFocusOnStepChange(id: string): void {
  useEffect(() => {
    document.getElementById(id)?.focus();
  }, [id]);
}
