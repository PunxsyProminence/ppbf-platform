import { queryOne } from './db';
import { assertVideoIsFilmStudyMedia, VideoDestinationError } from './videoDestination';

jest.mock('./db', () => ({ queryOne: jest.fn() }));

const mockQueryOne = queryOne as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

/*
 * THE BOUNDARY, FROM THE FILM STUDY SIDE.
 *
 * Its twin, assertVideoClippable, stops Film Study footage becoming
 * recognition evidence. This stops the reverse. Four paths accept a
 * video_session_id without ever seeing a list -- analysis, publication,
 * coach-reported observations, playback -- so filtering the list was
 * navigation, not an invariant. Each of those routes asserts that it CONSULTS
 * this; what the answer should be is decided here, once.
 */

test('film study footage passes', async () => {
  mockQueryOne.mockResolvedValueOnce({ capture_take_id: null });

  await expect(assertVideoIsFilmStudyMedia('org-1', 'vs-1')).resolves.toBeUndefined();
});

test('teaching footage is refused, and says why', async () => {
  // A take is what makes footage part of the recognition corpus, and the
  // owner's ruling is that it never crosses into Film Study.
  mockQueryOne.mockResolvedValueOnce({ capture_take_id: 'take-1' });

  await expect(assertVideoIsFilmStudyMedia('org-1', 'vs-1'))
    .rejects.toThrow(/recorded to teach Shadow/);
});

test('a video this organization cannot see is refused, not waved through', async () => {
  /*
   * FAILS CLOSED. "I could not tell" must never resolve to "allowed" on a
   * boundary ruled categorical -- and a caller who reached here with an id
   * this gym does not hold has a worse problem than the one being guarded.
   */
  mockQueryOne.mockResolvedValueOnce(null);

  await expect(assertVideoIsFilmStudyMedia('org-1', 'vs-missing'))
    .rejects.toBeInstanceOf(VideoDestinationError);
});

test('the refusal is a Forbidden, so it reaches the caller as 403 rather than 500', async () => {
  // jsonError maps by message PREFIX. A refusal that did not start 'Forbidden'
  // would surface as an internal error and tell the caller nothing.
  mockQueryOne.mockResolvedValueOnce({ capture_take_id: 'take-1' });

  await expect(assertVideoIsFilmStudyMedia('org-1', 'vs-1'))
    .rejects.toThrow(/^Forbidden:/);
});

test('it asks the database for exactly this organization and this video', async () => {
  // Org scoping is the reason a caller cannot probe another gym's ids.
  mockQueryOne.mockResolvedValueOnce({ capture_take_id: null });

  await assertVideoIsFilmStudyMedia('org-1', 'vs-1');

  const [sql, params] = mockQueryOne.mock.calls[0]!;
  expect(String(sql)).toContain('capture_take_id');
  expect(params).toEqual(['org-1', 'vs-1']);
});
