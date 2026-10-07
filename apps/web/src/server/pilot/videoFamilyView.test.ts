/**
 * The family projection of a video (videoFamilyView.ts): what an athlete or a
 * guardian receives, and above all what they do not -- the coach's account id
 * (OD-2026-10-06-025 ruling 2) and, on the list, the coach's notes, which
 * travel only with a playback the consent check has already allowed.
 */

import { getCoachDisplayName } from './achievements';
import { queryOne } from './db';
import {
  FAMILY_COACH_NAME_FLOOR,
  familyCoachName,
  isFamilyVideoCaller,
  toFamilyVideoListItem,
  toFamilyVideoPlayback,
} from './videoFamilyView';

jest.mock('./db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('./achievements', () => ({ getCoachDisplayName: jest.fn() }));

const mockQueryOne = jest.mocked(queryOne);
const mockCoachName = jest.mocked(getCoachDisplayName);

afterEach(() => {
  jest.resetAllMocks();
});

const row = (overrides: Record<string, unknown> = {}) => ({
  video_session_id: 'vid-1',
  organization_id: 'org-1',
  title: 'Sparring round 3',
  notes: '  Keep the guard up on the way out.  ',
  file_name: 'round3.mp4',
  file_size_bytes: 2_000_000,
  mime_type: 'video/mp4',
  status: 'ready',
  scan_state: 'clean',
  athlete_id: 'ath-1',
  blob_path: 'org-1/vid-1/round3.mp4',
  uploaded_by_account_id: 'coach-acct-1',
  created_at: '2026-07-30T00:00:00.000Z',
  updated_at: '2026-07-31T00:00:00.000Z',
  capture_take_id: null,
  ...overrides,
});

describe('who is a family caller', () => {
  test.each(['athlete', 'parent'] as const)('%s is', (role) => {
    expect(isFamilyVideoCaller(role)).toBe(true);
  });
  test.each(['coach', 'admin', 'organization_admin', 'platform_owner', 'volunteer', 'staff'] as const)(
    '%s is not',
    (role) => {
      expect(isFamilyVideoCaller(role)).toBe(false);
    },
  );
});

describe('the family list item', () => {
  test('carries metadata only: no notes, no account id, no organization, no blob path, no take', () => {
    const item = toFamilyVideoListItem(row());
    expect(item).toEqual({
      video_session_id: 'vid-1',
      title: 'Sparring round 3',
      file_name: 'round3.mp4',
      file_size_bytes: 2_000_000,
      mime_type: 'video/mp4',
      status: 'ready',
      scan_state: 'clean',
      athlete_id: 'ath-1',
      created_at: '2026-07-30T00:00:00.000Z',
    });
    // Named fields, never a spread: a column added to the row later does not
    // reach a family until someone names it here.
    expect(Object.keys(item)).not.toContain('notes');
    expect(Object.keys(item)).not.toContain('uploaded_by_account_id');
    expect(JSON.stringify(item)).not.toContain('coach-acct-1');
  });
});

describe('the family playback', () => {
  test('carries the coach note signed with the display name and dated, and no account id', async () => {
    mockQueryOne.mockResolvedValueOnce({ deleted_at: null });
    mockCoachName.mockResolvedValueOnce('Coach Jane');

    const playback = await toFamilyVideoPlayback('org-1', row(), 'https://blob.example/sas');

    expect(playback.stream_url).toBe('https://blob.example/sas');
    expect(playback.coach_notes).toEqual([
      { text: 'Keep the guard up on the way out.', coach_name: 'Coach Jane', noted_at: '2026-07-30T00:00:00.000Z' },
    ]);
    expect(mockCoachName).toHaveBeenCalledWith('org-1', 'coach-acct-1');
    expect(JSON.stringify(playback)).not.toContain('coach-acct-1');
    expect(JSON.stringify(playback)).not.toContain('blob_path');
    expect(Object.keys(playback)).not.toContain('notes');
  });

  test('an empty note is an empty list, and the coach is not looked up', async () => {
    const playback = await toFamilyVideoPlayback('org-1', row({ notes: '   ' }), 'https://blob.example/sas');
    expect(playback.coach_notes).toEqual([]);
    expect(mockQueryOne).not.toHaveBeenCalled();
    expect(mockCoachName).not.toHaveBeenCalled();
  });

  test('the note is dated from created_at, not updated_at, which moves on every status change', async () => {
    mockQueryOne.mockResolvedValueOnce({ deleted_at: null });
    mockCoachName.mockResolvedValueOnce('Coach Jane');
    const playback = await toFamilyVideoPlayback('org-1', row({ updated_at: '2026-09-01T00:00:00.000Z' }), 'u');
    expect(playback.coach_notes[0]!.noted_at).toBe('2026-07-30T00:00:00.000Z');
  });
});

describe("the coach's name for a family", () => {
  test('a deleted coach is not named: the floor phrase, and the name reader is never asked', async () => {
    mockQueryOne.mockResolvedValueOnce({ deleted_at: '2026-06-01T00:00:00.000Z' });
    await expect(familyCoachName('org-1', 'coach-acct-1')).resolves.toBe(FAMILY_COACH_NAME_FLOOR);
    expect(mockCoachName).not.toHaveBeenCalled();
  });

  test('an account that no longer exists is the floor phrase too', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    await expect(familyCoachName('org-1', 'coach-acct-1')).resolves.toBe(FAMILY_COACH_NAME_FLOOR);
    expect(mockCoachName).not.toHaveBeenCalled();
  });

  test('a live coach is named by the existing reader, scoped to the asking organization', async () => {
    mockQueryOne.mockResolvedValueOnce({ deleted_at: null });
    mockCoachName.mockResolvedValueOnce('Coach Jane');
    await expect(familyCoachName('org-1', 'coach-acct-1')).resolves.toBe('Coach Jane');
    expect(mockCoachName).toHaveBeenCalledWith('org-1', 'coach-acct-1');
  });
});
