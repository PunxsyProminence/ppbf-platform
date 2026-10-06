jest.mock('./db', () => ({ queryOne: jest.fn() }));
jest.mock('./videoClipTags', () => ({ listLiveTagSubjects: jest.fn() }));

import { queryOne } from './db';
import { listLiveTagSubjects } from './videoClipTags';
import { assertVideoConcernsAthlete, VideoNotOfAthleteError } from './videoAthleteScope';

const mockQueryOne = jest.mocked(queryOne);
const mockSubjects = jest.mocked(listLiveTagSubjects);

beforeEach(() => {
  jest.clearAllMocks();
  mockSubjects.mockResolvedValue([]);
});

describe('assertVideoConcernsAthlete', () => {
  test('the video is read in the caller\'s organization only', async () => {
    mockQueryOne.mockResolvedValue({ athlete_id: 'ATH-1' });
    await assertVideoConcernsAthlete('org-1', 'vs-1', 'ATH-1');
    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toMatch(/organization_id = \$1 and video_session_id = \$2/);
    expect(params).toEqual(['org-1', 'vs-1']);
  });

  test("the athlete's own video passes without consulting tags", async () => {
    mockQueryOne.mockResolvedValue({ athlete_id: 'ATH-1' });
    await expect(assertVideoConcernsAthlete('org-1', 'vs-1', 'ATH-1')).resolves.toBeUndefined();
    expect(mockSubjects).not.toHaveBeenCalled();
  });

  test('another athlete\'s video passes when this athlete is a live tag subject in it', async () => {
    mockQueryOne.mockResolvedValue({ athlete_id: 'ATH-2' });
    mockSubjects.mockResolvedValue([
      { athlete_id: 'ATH-2', athlete_deleted: false },
      { athlete_id: 'ATH-1', athlete_deleted: false },
    ] as never);
    await expect(assertVideoConcernsAthlete('org-1', 'vs-1', 'ATH-1')).resolves.toBeUndefined();
    expect(mockSubjects).toHaveBeenCalledWith('org-1', 'vs-1');
  });

  test("another athlete's video that does not tag this athlete is refused", async () => {
    mockQueryOne.mockResolvedValue({ athlete_id: 'ATH-2' });
    mockSubjects.mockResolvedValue([{ athlete_id: 'ATH-2', athlete_deleted: false }] as never);
    await expect(assertVideoConcernsAthlete('org-1', 'vs-1', 'ATH-1')).rejects.toBeInstanceOf(VideoNotOfAthleteError);
  });

  test('a tag on a deleted athlete does not count', async () => {
    mockQueryOne.mockResolvedValue({ athlete_id: null });
    mockSubjects.mockResolvedValue([{ athlete_id: 'ATH-1', athlete_deleted: true }] as never);
    await expect(assertVideoConcernsAthlete('org-1', 'vs-1', 'ATH-1')).rejects.toBeInstanceOf(VideoNotOfAthleteError);
  });

  test('an untagged group video with no athlete is refused until tagged', async () => {
    mockQueryOne.mockResolvedValue({ athlete_id: null });
    await expect(assertVideoConcernsAthlete('org-1', 'vs-1', 'ATH-1')).rejects.toBeInstanceOf(VideoNotOfAthleteError);
  });

  test('a tagged group video with no athlete passes for a tagged athlete', async () => {
    mockQueryOne.mockResolvedValue({ athlete_id: null });
    mockSubjects.mockResolvedValue([{ athlete_id: 'ATH-1', athlete_deleted: false }] as never);
    await expect(assertVideoConcernsAthlete('org-1', 'vs-1', 'ATH-1')).resolves.toBeUndefined();
  });

  test('a missing video is refused the same way, and is a 400', async () => {
    mockQueryOne.mockResolvedValue(null);
    const refusal = await assertVideoConcernsAthlete('org-1', 'vs-x', 'ATH-1').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(VideoNotOfAthleteError);
    expect(refusal).toMatchObject({ status: 400, code: 'VIDEO_NOT_OF_ATHLETE' });
    expect(mockSubjects).not.toHaveBeenCalled();
  });
});
