export const ui = {
  tabContainer: 'border-2 border-[var(--black)] bg-[var(--canvas-tan)]',
  tabRow: 'flex flex-wrap gap-1 p-2',
  tabButtonBase:
    'px-3 py-2 text-xs font-semibold uppercase transition border-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--red-primary)]',
  tabButtonActive: 'bg-[var(--red-primary)] border-[var(--black)] text-[var(--canvas-tan-light)]',
  tabButtonInactive: 'bg-[var(--canvas-tan-light)] border-[var(--black)] text-[var(--gray-dark)] hover:bg-[var(--canvas-tan-dark)] hover:text-[var(--black)]',
  modeButtonBase:
    'px-4 py-2 font-mono font-bold text-xs border-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--red-primary)]',
  modeButtonActive: 'bg-[var(--red-primary)] border-[var(--black)] text-[var(--canvas-tan-light)]',
  modeButtonInactive: 'bg-[var(--canvas-tan-light)] border-[var(--black)] text-[var(--gray-dark)] hover:bg-[var(--canvas-tan-dark)] hover:text-[var(--black)]',
  panel: 'border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-6',
  panelSpaced: 'border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-6 space-y-4',
} as const;

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
