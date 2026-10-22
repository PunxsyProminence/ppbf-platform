/* How an admin screen names a staff member it holds only as a row of the gym's
   directory (/api/pilot/admin/staff): the name the gym typed, else the name the
   login gives, else a plain floor. Never the sign-in address and never the
   account id (OD-2026-10-06-025, "Show coach name, hide ID"; OD-2026-10-19-008
   part B). Pure, so board seats, coach coverage and floor hours read one rule. */

import { bareTypedStaffName, deriveStaffDisplayName } from './coachDisplayName';
import { canCarryStaffDisplayName } from './staffDisplayName';

/**
 * What a person with no typed name and a role-word login ("admin@", "info@",
 * "ppbf@") is called. The same words the server uses for a staff note's author
 * (STAFF_AUTHOR_NAME_FLOOR, achievements.ts, which a client page cannot import;
 * staffListNames.test.ts holds the two together). Wording PROPOSED.
 */
export const STAFF_LIST_NAME_FLOOR = 'Gym office';

export interface StaffListSource {
  account_id: string;
  login_email?: string | null;
  staff_display_name?: string | null;
  role?: string | null;
  /** False once the person has left this gym; their typed name is then not read (storedStaffNameSql's rule). */
  membership_active?: boolean | null;
}

/**
 * One person's name, unnumbered. The typed name counts only for a role that
 * may carry one and only while the membership is active, two of the checks
 * the server makes on every read (storedStaffNameSql; the directory does not
 * say whether an account is deleted, so the third is the server's alone);
 * otherwise the name the login gives, then the floor.
 */
export function staffListNameFor(source: StaffListSource): string {
  const mayBeNamed = canCarryStaffDisplayName(source.role ?? '') && source.membership_active !== false;
  const typed = mayBeNamed ? bareTypedStaffName(source.staff_display_name) : null;
  return typed ?? deriveStaffDisplayName(source.login_email) ?? STAFF_LIST_NAME_FLOOR;
}

/**
 * Account id to the label a list prints, from (account id, name) pairs in the
 * order a screen wants them numbered. Two different people who read the same
 * are numbered "(1 of 2)", "(2 of 2)", never told apart by their sign-in
 * address (OD-2026-10-06-025, as the schedule's coach picker does).
 */
export function numberSharedNames(entries: Iterable<readonly [string, string]>): Map<string, string> {
  const names = new Map<string, string>();
  const sharing = new Map<string, string[]>();
  for (const [accountId, name] of entries) {
    if (names.has(accountId)) continue;
    names.set(accountId, name);
    sharing.set(name, [...(sharing.get(name) ?? []), accountId]);
  }
  const labels = new Map<string, string>();
  for (const [accountId, name] of names) {
    const same = sharing.get(name) ?? [];
    labels.set(accountId, same.length > 1 ? `${name} (${same.indexOf(accountId) + 1} of ${same.length})` : name);
  }
  return labels;
}

/** The same for a directory of people, each named by staffListNameFor, in the order given. */
export function staffListLabels(sources: readonly StaffListSource[]): Map<string, string> {
  return numberSharedNames(sources.map((source) => [source.account_id, staffListNameFor(source)] as const));
}
