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
 * child here and the next page reads it: this tab's sessionStorage first (two
 * tabs can hold two different children), and localStorage behind it, so a
 * link opened in a NEW tab -- which starts with empty sessionStorage -- still
 * finds the child chosen last. Neither is sent to the server.
 *
 * The value is never trusted. Every page that reads it sends it to the server,
 * which re-runs the guardian check before answering -- this only says which of
 * the guardian's own children they meant. A read on a page signed in as
 * someone else is ignored by its caller (see PrintRoom), and storage that is
 * blocked or full is treated as nothing chosen. Signing out, or the server
 * refusing the session, forgets it (roleSession.clearRoleSession), so the
 * next person on a shared tablet does not inherit it; the client's role cache
 * merely running out does not. The hub writes it whenever the selected child changes, not
 * only on a click, so a link opened any way prints the child on screen.
 */

const KEY = 'ppbf.parent.chosenChild';

function storages(): Storage[] {
  const found: Storage[] = [];
  for (const pick of [() => window.sessionStorage, () => window.localStorage]) {
    try {
      const storage = pick();
      if (storage) found.push(storage);
    } catch {
      // That storage is blocked: the other may still work.
    }
  }
  return found;
}

export function rememberChosenChild(athleteId: string | null | undefined): void {
  if (!athleteId) return;
  for (const storage of storages()) {
    try {
      storage.setItem(KEY, athleteId);
    } catch {
      // Full or blocked: the next page falls back to its own default.
    }
  }
}

export function forgetChosenChild(): void {
  for (const storage of storages()) {
    try {
      storage.removeItem(KEY);
    } catch {
      // Blocked: nothing was kept there.
    }
  }
}

export function readChosenChild(): string | null {
  for (const storage of storages()) {
    try {
      const value = storage.getItem(KEY);
      if (value && value.trim()) return value.trim();
    } catch {
      // Blocked: try the next one.
    }
  }
  return null;
}
