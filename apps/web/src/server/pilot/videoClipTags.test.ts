import { query, withTransaction } from './db';
import { ConflictError } from './errors';
import { assertConsentCoversVideo } from './videoPlaybackConsent';
import {
  addClipTag,
  assertVideoHasNoLiveClipTags,
  listLiveTagSubjects,
  listTaggedClips,
  untaggedVideoSql,
} from './videoClipTags';

jest.mock('./db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('./videoPlaybackConsent', () => ({ assertConsentCoversVideo: jest.fn() }));

const mockQuery = jest.mocked(query);
const mockTransaction = jest.mocked(withTransaction);
const mockConsent = jest.mocked(assertConsentCoversVideo);

afterEach(() => {
  mockQuery.mockReset();
  mockConsent.mockReset();
});

/*
 * BEFORE THE MIGRATION IS APPLIED nothing can have been tagged, so every read
 * that existing routes make must answer "no tags" -- and must not error, or
 * ordinary playback and the athlete/parent list would 500 in the window
 * between deploy and the operator applying video-clip-tags. The same
 * behaviour against a real schema is in videoClipTags.pg.test.ts.
 */
describe('before the video-clip-tags migration is applied', () => {
  test('the athlete/parent list predicate is empty, so the list query is unchanged', async () => {
    mockQuery.mockResolvedValueOnce([{ ready: false }]);
    await expect(untaggedVideoSql('pilot.video_sessions')).resolves.toBe('');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('the playback gate reads no tags from a missing table', async () => {
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    await expect(listLiveTagSubjects('org-1', 'vid-1')).resolves.toEqual([]);
  });

  test('any other database fault still surfaces -- it is not read as "no tags"', async () => {
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: '08006' }));
    await expect(listLiveTagSubjects('org-1', 'vid-1')).rejects.toThrow('connection reset');
  });

  test('the publish check does not query the missing table', async () => {
    mockQuery.mockResolvedValueOnce([{ ready: false }]);
    await expect(assertVideoHasNoLiveClipTags('org-1', 'vid-1')).resolves.toBeUndefined();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe('after the migration is applied', () => {
  test('the list predicate excludes videos with a live tag', async () => {
    mockQuery.mockResolvedValueOnce([{ ready: true }]);
    const predicate = await untaggedVideoSql('pilot.video_sessions');
    expect(predicate).toMatch(/not exists/);
    expect(predicate).toMatch(/clip_tag\.removed_at is null/);
    expect(predicate).toMatch(/clip_tag\.video_session_id = pilot\.video_sessions\.video_session_id/);
  });

  test('a tagged video cannot be published', async () => {
    mockQuery.mockResolvedValueOnce([{ ready: true }]).mockResolvedValueOnce([{ tag_id: 'vct-1' }]);
    await expect(assertVideoHasNoLiveClipTags('org-1', 'vid-1')).rejects.toMatchObject({
      code: 'TAGGED_CLIP_NOT_PUBLISHABLE',
    });
  });

  test('the alias is checked before it reaches SQL', async () => {
    await expect(untaggedVideoSql('v; drop table x')).rejects.toThrow('bad alias');
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

/*
 * addClipTag's checks under the video lock, driven through a scripted
 * transaction client. The same rules against a real schema are in
 * videoClipTags.pg.test.ts.
 */
describe('addClipTag under the video lock', () => {
  type Row = Record<string, unknown>;
  function scripted(responses: { match: string; rows: Row[] }[]) {
    const statements: string[] = [];
    const client = {
      query: jest.fn(async (text: string) => {
        statements.push(text);
        const hit = responses.find((r) => text.includes(r.match));
        return { rows: hit ? hit.rows : [] };
      }),
    };
    mockTransaction.mockImplementationOnce(async (fn) => fn(client as never));
    return statements;
  }
  const input = {
    organizationId: 'org-1',
    videoSessionId: 'vid-1',
    athleteId: 'ath-2',
    eventKind: 'competition' as const,
    competitionId: 'comp-1',
    note: '',
    taggedByAccountId: 'coach-1',
  };
  const video = { match: 'for update', rows: [{ capture_take_id: null, status: 'ready' }] };

  test('a clip already tagged to another event refuses a different one', async () => {
    const statements = scripted([
      video,
      { match: 'select event_kind, competition_id', rows: [{ event_kind: 'sparring', competition_id: null }] },
    ]);
    await expect(addClipTag(input)).rejects.toMatchObject({ code: 'CLIP_TAG_EVENT_MISMATCH' });
    expect(statements.some((sql) => sql.includes('insert into pilot.video_clip_tags'))).toBe(false);
  });

  test('a clip tagged to another competition refuses this one', async () => {
    scripted([
      video,
      { match: 'select event_kind, competition_id', rows: [{ event_kind: 'competition', competition_id: 'comp-2' }] },
    ]);
    await expect(addClipTag(input)).rejects.toMatchObject({ code: 'CLIP_TAG_EVENT_MISMATCH' });
  });

  test('a withdrawn entry does not admit a competition tag', async () => {
    const statements = scripted([
      video,
      { match: 'from pilot.external_competition_entries', rows: [{ status: 'withdrawn' }] },
    ]);
    await expect(addClipTag(input)).rejects.toMatchObject({ code: 'CLIP_TAG_NOT_ENTERED' });
    expect(statements.some((sql) => sql.includes('insert into pilot.video_clip_tags'))).toBe(false);
  });

  test('an entered athlete on a clip of the same event is tagged', async () => {
    const statements = scripted([
      video,
      { match: 'select event_kind, competition_id', rows: [{ event_kind: 'competition', competition_id: 'comp-1' }] },
      { match: 'from pilot.external_competition_entries', rows: [{ status: 'entered' }] },
      { match: 'insert into pilot.video_clip_tags', rows: [{ tag_id: 'vct-2' }] },
    ]);
    await expect(addClipTag(input)).resolves.toMatchObject({ tag_id: 'vct-2' });
    expect(statements.some((sql) => sql.includes('insert into pilot.video_clip_tags'))).toBe(true);
  });
});

/*
 * Owner, Jason 2026-10-04: "A) Hide". A clip whose playback a consent block
 * stops is left out of staff clip lists too.
 */
describe('listTaggedClips hides clips that playback would refuse', () => {
  const clip = (video: string, athlete: string) => ({
    tag_id: `tag-${video}-${athlete}`, video_session_id: video, athlete_id: athlete, event_kind: 'sparring',
    competition_id: null, note: `note ${video}`, tagged_by_account_id: 'coach-1', created_at: '',
    title: `title ${video}`, status: 'ready', recorded_at: '',
  });

  test("a clip is hidden when ANY athlete in it -- even one outside the caller's scope -- is blocked", async () => {
    // The coach's scope returns only ath-1's rows; vid-1 also shows ath-2.
    mockQuery
      .mockResolvedValueOnce([clip('vid-1', 'ath-1'), clip('vid-2', 'ath-1')])
      .mockResolvedValueOnce([
        { video_session_id: 'vid-1', athlete_id: 'ath-1' },
        { video_session_id: 'vid-1', athlete_id: 'ath-2' },
        { video_session_id: 'vid-2', athlete_id: 'ath-1' },
      ]);
    mockConsent.mockImplementation(async (_org, athleteId) => {
      if (athleteId === 'ath-2') throw new ConflictError('Blocked', 'GUARDIAN_CONSENT_WITHDRAWN');
    });

    const rows = await listTaggedClips({ organizationId: 'org-1', athleteIds: ['ath-1'], limit: 50 });

    expect(rows.map((row) => row.video_session_id)).toEqual(['vid-2']);
    expect(mockConsent).toHaveBeenCalledWith('org-1', 'ath-2');
    // Every subject is read from the clip itself, not from the caller's scope.
    expect(mockQuery.mock.calls[1][0]).toMatch(/from pilot\.video_clip_tags t/);
    expect(mockQuery.mock.calls[1][0]).toMatch(/from pilot\.video_sessions v/);
    expect(mockQuery.mock.calls[1][1]).toEqual(['org-1', ['vid-1', 'vid-2']]);
    // Every live tag on those videos, with no narrowing by the caller's athletes.
    const subjectSql = String(mockQuery.mock.calls[1][0]).replace(/\s+/g, ' ');
    expect(subjectSql).toContain('where t.organization_id = $1 and t.video_session_id = any($2::text[]) and t.removed_at is null union');
    expect(subjectSql).not.toMatch(/athlete_id = any/);
  });

  test.each(['GUARDIAN_CONSENT_EXCLUDES_VIDEO', 'GUARDIAN_CONSENT_UNREADABLE'])(
    'a %s block hides the clip too',
    async (code) => {
      mockQuery
        .mockResolvedValueOnce([clip('vid-1', 'ath-1')])
        .mockResolvedValueOnce([{ video_session_id: 'vid-1', athlete_id: 'ath-1' }]);
      mockConsent.mockRejectedValueOnce(new ConflictError('Blocked', code));
      expect(await listTaggedClips({ organizationId: 'org-1', athleteIds: null, limit: 50 })).toEqual([]);
    },
  );

  test('a consent read that fails for another reason fails the list rather than showing the clip', async () => {
    mockQuery
      .mockResolvedValueOnce([clip('vid-1', 'ath-1')])
      .mockResolvedValueOnce([{ video_session_id: 'vid-1', athlete_id: 'ath-1' }]);
    mockConsent.mockRejectedValueOnce(new Error('connection reset'));
    await expect(listTaggedClips({ organizationId: 'org-1', athleteIds: null, limit: 50 })).rejects.toThrow('connection reset');
  });

  test('clips with clear consent are all listed, each athlete checked once', async () => {
    mockQuery
      .mockResolvedValueOnce([clip('vid-1', 'ath-1'), clip('vid-1', 'ath-2'), clip('vid-2', 'ath-1')])
      .mockResolvedValueOnce([
        { video_session_id: 'vid-1', athlete_id: 'ath-1' },
        { video_session_id: 'vid-1', athlete_id: 'ath-2' },
        { video_session_id: 'vid-2', athlete_id: 'ath-1' },
      ]);
    mockConsent.mockResolvedValue(undefined);
    const rows = await listTaggedClips({ organizationId: 'org-1', athleteIds: null, limit: 50 });
    expect(rows).toHaveLength(3);
    expect(mockConsent).toHaveBeenCalledTimes(2);
  });

  test('an empty list reads no consent', async () => {
    mockQuery.mockResolvedValueOnce([]);
    expect(await listTaggedClips({ organizationId: 'org-1', athleteIds: null, limit: 50 })).toEqual([]);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockConsent).not.toHaveBeenCalled();
  });

  test('the list query leaves out clips with a deleted athlete in them', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await listTaggedClips({ organizationId: 'org-1', athleteIds: null, limit: 50 });
    expect(mockQuery.mock.calls[0][0]).toMatch(/other_athlete\.deleted_at is not null/);
  });
});

