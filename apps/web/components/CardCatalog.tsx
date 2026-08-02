'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useSyncExternalStore } from 'react';

import { getRoleSessionSnapshot, subscribeRoleSession } from './roleSession';
import {
  ROOM_LABEL,
  doorsByRoom,
  searchDoors,
  type Door,
} from './buildingMap';

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
 */
export default function CardCatalog() {
  const router = useRouter();
  const pathname = usePathname();
  const session = useSyncExternalStore(subscribeRoleSession, getRoleSessionSnapshot, () => null);
  const role = session?.role ?? null;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Where focus was before we opened, so Escape can hand it back.
  const restoreRef = useRef<HTMLElement | null>(null);

  const results = useMemo(() => searchDoors(role, query), [role, query]);
  const grouped = useMemo(() => doorsByRoom(role), [role]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setCursor(0);
    // Returning focus is the part most command palettes skip, and it is the
    // part a keyboard user actually notices.
    restoreRef.current?.focus?.();
    restoreRef.current = null;
  }, []);

  /* ---- global shortcut ------------------------------------------------- */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      // Cmd/Ctrl+K always opens, even mid-field: it is unambiguous.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (!open) restoreRef.current = document.activeElement as HTMLElement;
        setOpen((v) => !v);
        return;
      }
      // Bare "/" is a convenience, so it must never steal a keystroke from
      // someone filling in a form.
      if (!open && e.key === '/' && !typing) {
        e.preventDefault();
        restoreRef.current = document.activeElement as HTMLElement;
        setOpen(true);
        return;
      }
      if (open && e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  /* ---- focus the field on open ----------------------------------------- */
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  /* ---- close on navigation -------------------------------------------- */
  useEffect(() => { if (open) close(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pathname]);

  /* ---- keep the cursor in range and in view --------------------------- */
  useEffect(() => { setCursor(0); }, [query]);
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

  function onFieldKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const door = results[cursor];
      if (door) go(door);
    }
  }

  if (!open) return <CatalogHint />;

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
        aria-label="Card catalog — jump to any surface"
        className="catalog relative w-full max-w-[620px]"
      >
        <div className="catalog-field">
          <span aria-hidden="true" className="catalog-glyph">⌕</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onFieldKey}
            placeholder="Find a room, a record, a queue…"
            aria-label="Search surfaces"
            aria-controls="catalog-results"
            aria-activedescendant={results[cursor] ? `catalog-opt-${cursor}` : undefined}
            role="combobox"
            aria-expanded="true"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="catalog-kbd">esc</kbd>
        </div>

        {results.length === 0 ? (
          <div className="catalog-empty">
            <div className="catalog-empty-glyph" aria-hidden="true">⌾</div>
            <b>Nothing filed under that</b>
            <span>
              Try a room ({Object.values(ROOM_LABEL).slice(0, 3).join(', ')}…), a layer number,
              or a word from the surface you want.
            </span>
          </div>
        ) : (
          <ul id="catalog-results" ref={listRef} role="listbox" className="catalog-list">
            {query.trim()
              ? results.map((door, i) => (
                  <CatalogRow
                    key={door.href}
                    door={door}
                    idx={i}
                    active={i === cursor}
                    showRoom
                    onPick={() => go(door)}
                    onHover={() => setCursor(i)}
                  />
                ))
              : /* Empty query: browse the building room by room. */
                grouped.map((group) => (
                  <li key={group.room} role="presentation">
                    <div className="catalog-group">{ROOM_LABEL[group.room]}</div>
                    <ul role="group" className="contents">
                      {group.doors.map((door) => {
                        const i = results.indexOf(door);
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
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
          <span className="catalog-count">
            {results.length} {results.length === 1 ? 'card' : 'cards'}
            {role ? '' : ' · signed out'}
          </span>
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

/** A permanent, quiet affordance. A shortcut nobody knows about is not a feature. */
function CatalogHint() {
  return (
    <button
      type="button"
      className="catalog-hint"
      onClick={() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }),
        );
      }}
      aria-label="Open the card catalog to jump to another surface"
    >
      <span aria-hidden="true">⌕</span>
      <span className="catalog-hint-lbl">Jump</span>
      <kbd>⌘K</kbd>
    </button>
  );
}
