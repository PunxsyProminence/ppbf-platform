'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSyncExternalStore } from 'react';

import { getRoleSessionSnapshot, subscribeRoleSession } from './roleSession';
import {
  ROOM_BLURB,
  ROOM_LABEL,
  doorForPath,
  doorsByRoom,
  type Room,
} from './buildingMap';

/**
 * THE CORRIDOR — how you walk the building.
 *
 * Law 6 made every screen a room. Nothing, until now, let you get between them:
 * 63 routes and two links in the header. The corridor is the hallway those
 * rooms open onto, and it does two jobs at once — it moves you, and it tells
 * you where you are standing, which is the part a breadcrumb usually does badly.
 *
 * Only rooms the session can enter are listed. That is a courtesy so the
 * corridor does not offer a door that bounces you; the page guard remains the
 * authority. See the note at the top of buildingMap.ts.
 */
export default function Corridor() {
  const pathname = usePathname();
  const session = useSyncExternalStore(subscribeRoleSession, getRoleSessionSnapshot, () => null);
  const role = session?.role ?? null;

  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const groups = useMemo(() => doorsByRoom(role), [role]);
  const here = useMemo(() => doorForPath(pathname), [pathname]);
  const hereRoom: Room | null = here?.room ?? null;

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  /* Close on Escape, and on a click outside the panel. */
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    }
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (panelRef.current && !panelRef.current.contains(t) && !triggerRef.current?.contains(t)) {
        close();
      }
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open, close]);

  /* Walking through a door closes the corridor behind you. Done by the parent
     keying this component on the pathname rather than by an effect: setState in
     an effect cascades a render, and a remount gives exactly the semantics
     wanted — the corridor is shut on every new surface. */

  // Signed out there is nothing to walk between, so the corridor stays shut
  // rather than showing a hallway of doors that all lead to /login.
  if (!role && groups.length === 0) return null;

  return (
    <div className="corridor-root">
      <button
        ref={triggerRef}
        type="button"
        className={`corridor-trigger${open ? ' is-open' : ''}`}
        aria-expanded={open}
        aria-controls="corridor-panel"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="corridor-trigger-glyph" aria-hidden="true">▤</span>
        <span className="corridor-trigger-lbl">
          {hereRoom ? ROOM_LABEL[hereRoom] : 'Rooms'}
        </span>
        {here && <span className="corridor-trigger-here">{here.label}</span>}
      </button>

      {open && (
        <div
          id="corridor-panel"
          ref={panelRef}
          className="corridor-panel"
          role="navigation"
          aria-label="The building — rooms and the surfaces in them"
        >
          <div className="corridor-head">
            <b>The building</b>
            <span>
              {groups.reduce((n, g) => n + g.doors.length, 0)} surfaces
              {role ? ` open to ${role.replace(/_/g, ' ')}` : ' open without a session'}
            </span>
          </div>

          <div className="corridor-rooms">
            {groups.map((group) => (
              <section
                key={group.room}
                className={`corridor-room room--${group.room}${group.room === hereRoom ? ' is-here' : ''}`}
              >
                <header className="corridor-room-hd">
                  <b>{ROOM_LABEL[group.room]}</b>
                  {group.room === hereRoom && <span className="corridor-youarehere">you are here</span>}
                  <span className="corridor-room-blurb">{ROOM_BLURB[group.room]}</span>
                </header>
                <ul className="corridor-doors">
                  {group.doors.map((door) => {
                    const current = door.href === pathname;
                    return (
                      <li key={door.href}>
                        <Link
                          href={door.href}
                          className={`corridor-door${current ? ' is-current' : ''}`}
                          aria-current={current ? 'page' : undefined}
                        >
                          {door.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>

          <div className="corridor-foot">
            Press <kbd>⌘K</kbd> or <kbd>/</kbd> to search every surface instead.
          </div>
        </div>
      )}
    </div>
  );
}
