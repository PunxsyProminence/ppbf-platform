// Who an event is about, on a body-point set: Fighter 1 or Fighter 2
// (OD-2026-10-08-005 A-Q10a; TEACH-T T-4).
//
// The database is mocked: the first queryOne is the set's context, the second
// would be the insert. calibrationEventInPlaceEdit.pg.test.ts holds the same
// rule against a real database, edits included.

jest.mock('../db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
}));

import { queryOne } from '../db';
import { recordAnnotationEvent, type RecordAnnotationEventInput } from './annotations';

const mockQueryOne = jest.mocked(queryOne);

function contextOf(version: string) {
  return {
    annotation_set_id: 'set-1',
    calibration_clip_id: 'clip-1',
    status: 'in_progress',
    ontology_version: version,
    annotator_account_id: 'acct-1',
    clip_start_ms: 0,
    clip_end_ms: 20_000,
  };
}

function punch(overrides: Partial<RecordAnnotationEventInput> = {}): RecordAnnotationEventInput {
  return {
    organizationId: 'org-1',
    eventId: 'evt-1',
    annotationSetId: 'set-1',
    eventClass: 'punch',
    actorTrack: 'fighter_1',
    opponentTrack: 'fighter_2',
    startMs: 1_000,
    endMs: 1_400,
    contactMs: 1_200,
    physicalHand: 'left',
    handRole: 'lead',
    punchType: 'lead_straight',
    targetZone: 'head',
    contactResult: 'clean_target_contact',
    visibility: 'clear',
    certainty: 'clear',
    ...overrides,
  } as RecordAnnotationEventInput;
}

/** Records one event on a set of the given version; resolves to the error, or null. */
async function attempt(version: string, overrides: Partial<RecordAnnotationEventInput> = {}) {
  mockQueryOne.mockReset();
  mockQueryOne
    .mockResolvedValueOnce(contextOf(version) as never)
    .mockResolvedValueOnce({ event_id: 'evt-1' } as never);
  return recordAnnotationEvent(punch(overrides)).then(() => null, (error: Error) => error);
}

const inserted = () => mockQueryOne.mock.calls.length === 2;

describe.each(['boxing-ontology-0.2', 'boxing-ontology-0.3', 'boxing-ontology-0.4'])('on a %s set', (version) => {
  test('Fighter 1 against Fighter 2 is recorded', async () => {
    expect(await attempt(version)).toBeNull();
    expect(inserted()).toBe(true);
  });

  test('an event with no opponent is recorded', async () => {
    expect(await attempt(version, { opponentTrack: null })).toBeNull();
    expect(inserted()).toBe(true);
  });

  test.each([
    ['a typed actor', { actorTrack: 'red' }, /^Missing actor_track: on boxing-ontology-0\.[234] the actor is fighter_1 or fighter_2$/],
    ['the label in other words', { actorTrack: 'Fighter 1' }, /^Missing actor_track/],
    ['a typed opponent', { opponentTrack: 'blue' }, /^Missing opponent_track: on boxing-ontology-0\.[234] the opponent is fighter_1 or fighter_2, or none$/],
  ])('%s is refused by name before anything is written', async (_label, overrides, message) => {
    const refusal = await attempt(version, overrides);
    expect(refusal?.message).toMatch(message);
    expect(refusal?.message).toContain(version);
    expect(inserted()).toBe(false);
  });
});

test('a 0.1 set keeps the typed actor and opponent it started with (OD-2026-10-02-008 4A)', async () => {
  expect(await attempt('boxing-ontology-0.1', { actorTrack: 'red corner', opponentTrack: 'blue corner' })).toBeNull();
  expect(inserted()).toBe(true);
});
