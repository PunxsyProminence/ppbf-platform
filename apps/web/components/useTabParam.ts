'use client';

import { useCallback, useState } from 'react';

/**
 * THE OPEN TAB, KEPT IN THE ADDRESS (`?tab=<id>`), so coming back to a page
 * opens the tab you left (app scrub ATH-16, FAM-06; lane AS4-4D4E, AS-4 part
 * 4e). Before this, every "Back to ..." link and every Back press landed on
 * the page's first tab.
 *
 * - Read once, when the page mounts. Only an id in `allowed` opens; anything
 *   else, or no value, opens `fallback`. `allowed` must be the tabs the page
 *   actually draws for the reader, so the address can never open a tab the
 *   reader could not open by pressing it (Overwatch's condition 2 on #2128).
 * - Written with replace, not push (Q5 A on #2128): Back leaves the page, as
 *   before, and does not walk back through the tabs. The write is the
 *   browser's own history.replaceState, which the Next.js App Router keeps in
 *   step with its own state (node_modules/next/dist/client/components/
 *   app-router.js, "Patch replaceState"; Next.js docs, "Linking and
 *   Navigating", window.history.replaceState). It needs no mounted router, so
 *   the workspaces render the same in tests and on the page.
 * - The fallback tab leaves no `?tab=` behind; every other query parameter
 *   and the hash are kept.
 *
 * This only chooses which allowed tab is drawn first. It reads nothing,
 * grants nothing, and each tab keeps its own reads and checks.
 */
export function readTabParam<T extends string>(allowed: readonly T[], fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  const value = new URLSearchParams(window.location.search).get('tab');
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function writeTabParam<T extends string>(tab: T, fallback: T): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (tab === fallback) url.searchParams.delete('tab');
  else url.searchParams.set('tab', tab);
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (next === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  window.history.replaceState(window.history.state, '', next);
}

export function useTabParam<T extends string>(allowed: readonly T[], fallback: T): readonly [T, (tab: T) => void] {
  const [tab, setTabState] = useState<T>(() => readTabParam(allowed, fallback));
  const setTab = useCallback(
    (next: T) => {
      setTabState(next);
      writeTabParam(next, fallback);
    },
    [fallback],
  );
  return [tab, setTab] as const;
}
