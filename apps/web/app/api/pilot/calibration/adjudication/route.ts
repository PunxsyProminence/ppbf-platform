import { randomUUID } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import {
  ADJUDICATION_RESOLUTION_TYPES,
  MISSED_EVENT_VERDICTS,
  RESOLVED_FROM_SOURCES,
  listAdjudicatedFields,
  listAdjudicationsForClip,
  recordAdjudication,
  type AdjudicatedFieldInput,
  type RecordAdjudicationInput,
} from '@/src/server/pilot/calibration/adjudication';
import type {
  AnnotationEventRow,
  AnnotationSetRow,
} from '@/src/server/pilot/calibration/annotations';
import {
  listAnnotationEventsForAdjudication,
  listAnnotationSetsForAdjudication,
} from '@/src/server/pilot/calibration/blinding';
import { DISAGREEMENT_CATEGORIES } from '@/src/server/pilot/calibration/comparison';
import type { CalibrationClipRow } from '@/src/server/pilot/calibration/projects';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

import { blankToNull, loadPlayableClip, writeCalibrationAuditEvent } from '../annotatorGate';

export const runtime = 'nodejs';

/**
 * HOW EACH DISAGREEMENT WAS SETTLED. The write half.
 *
 * An organization administrator who has seen where the two coaches disagreed
 * records, one decision at a time, what the disagreement actually was: whose
 * reading is accepted, whether both readings were equivalent after all,
 * whether an event only one coach marked really happened, or that the footage
 * cannot settle it. Every one of those is a row in
 * pilot.calibration_adjudications with the provenance that makes it a
 * DECISION rather than a third annotation.
 *
 * ---------------------------------------------------------------------------
 * THE GATE IS THE POINT OF THIS FILE, AND IT IS THE THING THAT WAS MISSING.
 *
 * `src/server/pilot/calibration/adjudication.ts` does not import blinding.ts.
 * Not a call, not a type, not a comment -- so `recordAdjudication` validates
 * its own vocabularies and its own row shape, and has NO opinion whatsoever
 * about whether the clip it is writing about was ever eligible to be
 * adjudicated. Every refusal blinding.ts exists to make -- not an
 * organization admin, nothing annotated here, a coach still working, one
 * reading where a pair was promised -- is invisible to it. The database
 * cannot help either: its foreign keys tie an adjudication to two sets on one
 * clip, and a set that is still `in_progress` satisfies every one of them.
 *
 * So a write surface built on `recordAdjudication` alone would settle a clip
 * that the READ half (`/api/pilot/calibration/comparison`) would refuse to
 * show -- the leak blinding.ts was written to prevent, arriving through the
 * write door. Worse in one respect than the read leak: it would leave a
 * durable row asserting that a human weighed two readings, when one of them
 * was not finished being written.
 *
 * `loadAdjudicableClip` below is therefore on the ONLY path to the write.
 * Both handlers go through it, it calls
 * `listAnnotationSetsForAdjudication`, and the two annotation set ids the
 * insert uses are the ones that call RETURNED -- they are never read from the
 * request body. A caller cannot name a pair; it can only settle the pair the
 * gate handed back.
 *
 * ---------------------------------------------------------------------------
 * WHY requireRole COMES FROM access.ts AND NOT FROM http.ts.
 *
 * There are two exported functions of that name. access.ts's resolves the
 * legacy 'admin' spelling to 'organization_admin' through `roleEquals` and
 * treats them as one role; http.ts's does a bare `includes` on the role
 * string and would 403 every un-migrated admin row while looking correct
 * against a fixture seeded only with the new spelling. blinding.ts's own
 * header says a route built on that module must take the access.ts one, and
 * it is right for a sharper reason than style: `resolveAdjudicationEligibility`
 * admits the legacy row through `isOrganizationAdminRole`, so a route on the
 * http.ts variant would refuse a caller that the module it depends on
 * admits -- two gates disagreeing about the same person on the same request.
 *
 * platform_owner is absent, and that is a decision rather than an omission.
 * blinding.ts refuses it by name: this surface exists so an ORGANIZATION can
 * settle a disagreement between its own two annotators, and a platform-wide
 * role is not a party to that. The building-map door for the page in front of
 * this route carries `roles: ['admin']` for the same reason, so the corridor
 * does not advertise a door the API refuses.
 *
 * ---------------------------------------------------------------------------
 * NO VOCABULARY IS VALIDATED HERE, and none is re-stated. Not the resolution
 * types, not the missed-event verdicts, not the disagreement categories, not
 * the rule that a `new_adjudicated_value` must carry the value it claims.
 * All of it belongs to `recordAdjudication` and, under that, to the CHECK
 * constraints -- and a copy of those rules in a route is a copy that drifts,
 * which for a controlled vocabulary means two surfaces silently accepting
 * different sets of labels. This is the same division events/route.ts states
 * for annotations.
 *
 * What this route DOES decide is everything the module cannot see: who is
 * asking, whether the footage may still be watched, whether the clip is
 * eligible at all, which two sets the decision is between, which vocabulary
 * it is filed under, and whether a named source event is really in the
 * reading it is being attributed to.
 *
 * ---------------------------------------------------------------------------
 * NO COMPARISON. This route computes no pairings, no disagreement counts and
 * no agreement figure of any kind. `compareAnnotationSets` is not imported.
 * Where the coaches disagreed is the read half's answer and restating it here
 * would be two surfaces deriving the same thing from the same rows. What the
 * GET below serves is the working set a DECISION needs -- the two readings'
 * raw events, so a decision can name one -- plus what has already been
 * settled on this clip.
 */

/**
 * WHO MAY SETTLE A DISAGREEMENT, in one place.
 *
 * Exported so the building-map door in front of this route can be checked
 * against it executably rather than by a comment claiming the two agree. The
 * `roles` on a door is advisory -- buildingMap.ts's header says so twice --
 * but advertising a door the API refuses is the specific failure that header
 * warns about, and nothing in this repository enforces it. The suite beside
 * this file runs the same access.ts `requireRole` against every role the door
 * advertises.
 *
 * 'admin' is deliberately NOT listed beside 'organization_admin': access.ts's
 * requireRole resolves the legacy spelling through `roleEquals`, so naming
 * both would suggest they are two decisions. platform_owner is absent for the
 * reason blinding.ts gives by name.
 */
export const ADJUDICATION_ROLES = ['organization_admin'] as const;

/** Both handlers' subject: the clip, the pair the gate admitted, and the two
 *  readings' events loaded through the same gate. */
interface AdjudicableClip {
  readonly clip: CalibrationClipRow;
  readonly setA: AnnotationSetRow;
  readonly setB: AnnotationSetRow;
  readonly eventsA: readonly AnnotationEventRow[];
  readonly eventsB: readonly AnnotationEventRow[];
}

/**
 * THE GATE, AND THE ONLY WAY TO THE WRITE.
 *
 * Order is load-bearing and is the order the read half uses:
 *
 *   1. the footage is still watchable -- re-checked on every request, never
 *      cached from clip selection, because a clip row is a pointer and not a
 *      grant. `loadPlayableClip` is role-agnostic; the role gate has already
 *      run in the handler above, before anything at all was read.
 *   2. `listAnnotationSetsForAdjudication` -- role AND state, from
 *      blinding.ts. It throws AdjudicationNotPermittedError for a
 *      non-administrator, for a clip nobody has annotated, for a clip where
 *      any set is still in progress, and for a clip carrying a single
 *      submitted set.
 *   3. exactly two, checked here as well.
 *   4. one vocabulary.
 *   5. the events of each reading, each loaded through the gated loader,
 *      which re-evaluates the clip's eligibility for itself rather than
 *      trusting that step 2 passed.
 *
 * That is the gate stated four times over between here and blinding.ts, and
 * it is defence in depth rather than duplication: the suite beside this file
 * measures which refusal each one is responsible for, and asserts the
 * OBSERVABLE difference -- that no reading was loaded, that no adjudication
 * was written -- rather than a status code that several of them produce.
 */
async function loadAdjudicableClip(
  principal: PilotPrincipal,
  calibrationClipId: string,
): Promise<AdjudicableClip> {
  const clip = await loadPlayableClip(principal.organizationId, calibrationClipId);

  const context = {
    organizationId: principal.organizationId,
    actorRole: principal.role,
  };

  const sets = await listAnnotationSetsForAdjudication(context, calibrationClipId);

  /* EXACTLY TWO.
   *
   * `resolveAdjudicationEligibility` now refuses zero and one on its own --
   * it names 'insufficient_sets_for_comparison' for a lone submitted set --
   * so in practice this line fires only at THREE OR MORE. It is written for
   * any count anyway, because a route whose correctness depends on a
   * refusal one module away is a route that breaks silently when that module
   * is widened.
   *
   * THREE OR MORE IS REFUSED, AND THAT IS A STATEMENT OF THE OPEN QUESTION
   * RATHER THAN AN ANSWER TO IT. Nothing in this schema caps annotators per
   * clip, `compareAnnotationSets` takes exactly two, and WHICH pair of three
   * or more -- or every pair -- a study means is unanswered anywhere in this
   * codebase. Picking the first two rows a query happened to return would
   * settle that by accident, in a table a gold dataset is later built from.
   * OWNER DECISION, flagged in the pull request rather than made here.
   *
   * The message names the count and the constraint. A bare "not eligible"
   * leaves an administrator unable to tell a bug from a permission wall from
   * a real structural limit, and those three want three different next
   * actions. The count is safe to name: the caller is an organization
   * administrator asking about their own organization's clip, and the call
   * above has already established that every set on it is submitted.
   */
  if (sets.length !== 2) {
    throw new Error(
      `Forbidden: this clip has ${sets.length} submitted annotation `
      + `${sets.length === 1 ? 'set' : 'sets'}, and adjudication is pairwise -- it settles a `
      + 'disagreement between exactly two independent readings of one clip. Which pair of '
      + 'three or more a study means is not a question this build answers.',
    );
  }

  const [setA, setB] = sets;

  /* ONE VOCABULARY, OR NO DECISION.
   *
   * `comparison.ts` refuses ONTOLOGY_VERSION_MISMATCH because two
   * vocabularies are two measurements and pooling them manufactures
   * disagreements out of a renamed label. The same fact is worse on the write
   * side: `pilot.calibration_adjudications.ontology_version` is a single
   * column, so a decision between two vocabularies would have to be filed
   * under one of them and would afterwards be indistinguishable from a
   * decision genuinely made under it.
   *
   * Checked here rather than delegated because nothing else on this path
   * looks: `recordAdjudication` takes the version as an input and the
   * database only checks that it is non-blank.
   */
  if (setA.ontology_version !== setB.ontology_version) {
    throw new Error(
      'Forbidden: the two readings of this clip were collected under different vocabularies '
      + `(${setA.ontology_version} and ${setB.ontology_version}), which are two measurements `
      + 'rather than one disagreement.',
    );
  }

  const eventsA = await listAnnotationEventsForAdjudication(
    context,
    calibrationClipId,
    setA.annotation_set_id,
  );
  const eventsB = await listAnnotationEventsForAdjudication(
    context,
    calibrationClipId,
    setB.annotation_set_id,
  );
  if (eventsA === null || eventsB === null) {
    // Unreachable through this path -- both ids came out of the same clip's
    // own list -- and handled rather than asserted away, because that null
    // means "not on this clip" and a decision assembled from a half-loaded
    // pair would be worse than a refusal.
    throw new Error('Not found: no such annotation set on this calibration clip');
  }

  return { clip, setA, setB, eventsA, eventsB };
}

/** Two annotators' raw readings of a named clip, which points at a video
 *  session and an athlete. Kept out of shared caches for the same reason
 *  annotation-set/route.ts keeps its own body out of them. */
const PRIVATE_NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0' } as const;

/**
 * THE WORKING SET A DECISION NEEDS, plus what has already been settled.
 *
 * Serves the two readings' raw events because a decision has to NAME one of
 * them -- `source_event_id_a` is an event id, and a screen that cannot list
 * the events cannot offer the choice. It serves no pairing and no counts:
 * that is the read half's answer, and deriving it a second time here would be
 * two surfaces computing the same thing from the same rows.
 *
 * THE VOCABULARIES TRAVEL WITH THE PAYLOAD, and that is deliberate.
 * `adjudication.ts` imports ./db, so importing its arrays as VALUES into a
 * 'use client' page would pull the Postgres driver into the browser bundle --
 * the reason coach/calibration/page.tsx restates its wire shapes and imports
 * only ontology.ts, which has no imports at all. The remaining choices were to
 * retype five controlled vocabularies into <option> tags, or to serve them
 * from the one module that defines them. ontology.ts's own header says why the
 * first is not a choice: "a vocabulary that lives in a form's <option> tags
 * drifts the moment a second surface renders it."
 *
 * KNOWN COST, stated rather than hidden: the field decisions are read one
 * adjudication at a time. `adjudication.ts` exposes no batched read, and
 * adding one is a change to a module this branch does not own. A clip carries
 * a handful of adjudications, so this is a small constant, not a scan.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ADJUDICATION_ROLES]);

    const { searchParams } = new URL(request.url);
    const clipId = searchParams.get('calibration_clip_id')?.trim() ?? '';
    if (!clipId) {
      throw new Error('Missing calibration_clip_id');
    }

    const subject = await loadAdjudicableClip(principal, clipId);

    const recorded = await listAdjudicationsForClip(principal.organizationId, clipId);
    const adjudications = await Promise.all(
      recorded.map(async (adjudication) => ({
        ...adjudication,
        fields: await listAdjudicatedFields(
          principal.organizationId,
          adjudication.adjudication_id,
        ),
      })),
    );

    return NextResponse.json({
      ok: true,
      clip: subject.clip,
      sets: { a: subject.setA, b: subject.setB },
      events: { a: subject.eventsA, b: subject.eventsB },
      adjudications,
      vocabularies: {
        resolution_types: ADJUDICATION_RESOLUTION_TYPES,
        missed_event_verdicts: MISSED_EVENT_VERDICTS,
        resolved_from_sources: RESOLVED_FROM_SOURCES,
        disagreement_categories: DISAGREEMENT_CATEGORIES,
      },
    }, { headers: PRIVATE_NO_STORE });
  } catch (error) {
    return jsonError(error);
  }
}

interface AdjudicatedFieldBody {
  field_name?: unknown;
  disagreement_category?: unknown;
  resolved_from?: unknown;
  resolved_value?: unknown;
  unresolved?: unknown;
}

interface AdjudicationBody {
  calibration_clip_id?: unknown;
  source_event_id_a?: unknown;
  source_event_id_b?: unknown;
  resolution_type?: unknown;
  missed_event_verdict?: unknown;
  notes?: unknown;
  fields?: unknown;
}

/**
 * A source event id the caller left off the form, normalised to "no event on
 * this side".
 *
 * An unselected <select> posts ''. `recordAdjudication` reads '' as a present
 * id and hands it to the insert, where the composite foreign key refuses it
 * as SQLSTATE 23503 -- an opaque 500 for an administrator who simply did not
 * pick anything on that side. The direction is what makes this safe: '' and
 * undefined become null, which the schema defines as "this annotator recorded
 * nothing here" and which the CHECK still refuses when BOTH sides are null.
 * Nothing becomes an id.
 */
function optionalEventId(value: unknown): unknown {
  if (value === '' || value === null || value === undefined) return null;
  return value;
}

/**
 * A named source event really is in the reading it is being attributed to.
 *
 * THE DATABASE IS THE GUARANTEE, NOT THIS.
 * `pilot_calibration_adjudications_source_a_fk` is a composite key over
 * (organization, clip, annotation_set_id_a, source_event_id_a), so an event
 * belonging to B -- or to another clip, or to nothing -- is already refused
 * there, and the pg suite proves it. What this adds is the same thing
 * `assertSetInProgress` adds over its own trigger: the refusal happens BEFORE
 * anything is written, and it names the field in words the caller can act on
 * instead of arriving as a 500 out of a constraint name.
 *
 * A non-string id fails here too, and fails closed: `some()` over the loaded
 * events is false for anything that is not one of their ids.
 */
function assertEventInReading(
  eventId: unknown,
  events: readonly AnnotationEventRow[],
  field: 'source_event_id_a' | 'source_event_id_b',
  reading: 'A' | 'B',
): void {
  if (eventId === null) return;
  if (typeof eventId !== 'string' || !events.some((event) => event.event_id === eventId)) {
    throw new Error(
      `Missing ${field}: no event with that id in annotator ${reading}'s submitted reading `
      + 'of this clip',
    );
  }
}

/**
 * Records one adjudication and its field-level decisions.
 *
 * WHAT THE CALLER MAY NOT SUPPLY, and why each one is derived instead:
 *
 *   * `annotation_set_id_a` / `_b` -- taken from what the blinding gate
 *     returned. A body-supplied pair is a body-supplied claim about which two
 *     readings were weighed, and the gate is the only thing on this path that
 *     knows which pair is eligible. Deriving them also makes A and B mean the
 *     same thing here as on the comparison screen: both take the ordering
 *     from `listAnnotationSetsForClip`, which is `created_at asc,
 *     annotation_set_id asc` and therefore stable.
 *   * `adjudicator_account_id` -- the authenticated principal. Accepting it
 *     from the body would let an administrator file a decision under another
 *     person's name, in the one column that makes the row evidence.
 *   * `ontology_version` -- the vocabulary the two readings were actually
 *     collected under, checked equal above.
 *   * `adjudication_id` and every `adjudicated_field_id` -- minted here with
 *     randomUUID, as events/route.ts mints an event id. A client-chosen
 *     primary key is a client-chosen collision, and on this table a collision
 *     is one gym's decision overwriting another's.
 *
 * THE CAST ASSERTS NOTHING. Every value that came off the wire arrives as
 * `unknown` and leaves as `unknown`; the cast exists only because the module's
 * input interface is typed against its controlled vocabularies and TypeScript
 * cannot know a runtime string is one of them. `recordAdjudication` re-checks
 * every one through `isInVocabulary` and throws `Missing <field>` for a
 * non-member, so a wrong label is a 400 naming the field rather than a stored
 * row. Written once, here, rather than at each field.
 *
 * NOT ENFORCED, AND FLAGGED RATHER THAN INVENTED: nothing below refuses a
 * SECOND adjudication naming the same pair of source events. There is no
 * superseding column on this table and no update path in `adjudication.ts`,
 * so whether a later decision corrects an earlier one or sits beside it as a
 * second answer is an owner decision. The GET above returns everything
 * already recorded on the clip so the administrator can see the earlier
 * decision rather than be silently protected from it.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ADJUDICATION_ROLES]);

    const body = (await request.json().catch(() => ({}))) as AdjudicationBody;
    const clipId = typeof body.calibration_clip_id === 'string'
      ? body.calibration_clip_id.trim()
      : '';
    if (!clipId) {
      throw new Error('Missing calibration_clip_id');
    }

    // THE GATE. Nothing below this line may run for a clip it refuses, and
    // nothing above it has written anything.
    const { clip, setA, setB, eventsA, eventsB } = await loadAdjudicableClip(principal, clipId);

    const sourceEventIdA = optionalEventId(body.source_event_id_a);
    const sourceEventIdB = optionalEventId(body.source_event_id_b);
    assertEventInReading(sourceEventIdA, eventsA, 'source_event_id_a', 'A');
    assertEventInReading(sourceEventIdB, eventsB, 'source_event_id_b', 'B');

    const rawFields = body.fields;
    if (rawFields !== undefined && rawFields !== null && !Array.isArray(rawFields)) {
      throw new Error('Missing fields: the field decisions must be a list');
    }
    const fields = ((Array.isArray(rawFields) ? rawFields : []) as AdjudicatedFieldBody[]).map(
      (field) => ({
        adjudicatedFieldId: randomUUID(),
        fieldName: field.field_name,
        disagreementCategory: field.disagreement_category,
        resolvedFrom: field.resolved_from,
        // '' becomes null -- "the reviewer settled this field on nothing" is
        // not a value, and the module refuses a value on an unresolved field.
        resolvedValue: blankToNull(field.resolved_value),
        unresolved: field.unresolved,
      } as unknown as AdjudicatedFieldInput),
    );

    const { adjudication, fields: fieldDecisions } = await recordAdjudication({
      organizationId: principal.organizationId,
      adjudicationId: randomUUID(),
      calibrationClipId: clip.calibration_clip_id,
      annotationSetIdA: setA.annotation_set_id,
      annotationSetIdB: setB.annotation_set_id,
      sourceEventIdA,
      sourceEventIdB,
      resolutionType: body.resolution_type,
      missedEventVerdict: blankToNull(body.missed_event_verdict),
      adjudicatorAccountId: principal.accountId,
      ontologyVersion: setA.ontology_version,
      notes: typeof body.notes === 'string' && body.notes.trim().length > 0
        ? body.notes.trim()
        : null,
      fields,
    } as unknown as RecordAdjudicationInput);

    /* AN AUDIT ROW, AND THE VOCABULARY WAS CHECKED RATHER THAN ASSUMED.
     *
     * `event_type` is a closed vocabulary -- declared in auditEventTypes.ts
     * and again as a CHECK in pilot_slice_postgres.sql, held together by
     * auditEventVocabulary.test.ts -- and 'create' is already in it. Writing
     * a new adjudication IS a create, so no value is invented and no
     * migration is needed. `entity_type` carries the meaning instead: it is
     * `text not null` with no CHECK, no enum and no foreign key, which is the
     * convention annotatorGate.ts already documents and uses for
     * 'calibration_annotation_set' and 'calibration_annotation_event'.
     *
     * `shadow_mirror: false` is forced by writeCalibrationAuditEvent and
     * cannot be turned back on from here: a disagreement corpus silently
     * becoming model input would make the measurement unrepeatable.
     *
     * THE DETAILS RECORD THE ACT, NOT THE DECISION. The resolution, the
     * verdict, the two readings and the two source events -- enough to show
     * that a named administrator settled a named disagreement at a named
     * time. Not the resolved VALUES: the audit table must not become a second
     * copy of the adjudicated fields, which have their own table, their own
     * provenance columns and their own uniqueness rule.
     *
     * Written after the adjudication, outside its transaction, exactly as
     * events/route.ts does. A failure here therefore leaves a recorded
     * decision with no audit row, which is the correct direction: the
     * alternative is discarding a human's decision because a log write
     * failed.
     */
    await writeCalibrationAuditEvent({
      eventType: 'create',
      principal,
      entityType: 'calibration_adjudication',
      entityId: adjudication.adjudication_id,
      details: {
        calibration_clip_id: adjudication.calibration_clip_id,
        annotation_set_id_a: adjudication.annotation_set_id_a,
        annotation_set_id_b: adjudication.annotation_set_id_b,
        source_event_id_a: adjudication.source_event_id_a,
        source_event_id_b: adjudication.source_event_id_b,
        resolution_type: adjudication.resolution_type,
        missed_event_verdict: adjudication.missed_event_verdict,
        field_decision_count: fieldDecisions.length,
      },
    });

    return NextResponse.json(
      { ok: true, adjudication, fields: fieldDecisions },
      { headers: PRIVATE_NO_STORE },
    );
  } catch (error) {
    return jsonError(error);
  }
}
