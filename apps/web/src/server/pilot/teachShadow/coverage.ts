import { query } from '@/src/server/pilot/db';
import {
  BOXING_ONTOLOGY_VERSION,
  DEFENSE_TYPES,
  PUNCH_TYPES,
  STANCES,
} from '@/src/server/pilot/calibration/ontology';

/*
 * WHAT SHADOW HAS BEEN SHOWN SO FAR. Counts of evidence that exists, and
 * nothing else.
 *
 * THIS IS NOT A MODEL REPORT, AND THE DISTINCTION IS THE WHOLE POINT. No
 * recognition model has been trained or evaluated -- there is no model,
 * inference, prediction or dataset table anywhere in this schema -- so every
 * figure here is "how much of this have people recorded and labelled", never
 * "how well does Shadow do on it". A percentage, an accuracy, a confidence or
 * a readiness score would all be invented, and a coach reading one would make
 * decisions on a number nothing produced.
 *
 * WHY "THINNEST EVIDENCE" AND NOT "LEAST CONFIDENT". The owner wants Shadow
 * taught the way a boxer is: find the weak area, work it, measure, repeat. The
 * honest version of that question today is WHAT HAS SHADOW BEEN SHOWN LEAST
 * OF, which is answerable from governed counts. "What is Shadow worst at"
 * needs a model and a held-out evaluation, and answering it from these numbers
 * would be a guess wearing the clothes of a measurement.
 *
 * WHAT IS DELIBERATELY ABSENT, because the data cannot support it:
 *   - Hours or minutes of footage. pilot.video_sessions has no duration column
 *     of any kind; file_size_bytes is not duration.
 *   - A count of distinct camera angles. camera_view is free text and
 *     nullable, and camera_view_id is minted per file, so counting either
 *     answers a different question than the one asked. "Takes filmed from two
 *     or more devices" is the honest substitute and is reported instead.
 *   - Anything derived from capture_source. It records whether bytes were
 *     recorded in-app or chosen from a device, and BOTH recorders now produce
 *     'in_app_recording'. The Teach Shadow corpus is identified by
 *     capture_take_id being present, which is exactly what Film Study never
 *     sends.
 */

/** One (punch type, stance) cell of the labelled-evidence grid. */
export interface PunchEvidenceCell {
  punch_type: string;
  /** Null when the annotator did not record the fighter's stance. */
  stance: string | null;
  events: number;
  /** Distinct clips the events came from -- 40 events off one clip is thin. */
  clips: number;
}

export interface DefenseEvidenceCell {
  defense_type: string;
  events: number;
  clips: number;
}

export interface TeachShadowCoverage {
  ontology_version: string;
  capture: {
    recording_sessions: number;
    capture_takes: number;
    /** Video rows that belong to a take. Film Study footage is never counted. */
    captured_files: number;
    /** Takes with two or more files, i.e. genuinely filmed from more than one device. */
    multi_angle_takes: number;
    athletes_captured: number;
  };
  labelling: {
    clips_cut: number;
    /** Sets a coach has finished and frozen. In-progress work is not evidence. */
    submitted_sets: number;
    /** Clips two coaches have both finished -- the only ones agreement can be measured on. */
    clips_with_two_submitted_sets: number;
    adjudications: number;
    gold_records: number;
  };
  /** Every term in the vocabulary, including the ones with nothing behind them. */
  punch_evidence: PunchEvidenceCell[];
  defense_evidence: DefenseEvidenceCell[];
  vocabulary: {
    punch_types: readonly string[];
    defense_types: readonly string[];
    stances: readonly string[];
  };
}

/*
 * SUBMITTED SETS ONLY, everywhere a label is counted.
 *
 * An in-progress set is one coach's unfinished work, still editable, and
 * invisible to the other annotator by design. Counting it would make the
 * corpus look larger than the evidence anyone has actually stood behind, and
 * the number would go DOWN when a coach deleted a mistaken event -- a coverage
 * figure that moves backwards for a good reason is a figure nobody trusts.
 */
const SUBMITTED_EVENTS_FROM = `
  from pilot.calibration_annotation_events e
  join pilot.calibration_annotation_sets s
    on s.annotation_set_id = e.annotation_set_id
   and s.organization_id = e.organization_id
 where e.organization_id = $1
   and s.status = 'submitted'`;

export async function readTeachShadowCoverage(organizationId: string): Promise<TeachShadowCoverage> {
  const [capture, labelling, punchRows, defenseRows] = await Promise.all([
    query<{
      recording_sessions: number;
      capture_takes: number;
      captured_files: number;
      multi_angle_takes: number;
      athletes_captured: number;
    }>(
      `select
         (select count(*)::int from pilot.recording_sessions where organization_id = $1)
           as recording_sessions,
         (select count(*)::int from pilot.capture_takes where organization_id = $1)
           as capture_takes,
         (select count(*)::int from pilot.video_sessions
           where organization_id = $1 and capture_take_id is not null)
           as captured_files,
         (select count(*)::int from (
            select capture_take_id
              from pilot.video_sessions
             where organization_id = $1 and capture_take_id is not null
             group by capture_take_id
            having count(*) >= 2
          ) t)
           as multi_angle_takes,
         (select count(distinct athlete_id)::int from pilot.video_sessions
           where organization_id = $1 and capture_take_id is not null and athlete_id is not null)
           as athletes_captured`,
      [organizationId],
    ),
    query<{
      clips_cut: number;
      submitted_sets: number;
      clips_with_two_submitted_sets: number;
      adjudications: number;
      gold_records: number;
    }>(
      `select
         (select count(*)::int from pilot.calibration_clips where organization_id = $1)
           as clips_cut,
         (select count(*)::int from pilot.calibration_annotation_sets
           where organization_id = $1 and status = 'submitted')
           as submitted_sets,
         (select count(*)::int from (
            select calibration_clip_id
              from pilot.calibration_annotation_sets
             where organization_id = $1 and status = 'submitted'
             group by calibration_clip_id
            having count(*) >= 2
          ) c)
           as clips_with_two_submitted_sets,
         (select count(*)::int from pilot.calibration_adjudications where organization_id = $1)
           as adjudications,
         (select count(*)::int from pilot.calibration_gold_records where organization_id = $1)
           as gold_records`,
      [organizationId],
    ),
    query<{ punch_type: string; stance: string | null; events: number; clips: number }>(
      `select e.punch_type, e.stance,
              count(*)::int as events,
              count(distinct e.calibration_clip_id)::int as clips
         ${SUBMITTED_EVENTS_FROM}
           and e.event_class = 'punch'
           and e.punch_type is not null
        group by e.punch_type, e.stance`,
      [organizationId],
    ),
    query<{ defense_type: string; events: number; clips: number }>(
      `select e.defense_type,
              count(*)::int as events,
              count(distinct e.calibration_clip_id)::int as clips
         ${SUBMITTED_EVENTS_FROM}
           and e.event_class = 'defense'
           and e.defense_type is not null
        group by e.defense_type`,
      [organizationId],
    ),
  ]);

  /*
   * EVERY TERM APPEARS, INCLUDING THE EMPTY ONES, and that is the feature. A
   * group-by returns only what exists, so a punch nobody has ever labelled --
   * exactly the gap this surface is for -- would silently not be listed. The
   * vocabulary is the list; the query only fills it in.
   */
  const punchCounts = new Map(punchRows.map((row) => [`${row.punch_type}\u0000${row.stance ?? ''}`, row]));
  const punch_evidence: PunchEvidenceCell[] = [];
  for (const punchType of PUNCH_TYPES) {
    for (const stance of [...STANCES, null]) {
      const row = punchCounts.get(`${punchType}\u0000${stance ?? ''}`);
      // A cell nobody has ever labelled is reported as zero rather than
      // omitted; a cell for a stance value nothing uses is left out so the
      // grid does not fill with rows that were never going to be filmed.
      if (!row && stance !== 'orthodox' && stance !== 'southpaw') continue;
      punch_evidence.push({
        punch_type: punchType,
        stance,
        events: row?.events ?? 0,
        clips: row?.clips ?? 0,
      });
    }
  }

  const defenseCounts = new Map(defenseRows.map((row) => [row.defense_type, row]));
  const defense_evidence: DefenseEvidenceCell[] = DEFENSE_TYPES.map((defenseType) => ({
    defense_type: defenseType,
    events: defenseCounts.get(defenseType)?.events ?? 0,
    clips: defenseCounts.get(defenseType)?.clips ?? 0,
  }));

  return {
    ontology_version: BOXING_ONTOLOGY_VERSION,
    capture: capture[0] ?? {
      recording_sessions: 0,
      capture_takes: 0,
      captured_files: 0,
      multi_angle_takes: 0,
      athletes_captured: 0,
    },
    labelling: labelling[0] ?? {
      clips_cut: 0,
      submitted_sets: 0,
      clips_with_two_submitted_sets: 0,
      adjudications: 0,
      gold_records: 0,
    },
    punch_evidence,
    defense_evidence,
    vocabulary: {
      punch_types: PUNCH_TYPES,
      defense_types: DEFENSE_TYPES,
      stances: STANCES,
    },
  };
}
