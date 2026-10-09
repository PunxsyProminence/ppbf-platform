import { randomUUID } from 'node:crypto';

import { query } from './db';

export type AnnouncementAuthorRole =
  | 'coach'
  | 'admin'
  | 'board-president'
  | 'board-chair'
  | 'board-vice-chair'
  | 'board-treasurer'
  | 'board-secretary'
  | 'board-safety-director'
  | 'board-community-director'
  | 'board-at-large';

const ALLOWED_AUTHOR_ROLES: AnnouncementAuthorRole[] = [
  'coach',
  'admin',
  'board-president',
  'board-chair',
  'board-vice-chair',
  'board-treasurer',
  'board-secretary',
  'board-safety-director',
  'board-community-director',
  'board-at-large',
];

// Closed vocabularies, mirroring the check constraints in
// infra/azure/pilot_slice_postgres_announcement_placements_migration.sql, as
// widened by pilot_slice_postgres_parent_hub_placement_migration.sql. A
// placement names a surface that exists; an unrecognized one would render
// nowhere at all, so the write is refused rather than stored.
export const ANNOUNCEMENT_PLACEMENTS = [
  'gym_notices',
  'athlete_workspace',
  'coach_workspace',
  'parent_hub',
  'everywhere',
] as const;

export type AnnouncementPlacement = (typeof ANNOUNCEMENT_PLACEMENTS)[number];

export const ANNOUNCEMENT_KINDS = ['notice', 'motivation'] as const;

export type AnnouncementKind = (typeof ANNOUNCEMENT_KINDS)[number];

export interface PilotAnnouncement {
  announcement_id: string;
  organization_id: string;
  message: string;
  author_name: string;
  author_role: string;
  created_at: string;
  placement: AnnouncementPlacement;
  kind: AnnouncementKind;
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
}

const ANNOUNCEMENT_FIELDS =
  'announcement_id, organization_id, message, author_name, author_role, created_at, placement, kind, active, starts_at, ends_at';

// pilot.announcements is owned by
// infra/azure/pilot_slice_postgres_announcements_migration.sql, applied through
// the apply-migrations workflow like every other table.
//
// It previously had no migration at all: an `ensureAnnouncementTable()` helper
// issued CREATE TABLE from inside these functions, so the schema was created by
// whichever request happened to arrive first. That was already the wrong owner,
// and it stopped being merely untidy when GET /api/pilot/announcements/public
// shipped unauthenticated -- an anonymous internet request could then execute
// DDL against production Postgres. Do not reintroduce it; if the table is
// missing, the migration has not been run and the query should say so loudly
// rather than silently creating schema in a request handler.

/**
 * What a `board` principal may see of an announcement.
 *
 * The board role is aggregate oversight only: no free-text member content and
 * no author identity. A notice body is text a coach or admin typed, and it can
 * name an athlete; author_name is a named individual. Neither belongs to a role
 * whose whole contract is organization-level aggregates.
 *
 * Until this existed the boundary was a TypeScript interface in
 * BoardSeatEvidence.tsx that simply left the two fields out. That is erased at
 * compile time -- the server still sent both over the wire and the component
 * just did not read them, so devtools, curl with the session cookie, or any
 * non-browser client saw the whole payload. And it was not even applied
 * consistently: /notices renders `message` and `author_name` to a board
 * principal in a ledger with the column headers "What it says" and "Written
 * by", three files from where BoardSeatEvidence tells the same board member
 * that notice text and author names "stay outside this role".
 *
 * AN EXPLICIT ALLOW-LIST, not Omit<> or a destructured rest. A rest spread
 * would carry any column added to PilotAnnouncement later straight through to
 * the board -- the next sensitive field would leak by default and nothing here
 * would change. Naming the survivors means a new column is invisible to the
 * board until someone deliberately adds it.
 */
export type BoardVisibleAnnouncement = Pick<
  PilotAnnouncement,
  | 'announcement_id'
  | 'organization_id'
  | 'author_role'
  | 'created_at'
  | 'placement'
  | 'kind'
  | 'active'
  | 'starts_at'
  | 'ends_at'
>;

export function projectAnnouncementForBoard(announcement: PilotAnnouncement): BoardVisibleAnnouncement {
  return {
    announcement_id: announcement.announcement_id,
    organization_id: announcement.organization_id,
    // author_ROLE, not author_name: "a board notice was posted" is governance
    // information; which person posted it is member identity.
    author_role: announcement.author_role,
    created_at: announcement.created_at,
    placement: announcement.placement,
    kind: announcement.kind,
    active: announcement.active,
    starts_at: announcement.starts_at,
    ends_at: announcement.ends_at,
  };
}

export function isAllowedAnnouncementRole(role: string): role is AnnouncementAuthorRole {
  return ALLOWED_AUTHOR_ROLES.includes(role as AnnouncementAuthorRole);
}

export function isAnnouncementPlacement(value: unknown): value is AnnouncementPlacement {
  return ANNOUNCEMENT_PLACEMENTS.includes(value as AnnouncementPlacement);
}

export function isAnnouncementKind(value: unknown): value is AnnouncementKind {
  return ANNOUNCEMENT_KINDS.includes(value as AnnouncementKind);
}

function clampLimit(limit: number | undefined): number {
  return Number.isFinite(limit) ? Math.max(1, Math.min(limit as number, 25)) : 8;
}

// Everything one organization has ever posted, newest first, including items
// that are retired, expired, or not yet in their window. Only the authoring
// surface should read this -- a reader that draws announcements must use
// listLiveAnnouncements so a scheduled or retired item cannot reach a member.
export async function listAnnouncements(organizationId: string, limit = 8): Promise<PilotAnnouncement[]> {
  const safeLimit = clampLimit(limit);
  return query<PilotAnnouncement>(
    `select ${ANNOUNCEMENT_FIELDS}
     from pilot.announcements
     where organization_id = $1
     order by created_at desc
     limit ${safeLimit}`,
    [organizationId],
  );
}

// What a member may actually see on one surface right now. 'everywhere' is
// included in every MEMBER placement's read by definition. A null bound is an
// unset bound, not a closed one, so it reads as always-on in that direction.
//
// includeEverywhere: 'everywhere' means every signed-in surface (athletes,
// coaches, parents), not every screen in the world (OD-2026-10-07-008, "Members
// only"). The two anonymous readers -- the login-page Gym Notices panel and the
// public wall -- pass false, so a notice reaches a signed-out page only when its
// author placed it on gym_notices in as many words. Defaults to true because
// every other caller is a session-scoped read.
export async function listLiveAnnouncements(
  organizationId: string,
  params: {
    placement: AnnouncementPlacement;
    kind: AnnouncementKind;
    limit?: number;
    includeEverywhere?: boolean;
  },
): Promise<PilotAnnouncement[]> {
  const safeLimit = clampLimit(params.limit);
  const placementClause =
    params.includeEverywhere === false ? 'placement = $2' : "(placement = $2 or placement = 'everywhere')";
  return query<PilotAnnouncement>(
    `select ${ANNOUNCEMENT_FIELDS}
     from pilot.announcements
     where organization_id = $1
       and active
       and ${placementClause}
       and kind = $3
       and (starts_at is null or starts_at <= now())
       and (ends_at is null or ends_at > now())
     order by created_at desc
     limit ${safeLimit}`,
    [organizationId, params.placement, params.kind],
  );
}

export async function createAnnouncement(params: {
  organizationId: string;
  message: string;
  authorName: string;
  authorRole: AnnouncementAuthorRole;
  placement?: AnnouncementPlacement;
  kind?: AnnouncementKind;
  startsAt?: string | null;
  endsAt?: string | null;
}): Promise<PilotAnnouncement> {
  const announcementId = randomUUID();
  await query(
    `insert into pilot.announcements
     (organization_id, announcement_id, message, author_name, author_role, placement, kind, starts_at, ends_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz)`,
    [
      params.organizationId,
      announcementId,
      params.message,
      params.authorName,
      params.authorRole,
      params.placement ?? 'gym_notices',
      params.kind ?? 'notice',
      params.startsAt ?? null,
      params.endsAt ?? null,
    ],
  );

  const rows = await query<PilotAnnouncement>(
    `select ${ANNOUNCEMENT_FIELDS}
     from pilot.announcements
     where organization_id = $1 and announcement_id = $2`,
    [params.organizationId, announcementId],
  );

  if (!rows[0]) {
    throw new Error('Announcement write verification failed');
  }

  return rows[0];
}

// Retiring keeps the record and its authorship; there is no delete path,
// because a notice that was live is part of what the gym told people.
// Returns null when no row in this organization carries that id, so the
// caller can report "nothing changed" rather than a silent success.
//
// WHO MAY (CL-A8; Jason 2026-10-06, "author + org admin", the CL-A14 line).
// onlyAuthorAccountId null means an organization admin: any notice in the
// organization. Otherwise the write lands only if that account is the actor
// on the notice's 'create' audit row in this organization. The table has no
// author column -- author_name is a typed byline, not an identity -- and the
// post route has always written that audit row, so it is the record of who
// posted. A notice with no create row can be retired by an admin only. The
// check rides on the UPDATE itself, so there is no read-then-write window,
// and a refusal is the same null as a missing row.
export async function setAnnouncementActive(params: {
  organizationId: string;
  announcementId: string;
  active: boolean;
  // Required, not optional: leaving it out must not quietly mean "admin".
  onlyAuthorAccountId: string | null;
}): Promise<PilotAnnouncement | null> {
  const rows = await query<PilotAnnouncement>(
    `update pilot.announcements a
     set active = $3, updated_at = now()
     where a.organization_id = $1 and a.announcement_id = $2
       and (
         $4::text is null
         or exists (
           select 1 from pilot.audit_events ae
           where ae.organization_id = a.organization_id
             and ae.entity_type = 'announcement'
             and ae.entity_id = a.announcement_id::text
             and ae.event_type = 'create'
             and ae.actor_account_id = $4::text
         )
       )
     returning ${ANNOUNCEMENT_FIELDS}`,
    [params.organizationId, params.announcementId, params.active, params.onlyAuthorAccountId],
  );

  return rows[0] ?? null;
}

// Of these notices, the ones this account posted: the actor on each notice's
// 'create' audit row in this organization, the same authorship
// setAnnouncementActive enforces. Read so the authoring page offers Retire and
// Restore only where the update route would accept them; the write still
// decides on its own.
export async function listAuthoredAnnouncementIds(
  organizationId: string,
  accountId: string,
  announcementIds: readonly string[],
): Promise<string[]> {
  if (announcementIds.length === 0) {
    return [];
  }
  const rows = await query<{ entity_id: string }>(
    `select distinct entity_id
     from pilot.audit_events
     where organization_id = $1
       and entity_type = 'announcement'
       and event_type = 'create'
       and actor_account_id = $2
       and entity_id = any($3::text[])`,
    [organizationId, accountId, [...announcementIds]],
  );
  const authored = new Set(rows.map((row) => row.entity_id));
  return announcementIds.filter((id) => authored.has(id));
}
