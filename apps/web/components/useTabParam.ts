'use client';

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';

/**
 * THE OPEN TAB, KEPT IN THE ADDRESS (`?tab=<id>`), so coming back to a page
 * opens the tab you left (app scrub ATH-16, FAM-06; lane AS4-4D4E, AS-4 part
 * 4e). Before this, every Back press landed on the page's first tab.
 *
 * - The address is the one place the tab lives. The page reads it on every
 *   render; only an id in `allowed` opens, and anything else, or no value,
 *   opens `fallback`. `allowed` must be the tabs the page actually draws for
 *   the reader, so the address can never open a tab the reader could not open
 *   by pressing it (Overwatch's condition 2 on #2128).
 * - Written with replace, not push (Q5 A on #2128): Back leaves the page, as
 *   before, and does not walk back through the tabs. The write is the
 *   browser's own history.replaceState with a null state, which the Next.js
 *   App Router patches to copy into its own state
 *   (node_modules/next/dist/client/components/app-router.js, "Patch
 *   replaceState"; Next.js docs, "Linking and Navigating"). A non-null state
 *   carrying Next's own marker would skip that copy, and Next would later
 *   write its stale address back (review on #2130). It needs no mounted
 *   router, so the workspaces render the same in tests and on the page.
 * - A same-page link (the job bar's Parent Hub tab items while on Parent Hub)
 *   cannot reopen the page: Next keys a page without its search, so a soft
 *   navigation to `?tab=` would change only the address. Such a link calls
 *   openTabHere instead, which writes the address and tells every reader.
 * - The fallback tab leaves no `?tab=` behind; every other query parameter
 *   and the hash are kept.
 *
 * This only chooses which allowed tab is drawn. It reads nothing, grants
 * nothing, and each tab keeps its own reads and checks.
 */

const TAB_PARAM_EVENT = 'ppbf:tab-param';

function subscribe(onChange: () => void): () => void {
  window.addEventListener(TAB_PARAM_EVENT, onChange);
  window.addEventListener('popstate', onChange);
  return () => {
    window.removeEventListener(TAB_PARAM_EVENT, onChange);
    window.removeEventListener('popstate', onChange);
  };
}

const readSearch = () => window.location.search;
const noSearch = () => '';

export function tabFromSearch<T extends string>(search: string, allowed: readonly T[], fallback: T): T {
  const value = new URLSearchParams(search).get('tab');
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function readTabParam<T extends string>(allowed: readonly T[], fallback: T): T {
  return typeof window === 'undefined' ? fallback : tabFromSearch(window.location.search, allowed, fallback);
}

/** Replace the address with `url` (same page) and tell every useTabParam reader. */
export function replaceAddress(url: string): void {
  if (typeof window === 'undefined') return;
  const target = new URL(url, window.location.href);
  const next = `${target.pathname}${target.search}${target.hash}`;
  if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    window.history.replaceState(null, '', next);
  }
  window.dispatchEvent(new Event(TAB_PARAM_EVENT));
}

export function writeTabParam<T extends string>(tab: T, fallback: T): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (tab === fallback) url.searchParams.delete('tab');
  else url.searchParams.set('tab', tab);
  replaceAddress(`${url.pathname}${url.search}${url.hash}`);
}

/**
 * For a link to `href` that names a tab: when the reader is already on that
 * page, open the tab in place and report true (the caller then stops the
 * link's own navigation); otherwise report false and let the link navigate.
 */
export function openTabHere(href: string): boolean {
  if (typeof window === 'undefined') return false;
  const target = new URL(href, window.location.href);
  if (target.origin !== window.location.origin || target.pathname !== window.location.pathname) return false;
  replaceAddress(`${target.pathname}${target.search}${window.location.hash}`);
  return true;
}

export function useTabParam<T extends string>(allowed: readonly T[], fallback: T): readonly [T, (tab: T) => void] {
  const search = useSyncExternalStore(subscribe, readSearch, noSearch);
  const tab = useMemo(() => tabFromSearch(search, allowed, fallback), [search, allowed, fallback]);
  // The page this reader is on. A tab set after an await, once the reader has
  // left, must not write `?tab=` onto the next page's address (review on #2130).
  const [mountedPath] = useState(() => (typeof window === 'undefined' ? null : window.location.pathname));
  const setTab = useCallback(
    (next: T) => {
      if (typeof window === 'undefined' || window.location.pathname !== mountedPath) return;
      writeTabParam(next, fallback);
    },
    [fallback, mountedPath],
  );
  return [tab, setTab] as const;
}
