'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';

import ChromeLink from './ChromeLink';
import { useBoardSession } from './BoardRoleGate';
import { BUILDING, isRefusalSurface } from './buildingMap';
import { jobBarFor, type JobItem, type JobSection } from './jobBars';
import { getRoleSessionSnapshot, subscribeRoleSession } from './roleSession';

/**
 * THE JOB BAR (AS-4, U2-4b): each role's few jobs, on every page.
 *
 * The sections are jobBars.ts's (4a), from the App Scrub stage 2 file, section
 * 3.3, which Jason approved with S2-2 "A: Job bar + search (Recommended)"
 * (OD-2026-11-19-008). How it is drawn is scrub Q13 A (OD-2026-11-19-009):
 * "tags on tablet and desk, plain bar on phones". So there are two variants of
 * one component:
 *
 *   rail   leather tags in a row under the session bar, from the md width up
 *          (GlobalRoleHeader mounts it);
 *   phone  a plain bar fixed to the bottom of the screen below the md width
 *          (app/layout.tsx mounts it after the page, with a spacer as tall as
 *          the bar so the page's last line is never under it).
 *
 * A section with one page is a link. A longer one opens a small sheet of links
 * (jobBars.ts: "One item is a link; more than one opens a small sheet").
 *
 * WHAT IT SHOWS, AND WHAT IT DOES NOT DECIDE. Every page comes from jobBarFor,
 * which keeps an item only when visibleDoors gives the person its door, and
 * drops a section left empty. The bar never narrows or widens a door; each
 * page's own gate is still the authority (see buildingMap.ts's header note).
 *
 * BOARD SEATS FAIL CLOSED. The role session carries a board member's landing
 * seat; the seats they hold live only in BoardRoleGate's context, which sits
 * inside the board pages, below this bar. So here the held seats are usually
 * unknown, and they are passed as `null` ("holds none"), never left out:
 * jobBarFor then draws no seat workspace and makes Home Board Hub. A cached
 * landing seat is never trusted on its own.
 */

export type JobBarVariant = 'rail' | 'phone';

/**
 * Parent Hub's tab headings, by tab id, as ParentHub.tsx draws its tab rail
 * (JobBar.test.tsx reads that file and checks each pair). Until AS-4's 4e
 * reads `?tab=` there, the link opens Parent Hub, and the item says so.
 */
export const PARENT_HUB_TAB_LABEL: Readonly<Record<string, string>> = {
  overview: 'Overview',
  'parent-floor': 'Parent Floor',
  'home-assignments': 'Assignments',
  observations: 'Observations',
  'family-goals': 'Family Goals',
  messages: 'Messages',
  attendance: 'Attendance',
  progress: 'Progress',
  resources: 'Resources',
  shadow: 'SHADOW Intel',
};

/**
 * Whether Parent Hub opens a tab from the address (`?tab=`). It does not yet:
 * AS-4's 4e adds that (useTabParam). Until then a tab item would name a place
 * its link does not take you to, and on the hub itself would do nothing (layout
 * review round 1, BLOCKER), so tab items are not drawn; a section of nothing
 * but tabs (the parent's Messages) waits with them. Parent Hub, the parent's
 * Home, still has every tab. 4e sets this to true.
 */
export const PARENT_HUB_OPENS_TAB = false;

const DOOR_LABEL = new Map(BUILDING.map((door) => [door.href, door.label]));

const drawable = (item: JobItem): boolean => PARENT_HUB_OPENS_TAB || !item.tab;

function itemHref(item: JobItem): string {
  return item.tab ? `${item.href}?tab=${encodeURIComponent(item.tab)}` : item.href;
}

function itemKey(item: JobItem): string {
  return itemHref(item);
}

/** True when the page at `href` is where the person is standing, or above it. */
function covers(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

interface DrawnSection extends JobSection {
  readonly key: string;
}

export default function JobBar({ variant }: { readonly variant: JobBarVariant }) {
  const pathname = usePathname() ?? '';
  const session = useSyncExternalStore(subscribeRoleSession, getRoleSessionSnapshot, () => null);
  const boardSession = useBoardSession();
  const baseId = useId();

  // The sheet is tied to the page it was opened on, so walking to another page
  // shuts it without an effect writing state on navigation.
  const [opened, setOpened] = useState<{ readonly index: number; readonly path: string } | null>(null);
  const openIndex = opened && opened.path === pathname ? opened.index : null;
  const navRef = useRef<HTMLElement>(null);
  const triggers = useRef(new Map<number, HTMLButtonElement>());
  const sheetRef = useRef<HTMLDivElement | null>(null);

  const role = session?.role ?? null;
  const landingSeat = session?.boardSeat ?? null;
  const heldSeats = boardSession?.seats ?? null;

  const sections = useMemo<DrawnSection[]>(() => {
    const bar = jobBarFor(role, { boardSeat: landingSeat, boardSeats: heldSeats });
    if (!bar) return [];
    const all: JobSection[] = [...bar.sections, { label: 'More', items: bar.more }]
      .map((section) => ({ label: section.label, items: section.items.filter(drawable) }))
      .filter((section) => section.items.length > 0);
    // A section that only repeats an earlier one is drawn once: a board member
    // with no confirmed seat has Board Hub as both Home and "Board hub".
    const seen = new Set<string>();
    const drawn: DrawnSection[] = [];
    for (const section of all) {
      const key = section.items.map(itemKey).join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      drawn.push({ ...section, key: `${section.label}:${key}` });
    }
    return drawn;
  }, [role, landingSeat, heldSeats]);

  // Where the person is: the longest page address that holds this path, and
  // the first section that lists it. A Parent Hub tab item is never "here":
  // which tab is open is the hub's to say.
  const here = useMemo(() => {
    let best: { href: string; section: number } | null = null;
    sections.forEach((section, index) => {
      for (const item of section.items) {
        if (item.tab || !covers(item.href, pathname)) continue;
        if (!best || item.href.length > best.href.length) best = { href: item.href, section: index };
      }
    });
    return best as { href: string; section: number } | null;
  }, [sections, pathname]);

  const close = useCallback(
    (returnFocus: boolean) => {
      if (returnFocus && openIndex !== null) triggers.current.get(openIndex)?.focus();
      setOpened(null);
    },
    [openIndex],
  );

  /* THE SHEET FITS THE SCREEN (layout review round 1). Measured once when it
     opens: a rail sheet is moved left as far as it would run past the right
     edge (a 768px tablet), and either sheet is cut to the room it actually has
     -- below the screen's bottom for the rail (a landscape phone), above the
     sticky session bar for the phone sheet (a short phone) -- and scrolls. */
  const fitSheet = useCallback(
    (sheet: HTMLDivElement | null) => {
      if (!sheet || typeof window === 'undefined') return;
      const gap = 8;
      // Clear the last fit first, so a second measure (a re-render, a turn of
      // the tablet) starts from where the sheet really sits.
      sheet.style.left = '';
      sheet.style.maxHeight = '';
      const box = sheet.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) return; // not laid out (jsdom)
      if (variant === 'rail') {
        const overflow = box.right - (window.innerWidth - gap);
        if (overflow > 0) sheet.style.left = `${-Math.min(overflow, box.left - gap)}px`;
        sheet.style.maxHeight = `${Math.max(120, window.innerHeight - box.top - gap)}px`;
      } else {
        const header = document.querySelector('header');
        const headerBottom = header ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
        // No floor here: on a landscape phone the room below the session bar
        // can be small, and a taller sheet would slide under that bar (layout
        // review round 2). It scrolls instead.
        sheet.style.maxHeight = `${Math.max(0, box.bottom - headerBottom - gap)}px`;
      }
    },
    [variant],
  );

  useEffect(() => {
    if (openIndex === null) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
      }
    }
    function onDown(event: MouseEvent) {
      if (navRef.current && !navRef.current.contains(event.target as Node)) close(false);
    }
    // A tablet turned with a sheet open: measure it again, or its foot can sit
    // below the screen inside the sticky bar, out of reach (layout review round 2).
    function onResize() {
      const sheet = sheetRef.current;
      if (sheet) fitSheet(sheet);
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onResize);
    };
  }, [openIndex, close, fitSheet]);


  const isWallRoute = pathname === '/wall' || pathname.startsWith('/wall/');
  if (!session || pathname === '/login' || isWallRoute || isRefusalSurface(role, pathname)) return null;
  if (sections.length === 0) return null;

  const rail = variant === 'rail';
  const controlClass = rail ? 'leather-tag job-bar__tag' : 'job-bar__cell';

  return (
    <>
      <nav ref={navRef} aria-label="Your jobs" className={`job-bar job-bar--${variant}`}>
        <ul className="job-bar__row">
          {sections.map((section, index) => {
            const active = here?.section === index;
            const control = `${controlClass}${active ? ' is-active' : ''}`;
            if (section.items.length === 1) {
              const item = section.items[0];
              const current = active && !item.tab && item.href === here?.href;
              return (
                <li key={section.key} className="job-bar__section">
                  <ChromeLink href={itemHref(item)} className={control} aria-current={current ? 'page' : undefined}>
                    {section.label}
                  </ChromeLink>
                </li>
              );
            }
            const sheetId = `${baseId}-sheet-${index}`;
            const expanded = openIndex === index;
            return (
              <li key={section.key} className="job-bar__section">
                <button
                  ref={(node) => {
                    if (node) triggers.current.set(index, node);
                    else triggers.current.delete(index);
                  }}
                  type="button"
                  className={`${control}${expanded ? ' is-open' : ''}`}
                  aria-expanded={expanded}
                  aria-controls={sheetId}
                  onClick={() => setOpened(expanded ? null : { index, path: pathname })}
                >
                  {section.label}
                  {active ? <span className="sr-only"> (you are here)</span> : null}
                  <span className="job-bar__caret" aria-hidden="true">{expanded ? '▴' : '▾'}</span>
                </button>
                {expanded ? (
                  <div
                    id={sheetId}
                    ref={(node) => {
                      sheetRef.current = node;
                      fitSheet(node);
                    }}
                    className="job-bar__sheet"
                  >
                    <p className="job-bar__sheet-head">{section.label}</p>
                    <ul className="job-bar__list">
                      {section.items.map((item) => {
                        const current = active && !item.tab && item.href === here?.href;
                        return (
                          <li key={itemKey(item)}>
                            <ChromeLink
                              href={itemHref(item)}
                              className={`job-bar__link${current ? ' is-current' : ''}`}
                              aria-current={current ? 'page' : undefined}
                            >
                              {item.tab ? (
                                <>
                                  {PARENT_HUB_TAB_LABEL[item.tab] ?? item.tab}
                                  <span className="job-bar__hint"> · Parent Hub tab</span>
                                </>
                              ) : (
                                DOOR_LABEL.get(item.href) ?? item.href
                              )}
                            </ChromeLink>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </nav>
      {rail ? null : <div className="job-bar-spacer" aria-hidden="true" />}
    </>
  );
}
