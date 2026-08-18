import { query } from './db';

/**
 * pilot.club_members: the general roster record for a dues-paying member who
 * is not necessarily an athlete.
 *
 * See pilot_slice_postgres_club_members_migration.sql for the full design
 * reasoning: pilot.athletes is training-specific and stays that way,
 * pilot.accounts.role is authentication rather than club membership, and
 * pilot.program_memberships links only to an athlete -- none of the three
 * fit a Non-Athlete adult member (e.g. the gym owner, on the real roster
 * with a home address and no training record at all). This is the minimal
 * new table an Athlete-type row AND a non-athlete row can both point at.
 *
 * SAFEGUARDING: when a row is linked to an athlete (athlete_id set),
 * full_name stays null here -- the database enforces this
 * (pilot_club_members_name_check) -- and every read joins through
 * pilot.athletes for the name, so a minor's name lives in exactly one place.
 * A non-athlete row has no other record to join through, so full_name is
 * required there.
 */
export type ClubMembershipType =
  | 'athlete'
  | 'non_athlete'
  | 'junior_fitness_non_contact'
  | 'adult_fitness_non_contact';

export const CLUB_MEMBERSHIP_TYPES: readonly ClubMembershipType[] = [
  'athlete',
  'non_athlete',
  'junior_fitness_non_contact',
  'adult_fitness_non_contact',
];

export interface ClubMemberInput {
  member_id: string;
  /** Set when this member also has a pilot.athletes record; null otherwise. */
  athlete_id: string | null;
  /** Required when athlete_id is null; must be null when athlete_id is set. */
  full_name: string | null;
  membership_type: ClubMembershipType;
  address_line1: string;
  city: string;
  state: string;
  postal_code: string;
  created_by_account_id: string;
}

/**
 * Create-only, mirroring insertAthleteIfAbsent in entities.ts: the insert
 * carries `on conflict do nothing`, so a member_id already on the roster is
 * left exactly as it is and the caller learns that from the false return
 * rather than a silently overwritten row.
 */
export async function insertClubMemberIfAbsent(organizationId: string, payload: ClubMemberInput): Promise<boolean> {
  const inserted = await query<{ member_id: string }>(
    `insert into pilot.club_members
       (organization_id, member_id, athlete_id, full_name, membership_type, address_line1, city, state, postal_code, created_by_account_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (organization_id, member_id) do nothing
     returning member_id`,
    [
      organizationId,
      payload.member_id,
      payload.athlete_id,
      payload.full_name,
      payload.membership_type,
      payload.address_line1,
      payload.city,
      payload.state,
      payload.postal_code,
      payload.created_by_account_id,
    ],
  );

  return inserted.length > 0;
}

export function isClubMembershipType(value: unknown): value is ClubMembershipType {
  return typeof value === 'string' && (CLUB_MEMBERSHIP_TYPES as readonly string[]).includes(value);
}
