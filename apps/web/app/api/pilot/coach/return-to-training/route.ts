import { NextResponse, type NextRequest } from 'next/server';

import { assertAthleteBelongsToOrganization, assertCoachAssignedToAthlete } from '@/src/server/pilot/access';
import { getInjuryById, linkInjuryToPlan } from '@/src/server/pilot/athleteInjuries';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { ConflictError, NotFoundError, ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import {
  addReturnToTrainingStep,
  advanceReturnToTrainingStep,
  createReturnToTrainingPlan,
  listReturnToTrainingPlans,
  listReturnToTrainingSteps,
  type ReturnToTrainingPlanRow,
  type ReturnToTrainingStepRow,
  type RttPermittedContact,
  type RttScaleLevel,
  type RttTriggeringEvent,
} from '@/src/server/pilot/safetyFlags';
import { SHADOW_PHI_ROLES } from '@/src/server/pilot/shadowRoleSets';

export const runtime = 'nodejs';

// Every response names a child's injury and the coach's plan for it.
const NO_STORE = { headers: { 'cache-control': 'private, no-store' } };

/**
 * The coach's return-to-training plan on an injury record (lane P8). Read the
 * athlete's plans and their steps, create a plan on an injury, add a step,
 * advance the current step.
 *
 * Who: SHADOW_PHI_ROLES -- coach, organization_admin, admin -- the same gate
 * as coach/injuries, because a plan names one child's injury. A coach reaches
 * only athletes they coach or cover (assertCoachAssignedToAthlete); an
 * organization admin reaches any live athlete in their organization. Every
 * action names the athlete, standing is checked on that athlete first, and a
 * plan or step is then accepted only if it is in THAT athlete's list -- so a
 * plan id from another athlete, or another organization, is the same 404 as
 * one that does not exist, and a coach cannot probe ids.
 *
 * NOT A MEDICAL CLEARANCE (OD-2026-09-21-001; safetyFlags.ts header): the
 * rest period and earliest return date are entered by the coach from the
 * governing rule or a physician, never computed here, and advancing a step is
 * the signed-in coach's recorded decision with a note. Nothing here lifts a
 * training hold; a hold has its own route and rule.
 *
 * Creating a plan on an injury links the injury to it (the injury's expected
 * return then reads from the plan, athleteInjuries.ts:24). The plan row, its
 * audit row and the link are separate writes, not one transaction (neither
 * module takes a client). The link itself is atomic and link-only
 * (linkInjuryToPlan): an injury edit made meanwhile is kept, and of two
 * coaches creating a plan on the same injury at once only the first links;
 * the second sees a 409 and their plan stays unlinked. A plan whose link
 * failed is audited and listed as a link candidate on the injury page; link
 * it from the injury record rather than creating another.
 */

const TRIGGERING_EVENTS: readonly RttTriggeringEvent[] = [
  'confirmed_concussion', 'knockout', 'technical_knockout', 'injury', 'illness', 'other',
];
const PERMITTED_CONTACT: readonly RttPermittedContact[] = [
  'none', 'light_technical', 'conditioned', 'controlled_sparring', 'open_sparring',
];
const SCALE_LEVELS: readonly RttScaleLevel[] = ['A', 'B', 'C'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 2000;

function str(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value.trim() : '';
}

function text(body: Record<string, unknown>, key: string): string {
  const value = str(body, key);
  if (value.length > MAX_TEXT) throw new ValidationError(`${key} must be at most ${MAX_TEXT} characters.`);
  return value;
}

function oneOf<T extends string>(values: readonly T[], value: unknown, field: string, fallback?: T): T {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new ValidationError(`${field} must be one of: ${values.join(', ')}.`);
  }
  return value as T;
}

function dateOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'string' && ISO_DATE.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value < '0001-01-01') {
    throw new ValidationError(`${field} must be a date (YYYY-MM-DD).`);
  }
  return value;
}

function positiveIntOrNull(value: unknown, field: string, max: number): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new ValidationError(`${field} must be a whole number from 1 to ${max}.`);
  }
  return value;
}

async function assertStanding(principal: PilotPrincipal, athleteId: string): Promise<void> {
  if (principal.role === 'coach') {
    await assertCoachAssignedToAthlete(principal.accountId, athleteId, principal.organizationId);
  } else {
    await assertAthleteBelongsToOrganization(principal.organizationId, athleteId);
  }
}

/** The injury, only if this principal has standing with its athlete; otherwise the same 404 as absent. */
async function injuryWithStanding(principal: PilotPrincipal, injuryId: string) {
  const injury = await getInjuryById(principal.organizationId, injuryId);
  if (!injury || injury.entered_in_error) throw new NotFoundError('Injury record not found.');
  try {
    await assertStanding(principal, injury.athlete_id);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Forbidden')) {
      throw new NotFoundError('Injury record not found.');
    }
    throw error;
  }
  return injury;
}

/**
 * The plan, only if it is one of the named athlete's plans. Standing with the
 * athlete has already been asserted by the caller; a plan outside that list
 * is reported as absent, whatever it is.
 */
async function planOfAthlete(organizationId: string, athleteId: string, planId: string): Promise<ReturnToTrainingPlanRow> {
  const plans = await listReturnToTrainingPlans(organizationId, { athleteId });
  const plan = plans.find((row) => row.plan_id === planId);
  if (!plan) throw new NotFoundError('Return-to-training plan not found.');
  return plan;
}

/** The first step not yet advanced, in week order: the one the athlete is on. */
function currentStep(steps: ReturnToTrainingStepRow[]): ReturnToTrainingStepRow | null {
  return steps.find((step) => step.advanced_at === null) ?? null;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_PHI_ROLES]);

    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim() ?? '';
    if (!athleteId) throw new ValidationError('athlete_id is required.');
    await assertStanding(principal, athleteId);

    const plans = await listReturnToTrainingPlans(principal.organizationId, { athleteId });
    const withSteps = await Promise.all(
      plans.map(async (plan) => {
        const steps = await listReturnToTrainingSteps(principal.organizationId, plan.plan_id);
        return { ...plan, steps, current_step_id: currentStep(steps)?.step_id ?? null };
      }),
    );
    return NextResponse.json({ ok: true, plans: withSteps }, NO_STORE);
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_PHI_ROLES]);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') throw new ValidationError('Missing request body.');
    const action = str(body, 'action');

    if (action === 'create_plan') {
      const injuryId = str(body, 'injury_id');
      if (!injuryId) throw new ValidationError('injury_id is required.');
      const injury = await injuryWithStanding(principal, injuryId);
      if (injury.linked_rtt_plan_id) {
        throw new ConflictError('This injury already has a return-to-training plan.', 'RTT_PLAN_ALREADY_LINKED');
      }

      const authoritySource = text(body, 'authority_source');
      if (!authoritySource) throw new ValidationError('authority_source is required: who set the rest period (rulebook, physician).');
      // The plan becomes the one source of the expected return (the link
      // clears the injury's own), so a date the coach already entered on the
      // injury carries into the plan rather than being dropped.
      const earliestReturnDate = dateOrNull(body.earliest_return_date, 'earliest_return_date') ?? injury.expected_return_date;
      if (earliestReturnDate && earliestReturnDate < injury.injury_date) {
        throw new ValidationError("earliest_return_date is before this injury's date.");
      }
      const clearanceOnFile = body.medical_clearance_on_file;
      if (clearanceOnFile !== undefined && clearanceOnFile !== null && typeof clearanceOnFile !== 'boolean') {
        throw new ValidationError('medical_clearance_on_file must be true or false.');
      }

      const plan = await createReturnToTrainingPlan({
        organizationId: principal.organizationId,
        athleteId: injury.athlete_id,
        triggeringEvent: oneOf(TRIGGERING_EVENTS, body.triggering_event, 'triggering_event', 'injury'),
        eventDate: dateOrNull(body.event_date, 'event_date') ?? injury.injury_date,
        authoritySource,
        restPeriodDays: positiveIntOrNull(body.rest_period_days, 'rest_period_days', 3650),
        earliestReturnDate,
        medicalClearanceOnFile: clearanceOnFile === true,
        enteredByAccountId: principal.accountId,
        enteredByRole: principal.role,
        note: text(body, 'note'),
      });

      // Audited as soon as the record exists, before the link: a link that
      // fails must not leave a health record with no audit row.
      await writePilotAuditEvent({
        event_type: 'create',
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'return_to_training_plan',
        entity_id: plan.plan_id,
        // Ids and enums only: authority_source is free text and can name a
        // physician, and details are mirrored into the shadow event stream.
        details: { injury_id: injuryId, triggering_event: plan.triggering_event, medical_clearance_on_file: plan.medical_clearance_on_file },
      });

      // Link only: the row's other fields are left as they are now, not as
      // they were read above, and a plan linked meanwhile wins (409).
      const linked = await linkInjuryToPlan({
        organizationId: principal.organizationId,
        injuryId,
        planId: plan.plan_id,
        updatedByAccountId: principal.accountId,
      });
      return NextResponse.json({ ok: true, plan: { ...plan, steps: [], current_step_id: null }, injury: linked }, NO_STORE);
    }

    if (action === 'add_step') {
      const athleteId = str(body, 'athlete_id');
      const planId = str(body, 'plan_id');
      if (!athleteId || !planId) throw new ValidationError('athlete_id and plan_id are required.');
      await assertStanding(principal, athleteId);
      const plan = await planOfAthlete(principal.organizationId, athleteId, planId);
      if (plan.status !== 'active') {
        throw new ConflictError(`This plan is ${plan.status}; steps are added to an active plan.`, 'RTT_PLAN_NOT_ACTIVE');
      }

      const weekNumber = positiveIntOrNull(body.week_number, 'week_number', 520);
      if (weekNumber === null) throw new ValidationError('week_number must be a whole number from 1 to 520.');
      const intensityLabel = text(body, 'intensity_label');
      if (!intensityLabel) throw new ValidationError("intensity_label is required: the coach's own words for the week's ceiling.");

      // A week at or below one already advanced would become the current
      // step and move the athlete's ceiling backwards without anyone deciding
      // that. Weeks are added ahead of where the athlete is.
      const advancedWeeks = (await listReturnToTrainingSteps(principal.organizationId, planId))
        .filter((step) => step.advanced_at !== null)
        .map((step) => step.week_number);
      const highestAdvanced = advancedWeeks.length > 0 ? Math.max(...advancedWeeks) : 0;
      if (weekNumber <= highestAdvanced) {
        throw new ConflictError(
          `Week ${highestAdvanced} has already been advanced; add a week after it.`,
          'RTT_STEP_WEEK_ALREADY_PASSED',
        );
      }

      const step = await addReturnToTrainingStep({
        organizationId: principal.organizationId,
        planId,
        weekNumber,
        intensityLabel,
        permittedContact: oneOf(PERMITTED_CONTACT, body.permitted_contact, 'permitted_contact', 'none'),
        permittedScaleLevel: body.permitted_scale_level === undefined || body.permitted_scale_level === null || body.permitted_scale_level === ''
          ? null
          : oneOf(SCALE_LEVELS, body.permitted_scale_level, 'permitted_scale_level'),
        plannedNote: text(body, 'planned_note'),
      });

      await writePilotAuditEvent({
        event_type: 'create',
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'return_to_training_step',
        entity_id: step.step_id,
        details: { plan_id: planId, week_number: step.week_number, permitted_contact: step.permitted_contact },
      });
      return NextResponse.json({ ok: true, step }, NO_STORE);
    }

    throw new ValidationError('action must be create_plan or add_step.');
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Advance the current step: the coach's decision that the athlete has done
 * this week's work and may move to the next ceiling, with their note. Only
 * the current step (the earliest not yet advanced) can be advanced, so a
 * plan is walked in order and a stale page cannot skip a week.
 */
export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_PHI_ROLES]);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') throw new ValidationError('Missing request body.');
    const athleteId = str(body, 'athlete_id');
    const planId = str(body, 'plan_id');
    const stepId = str(body, 'step_id');
    if (!athleteId || !planId || !stepId) throw new ValidationError('athlete_id, plan_id and step_id are required.');
    const note = text(body, 'advancement_note');

    await assertStanding(principal, athleteId);
    const plan = await planOfAthlete(principal.organizationId, athleteId, planId);
    if (plan.status !== 'active') {
      throw new ConflictError(`This plan is ${plan.status}; its steps are not advanced.`, 'RTT_PLAN_NOT_ACTIVE');
    }
    const steps = await listReturnToTrainingSteps(principal.organizationId, planId);
    const current = currentStep(steps);
    const named = steps.find((step) => step.step_id === stepId);
    if (!named) throw new NotFoundError('Return-to-training step not found.');
    if (named.advanced_at !== null) {
      throw new ConflictError(`Week ${named.week_number} has already been advanced.`, 'RTT_STEP_ALREADY_ADVANCED');
    }
    if (!current || current.step_id !== stepId) {
      throw new ConflictError(
        current
          ? `Week ${current.week_number} is the current step; advance it first.`
          : 'Every step of this plan has been advanced.',
        'RTT_STEP_NOT_CURRENT',
      );
    }

    const step = await advanceReturnToTrainingStep({
      organizationId: principal.organizationId,
      stepId,
      advancedByAccountId: principal.accountId,
      advancementNote: note,
    });

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'return_to_training_step',
      entity_id: step.step_id,
      details: { plan_id: planId, week_number: step.week_number, advanced: true },
    });
    return NextResponse.json({ ok: true, step }, NO_STORE);
  } catch (error) {
    return jsonError(error);
  }
}
