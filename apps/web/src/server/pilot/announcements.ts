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

let ensured = false;

async function ensureAnnouncementTable(): Promise<void> {
  if (ensured) {
    return;
  }

  await query(
    `create table if not exists pilot.announcements (
      organization_id text not null references pilot.organizations(organization_id),
      announcement_id uuid not null,
      message text not null,
      author_name text not null,
      author_role text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint pilot_announcements_pk primary key (organization_id, announcement_id)
    )`,
  );

  await query(
    `create index if not exists idx_pilot_announcements_org_created on pilot.announcements(organization_id, created_at desc)`,
  );

  ensured = true;
}

export function isAllowedAnnouncementRole(role: string): role is AnnouncementAuthorRole {
  return ALLOWED_AUTHOR_ROLES.includes(role as AnnouncementAuthorRole);
}

export async function listAnnouncements(organizationId: string, limit = 8): Promise<PilotAnnouncement[]> {
  await ensureAnnouncementTable();

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
  await ensureAnnouncementTable();

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
