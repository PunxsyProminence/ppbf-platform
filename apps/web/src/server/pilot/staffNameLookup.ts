import { STAFF_LIST_NAME_FLOOR } from '@/src/shared/staffListNames';

import { getCoachDisplayName, getStaffDisplayName } from './achievements';

/* Names for a list of rows that each carry the account id of a staff member
   (who issued a code, who filmed a clip, who linked a session). One read per
   DISTINCT person, through the same readers every other screen uses, so the
   name the gym typed comes first and the login's name is the fallback
   (achievements.ts getStaffDisplayName / getCoachDisplayName). A screen never
   prints the account id or the sign-in address: a person who cannot be named
   reads as the floor (OD-2026-10-06-025, "Show coach name, hide ID"). */

function distinctIds(accountIds: Iterable<string | null | undefined>): string[] {
  const ids = new Set<string>();
  for (const id of accountIds) {
    if (typeof id === 'string' && id !== '') ids.add(id);
  }
  return [...ids];
}

/**
 * Account id to the person's name without a title ("Dana"), or the floor
 * ("Gym office") when they cannot be named. For rows an organization admin or
 * a coach may have written.
 */
export async function staffNamesByAccount(
  organizationId: string,
  accountIds: Iterable<string | null | undefined>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const id of distinctIds(accountIds)) {
    names.set(id, (await getStaffDisplayName(organizationId, id)) ?? STAFF_LIST_NAME_FLOOR);
  }
  return names;
}

/**
 * The same with the coach title ("Coach Dana", else "Your coach"): the form
 * the development-blocks screen already prints for who wrote a block.
 */
export async function coachNamesByAccount(
  organizationId: string,
  accountIds: Iterable<string | null | undefined>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const id of distinctIds(accountIds)) {
    names.set(id, await getCoachDisplayName(organizationId, id));
  }
  return names;
}
