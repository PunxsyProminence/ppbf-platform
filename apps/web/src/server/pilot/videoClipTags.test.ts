import { query } from './db';
import { assertVideoHasNoLiveClipTags, listLiveTagSubjects, untaggedVideoSql } from './videoClipTags';

jest.mock('./db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));

const mockQuery = jest.mocked(query);

afterEach(() => {
  mockQuery.mockReset();
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
