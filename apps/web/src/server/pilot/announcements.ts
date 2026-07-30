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

export interface PilotAnnouncement {
  announcement_id: string;
  organization_id: string;
  message: string;
  author_name: string;
  author_role: string;
  created_at: string;
}

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

export function isAllowedAnnouncementRole(role: string): role is AnnouncementAuthorRole {
  return ALLOWED_AUTHOR_ROLES.includes(role as AnnouncementAuthorRole);
}

export async function listAnnouncements(organizationId: string, limit = 8): Promise<PilotAnnouncement[]> {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 25)) : 8;
  return query<PilotAnnouncement>(
    `select announcement_id, organization_id, message, author_name, author_role, created_at
     from pilot.announcements
     where organization_id = $1
     order by created_at desc
     limit ${safeLimit}`,
    [organizationId],
  );
}

export async function createAnnouncement(params: {
  organizationId: string;
  message: string;
  authorName: string;
  authorRole: AnnouncementAuthorRole;
}): Promise<PilotAnnouncement> {
  const announcementId = randomUUID();
  await query(
    `insert into pilot.announcements
     (organization_id, announcement_id, message, author_name, author_role)
     values ($1,$2,$3,$4,$5)`,
    [params.organizationId, announcementId, params.message, params.authorName, params.authorRole],
  );

  const rows = await query<PilotAnnouncement>(
    `select announcement_id, organization_id, message, author_name, author_role, created_at
     from pilot.announcements
     where organization_id = $1 and announcement_id = $2`,
    [params.organizationId, announcementId],
  );

  if (!rows[0]) {
    throw new Error('Announcement write verification failed');
  }

  return rows[0];
}
