/* ARRIVING AT A PAGE WITH THE ATHLETE ALREADY CHOSEN (#1474 item 5).
 *
 * A coach who follows a pain report's "Record what you did" link came for that
 * athlete, so the Decision Loop opens on them. The athlete travels in page
 * memory, never in the address: no athlete id goes in a page URL, where it
 * would sit in the address bar, the browser history and the server's request
 * logs (Overwatch ruling on #1474, Q2 = C; applied to the coach safety pages,
 * lane AS-5 Q3 = A).
 *
 * One hand-off, taken once, and only within a few seconds of the click: a
 * navigation that never arrived (another tap, a redirect) must not open a
 * later, unrelated visit on that athlete. It lives only as long as this tab's
 * page: the link is a client-side navigation, so it survives the trip; a new
 * tab or a reload arrives with nothing, which is the page's ordinary empty
 * state. Nothing is written to storage on the device. Whether the coach may
 * reach the athlete is not decided here: the page selects them only if its
 * roster, which the server answers, lists them.
 *
 * WHICH PAGE (lane AS-5). A hand-off names the page it is for, and only that
 * page takes it. A page that takes a hand-off meant for another page gets
 * nothing, and the hand-off is spent: the navigation it was made for did not
 * happen. Left out, the page is the Decision Loop, as it always was. */

/** How long a hand-off waits for the page it was meant for. */
export const ARRIVAL_WINDOW_MS = 10_000;

/** The page a hand-off is for when none is named. */
export const DECISION_LOOP_PAGE = '/coach/decision-loop';
/** The Clearance Board, which Escalations hands an athlete to. */
export const CLEARANCE_BOARD_PAGE = '/coach/sports-medicine';
/** The id of the Decision Loop's "Post to the Family's Page" section, which a
    link may open at (lane AS-5): a section name in the address, never an id. */
export const POST_TO_FAMILY_SECTION = 'post-to-family';

let pending: { athleteId: string; page: string; at: number } | null = null;

/** A plain left click, the only click a link should hand off on: a modified
    or middle click opens another tab, which arrives with nothing and would
    leave the hand-off waiting here for whatever this tab opens next (the same
    rule as the coach home's "Record what you did" link). */
export function isPlainClick(event: {
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** Called by the link, in the click that navigates. */
export function handOffArrivalAthlete(athleteId: string, page: string = DECISION_LOOP_PAGE): void {
  const id = athleteId.trim();
  pending = id ? { athleteId: id, page, at: Date.now() } : null;
}

/** Called once by the arriving page. A second call, a call after
    ARRIVAL_WINDOW_MS, or a call from a page the hand-off was not for, returns
    null. */
export function takeArrivalAthlete(page: string = DECISION_LOOP_PAGE): string | null {
  const taken = pending;
  pending = null;
  if (!taken || taken.page !== page || Date.now() - taken.at > ARRIVAL_WINDOW_MS) return null;
  return taken.athleteId;
}
