import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowAuthority, type ShadowAutomationMode } from '@/src/server/pilot/shadowAuthority';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import {
  effectiveMedicalStatus,
  getLatestMedicalAdministrativeStatus,
  setMedicalAdministrativeStatus,
  type MedicalAdministrativeStatusValue,
} from '@/src/server/pilot/shadowMedicalStatus';
import { SHADOW_PHI_ROLES } from '@/src/server/pilot/shadowRoleSets';

export const runtime = 'nodejs';

const STATUS_VALUES = new Set<string>(['cleared', 'restricted', 'not_cleared', 'pending']);

// Validated as a closed set rather than accepted verbatim. The two sibling
// assertShadowAuthority call sites take automation_mode straight off the body
// with no check, and the audit found the consequence: the one denial branch
// that fires on automationMode === 'automatic' is evaded by sending
// "Automatic", because nothing normalizes or rejects the casing and the column
// carries no CHECK either. This route refuses an unrecognised mode outright.
const AUTOMATION_MODES = new Set<string>(['automatic', 'assisted', 'manual']);

// Every table this route writes to, including the authority-check ledger. A
// database missing shadow_authority_checks would otherwise fail the request
// mid-write, after the authority decision was made and before it was recorded.
const REQUIRED_TABLES = ['shadow_medical_administrative_status', 'shadow_authority_checks'];

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

/**
 * Parses the optional expiry.
 *
 * Absent means "no stated expiry", which is the same behaviour this record had
 * before an expiry existed at all -- see the TODO(owner) on
 * ShadowMedicalAdministrativeStatusRow.expires_at for why no interval is
 * defaulted in here. A supplied expiry must be a real timestamp in the future:
 * an already-lapsed clearance is not a clearance, and accepting one would
 * write a record that reads as expired the instant it lands, which is a
 * data-entry mistake rather than an intent anyone has.
 */
function parseExpiresAt(value: unknown, nowMs: number): { ok: boolean; value: string | null } {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 40) {
    return { ok: false, value: null };
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || parsed <= nowMs) {
    return { ok: false, value: null };
  }
  return { ok: true, value: new Date(parsed).toISOString() };
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    // SHADOW_PHI_ROLES, not the projection read set: medical clearance is
    // organization-private health information and platform_owner must never
    // reach it. See shadowRoleSets.ts for why Omega is narrower here, not wider.
    requireRole(principal, [...SHADOW_PHI_ROLES]);

    const athleteId = request.nextUrl.searchParams.get('athleteId');
    if (!boundedString(athleteId, 300)) {
      return NextResponse.json({ ok: false, error: 'athleteId is required.' }, { status: 400 });
    }

    await assertActorCanAccessAthlete(principal, athleteId);
    await assertShadowRuntimeReadiness({ requiredTables: ['shadow_medical_administrative_status'] });

    const status = await getLatestMedicalAdministrativeStatus(principal.organizationId, athleteId);
    // `status` is the row as stored -- a lapsed clearance still reads
    // status: 'cleared' there, because the record of who cleared this athlete
    // and when must not vanish. `effectiveStatus` is what the gates act on:
    // 'no_record', 'cleared_expired', or the stored value. Additive, so
    // existing readers of `status` are unaffected.
    return NextResponse.json({
      ok: true,
      status,
      effectiveStatus: effectiveMedicalStatus(status),
    });
  } catch (error) {
    return jsonError(error);
  }
}

interface MedicalStatusRequestBody {
  athleteId?: unknown;
  status?: unknown;
  restrictionFlags?: unknown;
  sourceReference?: unknown;
  expiresAt?: unknown;
  automationMode?: unknown;
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    // SHADOW_PHI_ROLES, not the projection read set: medical clearance is
    // organization-private health information and platform_owner must never
    // reach it. See shadowRoleSets.ts for why Omega is narrower here, not wider.
    //
    // NOTE: this set admits any coach with access to the athlete, and that is
    // deliberately UNCHANGED here. Whether writing a clearance should require
    // narrower authority than coaching the athlete is an escalated
    // authorization question for the owner, not something to settle inside a
    // fix; see the PR that added the authority check below.
    requireRole(principal, [...SHADOW_PHI_ROLES]);

    const body = (await request.json().catch(() => ({}))) as MedicalStatusRequestBody;
    const expiresAt = parseExpiresAt(body.expiresAt, Date.now());
    const automationMode = body.automationMode ?? 'manual';
    if (
      !boundedString(body.athleteId, 300)
      || typeof body.status !== 'string'
      || !STATUS_VALUES.has(body.status)
      || !expiresAt.ok
      || typeof automationMode !== 'string'
      || !AUTOMATION_MODES.has(automationMode)
      || (body.sourceReference !== undefined && !boundedString(body.sourceReference, 500))
      || (
        body.restrictionFlags !== undefined
        && (typeof body.restrictionFlags !== 'object' || body.restrictionFlags === null || Array.isArray(body.restrictionFlags))
      )
    ) {
      return NextResponse.json({ ok: false, error: 'Medical status payload is invalid.' }, { status: 400 });
    }

    const restrictionFlags = body.restrictionFlags as Record<string, unknown> | undefined;

    await assertActorCanAccessAthlete(principal, body.athleteId);
    await assertShadowRuntimeReadiness({ requiredTables: REQUIRED_TABLES });

    // The authority gate this write was missing entirely.
    //
    // shadowAuthority.ts exists for exactly this class of action -- its
    // forbidden-action list names 'clear', 'concussion', 'sparring',
    // 'weight_cut' and 'medical_decision' -- and this route, the ONLY writer of
    // the table every contact-clearance gate reads, never called it. Three
    // other SHADOW routes did.
    //
    // The arguments are chosen so the check can actually deny rather than being
    // a formality:
    //
    // - `action` carries the status being written, so 'cleared' and
    //   'not_cleared' both match the forbidden-clearance list by name. An
    //   automatic actor proposing either is refused with the decider's own
    //   reason.
    // - `lowRisk: false` and `reversible: false` refuse ANY automatic actor
    //   whatever status it proposes, without depending on the action string.
    //   Both are honest: this record decides whether a child may take contact,
    //   and while a later row can supersede it, contact already taken while it
    //   read 'cleared' cannot be undone. Passing `true` for these is what left
    //   the sibling call sites unable to deny anything.
    // - `withinApprovedOptions: true` is earned: `status` was just checked
    //   against the closed STATUS_VALUES set above.
    // - `confidenceTier: 'NOT_APPLICABLE'` because no inference produced this.
    //   A human is transcribing an administrative fact; claiming a model
    //   confidence tier for it would be fiction.
    // - `restrictionConflict` is computed, not hardcoded false: recording
    //   'cleared' while attaching restriction flags to the same record is
    //   self-contradictory, and it matters because no reader anywhere consults
    //   restriction_flags -- every gate compares `status` only. Such a write
    //   would look like "cleared with limits" to the person making it and read
    //   as "fully cleared" to every gate. The decider refuses it.
    //
    // No free text goes into `metadata`: sourceReference can carry clinical
    // detail, so only its presence is recorded.
    await assertShadowAuthority({
      actor: principal,
      organizationId: principal.organizationId,
      action: `shadow.medical_administrative_status.set.${body.status}`,
      automationMode: automationMode as ShadowAutomationMode,
      confidenceTier: 'NOT_APPLICABLE',
      lowRisk: false,
      reversible: false,
      withinApprovedOptions: true,
      restrictionConflict: body.status === 'cleared' && Object.keys(restrictionFlags ?? {}).length > 0,
      metadata: {
        athlete_id: body.athleteId,
        status: body.status,
        expires_at: expiresAt.value,
        source_reference_present: body.sourceReference !== undefined,
      },
    });

    const status = await setMedicalAdministrativeStatus({
      organizationId: principal.organizationId,
      athleteId: body.athleteId,
      status: body.status as MedicalAdministrativeStatusValue,
      restrictionFlags,
      sourceReference: body.sourceReference as string | undefined,
      expiresAt: expiresAt.value,
      setByAccountId: principal.accountId,
      setByRole: principal.role,
    });

    return NextResponse.json({
      ok: true,
      status,
      effectiveStatus: effectiveMedicalStatus(status),
    });
  } catch (error) {
    return jsonError(error);
  }
}
