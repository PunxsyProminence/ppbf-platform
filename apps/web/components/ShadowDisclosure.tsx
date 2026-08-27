import type { ReactNode } from 'react';

/**
 * The one disclosure primitive this room has. Everything an answer offers
 * BELOW the answer itself -- the receipts, the diagnostics -- collapses into
 * one of these, so the reader meets the answer, then the limits on it, then
 * the controls, and only then the machinery.
 *
 * What must never be wrapped in one: the safety line, the handoff banner, the
 * evidence grade, or a refusal. Those are the answer's boundary conditions;
 * a reader who does not expand is exactly the reader who needs them.
 *
 * Two accessibility properties the bare <details>/<summary> in this file's
 * predecessor did not have: the summary is a real tap target (the design
 * system floors <button> at 44px and deliberately exempts everything else, so
 * a summary styled with .t-label alone came out at 11px of text and about 16px
 * of box), and the marker sits beside a label that names what is inside rather
 * than a bare triangle.
 */

interface ShadowDisclosureProps {
  readonly label: string;
  readonly children: ReactNode;
  /** Extra classes for the <details> element. Colour is inherited. */
  readonly className?: string;
}

export default function ShadowDisclosure({ label, children, className }: ShadowDisclosureProps) {
  return (
    <details className={`group ${className ?? ''}`}>
      <summary className="t-label flex min-h-[44px] cursor-pointer list-none items-center gap-[var(--s2)]">
        {/* The state is already on the summary's aria-expanded, so the glyph
            is decoration: shown to eyes, hidden from screen readers. */}
        <span aria-hidden="true" className="group-open:hidden">+</span>
        <span aria-hidden="true" className="hidden group-open:inline">−</span>
        {label}
      </summary>
      <div className="pb-[var(--s2)]">{children}</div>
    </details>
  );
}
