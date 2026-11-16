import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { gymToday } from '@/src/server/pilot/competenceCohorts';
import { ForbiddenError, NotFoundError, ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  INCIDENT_ID_MAX,
  LOSS_OF_CONSCIOUSNESS_VALUES,
  type LossOfConsciousness,
  MEDICAL_RESTRICTION_SOURCES,
  MEDICAL_RESTRICTION_VOID_ROLES,
  MEDICAL_RESTRICTION_WRITER_ROLES,
  type MedicalRestrictionRow,
  type MedicalRestrictionSource,
  type MedicalRestrictionVoidRole,
  type MedicalRestrictionWriterRole,
  NOTE_MAX,
  VOID_REASON_MAX,
  getMedicalRestrictionById,
  listMedicalRestrictions,
  parseDay,
  recordLbcInformed,
  recordMedicalRestriction,
  recordRelease,
  restrictionState,
  voidMedicalRestriction,
} from '@/src/server/pilot/medicalRestrictions';

export const runtime = 'nodejs';

// USA Boxing medical restrictions, staff side (Backbone P22; lane P22a).
//
// WHO. Coaches, organization admins and admins, and for each request only for
// an athlete assertActorCanAccessAthlete admits (a coach of this gym, #1480;
// an org admin for any live athlete in their own gym). That gate refuses
// deleted athletes, other gyms' athletes, platform_owner and board. Athletes
// and parents stop at the role gate: what they see of a restriction is a
// separate, narrower read (OW25-06 A: on file, minimum end date, release
// needed -- never the source or the loss-of-consciousness field). The
// organization is always the principal's own; there is no organization_id
// parameter.
//
// WHAT IS WRITTEN (OW25-05 A, OD-2026-11-10-002). action:
//   record        -- a new restriction for athlete_id.
//   release       -- the date the physician's clearance or medical release
//                    was signed. Set once. With the minimum end date passed,
//                    this is what lifts the gate; nothing else does.
//   lbc_informed  -- the date the LBC (or its registration chair) was told.
//                    Set once.
//   void          -- marks a record entered in error, with a reason. Gym admin
//                    only (organization_admin, admin); a coach is refused. The
//                    row stays and reads as voided (Overwatch, P22 step 1, Q7).
// There is no delete and no lift. A coach may stop, reduce or defer; nobody
// overrides the gate (AGENT_KERNEL.md authority doctrine).
//
// An action on a restriction_id reads the row in the principal's own
// organization first, then checks standing on THAT row's athlete. "Not yours"
// and "not real" are the same 404, so ids cannot be probed.
//
// STRICT BODY: every key must be one this route knows for that action.

const NO_STORE = { 'cache-control': 'private, no-store' };

const ACTION_FIELDS: Record<string, ReadonlySet<string>> = {
  record: new Set(['action', 'athlete_id', 'source', 'loss_of_consciousness', 'start_date', 'minimum_end_date', 'linked_incident_id', 'note']),
  release: new Set(['action', 'restriction_id', 'release_signed_on']),
  lbc_informed: new Set(['action', 'restriction_id', 'lbc_informed_on']),
  void: new Set(['action', 'restriction_id', 'reason']),
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requiredEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`Unsupported ${field}: must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`Missing ${field}`);
  return value.trim();
}

function optionalText(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ValidationError(`Unsupported ${field}: must be text`);
  const text = value.trim();
  if (text.length > max) throw new ValidationError(`Unsupported ${field}: longer than ${max} characters`);
  return text;
}

/** A recorded date may not be in the future: a release or a call to the LBC has happened, or it has not. */
function pastOrToday(day: string, field: string): string {
  if (day > gymToday()) throw new ValidationError(`Unsupported ${field}: cannot be after today`);
  return day;
}

function withState(row: MedicalRestrictionRow, today: string) {
  return { ...row, state: restrictionState(row, today) };
}

/** The row, if it exists in this organization AND the caller has standing on its athlete; otherwise one 404. */
async function restrictionForActor(
  principal: Parameters<typeof assertActorCanAccessAthlete>[0],
  restrictionIdRaw: unknown,
): Promise<MedicalRestrictionRow> {
  const restrictionId = requiredText(restrictionIdRaw, 'restriction_id');
  const notFound = new NotFoundError('Not found: no such medical restriction');
  if (!UUID.test(restrictionId)) throw notFound;
  const row = await getMedicalRestrictionById(principal.organizationId, restrictionId);
  if (!row) throw notFound;
  try {
    await assertActorCanAccessAthlete(principal, row.athlete_id);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Forbidden')) throw notFound;
    throw error;
  }
  return row;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...MEDICAL_RESTRICTION_WRITER_ROLES]);
    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim() ?? '';
    if (!athleteId) throw new ValidationError('Missing athlete_id');
    await assertActorCanAccessAthlete(principal, athleteId);
    const today = gymToday();
    const rows = await listMedicalRestrictions(principal.organizationId, athleteId);
    return NextResponse.json(
      { ok: true, today, restrictions: rows.map((row) => withState(row, today)) },
      { headers: NO_STORE },
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...MEDICAL_RESTRICTION_WRITER_ROLES]);
    const actorRole = principal.role as MedicalRestrictionWriterRole;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ValidationError('Request body must be JSON.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be a JSON object.');
    }
    const input = body as Record<string, unknown>;
    const action = typeof input.action === 'string' ? input.action : '';
    const allowed = ACTION_FIELDS[action];
    if (!allowed) throw new ValidationError('Unsupported action: must be record, release, lbc_informed or void');
    const unknownKeys = Object.keys(input).filter((key) => !allowed.has(key));
    if (unknownKeys.length > 0) {
      throw new ValidationError(`Unsupported field(s) for ${action}: ${unknownKeys.join(', ')}`);
    }

    const today = gymToday();

    if (action === 'record') {
      const athleteId = requiredText(input.athlete_id, 'athlete_id');
      const source = requiredEnum<MedicalRestrictionSource>(input.source, 'source', MEDICAL_RESTRICTION_SOURCES);
      const lossOfConsciousness = requiredEnum<LossOfConsciousness>(
        input.loss_of_consciousness,
        'loss_of_consciousness',
        LOSS_OF_CONSCIOUSNESS_VALUES,
      );
      const startDate = parseDay(input.start_date, 'start_date');
      const minimumEndDate = parseDay(input.minimum_end_date, 'minimum_end_date');
      if (minimumEndDate < startDate) {
        throw new ValidationError('Unsupported minimum_end_date: must be on or after start_date');
      }
      const linkedIncidentId = optionalText(input.linked_incident_id, 'linked_incident_id', INCIDENT_ID_MAX) || null;
      const note = optionalText(input.note, 'note', NOTE_MAX);
      await assertActorCanAccessAthlete(principal, athleteId);
      const row = await recordMedicalRestriction({
        organizationId: principal.organizationId,
        athleteId,
        source,
        lossOfConsciousness,
        startDate,
        minimumEndDate,
        linkedIncidentId,
        note,
        actorAccountId: principal.accountId,
        actorRole,
      });
      return NextResponse.json({ ok: true, restriction: withState(row, today) }, { status: 201, headers: NO_STORE });
    }

    if (action === 'void') {
      // Role first, before the row is read: a coach learns nothing about the id.
      if (!(MEDICAL_RESTRICTION_VOID_ROLES as readonly string[]).includes(principal.role)) {
        throw new ForbiddenError('Forbidden: only a gym admin can mark a medical restriction entered in error');
      }
      const reason = optionalText(input.reason, 'reason', VOID_REASON_MAX);
      if (!reason) throw new ValidationError('Missing reason: say why this record was entered in error');
      const existing = await restrictionForActor(principal, input.restriction_id);
      const row = await voidMedicalRestriction({
        organizationId: principal.organizationId,
        restrictionId: existing.restriction_id,
        reason,
        actorAccountId: principal.accountId,
        actorRole: principal.role as MedicalRestrictionVoidRole,
      });
      if (!row) throw new NotFoundError('Not found: no such medical restriction');
      return NextResponse.json({ ok: true, restriction: withState(row, today) }, { headers: NO_STORE });
    }

    const existing = await restrictionForActor(principal, input.restriction_id);

    if (action === 'release') {
      const releaseSignedOn = pastOrToday(parseDay(input.release_signed_on, 'release_signed_on'), 'release_signed_on');
      if (releaseSignedOn < existing.start_date) {
        throw new ValidationError('Unsupported release_signed_on: a release cannot be signed before the restriction started');
      }
      const row = await recordRelease({
        organizationId: principal.organizationId,
        restrictionId: existing.restriction_id,
        releaseSignedOn,
        actorAccountId: principal.accountId,
        actorRole,
      });
      if (!row) throw new NotFoundError('Not found: no such medical restriction');
      return NextResponse.json({ ok: true, restriction: withState(row, today) }, { headers: NO_STORE });
    }

    // lbc_informed
    const lbcInformedOn = pastOrToday(parseDay(input.lbc_informed_on, 'lbc_informed_on'), 'lbc_informed_on');
    const row = await recordLbcInformed({
      organizationId: principal.organizationId,
      restrictionId: existing.restriction_id,
      lbcInformedOn,
      actorAccountId: principal.accountId,
      actorRole,
    });
    if (!row) throw new NotFoundError('Not found: no such medical restriction');
    return NextResponse.json({ ok: true, restriction: withState(row, today) }, { headers: NO_STORE });
  } catch (error) {
    return jsonError(error);
  }
}
