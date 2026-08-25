/**
 * UI Styles Registry
 *
 * These surfaces were authored in cream while the workspaces that fill them
 * -- Athlete, Coach, Parent -- write ink-authored type into them: --bone-400
 * captions and --brass-300 headings. That pairing measured 1.31:1 and 2.01:1,
 * on a page a coach reads mid-session from a floor tablet. The panels are
 * leather now, which is the ground the content was already written for.
 *
 * Backs the tabs, mode switches and panel shells in the Athlete, Coach and
 * Parent workspaces, which makes it the highest-reach style file in the app.
 *
 * Chrome vs. status
 * -----------------
 * Selected tabs and modes used to be painted in --red-primary, which aliases
 * to --locked: the safety gate's "this athlete may not participate" red. Law 2
 * reserves saturated colour for safety state, and a selected tab is not one —
 * when the gate's red is also the tab highlight, a locked athlete stops being
 * unmissable. Chrome now uses --accent (brass): a selected tab is a control in
 * the "on" position, which is chassis, not a claim about a person.
 *
 * Red survives in exactly two places here, both correct: the status ladder
 * below, and the error/retry affordances.
 *
 * Tokens
 * ------
 * - --accent / --accent-ink : chrome accent (brass). Never a status.
 * - --black, --canvas-tan*  : ground and ink, aliased onto design-system values
 * - --status-*              : the safety ladder. --status-danger and
 *                             --status-info were referenced here for a long
 *                             time without being defined anywhere; they exist
 *                             in globals.css now.
 * - --skeleton-bg           : loading placeholder, now on-palette paper
 */

export const ui = {
  tabContainer: 'mat-leather rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)]',
  tabRow: 'flex flex-wrap gap-1 p-2',
  tabButtonBase:
    'inline-flex min-h-[44px] items-center px-3 py-2 text-xs font-semibold uppercase transition border-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
  tabButtonActive: 'bg-[var(--accent)] border-[color:var(--brass-600)] text-[color:var(--accent-ink)]',
  tabButtonInactive: 'border-[color:rgb(var(--brass-400-rgb)_/_.28)] text-[color:var(--bone-300)] hover:border-[color:var(--brass-400)] hover:text-[color:var(--bone-100)]',
  modeButtonBase:
    'inline-flex min-h-[44px] items-center px-4 py-2 font-mono font-bold text-xs border-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
  modeButtonActive: 'bg-[var(--accent)] border-[color:var(--brass-600)] text-[color:var(--accent-ink)]',
  modeButtonInactive: 'border-[color:rgb(var(--brass-400-rgb)_/_.28)] text-[color:var(--bone-300)] hover:border-[color:var(--brass-400)] hover:text-[color:var(--bone-100)]',
  panel: 'mat-leather--raised rounded-[var(--r-md)] p-[var(--s5)]',
  panelSpaced: 'mat-leather--raised rounded-[var(--r-md)] p-[var(--s5)] space-y-[var(--s4)]',

  /* Status badges. Law 3: colour is never the only channel, so callers pair
     these with the state's glyph and uppercase label rather than relying on
     the fill alone. Ink is bone rather than pure white — white on these fills
     is harsher than anything else on a warm ground. */
  statusDanger: 'bg-[var(--status-danger)] text-[var(--bone-100)] px-2 py-1 rounded text-xs font-semibold',
  statusWarning: 'bg-[var(--status-warning)] text-[var(--bone-100)] px-2 py-1 rounded text-xs font-semibold',
  statusReady: 'bg-[var(--status-ready)] text-[var(--bone-100)] px-2 py-1 rounded text-xs font-semibold',
  statusInfo: 'bg-[var(--status-info)] text-[var(--bone-100)] px-2 py-1 rounded text-xs font-semibold',
  statusInactive: 'bg-[var(--status-inactive)] text-[var(--bone-100)] px-2 py-1 rounded text-xs font-semibold',

  // Error state button (with retry) — red here is correct: it is destructive
  // or it is reporting a real failure.
  errorButton:
    'inline-flex min-h-[44px] items-center bg-[var(--status-danger)] text-[var(--bone-100)] hover:opacity-80 transition border-2 border-[color:var(--locked)] px-3 py-2 text-xs font-semibold uppercase',
  errorContainer: 'border-2 border-[var(--status-danger)] bg-[var(--status-danger)]/10 p-4 rounded',
  errorText: 'text-[var(--status-danger)] font-semibold',

  // Loading state
  loadingContainer: 'animate-pulse bg-[var(--skeleton-bg)] p-4 rounded',
} as const;

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
