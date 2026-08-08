import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';

// pilot.disciplines, pilot.grappling_exposure, pilot.athlete_discipline_participation
// and pilot.mixed_age_session_records are owned by
// infra/azure/pilot_slice_postgres_multidiscipline_migration.sql, applied through
// the apply-migrations workflow like every other table. Nothing here issues DDL.
//
// BOXING AND GRAPPLING DO NOT SHARE A RISK MODEL. pilot.sparring_exposure records
// time under impact for striking; pilot.grappling_exposure records neck/joint/
// submission exposure for grappling. Neither table can express the other's risk --
// do not route grappling activity through sparringExposure.ts, and do not add a
// damage score, cumulative risk index, or recommended limit to either. No
// validated safe dose exists for any population this platform serves.

const MIN_UNRELATED_ADULT_NOTE_LENGTH = 15;

export type DisciplineLane = 'striking' | 'grappling' | 'mixed' | 'non_contact';
export type DisciplineExposureModel = 'head_impact' | 'positional_grappling' | 'mixed_contact' | 'none';

export interface DisciplineRow {
  organization_id: string;
  discipline: string;
  display_name: string;
  lane: DisciplineLane;
  exposure_model: DisciplineExposureModel;
  governing_body: string | null;
  age_policy_source: string | null;
  youth_permitted: boolean;
  adult_permitted: boolean;
  mixed_age_permitted: boolean;
  evidence_note: string;
  active: boolean;
}

export async function listDisciplines(
  organizationId: string,
  filter: { activeOnly?: boolean } = {},
): Promise<DisciplineRow[]> {
  return query<DisciplineRow>(
    `select organization_id, discipline, display_name, lane, exposure_model, governing_body,
            age_policy_source, youth_permitted, adult_permitted, mixed_age_permitted,
            evidence_note, active
     from pilot.disciplines
     where organization_id = $1
       and ($2::boolean is null or active = $2)
     order by discipline`,
    [organizationId, filter.activeOnly ?? null],
  );
}

export type GrapplingRoundType = 'positional' | 'flow' | 'situational' | 'competitive' | 'technique_only' | 'live_go';
export type GrapplingNeckExposure =
  | 'none' | 'incidental' | 'positional_pressure' | 'choke_defended' | 'choke_completed' | 'unclear';
export type GrapplingJointExposure =
  | 'none' | 'incidental' | 'joint_lock_defended' | 'joint_lock_completed' | 'unclear';
export type GrapplingImpactToHead =
  | 'none' | 'incidental_mat_contact' | 'incidental_clash' | 'repeated' | 'unclear';
export type GrapplingIntensity = 'light' | 'moderate' | 'firm' | 'unclear';
export type GrapplingAthletePresentation = 'normal' | 'slowed' | 'unsteady' | 'withdrawn' | 'other_concern';

export interface GrapplingExposureRow {
  organization_id: string;
  exposure_id: string;
  activity_id: string;
  athlete_id: string;
  discipline: string;
  segment_number: number;
  round_type: GrapplingRoundType;
  duration_sec: number;
  partner_athlete_id: string | null;
  partner_weight_delta_lb: number | null;
  partner_rank_delta: string | null;
  submissions_applied: number;
  submissions_received: number;
  neck_exposure: GrapplingNeckExposure;
  joint_exposure: GrapplingJointExposure;
  impact_to_head: GrapplingImpactToHead;
  takedowns_conceded: number | null;
  coach_observed_intensity: GrapplingIntensity;
  athlete_presentation: GrapplingAthletePresentation | null;
  coach_note: string;
  supervising_coach_account_id: string;
  stopped_early: boolean;
  stop_rule_id: string | null;
  stop_reason: string | null;
  created_at: string;
}

const GRAPPLING_EXPOSURE_FIELDS =
  'organization_id, exposure_id, activity_id, athlete_id, discipline, segment_number, round_type, '
  + 'duration_sec, partner_athlete_id, partner_weight_delta_lb, partner_rank_delta, submissions_applied, '
  + 'submissions_received, neck_exposure, joint_exposure, impact_to_head, takedowns_conceded, '
  + 'coach_observed_intensity, athlete_presentation, coach_note, supervising_coach_account_id, '
  + 'stopped_early, stop_rule_id, stop_reason, created_at';

export interface RecordGrapplingExposureInput {
  organizationId: string;
  activityId: string;
  athleteId: string;
  discipline: string;
  segmentNumber: number;
  roundType: GrapplingRoundType;
  durationSec: number;
  partnerAthleteId?: string;
  partnerWeightDeltaLb?: number;
  partnerRankDelta?: string;
  submissionsApplied?: number;
  submissionsReceived?: number;
  neckExposure?: GrapplingNeckExposure;
  jointExposure?: GrapplingJointExposure;
  impactToHead?: GrapplingImpactToHead;
  takedownsConceded?: number;
  coachObservedIntensity: GrapplingIntensity;
  athletePresentation?: GrapplingAthletePresentation;
  coachNote?: string;
  supervisingCoachAccountId: string;
  stoppedEarly?: boolean;
  stopRuleId?: string;
  stopReason?: string;
}

/**
 * Records one grappling exposure segment. Refuses up front, ahead of
 * pilot_grappling_exposure_choke_note, when neckExposure='choke_completed'
 * carries no coach note -- a completed choke is a coach-review event by
 * construction, never a bare statistic.
 */
export async function recordGrapplingExposure(input: RecordGrapplingExposureInput): Promise<GrapplingExposureRow> {
  const neckExposure = input.neckExposure ?? 'none';
  const coachNote = input.coachNote?.trim() ?? '';
  if (neckExposure === 'choke_completed' && coachNote.length < 10) {
    throw new Error('GRAPPLING_CHOKE_NOTE_REQUIRED: a completed choke requires a coach note of at least 10 characters');
  }

  const exposureId = randomUUID();
  const row = await queryOne<GrapplingExposureRow>(
    `insert into pilot.grappling_exposure
       (organization_id, exposure_id, activity_id, athlete_id, discipline, segment_number, round_type,
        duration_sec, partner_athlete_id, partner_weight_delta_lb, partner_rank_delta,
        submissions_applied, submissions_received, neck_exposure, joint_exposure, impact_to_head,
        takedowns_conceded, coach_observed_intensity, athlete_presentation, coach_note,
        supervising_coach_account_id, stopped_early, stop_rule_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     returning ${GRAPPLING_EXPOSURE_FIELDS}`,
    [
      input.organizationId,
      exposureId,
      input.activityId,
      input.athleteId,
      input.discipline,
      input.segmentNumber,
      input.roundType,
      input.durationSec,
      input.partnerAthleteId ?? null,
      input.partnerWeightDeltaLb ?? null,
      input.partnerRankDelta ?? null,
      input.submissionsApplied ?? 0,
      input.submissionsReceived ?? 0,
      neckExposure,
      input.jointExposure ?? 'none',
      input.impactToHead ?? 'none',
      input.takedownsConceded ?? null,
      input.coachObservedIntensity,
      input.athletePresentation ?? null,
      coachNote,
      input.supervisingCoachAccountId,
      input.stoppedEarly ?? false,
      input.stopRuleId ?? null,
    ],
  );
  if (!row) {
    throw new Error('Unable to record grappling exposure.');
  }
  return row;
}

export async function listGrapplingExposure(
  organizationId: string,
  athleteId: string,
): Promise<GrapplingExposureRow[]> {
  return query<GrapplingExposureRow>(
    `select ${GRAPPLING_EXPOSURE_FIELDS}
     from pilot.grappling_exposure
     where organization_id = $1 and athlete_id = $2
     order by created_at desc`,
    [organizationId, athleteId],
  );
}

export type DisciplineParticipationLevel =
  | 'observing' | 'technique_only' | 'controlled_live' | 'full_training' | 'competing';

export interface AthleteDisciplineParticipationRow {
  organization_id: string;
  participation_id: string;
  athlete_id: string;
  discipline: string;
  participation_level: DisciplineParticipationLevel;
  authority_source: string;
  determined_by_account_id: string;
  determined_by_role: string;
  determined_at: string;
  expires_on: string | null;
  note: string;
}

export interface RecordDisciplineParticipationInput {
  organizationId: string;
  athleteId: string;
  discipline: string;
  participationLevel: DisciplineParticipationLevel;
  authoritySource: string;
  determinedByAccountId: string;
  determinedByRole: string;
  expiresOn?: string;
  note?: string;
}

/**
 * Records a human's determination of which discipline a person may train in
 * and at what level. Never computed -- authoritySource names who decided
 * (head coach, PA state rules, physician), matching the table's own
 * comment that this records a determination rather than making one.
 */
export async function recordDisciplineParticipation(
  input: RecordDisciplineParticipationInput,
): Promise<AthleteDisciplineParticipationRow> {
  const participationId = randomUUID();
  const row = await queryOne<AthleteDisciplineParticipationRow>(
    `insert into pilot.athlete_discipline_participation
       (organization_id, participation_id, athlete_id, discipline, participation_level,
        authority_source, determined_by_account_id, determined_by_role, expires_on, note)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     returning organization_id, participation_id, athlete_id, discipline, participation_level,
               authority_source, determined_by_account_id, determined_by_role, determined_at,
               expires_on, note`,
    [
      input.organizationId,
      participationId,
      input.athleteId,
      input.discipline,
      input.participationLevel,
      input.authoritySource,
      input.determinedByAccountId,
      input.determinedByRole,
      input.expiresOn ?? null,
      input.note ?? '',
    ],
  );
  if (!row) {
    throw new Error('Unable to record discipline participation.');
  }
  return row;
}

export async function getCurrentDisciplineParticipation(
  organizationId: string,
  athleteId: string,
): Promise<AthleteDisciplineParticipationRow[]> {
  return query<AthleteDisciplineParticipationRow>(
    `select distinct on (discipline) organization_id, participation_id, athlete_id, discipline,
            participation_level, authority_source, determined_by_account_id, determined_by_role,
            determined_at, expires_on, note
     from pilot.athlete_discipline_participation
     where organization_id = $1 and athlete_id = $2
     order by discipline, determined_at desc`,
    [organizationId, athleteId],
  );
}

export type MixedAgeRelationship = 'parent_guardian' | 'sibling_adult' | 'other_family' | 'unrelated_adult';
export type MixedAgeContactPermitted = 'none' | 'technique_only' | 'controlled_light';

export interface MixedAgeSessionRecordRow {
  organization_id: string;
  record_id: string;
  activity_id: string;
  youth_athlete_id: string;
  adult_account_id: string;
  relationship: MixedAgeRelationship;
  pairing_permitted_by_account_id: string;
  contact_permitted: MixedAgeContactPermitted;
  supervising_coach_account_id: string;
  note: string;
  created_at: string;
}

export interface RecordMixedAgeSessionInput {
  organizationId: string;
  activityId: string;
  youthAthleteId: string;
  adultAccountId: string;
  relationship: MixedAgeRelationship;
  pairingPermittedByAccountId: string;
  contactPermitted?: MixedAgeContactPermitted;
  supervisingCoachAccountId: string;
  note?: string;
}

/**
 * Records a parent-and-child (or other mixed-age) pairing so the session can
 * be audited. Refuses up front, ahead of pilot_mixed_age_unrelated, when
 * relationship='unrelated_adult' carries a note under 15 characters --
 * silence is not acceptable in a safeguarding record.
 */
export async function recordMixedAgeSession(
  input: RecordMixedAgeSessionInput,
): Promise<MixedAgeSessionRecordRow> {
  const note = input.note?.trim() ?? '';
  if (input.relationship === 'unrelated_adult' && note.length < MIN_UNRELATED_ADULT_NOTE_LENGTH) {
    throw new Error(
      `MIXED_AGE_UNRELATED_NOTE_REQUIRED: an unrelated adult paired with a youth athlete requires a note of at least ${MIN_UNRELATED_ADULT_NOTE_LENGTH} characters`,
    );
  }

  const recordId = randomUUID();
  const row = await queryOne<MixedAgeSessionRecordRow>(
    `insert into pilot.mixed_age_session_records
       (organization_id, record_id, activity_id, youth_athlete_id, adult_account_id, relationship,
        pairing_permitted_by_account_id, contact_permitted, supervising_coach_account_id, note)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     returning organization_id, record_id, activity_id, youth_athlete_id, adult_account_id, relationship,
               pairing_permitted_by_account_id, contact_permitted, supervising_coach_account_id, note,
               created_at`,
    [
      input.organizationId,
      recordId,
      input.activityId,
      input.youthAthleteId,
      input.adultAccountId,
      input.relationship,
      input.pairingPermittedByAccountId,
      input.contactPermitted ?? 'technique_only',
      input.supervisingCoachAccountId,
      note,
    ],
  );
  if (!row) {
    throw new Error('Unable to record mixed-age session.');
  }
  return row;
}

export async function listMixedAgeSessions(
  organizationId: string,
  youthAthleteId: string,
): Promise<MixedAgeSessionRecordRow[]> {
  return query<MixedAgeSessionRecordRow>(
    `select organization_id, record_id, activity_id, youth_athlete_id, adult_account_id, relationship,
            pairing_permitted_by_account_id, contact_permitted, supervising_coach_account_id, note,
            created_at
     from pilot.mixed_age_session_records
     where organization_id = $1 and youth_athlete_id = $2
     order by created_at desc`,
    [organizationId, youthAthleteId],
  );
}
