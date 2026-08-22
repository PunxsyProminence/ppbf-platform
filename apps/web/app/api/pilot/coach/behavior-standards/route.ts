import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { getCoachDisplayName } from '@/src/server/pilot/achievements';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import {
  createStandard,
  isRecognitionKind,
  listStandards,
  raiseConductConcern,
  recognizeStandardMet,
  retireStandard,
} from '@/src/server/pilot/behaviorStandards';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// Behavior standards (module 125). The role split matters and is not
// incidental:
//
//   POSTING or RETIRING a standard is an organizational act -- it declares
//   what this gym expects of everyone -- so it is admin-only.
//
//   RECOGNIZING that an athlete met one, and RAISING a concern, are things
//   that happen on the floor, so coaches do both.
//
// A concern never lands here. raiseConductConcern files it into the
// safety-escalation ladder, where an org admin sees it and it carries an
// acknowledge/resolve lifecycle. There is no conduct log on this route and
// no way to add one through it.
//
// Both athlete-naming actions are authorized per athlete, not merely by
// role: filing a safeguarding conduct concern against a child is not
// something a coach with no relationship to that child may do, and the
// central gate (assertActorCanAccessAthlete) is what says which children
// this caller has.

const FLOOR_ROLES = ['coach', 'organization_admin', 'admin'] as const;
const POSTING_ROLES = ['organization_admin', 'admin'] as const;

const SEVERITIES = ['low', 'moderate', 'high', 'critical'] as const;
type Severity = (typeof SEVERITIES)[number];

const isSeverity = (value: unknown): value is Severity =>
  typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value);

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...FLOOR_ROLES]);

    const includeRetired = request.nextUrl.searchParams.get('include_retired') === 'true';
    const items = await listStandards(principal.organizationId, includeRetired);
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const body = (await request.json()) as Record<string, unknown>;

    if (body.action === 'post_standard') {
      requireRole(principal, [...POSTING_ROLES]);

      const standardName = text(body.standard_name)?.trim();
      if (!standardName) throw new ValidationError('A standard needs a name.');

      const recognitionKind = body.recognition_kind;
      if (!isRecognitionKind(recognitionKind)) {
        throw new ValidationError(
          'recognition_kind must be one of the platform\'s existing recognitions -- a posted standard says which recognition evidences it rather than inventing a new one.',
        );
      }

      const item = await createStandard({
        organizationId: principal.organizationId,
        standardName,
        description: text(body.description),
        recognitionKind,
        sortOrder: typeof body.sort_order === 'number' ? body.sort_order : undefined,
        createdByAccountId: principal.accountId,
      });
      if (!item) return hiddenNotFound();

      await audit(principal, 'create', item.standard_id, {
        action: 'post_standard',
        recognition_kind: recognitionKind,
      });
      return NextResponse.json({ item });
    }

    if (body.action === 'retire_standard') {
      requireRole(principal, [...POSTING_ROLES]);

      const standardId = text(body.standard_id)?.trim();
      if (!standardId) throw new ValidationError('Missing standard_id.');

      const item = await retireStandard(principal.organizationId, standardId);
      if (!item) return hiddenNotFound();

      await audit(principal, 'update', standardId, { action: 'retire_standard' });
      return NextResponse.json({ item });
    }

    if (body.action === 'recognize') {
      requireRole(principal, [...FLOOR_ROLES]);

      const standardId = text(body.standard_id)?.trim();
      const athleteId = text(body.athlete_id)?.trim();
      if (!standardId || !athleteId) {
        throw new ValidationError('recognize needs standard_id and athlete_id.');
      }
      await assertActorCanAccessAthlete(principal, athleteId);

      const coachDisplayName = await getCoachDisplayName(principal.organizationId, principal.accountId);
      const result = await recognizeStandardMet({
        organizationId: principal.organizationId,
        athleteId,
        standardId,
        coachAccountId: principal.accountId,
        coachDisplayName,
        note: text(body.note),
      });
      if (!result) return hiddenNotFound();

      return NextResponse.json({ item: result });
    }

    if (body.action === 'raise_concern') {
      requireRole(principal, [...FLOOR_ROLES]);

      const athleteId = text(body.athlete_id)?.trim();
      const reason = text(body.reason)?.trim();
      if (!athleteId) throw new ValidationError('raise_concern needs athlete_id.');
      await assertActorCanAccessAthlete(principal, athleteId);
      if (!reason) {
        throw new ValidationError(
          'A concern needs a reason in your own words. It goes to an org admin to handle, so it has to say what happened.',
        );
      }
      if (!isSeverity(body.severity)) {
        throw new ValidationError("severity must be 'low', 'moderate', 'high', or 'critical' -- your judgment, stated.");
      }

      const result = await raiseConductConcern({
        organizationId: principal.organizationId,
        athleteId,
        reason,
        severity: body.severity,
        standardId: text(body.standard_id)?.trim() || null,
        raisedByAccountId: principal.accountId,
        raisedByRole: principal.role,
      });

      // Audited as an escalation, not as a behavior record: the entity is the
      // escalation it became, and the athlete is not the subject of a log.
      await audit(principal, 'create', result.escalation_id, {
        action: 'raise_concern',
        routed_to: 'safety_escalations',
      });
      return NextResponse.json({ item: result });
    }

    throw new ValidationError(
      "action must be 'post_standard', 'retire_standard', 'recognize', or 'raise_concern'.",
    );
  } catch (error) {
    return jsonError(error);
  }
}

async function audit(
  principal: PilotPrincipal,
  eventType: 'create' | 'update',
  entityId: string,
  details: Record<string, unknown>,
) {
  await writePilotAuditEvent({
    event_type: eventType,
    actor_account_id: principal.accountId,
    actor_role: principal.role,
    organization_id: principal.organizationId,
    entity_type: 'behavior_standard',
    entity_id: entityId,
    details,
  });
}
