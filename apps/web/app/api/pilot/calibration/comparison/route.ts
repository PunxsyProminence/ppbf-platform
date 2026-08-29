import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import {
  listAnnotationEventsForAdjudication,
  listAnnotationSetsForAdjudication,
} from '@/src/server/pilot/calibration/blinding';
import {
  compareAnnotationSets,
  countDisagreementsByCategory,
} from '@/src/server/pilot/calibration/comparison';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

import { loadPlayableClip } from '../annotatorGate';

export const runtime = 'nodejs';

/**
 * WHERE THE TWO COACHES DISAGREED. Read-only, and derived on every request.
 *
 * Once both annotators have submitted their independent readings of one clip,
 * this is the one surface that puts them side by side: which actions they
 * paired, which one recorded and the other did not, and which cannot honestly
 * be paired at all. Nothing is written, nothing is settled, and no adjudication
 * is recorded here -- that is a later slice with its own gate and its own
 * table.
 *
 * ---------------------------------------------------------------------------
 * WHY IT LOADS THROUGH blinding.ts AND NOT THROUGH annotations.ts.
 *
 * The obvious loaders are annotations.ts::listAnnotationSetsForClip and
 * listAnnotationEvents. They are organization-scoped and apply NO blinding --
 * that module's own docblock says so and warns that wiring them to a screen
 * without a gate defeats the study. A comparison built on them would answer
 * with both readings the moment a request arrived, including while one
 * annotator was still working: the exact leak blinding.ts exists to prevent,
 * arriving through a new door. An annotator who had not yet submitted could
 * read their partner's complete work out of the diff.
 *
 * So the sets come from listAnnotationSetsForAdjudication and the events from
 * listAnnotationEventsForAdjudication, both of which refuse until every set on
 * the clip is submitted. The events loader re-evaluates the clip's eligibility
 * for itself rather than trusting that the sets call already passed, so the
 * gate below is stated three times over. That is defence in depth rather than
 * duplication, and the suite beside this file measures it: removing any one of
 * the three on its own still refuses, and the mutations are recorded there.
 *
 * ---------------------------------------------------------------------------
 * WHY requireRole COMES FROM access.ts AND NOT FROM http.ts.
 *
 * There are two exported functions of that name. access.ts's knows 'admin' is
 * a legacy spelling of 'organization_admin' and treats them as one role;
 * http.ts's does a bare `includes` on the role string and would 403 every
 * un-migrated admin row while looking correct in a fixture seeded only with
 * the new spelling. blinding.ts's own header names this and says a route built
 * on that module must take the access.ts one. resolveAdjudicationEligibility
 * resolves the alias the same way through isOrganizationAdminRole, so a route
 * on http.ts's variant would refuse a caller the module it depends on admits.
 *
 * platform_owner is absent, and deliberately: this surface exists so an
 * organization can settle a disagreement between its own two annotators, and
 * blinding.ts refuses a platform-wide role by name for the same reason.
 *
 * ---------------------------------------------------------------------------
 * NO AUDIT ROW. AUDIT_EVENT_TYPES is a closed vocabulary with no read or view
 * member, and writeCalibrationAuditEvent accepts only 'create' | 'update'.
 * Recording a read as an 'update' would be a false statement in the stream,
 * and widening the vocabulary needs a migration. This matches projects/route.ts
 * and clips/route.ts, which write no audit row on a list read. Whether an
 * administrator opening two coaches' raw readings should be disclosed in the
 * audit stream is an owner decision, not this route's to make.
 *
 * NO SCALAR. No agreement rate, no kappa, no score, no denominator. The
 * comparison module refuses to compute one and says why; a route that helpfully
 * added one at the wire would put the number back without the argument.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin']);

    const { searchParams } = new URL(request.url);
    const clipId = searchParams.get('calibration_clip_id')?.trim() ?? '';
    if (!clipId) {
      throw new Error('Missing calibration_clip_id');
    }

    // Role-agnostic, and re-checked on every read exactly as the five existing
    // calibration routes do it: a clip row is a pointer, not a cached grant,
    // and a video that has left 'ready' since the review screen was opened
    // must stop being readable immediately. A clip in another organization is
    // indistinguishable here from one that never existed.
    const clip = await loadPlayableClip(principal.organizationId, clipId);

    const context = {
      organizationId: principal.organizationId,
      actorRole: principal.role,
      actorAccountId: principal.accountId,
    };

    const sets = await listAnnotationSetsForAdjudication(context, clipId);

    /* EXACTLY TWO, CHECKED HERE, ON PURPOSE.
     *
     * resolveAdjudicationEligibility answers 'eligible' for a clip with a
     * SINGLE submitted set: `input.sets.every(isSubmitted)` is vacuously true
     * of a one-element array, so the only length it rejects is zero -- while
     * its docblock promises the caller "two raw readings". All eight unit cases
     * and all six pg cases stage two sets or none, so the one-set path is
     * untested at both layers and reaches a caller unannounced.
     *
     * It is NOT fixed there. That function is a mutation-tested authorization
     * primitive and widening its reason set is a separate decision with its own
     * evidence. What this route does instead is refuse for itself, so the
     * defect cannot reach compareAnnotationSets as `sets[1] === undefined` and
     * come back to an administrator as an opaque 500.
     *
     * Three or more is refused by the same line, and that is an honest
     * statement of the current behaviour rather than a decision about it:
     * nothing caps annotators per clip, compareAnnotationSets takes exactly
     * two, and WHICH pair -- or every pair -- is unanswered anywhere in this
     * codebase. Refusing makes that visible instead of quietly comparing the
     * first two rows a query happened to return.
     *
     * THE MESSAGE NAMES THE COUNT AND THE CONSTRAINT, and it has to. A bare
     * "not eligible" leaves an administrator unable to tell a bug from a
     * permission wall from a real structural limit, and those three want three
     * different next actions -- report it, ask for access, or decide which pair
     * the study means. So the refusal says how many submitted sets are on the
     * clip and says that comparison is pairwise.
     *
     * The count is safe to name: the caller is an organization administrator
     * asking about their own organization's clip, and the call above has
     * already established that every set on it is submitted.
     */
    if (sets.length !== 2) {
      throw new Error(
        `Forbidden: this clip has ${sets.length} submitted annotation `
        + `${sets.length === 1 ? 'set' : 'sets'}, and comparison is pairwise -- it reads `
        + 'exactly two independent readings of one clip. Which pair of three or more a study '
        + 'means is not a question this build answers.',
      );
    }

    const [setA, setB] = sets;

    const eventsA = await listAnnotationEventsForAdjudication(
      context,
      clipId,
      setA.annotation_set_id,
    );
    const eventsB = await listAnnotationEventsForAdjudication(
      context,
      clipId,
      setB.annotation_set_id,
    );
    if (eventsA === null || eventsB === null) {
      // Unreachable through this path -- both ids came out of the same clip's
      // own list -- and handled rather than asserted away, because that null
      // means "not on this clip" and a comparison built from a half-loaded
      // pair would be worse than a refusal.
      throw new Error('Not found: no such annotation set on this calibration clip');
    }

    const comparison = compareAnnotationSets(setA, eventsA, setB, eventsB);

    return NextResponse.json({
      ok: true,
      clip,
      comparison,
      // Counts per category, straight from the module. Counts, not rates: the
      // denominator is a question this route has no standing to answer.
      disagreement_counts: countDisagreementsByCategory(comparison),
    }, {
      // Two annotators' raw readings of a named clip, which points at a video
      // session and an athlete. Kept out of shared caches for the same reason
      // annotation-set/route.ts keeps its own body out of them.
      headers: { 'Cache-Control': 'private, no-store, max-age=0' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
