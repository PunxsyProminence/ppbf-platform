/* ARRIVING AT THE DECISION LOOP WITH THE ATHLETE ALREADY CHOSEN (#1474 item 5).
 *
 * A coach who follows a pain report's "Record what you did" link came for that
 * athlete, so the Decision Loop opens on them. The athlete travels in page
 * memory, never in the address: no athlete id goes in a page URL, where it
 * would sit in the address bar, the browser history and the server's request
 * logs (Overwatch ruling on #1474, Q2 = C).
 *
 * One hand-off, taken once. It lives only as long as this tab's page: the link
 * is a client-side navigation, so it survives the trip; a new tab or a reload
 * arrives with nothing, which is the page's ordinary empty state. Nothing is
 * written to storage on the device. Whether the coach may reach the athlete is
 * not decided here: the page selects them only if its roster, which the server
 * answers, lists them. */

let pending: string | null = null;

/** Called by the link, in the click that navigates. */
export function handOffArrivalAthlete(athleteId: string): void {
  pending = athleteId.trim() || null;
}

/** Called once by the Decision Loop page on arrival. A second call returns null. */
export function takeArrivalAthlete(): string | null {
  const athleteId = pending;
  pending = null;
  return athleteId;
}
