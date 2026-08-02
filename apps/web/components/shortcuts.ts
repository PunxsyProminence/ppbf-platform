/**
 * THE SHORTCUT REGISTRY — one source of truth for every key the platform binds.
 *
 * The design system shipped a "commands card" listing eight shortcuts. Not one
 * of them was implemented anywhere: the card was a picture of a feature. That is
 * worse than having no card, because a documented shortcut that does nothing
 * teaches a user that the keyboard does not work here.
 *
 * So this file is the registry, and the overlay renders FROM it. A shortcut
 * cannot appear in the help without something binding it, and cannot be bound
 * without appearing in the help. If you add a key, add it here.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * Coach triage (approve / deny / advance) is absent, and the reason is a real
 * product gap rather than an oversight: the coach's review queue
 * (/api/pilot/shadow/review-projection) is read-only — its POST is a query —
 * and the only coach decision endpoint (/api/pilot/coach-reviews) resolves
 * session_id through getSessionAthleteId, so it takes TRAINING sessions. The
 * queue holds intake_case_id, which is a different entity. Binding "a" to
 * approve would either fail server-side validation or, on an ID collision,
 * attach a coach review to an unrelated athlete. Triage needs a coach-facing
 * write endpoint for intake cases first.
 */

export interface Shortcut {
  /** Display form, e.g. "⌘K" or "?" — what the overlay shows. */
  keys: string;
  /** What it does, in the imperative. */
  label: string;
  /** Where it works. 'global' binds everywhere; the rest are contextual. */
  scope: 'global' | 'dialog' | 'form' | 'list';
  /**
   * True when a component in this repository actually binds it. Only bound
   * shortcuts are shown by default — see visibleShortcuts.
   */
  bound: boolean;
  /** Which component owns the binding, so the claim is checkable. */
  owner?: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  {
    keys: '⌘K',
    label: 'Open the card catalog — jump to any surface',
    scope: 'global',
    bound: true,
    owner: 'CardCatalog.tsx',
  },
  {
    keys: '/',
    label: 'Open the card catalog (when not typing in a field)',
    scope: 'global',
    bound: true,
    owner: 'CardCatalog.tsx',
  },
  {
    keys: '?',
    label: 'Show this list of shortcuts',
    scope: 'global',
    bound: true,
    owner: 'CommandsOverlay.tsx',
  },
  {
    keys: 'Esc',
    label: 'Close the catalog, the corridor, or this list',
    scope: 'dialog',
    bound: true,
    owner: 'CardCatalog.tsx, Corridor.tsx, CommandsOverlay.tsx',
  },
  {
    keys: '↑ ↓',
    label: 'Move through catalog results',
    scope: 'list',
    bound: true,
    owner: 'CardCatalog.tsx',
  },
  {
    keys: '↵',
    label: 'Open the highlighted result',
    scope: 'list',
    bound: true,
    owner: 'CardCatalog.tsx',
  },
];

/**
 * The shortcuts worth showing a user. Unbound entries are filtered out, so the
 * overlay can never advertise a key that does nothing — the failure mode this
 * registry exists to prevent.
 */
export function visibleShortcuts(): Shortcut[] {
  return SHORTCUTS.filter((s) => s.bound);
}

/** Grouped for display, in the order a reader wants them. */
export const SCOPE_ORDER: readonly Shortcut['scope'][] = ['global', 'dialog', 'list', 'form'];

export const SCOPE_LABEL: Record<Shortcut['scope'], string> = {
  global: 'Anywhere',
  dialog: 'In a dialog',
  list: 'In a list',
  form: 'In a form',
};

export function shortcutsByScope(): Array<{ scope: Shortcut['scope']; items: Shortcut[] }> {
  const visible = visibleShortcuts();
  return SCOPE_ORDER
    .map((scope) => ({ scope, items: visible.filter((s) => s.scope === scope) }))
    .filter((g) => g.items.length > 0);
}

/**
 * True when the event target is somewhere a bare printable key belongs to the
 * user, not to us. Shared by every global single-key binding so they cannot
 * drift apart — the bug where "/" or "?" gets swallowed mid-sentence.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === 'INPUT'
    || el.tagName === 'TEXTAREA'
    || el.tagName === 'SELECT'
    || el.isContentEditable === true
  );
}
