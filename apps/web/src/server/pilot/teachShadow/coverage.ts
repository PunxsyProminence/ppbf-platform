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
 *   - A count of distinct camera angles, and equally a count of DEVICES.
 *     camera_view is free text and nullable, camera_view_id is minted per
 *     file, and uploaded_by_account_id names a coach rather than a phone, so
 *     none of them answers "how many cameras were in the room". What is
 *     reported instead is the plainest true statement available -- how many
 *     takes carry more than one file -- and it is labelled as that, because
 *     one phone recording an attempt twice satisfies it just as two phones do.
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
    /*
     * Takes carrying more than one file. NOT "filmed from more than one
     * device", which it was called first and is not what it counts: a coach
     * who records an angle and then attaches a file shot on the same phone
     * produces two files from one device, and a take filmed by two phones
     * where one upload failed produces one file from two. The platform knows
     * how many files arrived; it does not know how many cameras were in the
     * room, because camera_view is free text and camera_view_id is minted per
     * file.
     */
    takes_with_multiple_files: number;
  };
  labelling: {
    clips_cut: number;
    /** Sets a coach has finished and frozen. In-progress work is not evidence. */
    submitted_sets: number;
    /** Clips two coaches have both finished -- the only ones agreement can be measured on. */
    clips_with_two_submitted_sets: number;
    adjudications: number;
    /*
     * PROMOTED, not merely nominated. governance_state runs candidate -> gold
     * -> excluded, defaulting to 'candidate' so that a caller who forgets to
     * say produces a row OUTSIDE the reference dataset rather than inside it.
     * Counting every row and calling the total "gold records" would report
     * deliberately EXCLUDED records as part of the reference set, which is the
     * opposite of what somebody excluded them for.
     */
    gold_records: number;
    /** Adjudicated and nominated, and deliberately not yet part of anything. */
    gold_candidates: number;
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
 * WHAT COUNTS AS CORPUS EVIDENCE, AND THE THREE THINGS THAT NARROW IT.
 *
 * SUBMITTED SETS ONLY. An in-progress set is one coach's unfinished work,
 * still editable, and invisible to the other annotator by design. Counting it
 * would make the corpus look larger than the evidence anyone has stood behind,
 * and the number would go DOWN when a coach deleted a mistaken event -- a
 * figure that moves backwards for a good reason is one nobody trusts.
 *
 * ONE ONTOLOGY VERSION. ontology.ts says every calibration row carries the
 * vocabulary it was created under precisely so a study run under 0.1 and one
 * run under 0.2 are never pooled, and that nothing here may aggregate across
 * versions without a recorded decision. Only one version exists today, so an
 * unfiltered count happens to be right -- and would quietly stop being right
 * the day a second one shipped, while still stamping the answer 0.1.
 *
 * AND TEACHING FOOTAGE ONLY, which is the boundary the whole area exists to
 * hold. Film Study media can never be promoted into the recognition corpus,
 * and a label is the form that promotion takes: the labels are the evidence a
 * recognizer is taught from. assertVideoClippable refuses to cut a clip from
 * anything but teaching footage, but clips cut before that rule existed are
 * still in the database, and refusing to REOPEN them does not stop their
 * labels being counted here as corpus evidence. So every count below walks
 * back to the source video and requires a capture take.
 *
 * capture_take_id is the discriminator because Teach Shadow capture always
 * sends one and Film Study never does. NULL is ambiguous -- it covers both a
 * Film Study recording and an upload predating takes -- and ambiguity resolves
 * to NOT PROVEN teaching footage, because the owner's rule is that a
 * destination is chosen before the media exists rather than reconstructed
 * afterwards. Those rows stay in the database as history; they stop being
 * counted as evidence.
 */
const TEACHING_SOURCE_JOIN = (alias: string) => `
  join pilot.calibration_clips cc
    on cc.calibration_clip_id = ${alias}.calibration_clip_id
   and cc.organization_id = ${alias}.organization_id
  join pilot.video_sessions cv
    on cv.video_session_id = cc.video_session_id
   and cv.organization_id = cc.organization_id
   and cv.capture_take_id is not null`;

const SUBMITTED_EVENTS_FROM = `
  from pilot.calibration_annotation_events e
  join pilot.calibration_annotation_sets s
    on s.annotation_set_id = e.annotation_set_id
   and s.organization_id = e.organization_id
  ${TEACHING_SOURCE_JOIN('e')}
 where e.organization_id = $1
   and s.status = 'submitted'
   and s.ontology_version = $2`;

export async function readTeachShadowCoverage(organizationId: string): Promise<TeachShadowCoverage> {
  const [capture, labelling, punchRows, defenseRows] = await Promise.all([
    query<{
      recording_sessions: number;
      capture_takes: number;
      captured_files: number;
      takes_with_multiple_files: number;

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
           as takes_with_multiple_files`,
      [organizationId],
    ),
    query<{
      clips_cut: number;
      submitted_sets: number;
      clips_with_two_submitted_sets: number;
      adjudications: number;
      gold_records: number;
      gold_candidates: number;
    }>(
      `select
         -- Clips cut from teaching footage. A clip cut from anything else is
         -- history, not corpus, so it is not counted as either.
         (select count(*)::int from pilot.calibration_clips c
            join pilot.video_sessions v
              on v.video_session_id = c.video_session_id
             and v.organization_id = c.organization_id
             and v.capture_take_id is not null
           where c.organization_id = $1)
           as clips_cut,
         (select count(*)::int from pilot.calibration_annotation_sets s
            ${TEACHING_SOURCE_JOIN('s')}
           where s.organization_id = $1 and s.status = 'submitted' and s.ontology_version = $2)
           as submitted_sets,
         (select count(*)::int from (
            select s.calibration_clip_id
              from pilot.calibration_annotation_sets s
              ${TEACHING_SOURCE_JOIN('s')}
             where s.organization_id = $1 and s.status = 'submitted' and s.ontology_version = $2
             group by s.calibration_clip_id
            having count(*) >= 2
          ) c)
           as clips_with_two_submitted_sets,
         (select count(*)::int from pilot.calibration_adjudications a
            ${TEACHING_SOURCE_JOIN('a')}
           where a.organization_id = $1 and a.ontology_version = $2)
           as adjudications,
         -- Gold carries its own video_session_id as provenance, so it needs no
         -- hop through the clip.
         (select count(*)::int from pilot.calibration_gold_records g
            join pilot.video_sessions v
              on v.video_session_id = g.video_session_id
             and v.organization_id = g.organization_id
             and v.capture_take_id is not null
           where g.organization_id = $1 and g.ontology_version = $2
             and g.governance_state = 'gold')
           as gold_records,
         (select count(*)::int from pilot.calibration_gold_records g
            join pilot.video_sessions v
              on v.video_session_id = g.video_session_id
             and v.organization_id = g.organization_id
             and v.capture_take_id is not null
           where g.organization_id = $1 and g.ontology_version = $2
             and g.governance_state = 'candidate')
           as gold_candidates`,
      [organizationId, BOXING_ONTOLOGY_VERSION],
    ),
    query<{ punch_type: string; stance: string | null; events: number; clips: number }>(
      `select e.punch_type, e.stance,
              count(*)::int as events,
              count(distinct e.calibration_clip_id)::int as clips
         ${SUBMITTED_EVENTS_FROM}
           and e.event_class = 'punch'
           and e.punch_type is not null
        group by e.punch_type, e.stance`,
      [organizationId, BOXING_ONTOLOGY_VERSION],
    ),
    query<{ defense_type: string; events: number; clips: number }>(
      `select e.defense_type,
              count(*)::int as events,
              count(distinct e.calibration_clip_id)::int as clips
         ${SUBMITTED_EVENTS_FROM}
           and e.event_class = 'defense'
           and e.defense_type is not null
        group by e.defense_type`,
      [organizationId, BOXING_ONTOLOGY_VERSION],
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
      takes_with_multiple_files: 0,
    },
    labelling: labelling[0] ?? {
      clips_cut: 0,
      submitted_sets: 0,
      clips_with_two_submitted_sets: 0,
      adjudications: 0,
      gold_records: 0,
      gold_candidates: 0,
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
