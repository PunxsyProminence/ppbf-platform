'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { SCOPE_LABEL, isTypingTarget, shortcutsByScope } from './shortcuts';

/**
 * THE COMMANDS CARD — "?" anywhere.
 *
 * The design system shipped this as a picture: a laminated card of eight
 * shortcuts, none of which were bound to anything. This renders from the
 * shortcut registry instead, so it lists exactly what works and nothing else.
 *
 * Styled as a notice posted on the gym wall, which is where a list of rules
 * belongs in this building.
 */
export default function CommandsOverlay() {
  const [open, setOpen] = useState(false);
  const restoreRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    restoreRef.current?.focus?.();
    restoreRef.current = null;
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (open && e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      // "?" is a printable character, so it must never be taken from someone
      // writing a session note. Same guard the catalog uses for "/", shared
      // from the registry so the two cannot drift.
      if (e.key === '?' && !isTypingTarget(e.target)) {
        // Let a modified "?" through — it may belong to the browser.
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        e.preventDefault();
        if (!open) restoreRef.current = document.activeElement as HTMLElement;
        setOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const groups = shortcutsByScope();

  return (
    <div
      className="ppbf fixed inset-0 z-[210] flex items-center justify-center px-4"
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div className="absolute inset-0 bg-[rgba(8,6,4,.72)]" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        className="commands-sheet relative"
      >
        <div className="commands-sheet-hd">
          <b>Keyboard</b>
          <span>Everything here is bound. Nothing here is decoration.</span>
        </div>

        {groups.map((group) => (
          <section key={group.scope} className="commands-scope">
            <div className="commands-scope-hd">{SCOPE_LABEL[group.scope]}</div>
            <ul className="commands-list">
              {group.items.map((s) => (
                <li key={s.keys + s.label} className="commands-item">
                  <span className="commands-key">{s.keys}</span>
                  <span className="commands-desc">{s.label}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}

        <div className="commands-sheet-ft">
          <kbd>esc</kbd> or <kbd>?</kbd> to close
        </div>
      </div>
    </div>
  );
}
