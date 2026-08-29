import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { AuditEventType } from '@/src/server/pilot/auditEventTypes';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import {
  getAnnotationSet,
  listAnnotationSetsForClip,
  type AnnotationSetRow,
} from '@/src/server/pilot/calibration/annotations';
import {
  assertVideoClippable,
  getCalibrationClip,
  type CalibrationClipRow,
} from '@/src/server/pilot/calibration/projects';

/**
 * The gate every calibration ANNOTATION route passes through.
 *
 * One file rather than five copies, because each of the checks below is a
 * one-line omission away from being wrong in a way review does not catch: a
 * route that forgets the ownership check reads another annotator's unsubmitted
 * work, a route that forgets `shadow_mirror: false` feeds calibration data
 * into SHADOW, and a route that forgets assertVideoClippable serves footage
 * the platform has since decided nobody may watch. Five copies means five
 * chances to omit one.
 *
 * WHAT THIS DOES NOT DO. It does not re-implement anything in
 * src/server/pilot/calibration/*. assertVideoClippable, the vocabulary
 * validation, the containment check and the submitted-set freeze all live
 * there (and, for the last three, in the database under that). This file
 * CALLS them and adds the two things a route needs that a data module cannot
 * know: who is asking, and whether the answer may be shown to them.
 */

/**
 * Who may annotate.
 *
 * Coaches and organization admins, and nobody else. The legacy 'admin' role is
 * NOT listed because access.ts's requireRole already treats it as an alias of
 * 'organization_admin' -- listing both would suggest they are two decisions.
 *
 * The rest of the role list is excluded by what the video read path already
 * does rather than by an opinion held here: assertActorCanAccessAthlete
 * refuses platform_owner and board by name and falls through to refuse
 * volunteer and staff, so an athlete- attributed clip would be unwatchable for
 * them anyway. A parent or athlete annotating a calibration study is not a
 * surface anyone has asked for and is not opened by guessing.
 */
export const ANNOTATOR_ROLES = ['coach', 'organization_admin'] as const;

export function requireAnnotator(principal: PilotPrincipal): void {
  requireRole(principal, [...ANNOTATOR_ROLES]);
}

/**
 * Every audit write this subsystem makes, with the SHADOW fan-out switched
 * off.
 *
 * writePilotAuditEvent mirrors into emitShadowEvent and shadow telemetry
 * unless `shadow_mirror` is exactly false. The owner's order for this build is
 * that calibration data does not feed SHADOW automatically: it is a
 * measurement of where trained humans disagree, and a disagreement corpus
 * silently becoming model input is the thing that would make the measurement
 * unrepeatable -- the study would be observing a system it had already
 * changed.
 *
 * The flag is forced here rather than passed at each call site, and the spread
 * is deliberately BEFORE the override so no caller can turn it back on by
 * passing `shadow_mirror: true`. A caller that wants a mirrored audit event is
 * writing about something other than calibration and should call
 * writePilotAuditEvent directly.
 *
 * `event_type` stays inside the closed vocabulary ('create' / 'update'). The
 * vocabulary is enforced by both auditEventTypes.ts and a database CHECK, so a
 * new value would need a migration; the distinct `entity_type` carries the
 * meaning instead.
 *
 * `entityType` IS THE HALF THAT GROWS. It is `text not null` in the schema --
 * no CHECK, no enum, no foreign key -- so a new calibration entity costs a
 * union member here and nothing in the database. 'calibration_adjudication'
 * was added when the adjudication write surface landed; the vocabulary that
 * would have needed a migration, `event_type`, was not touched.
 */
export async function writeCalibrationAuditEvent(input: {
  eventType: Extract<AuditEventType, 'create' | 'update'>;
  principal: PilotPrincipal;
  entityType:
    | 'calibration_annotation_set'
    | 'calibration_annotation_event'
    | 'calibration_adjudication';
  entityId: string;
  details: Record<string, unknown>;
}): Promise<void> {
  await writePilotAuditEvent({
    event_type: input.eventType,
    actor_account_id: input.principal.accountId,
    actor_role: input.principal.role,
    organization_id: input.principal.organizationId,
    entity_type: input.entityType,
    entity_id: input.entityId,
    details: input.details,
    shadow_mirror: false,
  });
}

/**
 * The clip, and proof that the video behind it may still be watched.
 *
 * assertVideoClippable is called on EVERY read and EVERY write, never once at
 * selection time, because that is the property projects.ts documents and the
 * reason it exists: a video can leave 'ready' after a clip is cut -- a late
 * scanner verdict, an admin block, an archive -- and a clip row is a pointer,
 * not a cached grant. An annotation session that checked once at the top would
 * go on serving footage the platform had since withdrawn for as long as the
 * annotator kept the tab open.
 *
 * The refusal it raises is VideoNotClippableError, whose message already
 * begins 'Forbidden' or 'Not found', so jsonError maps it without this
 * function inspecting it. Deliberately not caught and re-thrown as something
 * blander: an annotator whose clip has been quarantined mid-study needs to
 * know that is what happened.
 */
export async function loadPlayableClip(
  organizationId: string,
  calibrationClipId: string,
): Promise<CalibrationClipRow> {
  const clip = await getCalibrationClip(organizationId, calibrationClipId);
  if (!clip) {
    throw new Error('Not found: no such calibration clip in this organization');
  }

  await assertVideoClippable(organizationId, clip.video_session_id);
  return clip;
}

/**
 * The caller's OWN annotation set, by id, or a refusal indistinguishable from
 * "no such set".
 *
 * BLINDING IS NOT BUILT HERE, AND THIS IS NOT IT. The gate that stops one
 * annotator reading another's unsubmitted work across the whole subsystem is a
 * separate slice. What this does is narrower and unconditional: every route in
 * this directory addresses the CALLER'S set, so a set belonging to somebody
 * else is not a permission question, it is the wrong row. Returning it -- or
 * distinguishing it from a nonexistent one -- would tell annotator A that
 * annotator B has started, which is already a fact about B's work.
 *
 * Hence one message for both cases, matching the 403-vs-404 discipline the
 * video read path applies for the same reason.
 */
export async function loadOwnAnnotationSet(
  principal: PilotPrincipal,
  annotationSetId: string,
): Promise<AnnotationSetRow> {
  const set = await getAnnotationSet(principal.organizationId, annotationSetId);
  if (!set || set.annotator_account_id !== principal.accountId) {
    throw new Error('Not found: no such annotation set for this annotator');
  }
  return set;
}

/**
 * The caller's own set for one clip, or null when they have not opened one.
 *
 * listAnnotationSetsForClip is the UNBLINDED read -- its own docblock says so
 * and warns that wiring it to an annotator screen without a blinding gate
 * would defeat the study. It is used here because it is the only way to find a
 * set by (clip, annotator) rather than by id, and the filter below is applied
 * BEFORE anything is returned, so no row belonging to another annotator leaves
 * this function under any input. Nothing about the other sets -- not their
 * count, not their existence -- is derived from the list either.
 *
 * If a later change needs the other sets, it does not belong in this file.
 */
export async function findOwnAnnotationSetForClip(
  principal: PilotPrincipal,
  calibrationClipId: string,
): Promise<AnnotationSetRow | null> {
  const sets = await listAnnotationSetsForClip(principal.organizationId, calibrationClipId);
  return sets.find((set) => set.annotator_account_id === principal.accountId) ?? null;
}

/**
 * THE READ-ONLY CHECK. A submitted set can never be edited again.
 *
 * There are three enforcement layers and this is the outermost one. The
 * database trigger is the real guarantee (it holds against a backfill script
 * as well as against this route); recordAnnotationEvent and
 * deleteAnnotationEvent raise AnnotationSetSubmittedError one layer in. This
 * one exists so a route refuses BEFORE doing any of the work -- before minting
 * an event id, before writing an audit row -- and so the refusal names the
 * situation in words an annotator can act on.
 *
 * It must never be the only check, and it must never be relaxed to "warn". If
 * annotator A could revise their set after seeing B's, "independent" would be
 * a claim about intent rather than a property of the system, and every
 * agreement figure computed downstream would be worthless.
 *
 * 'Forbidden' prefix, so http.ts's jsonError makes it a 403 rather than
 * hiding the reason behind a 500.
 */
export function assertSetInProgress(set: AnnotationSetRow): void {
  if (set.status !== 'in_progress') {
    throw new Error(
      'Forbidden: this annotation set has been submitted and can no longer be changed',
    );
  }
}

/**
 * A field the caller left blank on an OPTIONAL control, normalised to "not
 * recorded".
 *
 * An unselected <select> posts ''. The calibration modules reject '' for an
 * optional vocabulary field with "Missing contact_zone", which is a 400 the
 * annotator cannot act on -- they did not choose a value because they did not
 * observe one.
 *
 * THIS IS NOT COERCION, AND THE DIRECTION IS WHAT MAKES IT SAFE. '' becomes
 * null, which the schema defines as "not recorded". It never becomes
 * 'unknown', which is a recorded observation -- "the annotator looked and
 * could not tell" -- and manufacturing one of those out of an empty form
 * control would produce a fabricated row indistinguishable from a real one
 * forever after. Applied ONLY to fields the ontology permits to be absent;
 * a required field's '' is left alone and is rejected, which is correct.
 */
export function blankToNull(value: unknown): unknown {
  if (value === '' || value === undefined) return null;
  return value;
}

/**
 * A millisecond field arriving over the wire, or null.
 *
 * JSON gives numbers, but an HTML number input gives a string, and
 * `Number('')` is 0 -- a bound that silently became the start of the video is
 * precisely the fabricated datum this subsystem exists not to produce. So a
 * string is parsed only when it is entirely digits, and anything else is
 * handed to the calibration module as-is, which rejects it by naming the
 * field.
 */
export function optionalMs(value: unknown): unknown {
  if (value === '' || value === null || value === undefined) return null;
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return Number(value);
  return value;
}
