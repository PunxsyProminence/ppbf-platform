import { NextResponse, type NextRequest } from 'next/server';

import { applyImport } from '@/src/server/pilot/contentImport/apply';
import { promptDrills, WORKOUT_PROMPT_DATASET, workoutIntakePrompt } from '@/src/server/pilot/contentImport/aiPrompt';
import { emitContentImportAuditMirror } from '@/src/server/pilot/contentImport/auditRow';
import { planImport } from '@/src/server/pilot/contentImport/plan';
import { ContentImportRefusal } from '@/src/server/pilot/contentImport/refusal';
import { checkUploadRequest, planView, readUploadBody } from '@/src/server/pilot/contentImport/upload';
import { withPoolClient, withTransaction } from '@/src/server/pilot/db';
import { listDrillLibrary } from '@/src/server/pilot/drillLibraryV3';
import { ConflictError, ForbiddenError } from '@/src/server/pilot/errors';
import { jsonError, requireMicrosoftAuthenticatedPrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

/**
 * Loading the gym's reference content -- disciplines, competence levels,
 * cohorts, the drill library, universal stop rules, workout templates and
 * session scripts -- from CSV files chosen in the browser (IMP-12; R1 "for
 * future work it will be 2"). It is the same core the seed workflow runs
 * (src/server/pilot/contentImport/, plan.ts THE SEAM): same parse, same
 * validation, same plan, same apply. Only the source of the files differs.
 *
 * ORGANIZATION ADMINS ONLY. requireRole names organization_admin and admin
 * (the flagged default: "the upload screen is for organization admins only";
 * the plan's decision 18). A coach is refused here, and the platform owner is
 * refused here AND by the core, which never lets the platform owner load gym
 * content (contentImport/actor.ts, ACTOR_PLATFORM_OWNER). Microsoft sign-in
 * (http.ts requireMicrosoftAuthenticatedPrincipal), the tier the neighbouring
 * organization-admin writes use (data-deletion, activation codes, coach
 * coverage); administrators sign in with Entra ID (authProviders.ts). The
 * core then checks the account again, in the database: active, not deleted,
 * and an ACTIVE membership in this gym (actor.ts).
 *
 * THE GYM IS THE SESSION'S, AND NOTHING ELSE. The organization comes from
 * principal.organizationId only. The body's other fields are never read, so a
 * body that names an organization is not refused and not obeyed -- it has no
 * effect at all. A file that carries a literal organization id is a blocking
 * finding of the core (validate.ts 'literal_organization'), so it cannot
 * steer the write either.
 *
 * CHECKING IS THE DEFAULT. A body without `commit: true` is parsed,
 * validated and planned inside a READ ONLY transaction -- the database itself
 * refuses any write -- and the plan comes back: new, new version, unchanged,
 * absent, blocking findings, warnings, and its plan_hash. Nothing is written.
 *
 * APPLY RUNS WHAT WAS SHOWN, OR NOTHING. `commit: true` must carry the
 * plan_hash of that preview. apply.ts plans again under its locks inside
 * withTransaction (db.ts:173) and refuses if the hash moved (STALE_PLAN) or
 * anything blocks (PLAN_BLOCKED); either refusal rolls back and is a 409 the
 * page answers with "check the files again". Every write, the history ledger
 * and the one audit row (auditRow.ts, inside the transaction) commit together
 * or not at all.
 *
 * THE SHADOW MIRROR COMES AFTER COMMIT, as auditRow.ts requires: it records an
 * event that happened, so it is written only once the import has. If it fails
 * the import is still committed, and the answer says both, never "failed".
 *
 * CAPS AND RESEARCH are upload.ts's: files, rows and bytes, each refusal
 * naming its number, and research refused by name.
 */
export async function POST(request: NextRequest) {
  try {
    const { principal, organizationId } = await admit(request);

    const upload = checkUploadRequest(await readUploadBody(request));

    if (!upload.commit) {
      const plan = await withTransaction(async (client) => {
        await client.query('set transaction read only');
        return planImport({ client, organizationId, actorAccountId: principal.accountId, files: upload.files });
      });
      return NextResponse.json({ ok: true, committed: false, plan: planView(plan, upload.files) });
    }

    const expectedPlanHash = upload.planHash as string;
    const result = await withTransaction((client) =>
      applyImport({ client, organizationId, actorAccountId: principal.accountId, files: upload.files, expectedPlanHash }));

    let auditMirror: 'written' | 'failed' | 'not_needed' = 'not_needed';
    if (result.audit) {
      const audit = result.audit;
      try {
        await withPoolClient((client) => emitContentImportAuditMirror(client, audit));
        auditMirror = 'written';
      } catch {
        // Fixed text only: the import id is ours, and the driver's message
        // can carry connection detail (db.ts sanitizedPoolErrorLog, same rule).
        console.error('content-import-audit-mirror-failed', { importId: result.importId });
        auditMirror = 'failed';
      }
    }

    return NextResponse.json({
      ok: true,
      committed: true,
      plan: planView(result.plan, upload.files),
      import_id: result.importId,
      audit_id: result.auditId,
      written: result.written,
      ledger_rows: result.ledgerRows,
      audit_mirror: auditMirror,
    });
  } catch (error) {
    return jsonError(asHttpError(error));
  }
}

/**
 * The one gate of this route, for both verbs: Microsoft sign-in, an
 * organization admin, and a gym on the session.
 */
async function admit(request: NextRequest) {
  const principal = await requireMicrosoftAuthenticatedPrincipal(request);
  requireRole(principal, ['organization_admin', 'admin']);
  const organizationId = principal.organizationId;
  if (!organizationId) {
    throw new Error('Forbidden: no organization on this session');
  }
  return { principal, organizationId };
}

/**
 * The workout intake prompt (contentImport/aiPrompt.ts): the text an admin
 * pastes into another AI assistant with a workout written in their own words,
 * to get back the two workout-template files this route's POST loads.
 *
 * SAME DOOR AS THE UPLOAD: admit() above is the one gate, so whoever may not
 * load gym content may not fetch the prompt for it either.
 *
 * IT CARRIES THIS GYM'S DRILLS, AND ONLY THEIRS (OD-2026-10-02-012). The list
 * is listDrillLibrary for the session's organization -- principal.organizationId
 * through admit(), never anything the request names -- so it is the coach
 * browse list: current versions only (active, not superseded). promptDrills()
 * keeps three fields of each row (lineage key, name, primary skill code); the
 * rest of the row, and anything of the session, does not reach the text.
 * Which drill states count as "the gym's list" is the owner's open question;
 * the current library versions are the proposed default.
 */
export async function GET(request: NextRequest) {
  try {
    const { organizationId } = await admit(request);
    const drills = promptDrills(await listDrillLibrary(organizationId));
    return NextResponse.json({ ok: true, dataset: WORKOUT_PROMPT_DATASET, prompt: workoutIntakePrompt(drills) });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * A refusal of the core is an answer written for the person (refusal.ts), so
 * it is passed on with its status; anything else stays an opaque 500.
 * NOT_IN_TRANSACTION would be this route's own bug, so it stays a 500 too.
 */
function asHttpError(error: unknown): unknown {
  if (!(error instanceof ContentImportRefusal)) return error;
  const message = error.message.replace(/^CONTENT_IMPORT_[A-Z_]+: /, '');
  switch (error.code) {
    case 'STALE_PLAN':
    case 'PLAN_BLOCKED':
      return new ConflictError(message, error.code);
    case 'NOT_IN_TRANSACTION':
      return error;
    default:
      // ORGANIZATION_NOT_FOUND and every ACTOR_* refusal: this account may not
      // load this gym's content.
      return new ForbiddenError(message, error.code);
  }
}
