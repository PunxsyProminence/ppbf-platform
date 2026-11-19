/**
 * The gym tablet idle sign-out times (lane U1; Jason's ruling OW25-53 A, the
 * gym admin sets the time, first value 1 hour; Overwatch Q3, a fixed list).
 *
 * One list for the server module (tabletIdlePolicy.ts), the database CHECK
 * (pinned against this list by tabletIdlePolicy.test.ts), the gym admin's
 * select on Customize the Gym, and the browser's timer. Shared because the
 * browser must not import the server module (it loads pg).
 */

export const TABLET_IDLE_MINUTES = [15, 30, 60, 120, 240] as const;
export type TabletIdleMinutes = (typeof TABLET_IDLE_MINUTES)[number];
export const DEFAULT_TABLET_IDLE_MINUTES: TabletIdleMinutes = 60;

/** How long the countdown shows before the tablet signs out. */
export const TABLET_IDLE_COUNTDOWN_SECONDS = 60;

export function isTabletIdleMinutes(value: unknown): value is TabletIdleMinutes {
  return typeof value === 'number' && (TABLET_IDLE_MINUTES as readonly number[]).includes(value);
}

/** The words the gym admin's select shows for each choice. */
export function tabletIdleLabel(minutes: TabletIdleMinutes): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? '1 hour' : `${hours} hours`;
}
