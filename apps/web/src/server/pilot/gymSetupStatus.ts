/**
 * WHAT IS LEFT BEFORE THE FIRST CLASS (lane L31 P5, issue #1469).
 *
 * One read-only answer for the organization admin, for their own gym: each
 * step a gym takes from "it exists" to "a class runs", what the records say
 * about it now, and the screen where it is done. Nothing here decides or
 * refuses anything; every line counts records the other screens already
 * write, and a line whose read fails says so rather than claiming done.
 *
 * The one step done outside the app (Overwatch Q3 A, 2026-10-16): a gym
 * admin signs in with Microsoft, so each one must first be a guest in the
 * Microsoft tenant. The checklist states it with its instructions.
 */

import { GYM_TIME_ZONE } from '@/src/lib/gymTime';
import { queryOne } from './db';
import { accountDeletedSql } from './deletedAccountSignIn';
import { readOrganizationWaiverRoster, TRACKED_WAIVER_TYPES } from './waiverCompliance';

export type SetupLineState = 'done' | 'to_do' | 'manual' | 'optional' | 'unavailable';

export interface SetupLine {
  key: string;
  title: string;
  state: SetupLineState;
  /** What the records say, in a sentence. */
  detail: string;
  /** The screen where the step is done, or null when the org admin has none to go to. */
  href: string | null;
  linkLabel: string | null;
  /** A second screen for the same step, when the work is split over two (the guardian step). */
  alsoHref?: string | null;
  alsoLinkLabel?: string | null;
}

async function count(sql: string, organizationId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(sql, [organizationId]);
  return Number(row?.n ?? 0);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

async function line(
  base: Omit<SetupLine, 'state' | 'detail'>,
  read: () => Promise<{ state: SetupLineState; detail: string }>,
): Promise<SetupLine> {
  try {
    return { ...base, ...(await read()) };
  } catch {
    return { ...base, state: 'unavailable', detail: 'This could not be read just now.' };
  }
}

export async function readGymSetupStatus(organizationId: string): Promise<SetupLine[]> {
  return Promise.all([
    Promise.resolve<SetupLine>({
      key: 'admin-sign-in',
      title: 'Gym admin sign-in',
      state: 'manual',
      detail:
        'Done outside the app, by the platform owner. A gym admin signs in with Microsoft, in the platform’s '
        + 'Microsoft tenant, so an admin whose email is not already a member of that tenant is first invited as a '
        + 'guest (Microsoft Entra admin center: Users, New user, Invite external user). You are signed in, so yours '
        + 'is done.',
      href: null,
      linkLabel: null,
    }),
    // Gym Office opens on the tab a link names (lane AS-10, OFF-09), so each step
    // lands on its own form, not on the roster.
    line({ key: 'coaches', title: 'At least one coach', href: '/admin/people?tab=invite-staff', linkLabel: 'Add a coach' }, async () => {
      const n = await count(
        `select count(*)::int as n
           from pilot.accounts a
           join pilot.organization_memberships m on m.account_id = a.account_id and m.organization_id = $1
          where m.role = 'coach' and m.active_flag and a.active_flag and not ${accountDeletedSql('a')}`,
        organizationId,
      );
      return n > 0
        ? { state: 'done', detail: `${plural(n, 'active coach', 'active coaches')}.` }
        : { state: 'to_do', detail: 'No active coach yet. A class needs a coach, and adding an athlete names one.' };
    }),
    line({ key: 'athletes', title: 'Athletes on the roster', href: '/admin/people?tab=add-athlete', linkLabel: 'Add an athlete' }, async () => {
      const n = await count(
        `select count(*)::int as n from pilot.athletes a
          where a.organization_id = $1 and a.active_flag and a.deleted_at is null`,
        organizationId,
      );
      return n > 0
        ? { state: 'done', detail: `${plural(n, 'active athlete', 'active athletes')}.` }
        : { state: 'to_do', detail: 'No athlete on the roster yet.' };
    }),
    line(
      // Gym Office is the one place a code is issued (lane AS-10, OFF-08; Overwatch Q5 A):
      // Add Athlete gives a roster athlete with no sign-in a code; a re-issue is on their row.
      { key: 'athlete-sign-in', title: 'Athletes can sign in', href: '/admin/people?tab=add-athlete', linkLabel: 'Add Athlete' },
      async () => {
        // From the roster, so an athlete never issued a code counts too: an
        // athlete gets a login only when the first code is issued.
        const row = await queryOne<{ total: number; with_pin: number; waiting: number }>(
          `select count(*)::int as total,
                  count(*) filter (where acct.pin_hash is not null and acct.active_flag)::int as with_pin,
                  count(*) filter (where acct.account_id is not null and acct.pin_hash is null)::int as waiting
             from pilot.athletes a
             left join pilot.accounts acct
               on acct.organization_id = a.organization_id and acct.athlete_id = a.athlete_id
              and acct.role = 'athlete' and not ${accountDeletedSql('acct')}
            where a.organization_id = $1 and a.active_flag and a.deleted_at is null`,
          [organizationId],
        );
        const total = Number(row?.total ?? 0);
        const withPin = Number(row?.with_pin ?? 0);
        const waiting = Number(row?.waiting ?? 0);
        const noCode = Math.max(total - withPin - waiting, 0);
        if (total === 0) return { state: 'to_do', detail: 'No athlete on the roster yet.' };
        if (withPin === total) {
          return { state: 'done', detail: `Every active athlete has set a PIN (${total}).` };
        }
        const parts = [
          `${plural(withPin, 'athlete has', 'athletes have')} set a PIN`,
          ...(waiting > 0 ? [`${plural(waiting, 'is', 'are')} waiting to redeem an activation code`] : []),
          ...(noCode > 0 ? [`${plural(noCode, 'has', 'have')} not been issued a code yet`] : []),
        ];
        // The link opens Add Athlete, which gives a roster athlete with no sign-in a
        // code. A code not redeemed is replaced on the athlete's own row, so the line
        // names that control too (lane AS-10, AS10-1 review).
        const reissue = waiting > 0 ? ' An unredeemed code is replaced from the athlete\'s row on Gym Office: Issue New Activation Code.' : '';
        return { state: 'to_do', detail: `${parts.join('; ')}.${reissue}` };
      },
    ),
    line(
      // A guardian who signs in is added on Gym Office; a family with no email gets a
      // paper-only guardian on Media Consent Audit (OD-2026-10-07-009 ruling 3). The count
      // below takes either (lane AS-10, OFF-09; Overwatch Q6 A).
      {
        key: 'guardians',
        title: 'A guardian for every athlete under 18',
        // role=parent: the invite opens with Parent / Guardian chosen, not Coach.
        href: '/admin/people?tab=invite-staff&role=parent',
        linkLabel: 'Add a guardian',
        alsoHref: '/admin/athlete-consent',
        alsoLinkLabel: 'Media Consent Audit',
      },
      async () => {
        const n = await count(
          `select count(*)::int as n from pilot.athletes a
            where a.organization_id = $1 and a.active_flag and a.deleted_at is null
              and a.dob > ((now() at time zone '${GYM_TIME_ZONE}')::date - interval '18 years')
              and not exists (
                select 1 from pilot.guardian_links gl
                 where gl.organization_id = a.organization_id and gl.athlete_id = a.athlete_id
              )`,
          organizationId,
        );
        return n === 0
          ? { state: 'done', detail: 'Every athlete under 18 has a guardian on file.' }
          : { state: 'to_do', detail: `${plural(n, 'athlete under 18 has', 'athletes under 18 have')} no guardian on file.` };
      },
    ),
    line(
      { key: 'waivers', title: 'Waivers and media consent on file', href: '/admin/waiver-status', linkLabel: 'Waiver compliance' },
      async () => {
        const roster = (await readOrganizationWaiverRoster(organizationId)).filter((athlete) => athlete.activeFlag);
        const missing = roster.filter((athlete) =>
          TRACKED_WAIVER_TYPES.some((type) => athlete.waivers[type] !== 'signed'),
        ).length;
        if (roster.length === 0) return { state: 'to_do', detail: 'No athlete on the roster yet.' };
        return missing === 0
          ? { state: 'done', detail: 'Every active athlete has each tracked waiver signed.' }
          : {
              state: 'to_do',
              detail: `${plural(missing, 'active athlete has', 'active athletes have')} at least one tracked waiver or consent not signed (missing, declined or withdrawn).`,
            };
      },
    ),
    line({ key: 'class', title: 'A class on the schedule', href: '/schedule', linkLabel: 'Schedule a class' }, async () => {
      const n = await count(
        `select count(*)::int as n from pilot.scheduler_classes
          where organization_id = $1 and status <> 'cancelled' and start_at > now()`,
        organizationId,
      );
      return n > 0
        ? { state: 'done', detail: `${plural(n, 'upcoming class', 'upcoming classes')}.` }
        : { state: 'to_do', detail: 'No upcoming class yet.' };
    }),
    // No link: the office pairs a TV on this page itself, where /admin/setup
    // shows the gym TV panel inside this line (lane SH, OFF-02); a coach
    // still pairs one from the coach workspace.
    line({ key: 'tv', title: 'A gym TV paired (if the gym uses one)', href: null, linkLabel: null }, async () => {
      const n = await count(
        `select count(*)::int as n from pilot.gym_tvs
          where organization_id = $1 and paired_at is not null and revoked_at is null`,
        organizationId,
      );
      return n > 0
        ? { state: 'done', detail: `${plural(n, 'TV is', 'TVs are')} paired.` }
        : { state: 'optional', detail: 'No TV paired. Pair one here, or a coach pairs one from the coach workspace.' };
    }),
  ]);
}
