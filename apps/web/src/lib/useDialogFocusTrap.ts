'use client';

import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), '
  + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Focus management for a modal rendered as a plain conditional div (this
 * codebase has no dialog component to extend, so this is the first one).
 * Moves focus in when the modal opens, traps Tab inside it, closes on
 * Escape, and returns focus to whatever triggered it on close -- the four
 * things a bare `{open && <div className="fixed inset-0 ...">}` never gets
 * for free.
 *
 * Attach the returned ref to the modal's outer element alongside
 * `role="dialog"` and `aria-modal="true"`.
 */
export function useDialogFocusTrap<T extends HTMLElement>(options: {
  open: boolean;
  onClose: () => void;
  /**
   * Default true. Set false for a confirmation whose own design requires
   * exactly two ways out (e.g. a destructive-action confirm where an
   * incidental Escape must not double as an accidental "cancel" or, worse,
   * be mistaken by a caller for the confirm path) -- the trap still moves
   * focus in and returns it on close, it just stops treating Escape as a
   * third dismissal route the design didn't intend.
   */
  closeOnEscape?: boolean;
}) {
  const { open, onClose, closeOnEscape = true } = options;
  const containerRef = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;

    const triggerElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const container = containerRef.current;
    const initialFocusTarget = container?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    initialFocusTarget?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && closeOnEscape) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== 'Tab' || !container) return;

      const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      triggerElement?.focus();
    };
  }, [open, closeOnEscape]);

  return containerRef;
}
