/**
 * UI Styles Registry
 *
 * CSS Variables Reference (defined in global.css or tailwind config):
 * - --black: Primary text/borders
 * - --red-primary: Primary action color
 * - --canvas-tan: Background tone
 * - --canvas-tan-light: Light background
 * - --canvas-tan-dark: Dark background
 * - --gray-dark: Secondary text
 *
 * Status Variables (for status badges/indicators):
 * - --status-danger: Error/critical states (red)
 * - --status-warning: Warning states (orange/yellow)
 * - --status-ready: Success/ready states (green)
 * - --status-info: Info/neutral states (blue)
 * - --status-inactive: Disabled/inactive states (gray)
 *
 * Skeleton Loader:
 * - --skeleton-bg: Background color for loading placeholders (light gray)
 */

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

  // Status badge styles (using unified CSS variables)
  statusDanger: 'bg-[var(--status-danger)] text-white px-2 py-1 rounded text-xs font-semibold',
  statusWarning: 'bg-[var(--status-warning)] text-white px-2 py-1 rounded text-xs font-semibold',
  statusReady: 'bg-[var(--status-ready)] text-white px-2 py-1 rounded text-xs font-semibold',
  statusInfo: 'bg-[var(--status-info)] text-white px-2 py-1 rounded text-xs font-semibold',
  statusInactive: 'bg-[var(--status-inactive)] text-white px-2 py-1 rounded text-xs font-semibold',

  // Error state button (with retry)
  errorButton:
    'bg-[var(--status-danger)] hover:opacity-80 transition border-2 border-[var(--black)] px-3 py-2 text-xs font-semibold uppercase',
  errorContainer: 'border-2 border-[var(--status-danger)] bg-[var(--status-danger)]/10 p-4 rounded',
  errorText: 'text-[var(--status-danger)] font-semibold',

  // Loading state
  loadingContainer: 'animate-pulse bg-[var(--canvas-tan-light)] p-4 rounded',
} as const;

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
