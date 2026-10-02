// Guards on the QA read-out's loader.
//
// WHAT IS MOCKED AND WHAT IS NOT. Only the data layer: the rows that
// annotations.ts, adjudication.ts and projects.ts would return. comparison.ts
// and qaReadModel.ts run for real underneath, so a case that says "this clip
// is not compared" is watching the real report come out without it.
//
// The cases that matter most are the ones about what is NEVER READ: the
// events of an unfinished set, and of a submitted set whose clip is not
// compared. Those are asserted on the mock's call list, because a loader that
// read them and then discarded them would produce the same report.

import { listAdjudicationsForClip, type AdjudicationRow } from './adjudication';
import {
  listAnnotationEvents,
  listAnnotationSetsForClip,
  type AnnotationEventRow,
  type AnnotationSetRow,
} from './annotations';
import { getCalibrationProject, listCalibrationClips } from './projects';
import { loadCalibrationQaReport } from './qaReportLoader';

jest.mock('./annotations', () => ({
  listAnnotationSetsForClip: jest.fn(),
  listAnnotationEvents: jest.fn(),
}));
jest.mock('./adjudication', () => ({ listAdjudicationsForClip: jest.fn() }));
jest.mock('./projects', () => ({
  getCalibrationProject: jest.fn(),
  listCalibrationClips: jest.fn(),
}));

const mockProject = getCalibrationProject as jest.Mock;
const mockClips = listCalibrationClips as jest.Mock;
const mockSets = listAnnotationSetsForClip as jest.Mock;
const mockEvents = listAnnotationEvents as jest.Mock;
const mockAdjudications = listAdjudicationsForClip as jest.Mock;

const ORG = 'org-qa';
const PROJECT = 'project-qa';
const ONTOLOGY = 'boxing-ontology-0.1';
const ACCOUNTS = { a: 'acct-annotator-alice', b: 'acct-annotator-bob', c: 'acct-annotator-cy' };
const ADJUDICATOR = 'acct-adjudicator-dee';
const ATHLETE = 'ath-under-study';
const VIDEO = 'vid-under-study';

type Suffix = keyof typeof ACCOUNTS;

function makeSet(
  clipId: string,
  suffix: Suffix,
  overrides: Partial<AnnotationSetRow> = {},
): AnnotationSetRow {
  return {
    organization_id: ORG,
    annotation_set_id: `${clipId}-set-${suffix}`,
    calibration_clip_id: `clip-${clipId}`,
    annotator_account_id: ACCOUNTS[suffix],
    ontology_version: ONTOLOGY,
    status: 'submitted',
    created_at: '2026-08-27T00:00:00.000Z',
    submitted_at: '2026-08-27T01:00:00.000Z',
    ...overrides,
  };
}

function inProgress(clipId: string, suffix: Suffix): AnnotationSetRow {
  return makeSet(clipId, suffix, { status: 'in_progress', submitted_at: null });
}

function makeEvent(
  clipId: string,
  suffix: Suffix,
  overrides: Partial<AnnotationEventRow> = {},
): AnnotationEventRow {
  return {
    organization_id: ORG,
    event_id: `${clipId}-evt-${suffix}`,
    annotation_set_id: `${clipId}-set-${suffix}`,
    calibration_clip_id: `clip-${clipId}`,
    clip_start_ms: 0,
    clip_end_ms: 20_000,
    event_class: 'punch',
    actor_track: 'red',
    opponent_track: 'blue',
    start_ms: 1_000,
    end_ms: 1_400,
    contact_ms: null,
    peak_ms: null,
    physical_hand: 'left',
    hand_role: 'lead',
    stance: 'orthodox',
    punch_type: 'lead_straight',
    target_zone: 'head',
    contact_result: 'clean_target_contact',
    contact_zone: 'head',
    defense_type: null,
    visibility: 'clear',
    certainty: 'clear',
    combination_group: null,
    sequence_order: null,
    counter_against_event_id: null,
    defends_against_event_id: null,
    created_at: '2026-08-27T00:30:00.000Z',
    ...overrides,
  };
}

function makeAdjudication(
  clipId: string,
  pair: [Suffix, Suffix],
  adjudicatedAt: string,
  overrides: Partial<AdjudicationRow> = {},
): AdjudicationRow {
  return {
    organization_id: ORG,
    adjudication_id: `${clipId}-adj-${pair.join('')}`,
    calibration_clip_id: `clip-${clipId}`,
    annotation_set_id_a: `${clipId}-set-${pair[0]}`,
    annotation_set_id_b: `${clipId}-set-${pair[1]}`,
    source_event_id_a: `${clipId}-evt-${pair[0]}`,
    source_event_id_b: `${clipId}-evt-${pair[1]}`,
    resolution_type: 'select_a',
    missed_event_verdict: null,
    revision: 1,
    adjudicator_account_id: ADJUDICATOR,
    adjudicated_at: adjudicatedAt,
    ontology_version: ONTOLOGY,
    notes: null,
    created_at: adjudicatedAt,
    ...overrides,
  };
}

interface StagedClip {
  sets: AnnotationSetRow[];
  adjudications?: AdjudicationRow[];
  /** Per-set event overrides, keyed by suffix. */
  events?: Partial<Record<Suffix, Partial<AnnotationEventRow>>>;
}

/** Stages the data layer. Events exist for EVERY set, finished or not, so a
 * loader that reads one it should not have is caught by the call list rather
 * than hidden by an empty answer. */
function stage(clips: Record<string, StagedClip>) {
  mockProject.mockResolvedValue({
    organization_id: ORG,
    calibration_project_id: PROJECT,
    name: 'Jab study',
    ontology_version: ONTOLOGY,
  });
  mockClips.mockResolvedValue(
    Object.keys(clips).map((clipId) => ({
      calibration_clip_id: `clip-${clipId}`,
      athlete_id: ATHLETE,
      video_session_id: VIDEO,
      clip_code: `CODE-${clipId}`,
      primary_sampling_reason: 'routine',
    })),
  );
  const staged = (clipId: string) => clips[clipId.replace(/^clip-/, '')];
  mockSets.mockImplementation(async (_org: string, clipId: string) => staged(clipId).sets);
  mockAdjudications.mockImplementation(
    async (_org: string, clipId: string) => staged(clipId).adjudications ?? [],
  );
  mockEvents.mockImplementation(async (_org: string, setId: string) => {
    const [clipId, suffix] = setId.split('-set-') as [string, Suffix];
    return [makeEvent(clipId, suffix, clips[clipId].events?.[suffix])];
  });
}

function eventReads(): string[] {
  return mockEvents.mock.calls.map((call) => call[1] as string);
}

function twoSubmitted(clipId: string): StagedClip {
  return { sets: [makeSet(clipId, 'a'), makeSet(clipId, 'b')] };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('loadCalibrationQaReport', () => {
  test('answers null for a study this organization does not have, and reads nothing else', async () => {
    mockProject.mockResolvedValue(null);

    expect(await loadCalibrationQaReport(ORG, 'project-elsewhere')).toBeNull();
    expect(mockProject).toHaveBeenCalledWith(ORG, 'project-elsewhere');
    expect(mockClips).not.toHaveBeenCalled();
    expect(mockSets).not.toHaveBeenCalled();
  });

  test('compares a clip with exactly two submitted readings', async () => {
    stage({ c1: twoSubmitted('c1') });

    const result = await loadCalibrationQaReport(ORG, PROJECT);

    expect(result?.projectName).toBe('Jab study');
    expect(result?.report.comparisonCount).toBe(1);
    expect(result?.report.status).toBe('insufficient_data');
    expect(result?.excludedClips).toEqual({
      readingInProgress: 0,
      noRecordedPair: 0,
      pairNotEstablished: 0,
      notComparable: 0,
    });
    expect(eventReads().sort()).toEqual(['c1-set-a', 'c1-set-b']);
  });

  test('reports rates once five clips are compared', async () => {
    stage(Object.fromEntries(['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => [id, twoSubmitted(id)])));

    const result = await loadCalibrationQaReport(ORG, PROJECT);

    expect(result?.report.comparisonCount).toBe(5);
    expect(result?.report.status).toBe('available');
  });

  test('asks every reader for this organization and this study only', async () => {
    stage({
      c1: {
        sets: [makeSet('c1', 'a'), makeSet('c1', 'b')],
        adjudications: [makeAdjudication('c1', ['a', 'b'], '2026-08-29T00:00:00.000Z')],
      },
    });

    await loadCalibrationQaReport(ORG, PROJECT);

    expect(mockProject.mock.calls).toEqual([[ORG, PROJECT]]);
    expect(mockClips.mock.calls).toEqual([[ORG, PROJECT]]);
    expect(mockSets.mock.calls).toEqual([[ORG, 'clip-c1']]);
    expect(mockAdjudications.mock.calls).toEqual([[ORG, 'clip-c1']]);
    expect(mockEvents.mock.calls.map((call) => call[0])).toEqual([ORG, ORG]);
  });

  test('never reads the events of an unfinished set, or of its finished partner', async () => {
    stage({
      waiting: { sets: [makeSet('waiting', 'a'), inProgress('waiting', 'b')] },
      alone: { sets: [makeSet('alone', 'a')] },
      untouched: { sets: [] },
    });

    const result = await loadCalibrationQaReport(ORG, PROJECT);

    expect(eventReads()).toEqual([]);
    expect(result?.report.comparisonCount).toBe(0);
    // The finished half of an unfinished pair contributes to no rate: its
    // 'unknown' and hedged values would describe one labeller's work before
    // the other has submitted.
    expect(result?.report.unknownRate.denominator).toBe(0);
    expect(result?.report.hedgedCertaintyRate.denominator).toBe(0);
    expect(result?.report.clipProgress).toMatchObject({
      totalClips: 3,
      clipsNotStarted: 1,
      clipsAwaitingSecondAnnotator: 1,
      clipsAwaitingSecondSubmission: 1,
    });
  });

  test('leaves out a clip with two submitted readings and a third in progress', async () => {
    stage({
      c1: { sets: [makeSet('c1', 'a'), makeSet('c1', 'b'), inProgress('c1', 'c')] },
    });

    const result = await loadCalibrationQaReport(ORG, PROJECT);

    expect(result?.report.comparisonCount).toBe(0);
    expect(result?.excludedClips.readingInProgress).toBe(1);
    expect(eventReads()).toEqual([]);
  });

  describe('three or more submitted readings (OD-2026-08-29-003)', () => {
    const three = (clipId: string) => [
      makeSet(clipId, 'a'),
      makeSet(clipId, 'b'),
      makeSet(clipId, 'c', { submitted_at: '2026-08-28T01:00:00.000Z' }),
    ];

    test('does not pair them itself when no adjudication names a pair', async () => {
      stage({ c1: { sets: three('c1') } });

      const result = await loadCalibrationQaReport(ORG, PROJECT);

      expect(result?.report.comparisonCount).toBe(0);
      expect(result?.excludedClips.noRecordedPair).toBe(1);
      expect(eventReads()).toEqual([]);
    });

    test('compares the one pair an adjudication names after the last submission', async () => {
      stage({
        c1: {
          sets: three('c1'),
          adjudications: [makeAdjudication('c1', ['a', 'c'], '2026-08-29T00:00:00.000Z')],
        },
      });

      const result = await loadCalibrationQaReport(ORG, PROJECT);

      expect(result?.report.comparisonCount).toBe(1);
      expect(eventReads().sort()).toEqual(['c1-set-a', 'c1-set-c']);
      expect(result?.report.clipProgress.clipsWithAdjudication).toBe(1);
      expect(result?.report.adjudicationRate.count).toBe(1);
    });

    test('refuses a pair adjudicated before the third reading was submitted', async () => {
      stage({
        c1: {
          sets: three('c1'),
          // Settled while the clip had two readings: nobody chose it over c.
          adjudications: [makeAdjudication('c1', ['a', 'b'], '2026-08-27T12:00:00.000Z')],
        },
      });

      const result = await loadCalibrationQaReport(ORG, PROJECT);

      expect(result?.report.comparisonCount).toBe(0);
      expect(result?.excludedClips.pairNotEstablished).toBe(1);
      expect(eventReads()).toEqual([]);
    });

    test('refuses a pair adjudicated at the same instant as the last submission', async () => {
      stage({
        c1: {
          sets: three('c1'),
          adjudications: [makeAdjudication('c1', ['a', 'b'], '2026-08-28T01:00:00.000Z')],
        },
      });

      const result = await loadCalibrationQaReport(ORG, PROJECT);

      expect(result?.excludedClips.pairNotEstablished).toBe(1);
    });

    test('takes the latest adjudication of the pair as the evidence of choice', async () => {
      stage({
        c1: {
          sets: three('c1'),
          adjudications: [
            makeAdjudication('c1', ['a', 'b'], '2026-08-27T12:00:00.000Z'),
            // A second disagreement on the same pair, settled after c arrived
            // and recorded with the readings the other way round.
            makeAdjudication('c1', ['b', 'a'], '2026-08-29T00:00:00.000Z', {
              adjudication_id: 'c1-adj-later',
              source_event_id_a: null,
            }),
          ],
        },
      });

      const result = await loadCalibrationQaReport(ORG, PROJECT);

      expect(result?.report.comparisonCount).toBe(1);
      expect(eventReads().sort()).toEqual(['c1-set-a', 'c1-set-b']);
    });

    test('refuses an adjudication naming a reading that is not on the clip', async () => {
      stage({
        c1: {
          sets: three('c1'),
          adjudications: [
            makeAdjudication('c1', ['a', 'b'], '2026-08-29T00:00:00.000Z', {
              annotation_set_id_b: 'elsewhere-set-b',
            }),
          ],
        },
      });

      const result = await loadCalibrationQaReport(ORG, PROJECT);

      expect(result?.report.comparisonCount).toBe(0);
      expect(result?.excludedClips.pairNotEstablished).toBe(1);
      expect(eventReads()).toEqual([]);
    });

    test('refuses when adjudications name more than one pair', async () => {
      stage({
        c1: {
          sets: three('c1'),
          adjudications: [
            makeAdjudication('c1', ['a', 'b'], '2026-08-29T00:00:00.000Z'),
            makeAdjudication('c1', ['a', 'c'], '2026-08-29T00:05:00.000Z'),
          ],
        },
      });

      const result = await loadCalibrationQaReport(ORG, PROJECT);

      expect(result?.report.comparisonCount).toBe(0);
      expect(result?.excludedClips.pairNotEstablished).toBe(1);
    });

    test('excludes rather than admits a clip whose submission time is unreadable', async () => {
      const sets = three('c1').map((set) => ({ ...set, submitted_at: null }));
      stage({
        c1: { sets, adjudications: [makeAdjudication('c1', ['a', 'b'], '2026-08-29T00:00:00.000Z')] },
      });

      const result = await loadCalibrationQaReport(ORG, PROJECT);

      expect(result?.excludedClips.pairNotEstablished).toBe(1);
    });

    test('accepts timestamps arriving as Date objects, as the driver delivers them', async () => {
      const sets = three('c1').map((set) => ({
        ...set,
        submitted_at: new Date(set.submitted_at as string) as unknown as string,
      }));
      stage({
        c1: {
          sets,
          adjudications: [
            makeAdjudication('c1', ['b', 'c'], new Date('2026-08-29T00:00:00.000Z') as unknown as string),
          ],
        },
      });

      const result = await loadCalibrationQaReport(ORG, PROJECT);

      expect(result?.report.comparisonCount).toBe(1);
    });
  });

  test('leaves out a pair read under another ontology version, without reading its events', async () => {
    stage({
      mixed: {
        sets: [makeSet('mixed', 'a'), makeSet('mixed', 'b', { ontology_version: 'boxing-ontology-0.2' })],
      },
      // Both readings agree with each other and not with the study.
      newer: {
        sets: (['a', 'b'] as const).map((suffix) =>
          makeSet('newer', suffix, { ontology_version: 'boxing-ontology-0.2' })),
      },
      fine: twoSubmitted('fine'),
    });

    const result = await loadCalibrationQaReport(ORG, PROJECT);

    expect(result?.report.comparisonCount).toBe(1);
    expect(result?.excludedClips.notComparable).toBe(2);
    expect(eventReads().sort()).toEqual(['fine-set-a', 'fine-set-b']);
  });

  test('keeps progress and exclusions adding up, and counts every adjudicated clip', async () => {
    stage({
      compared: twoSubmitted('compared'),
      // Settled at two readings; a third coach has since started.
      reopened: {
        sets: [makeSet('reopened', 'a'), makeSet('reopened', 'b'), inProgress('reopened', 'c')],
        adjudications: [makeAdjudication('reopened', ['a', 'b'], '2026-08-29T00:00:00.000Z')],
      },
      unpaired: { sets: [makeSet('unpaired', 'a'), makeSet('unpaired', 'b'), makeSet('unpaired', 'c')] },
      waiting: { sets: [makeSet('waiting', 'a')] },
    });

    const result = await loadCalibrationQaReport(ORG, PROJECT);
    const excluded = Object.values(result?.excludedClips ?? {}).reduce((sum, n) => sum + n, 0);

    expect(excluded).toBe(2);
    expect(result?.report.clipProgress.clipsReadyToCompare).toBe(
      (result?.report.comparisonCount ?? 0) + excluded,
    );
    expect(result?.report.clipProgress.clipsWithAdjudication).toBe(1);
    // ...and that adjudication is in no rate, because its clip is not compared.
    expect(result?.report.adjudicationRate.count).toBe(0);
  });

  test('lets a failed read fail the report rather than return part of one', async () => {
    stage({ c1: twoSubmitted('c1') });
    mockEvents.mockRejectedValue(new Error('connection lost'));

    await expect(loadCalibrationQaReport(ORG, PROJECT)).rejects.toThrow('connection lost');
  });

  test('counts unknown and hedged values from compared pairs only', async () => {
    stage({
      compared: {
        ...twoSubmitted('compared'),
        events: { a: { certainty: 'probable' }, b: { stance: 'unknown' } },
      },
      // A finished reading full of hedges, on a clip nobody else has finished.
      waiting: {
        sets: [makeSet('waiting', 'a'), inProgress('waiting', 'b')],
        events: { a: { certainty: 'uncertain', stance: 'unknown' } },
      },
    });

    const result = await loadCalibrationQaReport(ORG, PROJECT);

    expect(result?.report.hedgedCertaintyRate).toMatchObject({ count: 1, denominator: 2 });
    expect(result?.report.unknownRate.count).toBe(1);
  });

  test('lets no account id, set id or event id out', async () => {
    stage({
      c1: {
        sets: [makeSet('c1', 'a'), makeSet('c1', 'b'), makeSet('c1', 'c')],
        adjudications: [makeAdjudication('c1', ['a', 'b'], '2026-08-29T00:00:00.000Z')],
        events: { a: { target_zone: 'body' } },
      },
      c2: twoSubmitted('c2'),
      c3: { sets: [makeSet('c3', 'a'), inProgress('c3', 'b')] },
    });

    const serialized = JSON.stringify(await loadCalibrationQaReport(ORG, PROJECT));

    for (const forbidden of [
      ...Object.values(ACCOUNTS), ADJUDICATOR, ATHLETE, VIDEO, 'clip-c', 'CODE-', '-set-', '-evt-', '-adj-',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized.toLowerCase()).not.toContain('account');
    expect(serialized.toLowerCase()).not.toContain('athlete');
  });
});
