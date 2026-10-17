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

import { queryOne } from './db';
import { accountDeletedSql } from './deletedAccountSignIn';
import { readOrganizationWaiverRoster, TRACKED_WAIVER_TYPES } from './waiverCompliance';

export type SetupLineState = 'done' | 'to_do' | 'manual' | 'unavailable';

export interface SetupLine {
  key: string;
  title: string;
  state: SetupLineState;
  /** What the records say, in a sentence. */
  detail: string;
  /** The screen where the step is done. */
  href: string;
  linkLabel: string;
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
        'Done outside the app. A gym admin signs in with Microsoft, so before an admin’s first sign-in the platform '
        + 'owner adds their email as a guest in the gym’s Microsoft tenant (Microsoft Entra admin center: Users, '
        + 'then Invite external user). You are signed in, so yours is done.',
      href: '/admin/people',
      linkLabel: 'People',
    }),
    line({ key: 'coaches', title: 'At least one coach', href: '/admin/people', linkLabel: 'Add a coach' }, async () => {
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
    line({ key: 'athletes', title: 'Athletes on the roster', href: '/admin/people', linkLabel: 'Add an athlete' }, async () => {
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
      { key: 'athlete-sign-in', title: 'Athletes can sign in', href: '/admin/activation-codes', linkLabel: 'Activation codes' },
      async () => {
        const waiting = await count(
          `select count(*)::int as n from pilot.accounts a
            where a.organization_id = $1 and a.role = 'athlete' and a.pin_hash is null and not ${accountDeletedSql('a')}`,
          organizationId,
        );
        const withPin = await count(
          `select count(*)::int as n from pilot.accounts a
            where a.organization_id = $1 and a.role = 'athlete' and a.pin_hash is not null and a.active_flag
              and not ${accountDeletedSql('a')}`,
          organizationId,
        );
        if (waiting === 0 && withPin === 0) {
          return { state: 'to_do', detail: 'No athlete has a sign-in yet. Each one needs a one-time activation code.' };
        }
        return waiting === 0
          ? { state: 'done', detail: `${plural(withPin, 'athlete has', 'athletes have')} set a PIN.` }
          : {
              state: 'to_do',
              detail: `${plural(withPin, 'athlete has', 'athletes have')} set a PIN; ${plural(waiting, 'is', 'are')} still waiting to redeem an activation code.`,
            };
      },
    ),
    line(
      { key: 'guardians', title: 'A guardian for every athlete under 18', href: '/admin/athlete-consent', linkLabel: 'Guardians and consent' },
      async () => {
        const n = await count(
          `select count(*)::int as n from pilot.athletes a
            where a.organization_id = $1 and a.active_flag and a.deleted_at is null
              and a.dob > (current_date - interval '18 years')
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
              detail: `${plural(missing, 'active athlete is', 'active athletes are')} missing at least one tracked waiver or consent.`,
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
    line({ key: 'tv', title: 'A gym TV paired (if the gym uses one)', href: '/coach/environment/intake-router', linkLabel: 'Coach workspace' }, async () => {
      const n = await count(
        `select count(*)::int as n from pilot.gym_tvs
          where organization_id = $1 and paired_at is not null and revoked_at is null`,
        organizationId,
      );
      return n > 0
        ? { state: 'done', detail: `${plural(n, 'TV is', 'TVs are')} paired.` }
        : { state: 'to_do', detail: 'No TV paired. A coach pairs one with a code from the coach workspace.' };
    }),
  ]);
}
