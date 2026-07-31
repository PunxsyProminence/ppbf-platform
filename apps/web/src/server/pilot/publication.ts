import { randomUUID } from 'node:crypto';
import { query } from './db';

export interface VideoPublication {
  publication_id: string;
  video_session_id: string;
  athlete_id: string;
  publication_type: 'research_library' | 'public_coaching' | 'private_archive';
  title: string;
  description: string;
  tags: string[];
  compliance_check_status: 'pending' | 'passed' | 'failed' | 'manual_review';
  metadata_complete: boolean;
  visibility: 'private' | 'organization' | 'public' | 'research';
  status: 'draft' | 'pending_review' | 'approved' | 'published' | 'rejected' | 'archived';
  created_at: string;
}

export interface PublicationCheck {
  check_id: string;
  publication_id: string;
  check_type: string;
  check_status: 'passed' | 'failed' | 'warning' | 'manual_review';
  details: string;
}

export async function createPublication(params: {
  organizationId: string;
  videoSessionId: string;
  athleteId: string;
  submittedByAccountId: string;
  publicationType: string;
  title: string;
  description: string;
  tags?: string[];
}): Promise<VideoPublication> {
  const publicationId = `pub_${Date.now()}_${randomUUID().split('-')[0]}`;

  const result = await query<VideoPublication>(
    `insert into pilot.video_publications (
      publication_id, organization_id, video_session_id, athlete_id, submitted_by_account_id,
      publication_type, title, description, tags, status, compliance_check_status, metadata_complete
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', 'pending', false)
    returning publication_id, video_session_id, athlete_id, publication_type, title, description, tags,
             compliance_check_status, metadata_complete, visibility, status, created_at`,
    [
      publicationId,
      params.organizationId,
      params.videoSessionId,
      params.athleteId,
      params.submittedByAccountId,
      params.publicationType,
      params.title,
      params.description,
      // tags is text[]; node-pg serializes a JS array into a Postgres array
      // literal. JSON.stringify produced '[...]', which array_in rejects.
      params.tags || [],
    ],
  );

  return result[0];
}

export async function updatePublicationStatus(
  publicationId: string,
  status: string,
  complianceStatus?: string,
): Promise<void> {
  const now = new Date().toISOString();

  await query(
    `update pilot.video_publications
     set status = $2,
         updated_at = $3,
         compliance_check_status = coalesce($4, compliance_check_status),
         published_at = case when $2 = 'published' then $3::timestamptz else published_at end
     where publication_id = $1`,
    [publicationId, status, now, complianceStatus ?? null],
  );
}

export async function recordComplianceCheck(params: {
  organizationId: string;
  publicationId: string;
  checkType: string;
  checkStatus: string;
  details: string;
  checkedByAccountId?: string;
}): Promise<PublicationCheck> {
  const checkId = `check_${Date.now()}_${randomUUID().split('-')[0]}`;
  const now = new Date().toISOString();

  const result = await query<PublicationCheck>(
    `insert into pilot.publication_checks (
      check_id, organization_id, publication_id, check_type, check_status, details, checked_by_account_id, checked_at
    ) values ($1, $2, $3, $4, $5, $6, $7, $8)
    returning check_id, publication_id, check_type, check_status, details`,
    [
      checkId,
      params.organizationId,
      params.publicationId,
      params.checkType,
      params.checkStatus,
      params.details,
      params.checkedByAccountId || null,
      params.checkedByAccountId ? now : null,
    ],
  );

  return result[0];
}

export async function publishToResearchLibrary(params: {
  organizationId: string;
  publicationId: string;
  videoSessionId: string;
  title: string;
  description: string;
  tags?: string[];
}): Promise<string> {
  const libraryId = `lib_${Date.now()}_${crypto.randomUUID().split('-')[0]}`;

  await query(
    `insert into pilot.research_library (
      library_id, organization_id, publication_id, video_session_id, title, description, tags
    ) values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      libraryId,
      params.organizationId,
      params.publicationId,
      params.videoSessionId,
      params.title,
      params.description,
      params.tags || [],
    ],
  );

  // Update publication status to published
  await updatePublicationStatus(params.publicationId, 'published');

  return libraryId;
}

export async function getResearchLibrary(
  organizationId: string,
  filters?: {
    tags?: string[];
    limit?: number;
    offset?: number;
  },
): Promise<Array<{ library_id: string; publication_id?: string; video_session_id?: string; title: string; tags: string[] }>> {
  let sql = `
    select library_id, publication_id, video_session_id, title, description, tags, view_count, published_at
    from pilot.research_library
    where organization_id = $1 and archived_at is null
  `;
  const params: unknown[] = [organizationId];

  if (filters?.tags && filters.tags.length > 0) {
    sql += ` and tags && $${params.length + 1}`;
    params.push(filters.tags);
  }

  sql += ` order by published_at desc limit $${params.length + 1} offset $${params.length + 2}`;
  params.push(
    filters?.limit || 20,
    filters?.offset || 0,
  );

  return query(sql, params);
}

export async function getOrganizationPublications(
  organizationId: string,
  filters?: {
    status?: string;
    publicationType?: string;
    limit?: number;
  },
): Promise<VideoPublication[]> {
  let sql = `
    select publication_id, video_session_id, athlete_id, publication_type, title, description, tags,
           compliance_check_status, metadata_complete, visibility, status, created_at
    from pilot.video_publications
    where organization_id = $1
  `;
  const params: unknown[] = [organizationId];

  if (filters?.status) {
    sql += ` and status = $${params.length + 1}`;
    params.push(filters.status);
  }

  if (filters?.publicationType) {
    sql += ` and publication_type = $${params.length + 1}`;
    params.push(filters.publicationType);
  }

  sql += ` order by created_at desc limit $${params.length + 1}`;
  params.push(filters?.limit || 50);

  return query<VideoPublication>(sql, params);
}

export async function trackLibraryView(libraryId: string): Promise<void> {
  const now = new Date().toISOString();

  await query(
    `update pilot.research_library set view_count = view_count + 1, last_accessed_at = $1 where library_id = $2`,
    [now, libraryId],
  );
}
