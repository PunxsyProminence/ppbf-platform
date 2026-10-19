// assertFilmStudyConsent: WHO is asked. The lock and the race are proven
// against Postgres in filmStudyConsentRace.pg.test.ts; this suite pins the
// subject set, which that suite does not vary.
//
// Review finding on the coach-reported consent change: a coach-reported
// observation names the athlete it is ABOUT, who may be only a tag subject
// on a clip filed under another child. Asked for the named athlete and the
// tags alone, the child the clip is filed under was never asked.

import { assertFilmStudyConsent, filmStudyConsentFailureCode, FilmStudyTaggedAthleteDeletedError } from './filmStudyConsent';
import { queryOne } from './db';
import { ConflictError } from './errors';
import {
  assertGuardianMediaConsent,
  lockGuardianLinksForAthletes,
  readAdultOwnMediaConsent,
  type OwnMediaConsent,
  type QueryExecutor,
} from './guardianConsent';
import { listLiveTagSubjects } from './videoClipTags';
import { assertConsentCoversVideo } from './videoPlaybackConsent';

jest.mock('./db', () => ({ queryOne: jest.fn(), withTransaction: jest.fn() }));
jest.mock('./guardianConsent', () => ({
  ...jest.requireActual('./guardianConsent'),
  assertGuardianMediaConsent: jest.fn(),
  lockGuardianLinksForAthletes: jest.fn(),
  readAdultOwnMediaConsent: jest.fn(),
}));
jest.mock('./videoClipTags', () => ({ listLiveTagSubjects: jest.fn() }));
jest.mock('./videoPlaybackConsent', () => ({ assertConsentCoversVideo: jest.fn() }));

const mockQueryOne = jest.mocked(queryOne);
const mockSigned = jest.mocked(assertGuardianMediaConsent);
const mockLock = jest.mocked(lockGuardianLinksForAthletes);
const mockTags = jest.mocked(listLiveTagSubjects);
const mockCovers = jest.mocked(assertConsentCoversVideo);
const mockAdultOwn = jest.mocked(readAdultOwnMediaConsent);

const askedAthletes = () => mockCovers.mock.calls.map(([, id]) => id);

beforeEach(() => {
  jest.clearAllMocks();
  mockCovers.mockReset();
  mockQueryOne.mockResolvedValue({ athlete_id: 'OWNER' } as never);
  mockTags.mockResolvedValue([]);
  mockLock.mockResolvedValue([]);
  mockAdultOwn.mockResolvedValue(null);
});

test("the athlete the video is filed under is asked even when the caller names a tag subject", async () => {
  mockTags.mockResolvedValue([{ athlete_id: 'TAGGED', athlete_deleted: false }]);

  await assertFilmStudyConsent('org-1', 'vs-1', 'TAGGED');

  expect(mockQueryOne).toHaveBeenCalledWith(expect.stringContaining('from pilot.video_sessions'), ['org-1', 'vs-1']);
  expect(askedAthletes()).toEqual(['TAGGED', 'OWNER']);
  expect(mockSigned.mock.calls.map(([, id]) => id)).toEqual(['TAGGED', 'OWNER']);
});

test('the named athlete, the owner and every live tag subject are asked once each', async () => {
  mockTags.mockResolvedValue([
    { athlete_id: 'OWNER', athlete_deleted: false },
    { athlete_id: 'TAG-2', athlete_deleted: false },
  ]);

  await assertFilmStudyConsent('org-1', 'vs-1', 'OWNER');

  expect(askedAthletes()).toEqual(['OWNER', 'TAG-2']);
});

test('an unattributed clip adds nobody for the row', async () => {
  mockQueryOne.mockResolvedValue({ athlete_id: null } as never);

  await assertFilmStudyConsent('org-1', 'vs-1', 'NAMED');

  expect(askedAthletes()).toEqual(['NAMED']);
});

test("the owner's refusal stops the check, whichever athlete was named", async () => {
  mockTags.mockResolvedValue([{ athlete_id: 'TAGGED', athlete_deleted: false }]);
  mockCovers.mockImplementation(async (_org, id) => {
    if (id === 'OWNER') throw new Error('GUARDIAN_CONSENT_WITHDRAWN');
  });

  await expect(assertFilmStudyConsent('org-1', 'vs-1', 'TAGGED')).rejects.toThrow('GUARDIAN_CONSENT_WITHDRAWN');
});

test('inside a transaction the row is read on the client and every subject is locked in one pass', async () => {
  const client = { query: jest.fn(async () => ({ rows: [{ athlete_id: 'OWNER' }] })) } as unknown as QueryExecutor & { query: jest.Mock };
  mockTags.mockResolvedValue([{ athlete_id: 'TAG-2', athlete_deleted: false }]);

  await assertFilmStudyConsent('org-1', 'vs-1', 'NAMED', client);

  expect(mockQueryOne).not.toHaveBeenCalled();
  expect(client.query).toHaveBeenCalledWith(expect.stringContaining('from pilot.video_sessions'), ['org-1', 'vs-1']);
  expect(mockTags).toHaveBeenCalledWith('org-1', 'vs-1', client);
  expect(mockLock).toHaveBeenCalledWith(client, 'org-1', ['NAMED', 'OWNER', 'TAG-2'], 'share');
  expect(mockCovers.mock.calls.every(([, , c]) => c === client)).toBe(true);
});

test('a tag naming a deleted athlete refuses as not found before anyone is asked', async () => {
  mockTags.mockResolvedValue([{ athlete_id: 'GONE', athlete_deleted: true }]);

  await expect(assertFilmStudyConsent('org-1', 'vs-1', 'OWNER')).rejects.toBeInstanceOf(FilmStudyTaggedAthleteDeletedError);
  expect(mockCovers).not.toHaveBeenCalled();
});

// OD-2026-10-08-015: at 18 guardian-era consent stops counting for anything
// new; the adult's own decision governs. assertConsentCoversVideo already
// reads it (mocked here); this pins that the guardian-signed step no longer
// refuses an adult whose own current video consent stands.
describe("an adult's own consent (OD-2026-10-08-015)", () => {
  const own = (overrides: Partial<OwnMediaConsent> = {}): OwnMediaConsent => ({
    status: 'signed',
    coversVideo: true,
    publicUseAllowed: false,
    signedAt: '2026-10-18T00:00:00Z',
    recordedByOwnLogin: true,
    ...overrides,
  });
  const guardianEraWithdrawn = async () => {
    throw new ConflictError('Blocked: guardian media consent is missing or withdrawn.', 'GUARDIAN_CONSENT_MISSING');
  };

  test("their own video consent is analysed though the guardian-era row is withdrawn", async () => {
    mockAdultOwn.mockImplementation(async (_org, id) => (id === 'OWNER' ? own() : null));
    mockSigned.mockImplementation(guardianEraWithdrawn);

    await expect(assertFilmStudyConsent('org-1', 'vs-1', 'OWNER')).resolves.toBeUndefined();
    expect(mockSigned).not.toHaveBeenCalled();
  });

  test('the adult read is on the transaction client, after the coverage check', async () => {
    const client = { query: jest.fn(async () => ({ rows: [{ athlete_id: 'OWNER' }] })) } as unknown as QueryExecutor;
    const order: string[] = [];
    mockCovers.mockImplementation(async () => { order.push('covers'); });
    mockAdultOwn.mockImplementation(async () => { order.push('adult'); return own(); });

    await assertFilmStudyConsent('org-1', 'vs-1', 'OWNER', client);

    expect(order).toEqual(['covers', 'adult']);
    expect(mockAdultOwn).toHaveBeenCalledWith('org-1', 'OWNER', client);
  });

  test.each([
    ['no row of their own (or a minor, or unknown date of birth)', null],
    ['photo only', own({ coversVideo: false })],
    ['a signed row their own login did not record', own({ recordedByOwnLogin: false })],
    ['withdrawn', own({ status: 'withdrawn', coversVideo: false })],
  ])('CONTROL: %s still goes through the guardian step', async (_label, row) => {
    mockAdultOwn.mockResolvedValue(row);
    mockSigned.mockImplementation(guardianEraWithdrawn);

    await expect(assertFilmStudyConsent('org-1', 'vs-1', 'OWNER')).rejects.toThrow(ConflictError);
    expect(mockSigned).toHaveBeenCalledWith('org-1', 'OWNER');
  });

  test("an adult with their own consent on a clip tagging a minor whose guardian has not signed is still refused", async () => {
    mockTags.mockResolvedValue([{ athlete_id: 'MINOR', athlete_deleted: false }]);
    mockAdultOwn.mockImplementation(async (_org, id) => (id === 'OWNER' ? own() : null));
    mockSigned.mockImplementation(async (_org, id) => {
      if (id === 'MINOR') await guardianEraWithdrawn();
    });

    await expect(assertFilmStudyConsent('org-1', 'vs-1', 'OWNER')).rejects.toThrow(ConflictError);
    expect(mockSigned.mock.calls.map(([, id]) => id)).toEqual(['MINOR']);
  });
});

describe('job failure codes: an adult refusal is not filed as a guardian one', () => {
  test.each([
    ['ADULT_OWN_CONSENT_WITHDRAWN', 'SHADOW_FILM_CONSENT_ADULT_WITHDRAWN'],
    ['ADULT_OWN_CONSENT_EXCLUDES_VIDEO', 'SHADOW_FILM_CONSENT_ADULT_EXCLUDES_VIDEO'],
    ['ADULT_OWN_CONSENT_UNREADABLE', 'SHADOW_FILM_CONSENT_ADULT_UNREADABLE'],
    ['GUARDIAN_CONSENT_WITHDRAWN', 'SHADOW_FILM_CONSENT_WITHDRAWN'],
    ['GUARDIAN_CONSENT_EXCLUDES_VIDEO', 'SHADOW_FILM_CONSENT_EXCLUDES_VIDEO'],
    ['GUARDIAN_CONSENT_UNREADABLE', 'SHADOW_FILM_CONSENT_BLOCKED'],
  ])('%s -> %s', (errorCode, jobCode) => {
    expect(filmStudyConsentFailureCode(new ConflictError('Blocked.', errorCode))).toBe(jobCode);
  });
});
