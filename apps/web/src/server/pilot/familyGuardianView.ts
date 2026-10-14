/* WHAT A FAMILY IS SENT ABOUT AN ATHLETE'S GUARDIANS AND WAIVERS (lane L4, #1558).
 *
 * The intake reads handed a parent and the athlete `parent_id` and `full_name`
 * for EVERY guardian linked to the child, and the co-guardian's waiver rows
 * keyed by that id. A parent_id is minted as `par-${accountId}`
 * (staffProvisioning.ts) and an account id is email-shaped, so the email the
 * guardian projection held back returned inside the id; and with two guardians
 * each read the other's name. Owner rulings: with two guardians of one child
 * each sees only their own (OD-2026-10-12-024), and a co-guardian sees the
 * other's consent STATUS only (OD-2026-10-05-024 item 4).
 *
 * So a family's answer is built here from NAMED fields, never by deleting
 * fields from a row (goalProjection.ts, familyRecordView.ts): a column added
 * to pilot.parents, pilot.guardian_links or pilot.waivers later is absent
 * from a family's answer until somebody decides it belongs. No guardian id and
 * no account id is selected for a family reader at all; "is this row the
 * reader's own" is answered in SQL, against the guardian records the reader's
 * account backs (guardianAccess.ts, the one definition), and arrives as the
 * boolean `you`.
 *
 * Staff (coach, organization admin) do not come through here: they keep the
 * column lists in intake.ts and passbook.ts, unchanged. */

import { isOrganizationAdminRole } from './access';
import type { PilotRole } from './contracts';
import { query } from './db';
import { guardianParentIds } from './guardianAccess';

/** Who is reading. A reader nobody named is trusted with the least. */
export interface FamilyReader {
  role: PilotRole | null;
  /** The guardian records the reader's own account backs; only a parent has any. */
  ownParentIds: string[];
}

/* One account can back a different pilot.parents row per child, so "mine" is
   a set, the same one /parent/consent tests membership in. Only a parent is
   asked: nobody else has a guardian row of their own in these answers. */
export async function resolveFamilyReader(
  organizationId: string,
  role: PilotRole | null,
  accountId: string | null,
): Promise<FamilyReader> {
  const ownParentIds = role === 'parent' && accountId ? await guardianParentIds(organizationId, accountId) : [];
  return { role, ownParentIds };
}

/** Coach and organization admin read the storage columns; everyone else is
 *  sent the projections below. Named, so a role added to a route's gate later
 *  gets the family answer until somebody decides otherwise. */
export function readsStaffGuardianRows(role: PilotRole | null): boolean {
  return role !== null && (isOrganizationAdminRole(role) || role === 'coach');
}

/* ── Guardians ────────────────────────────────────────────────────────────── */

/** Every column of the two guardian tables is on exactly one of these lists;
 *  guardianContactProjection.pg.test.ts holds them against the live tables,
 *  so a new column fails there until it is placed. */
export const GUARDIAN_FAMILY_COLUMNS = ['full_name', 'relationship_to_athlete'] as const;

export const GUARDIAN_WITHHELD_FROM_FAMILY_COLUMNS = [
  'organization_id',
  'parent_id',
  'account_id',
  'phone',
  'email',
  'athlete_id',
  'created_at',
  'updated_at',
] as const;

interface FamilyGuardianRow {
  you: boolean;
  full_name: string;
  relationship_to_athlete: string;
}

/** A guardian as the athlete receives it: their own parents by name, no id. */
export interface AthleteGuardianView {
  full_name: string;
  relationship_to_athlete: string;
}

/** A guardian as a parent receives it: their own row, or that a co-guardian
 *  exists and how they are related to the child. Never the other's name. */
export type ParentGuardianView =
  | { you: true; full_name: string; relationship_to_athlete: string }
  | { you: false; relationship_to_athlete: string };

export type FamilyGuardianView = AthleteGuardianView | ParentGuardianView;

export function toFamilyGuardians(rows: FamilyGuardianRow[], role: PilotRole | null): FamilyGuardianView[] {
  if (role === 'athlete') {
    return rows.map((row): AthleteGuardianView => ({
      full_name: row.full_name,
      relationship_to_athlete: row.relationship_to_athlete,
    }));
  }

  return rows.map((row): ParentGuardianView => (row.you === true
    ? { you: true, full_name: row.full_name, relationship_to_athlete: row.relationship_to_athlete }
    : { you: false, relationship_to_athlete: row.relationship_to_athlete }));
}

export async function listFamilyGuardians(
  organizationId: string,
  athleteId: string | null,
  reader: FamilyReader,
): Promise<FamilyGuardianView[]> {
  // Own row first, then by relationship and by when the link was made: never
  // by a name or an id the reader is not sent.
  const rows = await query<FamilyGuardianRow>(
    `select (g.parent_id = any($3::text[])) as you,
            p.full_name,
            g.relationship_to_athlete
       from pilot.guardian_links g
       join pilot.parents p
         on p.organization_id = g.organization_id
        and p.parent_id = g.parent_id
      where g.organization_id = $1 and g.athlete_id = $2
      order by you desc, g.relationship_to_athlete asc, g.created_at asc`,
    [organizationId, athleteId, reader.ownParentIds],
  );

  return toFamilyGuardians(rows, reader.role);
}

/* ── Waivers ──────────────────────────────────────────────────────────────── */

/** What a waiver IS, as its own guardian and the athlete read it. No
 *  parent_id, no organization_id, and none of the staff columns
 *  (WAIVER_STAFF_COLUMNS in intake.ts). */
export const WAIVER_FAMILY_COLUMNS = [
  'waiver_id',
  'athlete_id',
  'waiver_type',
  'signed_by_name',
  'signed_by_role',
  'signed_at',
  'consent_version',
  'status',
  'covers_video',
  'public_use_allowed',
  'created_at',
  'updated_at',
] as const;

/** A waiver in full: the athlete's own record, or a parent's own row. */
interface WaiverDetail {
  waiver_id: string;
  athlete_id: string;
  waiver_type: string;
  signed_by_name: string | null;
  signed_by_role: string | null;
  signed_at: string | null;
  consent_version: string | null;
  status: string;
  covers_video: boolean;
  public_use_allowed: boolean;
  created_at: string;
  updated_at: string;
}

interface FamilyWaiverRow extends WaiverDetail {
  /** The row is keyed to a guardian record the reader's own account backs. */
  you: boolean;
  /** The newest row for its guardian record (or for no record) and waiver type. */
  latest_of_signer: boolean;
}

/** A waiver that is not the reader's own: that it is on file, and its status. */
export interface OtherWaiverStatus {
  you: false;
  waiver_type: string;
  status: string;
}

export type FamilyWaiverView = WaiverDetail | (WaiverDetail & { you: true }) | OtherWaiverStatus;

function waiverDetail(row: FamilyWaiverRow): WaiverDetail {
  return {
    waiver_id: row.waiver_id,
    athlete_id: row.athlete_id,
    waiver_type: row.waiver_type,
    signed_by_name: row.signed_by_name,
    signed_by_role: row.signed_by_role,
    signed_at: row.signed_at,
    consent_version: row.consent_version,
    status: row.status,
    covers_video: row.covers_video,
    public_use_allowed: row.public_use_allowed,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/* The athlete reads every waiver on their own record with the name it was
   signed under. A parent reads the rows keyed to their own guardian record,
   whole.

   EVERY OTHER ROW IS A STATUS (OD-2026-10-05-024 item 4: a co-guardian sees the
   other's consent status, nothing more): its type and status, with no record
   id, date, scope flags or name. That covers a row keyed to the other guardian,
   and also a row keyed to nobody -- which is NOT safely "a paper form": the
   retention purge clears parent_id on a deleted guardian's waivers and keeps
   the rows (pilot-cleanup-deleted-data.mjs), so an unkeyed row can be the other
   guardian's consent decision. And it is the CURRENT status only: the newest
   row per guardian record and type (rows keyed to nobody count as one group
   per type), listed after the reader's own rows and ordered by type, so
   neither how often the other guardian changed their mind nor when can be
   read from the list. */
export function toFamilyWaivers(rows: FamilyWaiverRow[], role: PilotRole | null): FamilyWaiverView[] {
  if (role === 'athlete') {
    return rows.map(waiverDetail);
  }

  const own = rows
    .filter((row) => row.you === true)
    .map((row): WaiverDetail & { you: true } => ({ you: true, ...waiverDetail(row) }));
  const others = rows
    .filter((row) => row.you !== true && row.latest_of_signer === true)
    .map((row): OtherWaiverStatus => ({ you: false, waiver_type: row.waiver_type, status: row.status }))
    .sort((a, b) => a.waiver_type.localeCompare(b.waiver_type) || a.status.localeCompare(b.status));

  return [...own, ...others];
}

export async function listFamilyWaivers(
  organizationId: string,
  athleteId: string | null,
  reader: FamilyReader,
): Promise<FamilyWaiverView[]> {
  const rows = await query<FamilyWaiverRow>(
    `select ${WAIVER_FAMILY_COLUMNS.map((column) => `w.${column}`).join(', ')},
            (w.parent_id = any($3::text[])) is true as you,
            (row_number() over (
              partition by w.parent_id, w.waiver_type
              order by w.created_at desc, w.waiver_id desc
            ) = 1) as latest_of_signer
       from pilot.waivers w
      where w.organization_id = $1 and w.athlete_id = $2
      order by w.created_at desc`,
    [organizationId, athleteId, reader.ownParentIds],
  );

  return toFamilyWaivers(rows, reader.role);
}
