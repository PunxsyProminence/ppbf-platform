"use client";

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

interface TutorialButtonProps {
  readonly anchor?: string;
  readonly label?: string;
  readonly className?: string;
}

export default function TutorialButton({ anchor, label = 'HOW THIS WORKS', className }: TutorialButtonProps) {
  const href = anchor ? `/help#${anchor}` : '/help';
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current) {
        return;
      }

      const target = event.target;
      if (target instanceof Node && !containerRef.current.contains(target)) {
        setOpen(false);
      }
    }

    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label="Toggle tutorial quick panel"
        className={`inline-flex min-h-[44px] items-center justify-center gap-2 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 text-xs font-mono font-bold uppercase tracking-[0.12em] text-[var(--black)] transition hover:bg-[var(--canvas-tan-dark)] ${className ?? ''}`.trim()}
      >
        <span>{label}</span>
        <span aria-hidden="true">{open ? '[-]' : '[+]'}</span>
      </button>

      {open ? (
        <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-[320px] max-w-[calc(100vw-1.5rem)] border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-3 shadow-[var(--shadow-md)]">
          <p className="text-xs font-mono uppercase tracking-[0.08em] text-[var(--red-primary)]">Quick Tutorial</p>
          <div className="mt-2 grid gap-2 text-sm leading-6 text-[var(--gray-dark)]">
            <p>Use this panel for quick orientation while keeping the workspace visible.</p>
            <p>Open the full tutorial center only when deeper guidance is needed.</p>
          </div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <Link
              href={href}
              onClick={() => setOpen(false)}
              className="inline-flex min-h-[44px] items-center justify-center border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 text-xs font-mono font-bold uppercase tracking-[0.1em] text-[var(--black)] transition hover:bg-[var(--canvas-tan-dark)]"
            >
              Open Full Tutorial
            </Link>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="inline-flex min-h-[44px] items-center justify-center border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 text-xs font-mono font-bold uppercase tracking-[0.1em] text-[var(--black)] transition hover:bg-[var(--canvas-tan-dark)]"
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
