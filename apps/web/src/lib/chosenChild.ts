/*
 * THE CHILD A GUARDIAN CHOSE, CARRIED BETWEEN PAGES WITHOUT THE ADDRESS
 * (#1596 item 2b; lane L29).
 *
 * The parent hub used to open the print room as /print?athlete_id=<child>. An
 * id in the page address ends up in browser history and shared links. (The
 * page's own API requests still name the child, as every parent-hub read
 * does; this is about the address a person sees, copies and keeps.)
 * A parent's session names no single child (a family can have several), so
 * the page cannot take it from the session either. The hub writes the chosen
 * child here, for this browser tab only (sessionStorage: gone when the tab
 * closes, never sent to the server), and the next page reads it.
 *
 * The value is never trusted. Every page that reads it sends it to the server,
 * which re-runs the guardian check before answering -- this only says which of
 * the guardian's own children they meant. A read on a page signed in as
 * someone else is ignored by its caller (see PrintRoom), and storage that is
 * blocked or full is treated as nothing chosen. Signing out forgets it
 * (roleSession.clearRoleSession), so the next person on a shared tablet does
 * not inherit it. The hub writes it whenever the selected child changes, not
 * only on a click, so a link opened any way prints the child on screen.
 */

const KEY = 'ppbf.parent.chosenChild';

export function rememberChosenChild(athleteId: string | null | undefined): void {
  try {
    if (athleteId) window.sessionStorage.setItem(KEY, athleteId);
  } catch {
    // Storage blocked: the next page falls back to its own default.
  }
}

export function forgetChosenChild(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Storage blocked: nothing was kept.
  }
}

export function readChosenChild(): string | null {
  try {
    const value = window.sessionStorage.getItem(KEY);
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}
