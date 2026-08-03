'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSyncExternalStore } from 'react';

import { apiBase } from '@/lib/apiBase';
import { clearRoleSession, getRoleSessionSnapshot, subscribeRoleSession } from './roleSession';
import {
  ROOM_LABEL,
  doorsByRoom,
  searchDoors,
  type Door,
} from './buildingMap';
import { isTypingTarget } from './shortcuts';
import useGymSound from './useGymSound';
import { beforeDawnNote, catalogNod, recordCatalogOpen } from './gymNotices';

/**
 * THE CARD CATALOG — Cmd/Ctrl+K, or "/" on any surface that is not a field.
 *
 * The file room is walled in cork and lit by a gooseneck; the drawer of index
 * cards is the object that belongs in it. Type and it filters, arrows move,
 * Enter opens, Escape closes.
 *
 * It never shows a door the session cannot open — but that filtering is a
 * courtesy, not a security boundary. Every page keeps its own guard. See the
 * note at the top of buildingMap.ts.
 *
 * ---------------------------------------------------------------------------
 * IT DOES THINGS NOW, NOT JUST GOES PLACES
 * ---------------------------------------------------------------------------
 * A ⌘K that only navigates is a menu with a search box. The rows below marked
 * as ACTS run something instead of pushing a route, and they are drawn
 * differently on purpose — a brass verb bezel instead of a route in mono type.
 * A row that looks like navigation and instead performs an action is the worst
 * thing a command palette can contain, so the two are never allowed to look
 * alike.
 *
 * WHAT MAY BECOME AN ACT — the rule, because it is the part that can hurt
 * somebody. An act may exist only when the thing behind it genuinely exists and
 * is genuinely permitted for the session running it:
 *
 *   · client-only acts (sound, print, copy, the shortcut sheet) touch no
 *     server and are correct for every role by construction; or
 *   · an act calls an endpoint that is in this repository and accepts this
 *     session's role. Sign out is the only one of those here, and it posts to
 *     /api/pilot/auth/logout — the same call, with the same `credentials`
 *     requirement, that GlobalRoleHeader.tsx already makes.
 *
 * WHAT IS DELIBERATELY ABSENT is coach triage, and the reasoning is written out
 * in shortcuts.ts rather than here so there is one place to read it. The short
 * version: the queue holds intake cases, and binding a key to "approve" would
 * put a keystroke in front of a decision the platform deliberately gates behind
 * a human document review. Read that file before adding one.
 */

/** A row that runs something. */
interface Act {
  id: string;
  label: string;
  hint?: string;
  /** Extra search terms, same idea as a door's. */
  keywords: string;
  /** The verb glyph in the bezel. */
  glyph: string;
  /** The short word beside it — DO, RING, END. */
  tag: string;
  /**
   * Kept out of the browse list and reachable only by searching for it.
   *
   * This is the whole mechanism behind the bell: it is not a puzzle and not a
   * key combination nobody will ever press, it is a thing you find because you
   * typed "bell" into the search box looking for the front desk. Curiosity is
   * rewarded; nothing is hidden from anyone who wonders.
   */
  hidden?: boolean;
  /** Signed-out sessions get no session acts. */
  needsSession?: boolean;
  /**
   * What happens to the drawer afterwards. Deliberately DATA rather than
   * something `run` does itself: closing reads the focus-restore ref, and an
   * act list built during render must not contain closures that touch refs —
   * React cannot guarantee when a render-time traversal reads one. So the
   * acts stay pure descriptions and `perform` below does the ref work, in the
   * event handler where it belongs.
   */
  after?: 'close' | 'print';
  /** Runs it, and returns the line to show, or null for nothing to say. */
  run: () => string | null;
}

type Row =
  | { kind: 'door'; door: Door }
  | { kind: 'act'; act: Act };

function actMatches(act: Act, query: string): boolean {
  const hay = `${act.label} ${act.hint ?? ''} ${act.keywords}`.toLowerCase();
  return query.split(/\s+/).every((term) => hay.includes(term));
}

export default function CardCatalog() {
  const router = useRouter();
  const session = useSyncExternalStore(subscribeRoleSession, getRoleSessionSnapshot, () => null);
  const role = session?.role ?? null;
  /* Destructured rather than held as one object: useGymSound returns a fresh
     object every render (play and setEnabled are the stable parts), so a memo
     keyed on the object would rebuild the act list on every keystroke. */
  const { enabled: soundEnabled, status: soundStatus, play: playSound, setEnabled: setSoundEnabled } = useGymSound();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  /* What the last act reported. Rule 2 of the sound system in one variable:
     every act says in words what it did, so the bell is never the only channel
     and an act that made no sound is not an act that silently failed. */
  const [said, setSaid] = useState<string | null>(null);
  const [rung, setRung] = useState(0);
  /* The gym noticing. Both are read once per open, inside the handler that
     opens it — never during render, because both read a clock or storage and a
     render that React discards or replays must do neither. */
  const [notice, setNotice] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Where focus was before we opened, so Escape can hand it back.
  const restoreRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setCursor(0);
    setSaid(null);
    // Returning focus is the part most command palettes skip, and it is the
    // part a keyboard user actually notices.
    restoreRef.current?.focus?.();
    restoreRef.current = null;
  }, []);

  /* ---- the acts --------------------------------------------------------- */
  const acts = useMemo<Act[]>(() => {
    const all: Act[] = [
      {
        id: 'sound',
        label: soundEnabled ? 'Turn the gym sound off' : 'Turn the gym sound on',
        hint: soundStatus === 'unavailable'
          ? 'This browser refused audio — the switch will say so.'
          : 'Off by default, and stays off on every floor kiosk until somebody asks.',
        keywords: 'sound audio bell mute unmute volume noise quiet',
        glyph: soundEnabled ? '◍' : '◌',
        tag: 'do',
        run: () => {
          const wanted = !soundEnabled;
          // Called from inside the click/keydown that ran the act, which is the
          // gesture every browser requires before audio may start.
          void setSoundEnabled(wanted);
          return wanted
            ? 'Sound on — it arms on your next click, because browsers require the gesture.'
            : 'Sound off.';
        },
      },
      {
        id: 'bell',
        // Not advertised. Found by typing "bell", which is exactly what
        // somebody looking for the front desk types.
        hidden: true,
        label: 'Ring the bell',
        hint: 'For no reason at all.',
        keywords: 'bell ring gong round chime start end',
        glyph: '◎',
        tag: 'ring',
        run: () => {
          const audible = playSound('bell');
          setRung((n) => n + 1);
          /* Law 3 and rule 2 of the sound system: the ring is VISIBLE first —
             the ring-out on the row, and this line — so somebody with the
             volume down, with audio blocked, or standing on a loud gym floor
             loses nothing. Sound is confirmation here, never information. */
          return audible
            ? 'Rung.'
            : 'Rung — on the screen only. Sound is off.';
        },
      },
      {
        id: 'shortcuts',
        label: 'Show the keyboard shortcuts',
        hint: 'The same card that "?" opens.',
        keywords: 'keys keyboard shortcuts help commands question mark',
        glyph: '⌨',
        tag: 'do',
        run: () => {
          /* CommandsOverlay owns "?" globally (shortcuts.ts records the
             binding). Dispatching the key rather than lifting the overlay's
             state keeps ONE owner for it — two components that can both open
             the same panel is how a panel starts opening twice. */
          window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
          return null;
        },
      },
      {
        id: 'copy-link',
        label: 'Copy a link to this page',
        keywords: 'copy link url share address clipboard',
        glyph: '⧉',
        tag: 'do',
        run: () => {
          const href = window.location.href;
          /* Guarded rather than called blind: clipboard is undefined on
             insecure origins and in several kiosk webviews, and an unhandled
             rejection here would take the palette down mid-keystroke. */
          const clip = navigator.clipboard;
          if (!clip?.writeText) {
            return `Clipboard unavailable here. The address is ${href}`;
          }
          void clip.writeText(href).catch(() => undefined);
          return 'Link copied.';
        },
      },
      {
        id: 'print',
        label: 'Print this page',
        keywords: 'print paper hardcopy pdf',
        glyph: '⎙',
        tag: 'do',
        after: 'print',
        run: () => null,
      },
      {
        id: 'sign-out',
        label: 'Sign out',
        hint: 'Ends the session on this device.',
        keywords: 'sign out log out logout leave lock exit end session',
        glyph: '⏻',
        tag: 'end',
        needsSession: true,
        after: 'close',
        run: () => {
          /* Exactly the call GlobalRoleHeader.tsx makes, credentials included:
             the API is a separate origin from the static app, so a fetch
             without them carries no session cookie and the server has nothing
             to revoke — "logout" that silently leaves the session alive. */
          void fetch(`${apiBase()}/api/pilot/auth/logout`, { method: 'POST', credentials: 'include' });
          clearRoleSession();
          router.replace('/login');
          return null;
        },
      },
    ];

    return all.filter((act) => !act.needsSession || role !== null);
  }, [soundEnabled, soundStatus, playSound, setSoundEnabled, role, router]);

  /* ---- results ---------------------------------------------------------- */
  const doors = useMemo(() => searchDoors(role, query), [role, query]);
  const grouped = useMemo(() => doorsByRoom(role), [role]);

  const trimmed = query.trim().toLowerCase();

  const matchedActs = useMemo(
    () => (trimmed ? acts.filter((a) => actMatches(a, trimmed)) : acts.filter((a) => !a.hidden)),
    [acts, trimmed],
  );

  /* Acts first. They are the shortest list, they are what somebody who typed a
     verb is after, and burying them under twelve routes would make the palette
     feel like it still only navigates. */
  const rows = useMemo<Row[]>(
    () => [
      ...matchedActs.map((act) => ({ kind: 'act' as const, act })),
      ...doors.map((door) => ({ kind: 'door' as const, door })),
    ],
    [matchedActs, doors],
  );

  /* ---- global shortcut ------------------------------------------------- */
  const openCatalog = useCallback(() => {
    restoreRef.current = document.activeElement as HTMLElement;
    setOpen(true);
    setSaid(null);
    /* Read here rather than in an effect on [open]: both of these touch a
       clock and localStorage, and they belong to the gesture that opened the
       drawer, not to a render pass. */
    setNotice(catalogNod(recordCatalogOpen()) ?? beforeDawnNote(new Date()));
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Shared with the "?" binding via the registry, so the two guards cannot
      // drift apart — that drift is how a palette starts eating keystrokes.
      const typing = isTypingTarget(e.target);

      // Cmd/Ctrl+K always opens, even mid-field: it is unambiguous.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (open) close();
        else openCatalog();
        return;
      }
      // Bare "/" is a convenience, so it must never steal a keystroke from
      // someone filling in a form.
      if (!open && e.key === '/' && !typing) {
        e.preventDefault();
        openCatalog();
        return;
      }
      if (open && e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close, openCatalog]);

  /* ---- focus the field on open ----------------------------------------- */
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  /* Closing on navigation is handled by the parent keying this component on the
     pathname, not by an effect: setState inside an effect cascades a render, and
     a remount is both cheaper and exactly the semantics wanted — a fresh, closed
     palette on every surface. */

  /* ---- keep the highlighted row in view ------------------------------- */
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`);
    // Guarded rather than called blind: this runs inside an effect on every
    // arrow key, so an environment without scrollIntoView (jsdom, and some
    // embedded webviews) would throw mid-navigation and take the palette down.
    if (typeof el?.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  function go(door: Door) {
    close();
    router.push(door.href);
  }

  function perform(act: Act) {
    const line = act.run();

    // The ref work lives here, in the handler, not in the act — see `after`.
    if (act.after) {
      close();
    }
    if (act.after === 'print') {
      window.print();
    }

    if (line === null) {
      // Nothing to report: the act navigated, printed, or opened another panel.
      return;
    }
    /* Otherwise the drawer STAYS OPEN and reports. An action palette that
       vanishes the instant you use it leaves you with no idea whether anything
       happened, which for a silent action (a bell with the sound off, a copy
       on a browser with no clipboard) means it reads as broken. */
    setSaid(line);
  }

  function pick(row: Row) {
    if (row.kind === 'door') go(row.door);
    else perform(row.act);
  }

  function onFieldKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, Math.max(rows.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[cursor];
      if (row) pick(row);
    }
  }

  if (!open) return <CatalogHint onOpen={openCatalog} />;

  const actCount = matchedActs.length;

  return (
    <div
      className="ppbf fixed inset-0 z-[200] flex items-start justify-center px-4 pt-[8vh]"
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      {/* The room goes dark around the open drawer. */}
      <div className="absolute inset-0 bg-[rgba(8,6,4,.72)] backdrop-blur-[2px]" />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Card catalog — jump to any surface, or do something"
        className="catalog relative w-full max-w-[620px]"
      >
        <div className="catalog-field">
          <span aria-hidden="true" className="catalog-glyph">⌕</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              // Cursor resets here rather than in an effect on [query]: the two
              // belong to the same user action, so doing it in one handler
              // avoids a second render pass.
              setQuery(e.target.value);
              setCursor(0);
              setSaid(null);
            }}
            onKeyDown={onFieldKey}
            placeholder="Find a room, a record, a queue — or type a verb…"
            aria-label="Search surfaces and actions"
            aria-controls="catalog-results"
            aria-activedescendant={rows[cursor] ? `catalog-opt-${cursor}` : undefined}
            role="combobox"
            aria-expanded="true"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="catalog-kbd">esc</kbd>
        </div>

        {rows.length === 0 ? (
          <div className="catalog-empty">
            <div className="catalog-empty-glyph" aria-hidden="true">⌾</div>
            <b>Nothing filed under that</b>
            <span>
              Try a room ({Object.values(ROOM_LABEL).slice(0, 3).join(', ')}…), a layer number,
              a word from the surface you want, or a verb like “print” or “sign out”.
            </span>
          </div>
        ) : (
          <ul id="catalog-results" ref={listRef} role="listbox" className="catalog-list">
            {actCount > 0 && (
              <li role="presentation">
                <div className="catalog-group">Things you can do here</div>
                <ul role="group" className="contents">
                  {matchedActs.map((act, i) => (
                    <ActRow
                      /* The bell's key carries the ring count so a SECOND ring
                         remounts the row and restarts the ring-out. Without
                         that, ringing twice shows the animation once — the
                         element never changed, so nothing replayed. */
                      key={act.id === 'bell' ? `bell:${rung}` : act.id}
                      act={act}
                      idx={i}
                      active={i === cursor}
                      rungKey={act.id === 'bell' ? rung : 0}
                      onPick={() => perform(act)}
                      onHover={() => setCursor(i)}
                    />
                  ))}
                </ul>
              </li>
            )}

            {trimmed
              ? doors.map((door, i) => (
                  <CatalogRow
                    key={door.href}
                    door={door}
                    idx={actCount + i}
                    active={actCount + i === cursor}
                    showRoom
                    onPick={() => go(door)}
                    onHover={() => setCursor(actCount + i)}
                  />
                ))
              : /* Empty query: browse the building room by room. */
                grouped.map((group) => (
                  <li key={group.room} role="presentation">
                    <div className="catalog-group">{ROOM_LABEL[group.room]}</div>
                    <ul role="group" className="contents">
                      {group.doors.map((door) => {
                        const i = actCount + doors.indexOf(door);
                        return (
                          <CatalogRow
                            key={door.href}
                            door={door}
                            idx={i}
                            active={i === cursor}
                            onPick={() => go(door)}
                            onHover={() => setCursor(i)}
                          />
                        );
                      })}
                    </ul>
                  </li>
                ))}
          </ul>
        )}

        <div className="catalog-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> open or run</span>
          <span><kbd>esc</kbd> close</span>
          <span className="catalog-count">
            {doors.length} {doors.length === 1 ? 'card' : 'cards'}
            {actCount > 0 ? ` · ${actCount} to do` : ''}
            {role ? '' : ' · signed out'}
          </span>
          {/* What the last act did. role="status" so it is announced rather
              than only seen — the whole point of the line. */}
          {said && (
            <span className="catalog-notice" role="status">{said}</span>
          )}
          {/* The gym noticing. One line, dry, and it does not repeat. */}
          {!said && notice && (
            <span className="catalog-notice">{notice}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function CatalogRow({
  door, idx, active, showRoom, onPick, onHover,
}: {
  door: Door; idx: number; active: boolean; showRoom?: boolean;
  onPick: () => void; onHover: () => void;
}) {
  return (
    <li
      id={`catalog-opt-${idx}`}
      data-idx={idx}
      role="option"
      aria-selected={active}
      className={`catalog-row${active ? ' is-active' : ''}`}
      onMouseDown={(e) => { e.preventDefault(); onPick(); }}
      onMouseEnter={onHover}
    >
      <div className="catalog-row-main">
        <b>{door.label}</b>
        {door.hint && <span className="catalog-row-hint">{door.hint}</span>}
      </div>
      <div className="catalog-row-meta">
        {showRoom && <span className="catalog-room-tag">{ROOM_LABEL[door.room]}</span>}
        <code>{door.href}</code>
      </div>
    </li>
  );
}

/**
 * A row that RUNS something.
 *
 * Visibly not a door: a verb in a brass bezel where a door shows its route in
 * mono type. Somebody scanning this list has to be able to tell, without
 * reading, which rows move them and which rows change something.
 */
function ActRow({
  act, idx, active, rungKey, onPick, onHover,
}: {
  act: Act; idx: number; active: boolean; rungKey: number;
  onPick: () => void; onHover: () => void;
}) {
  return (
    <li
      id={`catalog-opt-${idx}`}
      data-idx={idx}
      role="option"
      aria-selected={active}
      className={`catalog-row${active ? ' is-active' : ''}${rungKey > 0 ? ' catalog-rung' : ''}`}
      onMouseDown={(e) => { e.preventDefault(); onPick(); }}
      onMouseEnter={onHover}
    >
      <div className="catalog-row-main flex items-center gap-[var(--s3)]">
        <span aria-hidden="true" className="catalog-act-glyph">{act.glyph}</span>
        <span>
          <b>{act.label}</b>
          {act.hint && <span className="catalog-row-hint">{act.hint}</span>}
        </span>
      </div>
      <div className="catalog-row-meta">
        <span className="catalog-act-tag">{act.tag}</span>
      </div>
    </li>
  );
}

/** A permanent, quiet affordance. A shortcut nobody knows about is not a feature. */
function CatalogHint({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      className="catalog-hint"
      onClick={onOpen}
      aria-label="Open the card catalog to jump to another surface or run a command"
    >
      <span aria-hidden="true">⌕</span>
      <span className="catalog-hint-lbl">Jump</span>
      <kbd>⌘K</kbd>
    </button>
  );
}
