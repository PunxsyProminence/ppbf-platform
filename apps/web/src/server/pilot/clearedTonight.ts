import { countOpenViolationsByAthlete } from './compliance';
import { guardianLinkEnded } from './guardianAccess';
import { ownConsentCoversNewPublication, readOwnMediaConsent } from './guardianConsent';
import {
  effectiveMedicalStatus,
  EXPIRED_CLEARANCE_STATUS,
  getLatestMedicalAdministrativeStatus,
  isClearanceCurrent,
  NO_CLEARANCE_RECORD_STATUS,
} from './shadowMedicalStatus';
import { listTrainingHolds, type TrainingHoldRow, type TrainingHoldScope } from './trainingHolds';
import {
  MEDIA_CONSENT_TRACKED_TYPE,
  normalizeWaiverStatusText,
  readOrganizationWaiverRoster,
  TRACKED_WAIVER_TYPES,
  type AthleteWaiverStatus,
  type TrackedWaiverType,
  type WaiverStatus,
} from './waiverCompliance';

/**
 * ONE "CLEARED TONIGHT" ANSWER PER ATHLETE (Jason, OD-2026-10-08-006 A-Q19:
 * "Build one answer"). The admin used to open three screens to learn it:
 * Sports Medicine for holds and medical clearance, Waiver Compliance, and the
 * photo and media consent audit.
 *
 * THIS MODULE DECIDES NOTHING AND STOPS NOTHING. It reads what the existing
 * records say and reports it. No route, gate or screen reads this answer to
 * allow or refuse anything, and none may start to: the rules it reports are
 * enforced where they always were (trainingHolds.ts, contactClearanceGate.ts).
 *
 * THE ANSWER FOLLOWS THE TWO RULES MAIN ALREADY HAS, and only those:
 *
 *   - a training hold (trainingHolds.ts): 'all_training' stops training,
 *     'contact_only' stops contact, 'conditioning_only' is a historical scope
 *     nothing enforces;
 *   - medical clearance (shadowMedicalStatus.ts isClearanceCurrent, "the one
 *     place the 'is this athlete cleared' question is answered").
 *
 * Whichever of the two is more restrictive is the answer. It is not a second
 * eligibility rule: HOLD_SCOPE_ANSWER is keyed by the hold module's own scope
 * type, and the medical half calls that module's own two functions.
 *
 * THE WORDS GO NO FURTHER THAN WHAT A RECORD SAYS. A medical record somebody
 * entered as 'not_cleared' or 'restricted' is reported as that. A clearance
 * that is simply not in force (no record, pending, a cleared record past its
 * expiry) is NOT reported as "no contact": nobody decided that about the
 * athlete, and main's contact gate does not refuse their contact either, it
 * flags it. That athlete is 'cleared_to_train', with the medical clearance
 * stated beside the answer as what is on file. /coach/sports-medicine reads
 * the same two records through the same functions and shows each as its own
 * badge; this composes them into one answer. The two screens do not use the
 * same badge for every status, by that ruling.
 *
 * EVERYTHING ELSE IS LISTED, NEVER WEIGHED. Waivers, photo and video consent
 * and open compliance violations are facts on file. No code on main makes any
 * of them a condition of training (admin/consent/page.tsx says so of waivers;
 * compliance.ts says closing a violation "does not clear" an athlete), so
 * none of them can move the answer here either.
 *
 * A SOURCE THAT COULD NOT BE READ IS 'unavailable', NEVER 'cleared'. One case
 * is inherited rather than decided here: listTrainingHolds reads a database
 * with no training_holds table at all as "no holds" (its documented
 * pre-migration contract, the same one the enforcement reads keep). Such a
 * database can hold no hold, so that is not a false answer; every other hold
 * read failure, and every medical read failure including a missing table, is
 * 'unavailable'.
 */

export const CLEARED_TONIGHT_ANSWERS = [
  'cleared',
  'cleared_to_train',
  'cleared_no_contact',
  'not_cleared',
  'unavailable',
] as const;
export type ClearedTonightAnswer = (typeof CLEARED_TONIGHT_ANSWERS)[number];
/** An answer a record gave, as against one nobody could read. */
type KnownAnswer = Exclude<ClearedTonightAnswer, 'unavailable'>;

/**
 * The hold as staff are shown it beside an action (trainingHolds.ts
 * StaffHoldWarning holds the same line): never reason_text, which is staff
 * free text that can carry medical detail.
 */
export interface ClearedTonightHold {
  scope: TrainingHoldScope;
  athlete_explanation: string;
  lift_condition_text: string;
  expires_at: string | null;
}

/**
 * `status` is effectiveMedicalStatus's word (a stored status, 'no_record' or
 * 'cleared_expired'); `current` is isClearanceCurrent's answer. Never the
 * record's restriction_flags, source_reference or who set it.
 */
export interface ClearedTonightMedical {
  status: string;
  current: boolean;
  expires_at: string | null;
}

export type ClearedTonightHoldRead = ClearedTonightHold | null | 'unavailable';
export type ClearedTonightMedicalRead = ClearedTonightMedical | 'unavailable';

/**
 * Photo and media consent, by who can give it. A minor's is the guardians'
 * (the existing check, as the worklist words it). At 18 a guardian's consent
 * stops counting for a new publication and the athlete records their own
 * (OD-2026-10-08-015): `own` is that decision as the publication gate reads
 * it -- 'video' only when it would let a new publication through
 * (ownConsentCoversNewPublication), 'none' when nothing of theirs counts.
 */
export type AdultOwnMediaConsentWord = 'video' | 'photo_only' | 'withdrawn' | 'none' | 'unavailable';

export type ClearedTonightMediaConsent =
  | { basis: 'guardian'; status: WaiverStatus }
  | { basis: 'adult_own_consent'; own: AdultOwnMediaConsentWord; outside_gym: boolean };

/** Already in the shape the route sends: the route copies it, nothing more. */
export interface ClearedTonight {
  answer: ClearedTonightAnswer;
  hold: ClearedTonightHoldRead;
  medical: ClearedTonightMedicalRead;
  waivers: Array<{ type: TrackedWaiverType; status: WaiverStatus; recorded_on: string | null }>;
  media_consent: ClearedTonightMediaConsent;
  open_violations: number | 'unavailable';
}

export interface AthleteClearedTonight extends AthleteWaiverStatus {
  tonight: ClearedTonight;
}

/**
 * What each hold scope means for tonight. A Record over the hold module's own
 * scope type, so a scope added there fails the build here until it is given
 * an answer, instead of silently reading 'cleared'.
 */
const HOLD_SCOPE_ANSWER: Record<TrainingHoldScope, KnownAnswer> = {
  all_training: 'not_cleared',
  contact_only: 'cleared_no_contact',
  conditioning_only: 'cleared',
};

const RESTRICTIVENESS: Record<KnownAnswer, number> = {
  cleared: 0,
  cleared_to_train: 1,
  cleared_no_contact: 2,
  not_cleared: 3,
};

/**
 * No hold stops nothing. A scope this module has no answer for is null, read
 * as "nobody could tell" -- the column's CHECK forbids one today, and the
 * Record above fails the build before a new scope could get here unanswered.
 */
function holdAnswer(hold: ClearedTonightHold | null): KnownAnswer | null {
  if (!hold) return 'cleared';
  return (HOLD_SCOPE_ANSWER as Partial<Record<string, KnownAnswer>>)[hold.scope] ?? null;
}

/** For choosing which of two holds to report: an unanswerable one outranks all. */
function holdRank(hold: ClearedTonightHold): number {
  return RESTRICTIVENESS[holdAnswer(hold) ?? 'not_cleared'];
}

/**
 * Postgres hands an expiry over as its own text ('2026-10-20 12:00:00+00').
 * Node reads that; a tablet's browser may not, and the screen would then state
 * an expiry with no day. Sent as ISO so the day can always be shown. A value
 * that will not parse is passed through as it is rather than dropped.
 */
function isoInstant(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : at.toISOString();
}

/**
 * What a medical record that is NOT a clearance in force says about tonight,
 * by effectiveMedicalStatus's word. Two of them are decisions a person
 * entered; the other three are the absence of one.
 */
const MEDICAL_NOT_CURRENT_ANSWER = new Map<string, KnownAnswer>([
  ['not_cleared', 'not_cleared'],
  ['restricted', 'cleared_no_contact'],
  ['pending', 'cleared_to_train'],
  [EXPIRED_CLEARANCE_STATUS, 'cleared_to_train'],
  [NO_CLEARANCE_RECORD_STATUS, 'cleared_to_train'],
]);

/**
 * A clearance in force changes nothing. Otherwise the record's own word
 * decides. A word this module does not know is null, read as "nobody could
 * tell": a status added to the table later must not read as cleared here.
 */
function medicalAnswer(medical: ClearedTonightMedical): KnownAnswer | null {
  if (medical.current) return 'cleared';
  return MEDICAL_NOT_CURRENT_ANSWER.get(medical.status) ?? null;
}

/**
 * The one answer, from the two reads.
 *
 * A known "not cleared" stands whatever else could not be read: nothing the
 * unread source might say can make it less true. Short of that, a source that
 * could not be read makes the answer 'unavailable', because the unread half
 * could be the one that says no.
 */
export function clearedTonightAnswer(
  hold: ClearedTonightHoldRead,
  medical: ClearedTonightMedicalRead,
): ClearedTonightAnswer {
  const fromHold = hold === 'unavailable' ? null : holdAnswer(hold);
  const fromMedical = medical === 'unavailable' ? null : medicalAnswer(medical);

  if (fromHold === 'not_cleared' || fromMedical === 'not_cleared') return 'not_cleared';
  if (fromHold === null || fromMedical === null) return 'unavailable';
  return RESTRICTIVENESS[fromMedical] > RESTRICTIVENESS[fromHold] ? fromMedical : fromHold;
}

// Logged without the row, the athlete or the error text: a hold or a medical
// status names one child.
function logUnreadable(source: string, error: unknown): void {
  console.error({
    event: 'cleared-tonight-source-unreadable',
    source,
    errorClass: error instanceof Error ? error.name : typeof error,
  });
}

/**
 * Every athlete's active hold, through the existing staff list read (the one
 * readStaffHoldWarnings uses): it sweeps lapsed holds first, so a hold whose
 * clock ran out is not reported as active. One athlete has at most one active
 * hold; were there ever two, the more restrictive is the one reported.
 */
async function readActiveHolds(organizationId: string): Promise<Map<string, ClearedTonightHold> | 'unavailable'> {
  let holds: TrainingHoldRow[];
  try {
    holds = await listTrainingHolds(organizationId, { status: 'active' });
  } catch (error) {
    logUnreadable('training_holds', error);
    return 'unavailable';
  }
  const byAthlete = new Map<string, ClearedTonightHold>();
  for (const hold of holds) {
    const next: ClearedTonightHold = {
      scope: hold.scope,
      athlete_explanation: hold.athlete_explanation,
      lift_condition_text: hold.lift_condition_text,
      expires_at: isoInstant(hold.expires_at),
    };
    const existing = byAthlete.get(hold.athlete_id);
    if (!existing || holdRank(next) > holdRank(existing)) {
      byAthlete.set(hold.athlete_id, next);
    }
  }
  return byAthlete;
}

async function readMedical(organizationId: string, athleteId: string, now: Date): Promise<ClearedTonightMedicalRead> {
  try {
    const record = await getLatestMedicalAdministrativeStatus(organizationId, athleteId);
    return {
      status: effectiveMedicalStatus(record, now),
      current: isClearanceCurrent(record, now),
      expires_at: isoInstant(record?.expires_at),
    };
  } catch (error) {
    // Includes a database the medical-status table has not reached: nobody
    // could look, which is not the same as nothing being on file.
    logUnreadable('medical_status', error);
    return 'unavailable';
  }
}

/** outside_gym: their yes covers use outside the gym (recorded; staff honour it, nothing enforces it yet). */
async function readAdultOwn(
  organizationId: string,
  athleteId: string,
): Promise<{ own: AdultOwnMediaConsentWord; outside_gym: boolean }> {
  try {
    const own = await readOwnMediaConsent(organizationId, athleteId);
    const outside = own?.publicUseAllowed === true;
    if (ownConsentCoversNewPublication(own)) return { own: 'video', outside_gym: outside };
    const status = normalizeWaiverStatusText(own?.status);
    if (status === 'withdrawn') return { own: 'withdrawn', outside_gym: false };
    if (status === 'signed' && own?.recordedByOwnLogin && own.coversVideo === false) return { own: 'photo_only', outside_gym: outside };
    return { own: 'none', outside_gym: false };
  } catch (error) {
    logUnreadable('adult_own_media_consent', error);
    return { own: 'unavailable', outside_gym: false };
  }
}

const PAPER_WAIVER_TYPES = TRACKED_WAIVER_TYPES.filter((type) => type !== MEDIA_CONSENT_TRACKED_TYPE);

/**
 * The roster with each athlete's answer and what it rests on.
 *
 * The waiver and consent read is the worklist's own (waiverCompliance.ts) and
 * fails the way it always has: it throws, and the caller answers an error
 * rather than a roster with consent guessed. Holds, medical status and the
 * violation count each degrade to 'unavailable' on their own, so one unread
 * source does not hide the others.
 */
export async function getOrganizationClearedTonight(
  organizationId: string,
  now: Date = new Date(),
): Promise<AthleteClearedTonight[]> {
  const roster = await readOrganizationWaiverRoster(organizationId);

  const [holds, openViolations] = await Promise.all([
    readActiveHolds(organizationId),
    countOpenViolationsByAthlete(organizationId).catch((error: unknown) => {
      logUnreadable('compliance_violations', error);
      return 'unavailable' as const;
    }),
  ]);

  return Promise.all(
    roster.map(async (entry): Promise<AthleteClearedTonight> => {
      const hold: ClearedTonightHoldRead = holds === 'unavailable' ? 'unavailable' : holds.get(entry.athleteId) ?? null;
      const medical = await readMedical(organizationId, entry.athleteId, now);
      const adult = guardianLinkEnded(entry.dob, now);
      return {
        athleteId: entry.athleteId,
        athleteName: entry.athleteName,
        activeFlag: entry.activeFlag,
        waivers: entry.waivers,
        tonight: {
          answer: clearedTonightAnswer(hold, medical),
          hold,
          medical,
          waivers: PAPER_WAIVER_TYPES.map((type) => ({
            type,
            status: entry.waivers[type],
            recorded_on: entry.recordedOn[type] ?? null,
          })),
          media_consent: adult
            ? { basis: 'adult_own_consent', ...(await readAdultOwn(organizationId, entry.athleteId)) }
            : { basis: 'guardian', status: entry.waivers[MEDIA_CONSENT_TRACKED_TYPE] },
          open_violations: openViolations === 'unavailable' ? 'unavailable' : openViolations.get(entry.athleteId) ?? 0,
        },
      };
    }),
  );
}
