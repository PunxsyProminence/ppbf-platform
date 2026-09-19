'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { OpenedInstruction } from './drillInstructionRead';

/**
 * One drill open at a time, on any page that opens drills from somewhere
 * other than the library (W-D4B).
 *
 * The same guarantees /coach/drills gives its reference detail, in one place:
 * a newer open cancels an older one still in flight, so a slow answer can
 * never replace a faster one; leaving the page cancels whatever is loading;
 * and closing returns focus to the control that opened it, so a keyboard or
 * screen-reader user lands back where they were -- which on an athlete's
 * assignment list is the assignment itself.
 */
export function useDrillOpener() {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [opened, setOpened] = useState<OpenedInstruction | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const openerRef = useRef<string | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const open = useCallback(
    (key: string, openerId: string, read: (signal: AbortSignal) => Promise<OpenedInstruction>) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      requestRef.current += 1;
      const request = requestRef.current;
      openerRef.current = openerId;

      setOpenKey(key);
      setOpened(null);
      setFailed(false);
      setLoading(true);

      void read(controller.signal)
        .then((result) => {
          if (request === requestRef.current) setOpened(result);
        })
        .catch((error: unknown) => {
          if (request !== requestRef.current || controller.signal.aborted) return;
          // Logged, not displayed: the page owns what a person reads.
          console.error({ event: 'drill-instruction-load-failed', error });
          setFailed(true);
        })
        .finally(() => {
          if (request === requestRef.current) setLoading(false);
        });
    },
    [],
  );

  /**
   * returnFocus: false when the close is a side effect of something else the
   * person is doing -- picking a different drill, switching athlete. Focus
   * belongs where they are working then, not on a toggle they did not press.
   */
  const close = useCallback((options?: { returnFocus?: boolean }) => {
    controllerRef.current?.abort();
    requestRef.current += 1;
    const openerId = openerRef.current;
    openerRef.current = null;

    setOpenKey(null);
    setOpened(null);
    setFailed(false);
    setLoading(false);

    if (openerId && options?.returnFocus !== false) {
      window.requestAnimationFrame(() => {
        const opener = document.getElementById(openerId);
        opener?.scrollIntoView?.({ block: 'center' });
        opener?.focus();
      });
    }
  }, []);

  return { openKey, opened, loading, failed, open, close };
}
