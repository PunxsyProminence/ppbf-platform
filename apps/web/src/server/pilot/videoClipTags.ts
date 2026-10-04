import { randomUUID } from 'node:crypto';

import { query, withTransaction } from './db';
import { athleteNotDeletedSql } from './deletedAthletes';
import { ConflictError, ValidationError } from './errors';

/*
 * VIDEO CLIP TAGS: a sparring or bout video tagged to the athletes in it and
 * the event it records (pilot.video_clip_tags, owned by
 * infra/azure/pilot_slice_postgres_video_clip_tags_migration.sql).
 *
 * Owner decisions, Jason 2026-10-03:
 *   1. Tagged clips are STAFF ONLY (coach, organization admin).
 *   2. ANY tagged athlete's consent block blocks the whole clip, for everyone.
 *   3. A coach may review a clip when ANY tagged athlete is theirs.
 *
 * Human film study only: nothing here scores footage.
 *
 * A video names one athlete in video_sessions.athlete_id. A sparring clip
 * shows two or more, so every gate that used to read that one column has to
 * read the tags as well -- otherwise tagging a second child would let the
 * clip play, or be published, past that child's guardian's refusal.
 */

export type ClipEventKind = 'sparring' | 'competition';

export interface ClipTagRow {
  tag_id: string;
  video_session_id: string;
  athlete_id: string;
  event_kind: ClipEventKind;
  competition_id: string | null;
  note: string;
  tagged_by_account_id: string;
  created_at: string;
}

const TAG_COLUMNS = `tag_id, video_session_id, athlete_id, event_kind, competition_id, note,
  tagged_by_account_id, created_at`;

interface QueryExecutor {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/*
 * NO TABLE MEANS NO TAGS. Before the migration is applied nothing can have
 * been tagged, so an empty answer is the true one -- not a fail-open. Every
 * existing video route reads this, and a missing relation must not turn into
 * a 500 on ordinary playback in the window before the operator applies it.
 */
function isMissingRelation(error: unknown): boolean {
  return (error as { code?: unknown })?.code === '42P01';
}

/*
 * SQL predicate that drops tagged clips from a video list read by an athlete
 * or a parent (decision 1: staff only). Empty before the migration is
 * applied, when nothing can be tagged.
 */
export async function untaggedVideoSql(videoAlias: string): Promise<string> {
  if (!/^[a-z_.]+$/.test(videoAlias)) throw new Error('untaggedVideoSql: bad alias');
  const [table] = await query<{ ready: boolean }>(
    `select to_regclass('pilot.video_clip_tags') is not null as ready`,
  );
  if (!table?.ready) return '';
  return `and not exists (
    select 1 from pilot.video_clip_tags clip_tag
     where clip_tag.organization_id = ${videoAlias}.organization_id
       and clip_tag.video_session_id = ${videoAlias}.video_session_id
       and clip_tag.removed_at is null)`;
}

export interface LiveTagSubject {
  athlete_id: string;
  athlete_deleted: boolean;
}

/** Every athlete a live tag names on this video, deleted athletes included. */
export async function listLiveTagSubjects(
  organizationId: string,
  videoSessionId: string,
): Promise<LiveTagSubject[]> {
  try {
    return await query<LiveTagSubject>(
      `select t.athlete_id, (a.deleted_at is not null) as athlete_deleted
         from pilot.video_clip_tags t
         join pilot.athletes a
           on a.organization_id = t.organization_id and a.athlete_id = t.athlete_id
        where t.organization_id = $1 and t.video_session_id = $2 and t.removed_at is null`,
      [organizationId, videoSessionId],
    );
  } catch (error) {
    if (isMissingRelation(error)) return [];
    throw error;
  }
}

export class TaggedClipNotPublishableError extends ConflictError {
  constructor() {
    super(
      'This video is tagged as a sparring or bout clip. Tagged clips are for staff film study only and cannot be published.',
      'TAGGED_CLIP_NOT_PUBLISHABLE',
    );
  }
}

/*
 * Decision 1 keeps tagged clips off the publication path. A publication names
 * one athlete and its consent gate checks that one; a clip showing two would
 * pass on the first child's consent alone. Pass a transaction client to run
 * the check inside the publish claim, so a tag added after the draft was made
 * is still caught.
 */
export async function assertVideoHasNoLiveClipTags(
  organizationId: string,
  videoSessionId: string,
  executor?: QueryExecutor,
): Promise<void> {
  const run = async <T>(sql: string, params: unknown[]): Promise<T[]> =>
    executor ? (await executor.query<T>(sql, params)).rows : query<T>(sql, params);

  // Checked by name rather than by catching 42P01: inside the publish
  // transaction a failed statement would abort the whole claim.
  const [table] = await run<{ ready: boolean }>(
    `select to_regclass('pilot.video_clip_tags') is not null as ready`,
    [],
  );
  if (!table?.ready) return;

  const tags = await run<{ tag_id: string }>(
    `select tag_id from pilot.video_clip_tags
      where organization_id = $1 and video_session_id = $2 and removed_at is null
      limit 1`,
    [organizationId, videoSessionId],
  );
  if (tags.length > 0) throw new TaggedClipNotPublishableError();
}

/**
 * Publication states that are on their way to the shelf, on it, or can be
 * put back on the review queue (an admin may reopen a retracted one, and the
 * compliance console plays the video of anything it reviews).
 */
const LIVE_PUBLICATION_STATUSES = ['draft', 'pending_review', 'approved', 'published', 'retracted'];

export async function addClipTag(input: {
  organizationId: string;
  videoSessionId: string;
  athleteId: string;
  eventKind: ClipEventKind;
  competitionId: string | null;
  note: string;
  taggedByAccountId: string;
}): Promise<ClipTagRow> {
  if (input.eventKind === 'competition' && !input.competitionId) {
    throw new ValidationError('A competition clip must name the competition.', 'CLIP_TAG_EVENT_REQUIRED');
  }
  if (input.eventKind === 'sparring' && input.competitionId) {
    throw new ValidationError('A sparring clip cannot also name a competition.', 'CLIP_TAG_EVENT_MIXED');
  }
  if (input.note.length > 500) {
    throw new ValidationError('The tag note is limited to 500 characters.', 'CLIP_TAG_NOTE_TOO_LONG');
  }

  return withTransaction(async (client) => {
    // Locks the video row so two taggings serialize. It does NOT stop a draft
    // publication being created concurrently (that route takes no lock); the
    // publish claim re-checks tags inside its own transaction, and the
    // compliance console mints no playback link for a tagged video, so a
    // draft that slips in can be neither published nor played there.
    // A deleted athlete's video reads as not found, as everywhere else.
    const video = await client.query<{ capture_take_id: string | null; status: string }>(
      `select capture_take_id, status from pilot.video_sessions
        where organization_id = $1 and video_session_id = $2
          and ${athleteNotDeletedSql('pilot.video_sessions')}
        for update`,
      [input.organizationId, input.videoSessionId],
    );
    const row = video.rows[0];
    if (!row || row.capture_take_id !== null || row.status === 'archived' || row.status === 'infected') {
      // Teach Shadow footage is anonymous and must never name an athlete.
      throw new ValidationError('That video cannot be tagged.', 'CLIP_TAG_VIDEO_NOT_TAGGABLE');
    }

    const publication = await client.query<{ publication_id: string }>(
      `select publication_id from pilot.video_publications
        where organization_id = $1 and video_session_id = $2 and status = any($3::text[])
        limit 1`,
      [input.organizationId, input.videoSessionId, LIVE_PUBLICATION_STATUSES],
    );
    if (publication.rows.length > 0) {
      throw new ConflictError(
        'This video has a publication in progress or on the shelf. Retract or reject it before tagging the video as a clip.',
        'CLIP_TAG_VIDEO_PUBLISHED',
      );
    }

    try {
      const inserted = await client.query<ClipTagRow>(
        `insert into pilot.video_clip_tags
           (organization_id, tag_id, video_session_id, athlete_id, event_kind,
            competition_id, note, tagged_by_account_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning ${TAG_COLUMNS}`,
        [
          input.organizationId,
          `vct_${randomUUID()}`,
          input.videoSessionId,
          input.athleteId,
          input.eventKind,
          input.competitionId,
          input.note,
          input.taggedByAccountId,
        ],
      );
      return inserted.rows[0];
    } catch (error) {
      const { code, constraint } = error as { code?: string; constraint?: string };
      if (code === '23505') {
        throw new ConflictError('That athlete is already tagged on this video.', 'CLIP_TAG_DUPLICATE');
      }
      if (code === '23503' && constraint === 'pilot_video_clip_tags_entry_fk') {
        throw new ValidationError('That athlete is not entered in that competition.', 'CLIP_TAG_NOT_ENTERED');
      }
      throw error;
    }
  });
}

/** Soft removal: the row stays as the record of who tagged and who removed. */
export async function removeClipTag(input: {
  organizationId: string;
  tagId: string;
  removedByAccountId: string;
}): Promise<ClipTagRow | null> {
  const rows = await query<ClipTagRow>(
    `update pilot.video_clip_tags
        set removed_at = now(), removed_by_account_id = $3
      where organization_id = $1 and tag_id = $2 and removed_at is null
      returning ${TAG_COLUMNS}`,
    [input.organizationId, input.tagId, input.removedByAccountId],
  );
  return rows[0] ?? null;
}

export async function getLiveClipTag(organizationId: string, tagId: string): Promise<ClipTagRow | null> {
  const rows = await query<ClipTagRow>(
    `select ${TAG_COLUMNS} from pilot.video_clip_tags
      where organization_id = $1 and tag_id = $2 and removed_at is null`,
    [organizationId, tagId],
  );
  return rows[0] ?? null;
}

export async function listLiveClipTagsForVideo(
  organizationId: string,
  videoSessionId: string,
): Promise<ClipTagRow[]> {
  return query<ClipTagRow>(
    `select ${TAG_COLUMNS} from pilot.video_clip_tags
      where organization_id = $1 and video_session_id = $2 and removed_at is null
      order by created_at`,
    [organizationId, videoSessionId],
  );
}

export interface TaggedClipRow extends ClipTagRow {
  title: string;
  status: string;
  recorded_at: string;
}

/**
 * Tagged clips for review, newest first. athleteIds is the caller's access
 * scope (null = every athlete, for an organization admin); the route builds
 * it. Teach Shadow footage and deleted athletes never appear.
 */
export async function listTaggedClips(input: {
  organizationId: string;
  athleteIds: readonly string[] | null;
  athleteId?: string;
  competitionId?: string;
  limit: number;
}): Promise<TaggedClipRow[]> {
  const params: unknown[] = [input.organizationId, input.limit];
  let filters = '';
  if (input.athleteIds !== null) {
    params.push(input.athleteIds);
    filters += ` and t.athlete_id = any($${params.length}::text[])`;
  }
  if (input.athleteId) {
    params.push(input.athleteId);
    filters += ` and t.athlete_id = $${params.length}`;
  }
  if (input.competitionId) {
    params.push(input.competitionId);
    filters += ` and t.competition_id = $${params.length}`;
  }
  return query<TaggedClipRow>(
    `select t.tag_id, t.video_session_id, t.athlete_id, t.event_kind, t.competition_id, t.note, t.tagged_by_account_id, t.created_at,
            v.title, v.status, v.created_at as recorded_at
       from pilot.video_clip_tags t
       join pilot.video_sessions v
         on v.organization_id = t.organization_id and v.video_session_id = t.video_session_id
       join pilot.athletes a
         on a.organization_id = t.organization_id and a.athlete_id = t.athlete_id
      where t.organization_id = $1 and t.removed_at is null
        and v.capture_take_id is null and a.deleted_at is null
        and ${athleteNotDeletedSql('v')}
        ${filters}
      order by v.created_at desc, t.created_at
      limit $2`,
    params,
  );
}
