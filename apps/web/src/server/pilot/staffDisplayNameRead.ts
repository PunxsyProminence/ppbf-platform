import { STAFF_DISPLAY_NAME_ROLES } from '@/src/shared/staffDisplayName';

import { accountNotDeletedSql } from './deletedAthletes';

/* Spelled into the SQL rather than bound, so the one expression drops into any
   select list without renumbering its caller's parameters. The roles are this
   module's own constants; the check is that they stay plain words. */
const ROLE_LIST = STAFF_DISPLAY_NAME_ROLES.map((role) => {
  if (!/^[a-z_]+$/.test(role)) throw new Error(`staffDisplayNameRead: unexpected role "${role}"`);
  return `'${role}'`;
}).join(', ');

const SQL_REFERENCE = /^(?:\$\d+|[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)$/;

/**
 * The name the gym typed for a person (pilot.account_profiles.staff_display_name,
 * parent-portal Q1 part B), as ONE SQL expression for a select list: the name,
 * or NULL. Every screen that names a coach or staff member reads it through
 * here, and falls back to the name it built from the login before.
 *
 * NULL unless, at the time of the read, the account:
 * - holds an ACTIVE membership in THAT organization (a coach who has left is
 *   not named by the name the gym once typed, and one gym never reads a name
 *   another gym typed);
 * - in a role that may carry a name today (src/shared/staffDisplayName.ts). A
 *   named coach later re-invited as a guardian keeps the stored row (the invite
 *   does not clear it), so the role is checked here, on every read;
 * - is not deleted (the same mark setStaffDisplayName refuses).
 *
 * That holds for what a screen reads now. A name already copied into a row
 * when it was written (a recognition's signature, a behavior standard's
 * author) is that row's text and is not re-read here.
 *
 * The arguments are SQL expressions from the caller's own query: an alias's
 * column (`co.organization_id`) or a bound parameter (`$1`). Anything else is
 * refused, so caller input can never be spliced in.
 */
export function storedStaffNameSql(organizationIdSql: string, accountIdSql: string): string {
  for (const expression of [organizationIdSql, accountIdSql]) {
    if (!SQL_REFERENCE.test(expression)) {
      throw new Error(`storedStaffNameSql: not a column or parameter reference: "${expression}"`);
    }
  }
  return `(select sdn_ap.staff_display_name
      from pilot.account_profiles sdn_ap
      join pilot.organization_memberships sdn_om
        on sdn_om.organization_id = sdn_ap.organization_id and sdn_om.account_id = sdn_ap.account_id
     where sdn_ap.organization_id = ${organizationIdSql}
       and sdn_ap.account_id = ${accountIdSql}
       and sdn_om.active_flag
       and sdn_om.role in (${ROLE_LIST})
       and ${accountNotDeletedSql('sdn_ap')})`;
}
