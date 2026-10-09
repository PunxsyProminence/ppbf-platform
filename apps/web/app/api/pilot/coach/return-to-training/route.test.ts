import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { assertAthleteBelongsToOrganization, assertCoachAssignedToAthlete } from '@/src/server/pilot/access';
import { getInjuryById, updateInjury } from '@/src/server/pilot/athleteInjuries';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  addReturnToTrainingStep,
  advanceReturnToTrainingStep,
  createReturnToTrainingPlan,
  listReturnToTrainingPlans,
  listReturnToTrainingSteps,
} from '@/src/server/pilot/safetyFlags';

jest.mock('@/src/server/pilot/access', () => ({
  ...jest.requireActual('@/src/server/pilot/access'),
  assertAthleteBelongsToOrganization: jest.fn(),
  assertCoachAssignedToAthlete: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));

jest.mock('@/src/server/pilot/athleteInjuries', () => ({
  ...jest.requireActual('@/src/server/pilot/athleteInjuries'),
  getInjuryById: jest.fn(),
  updateInjury: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

jest.mock('@/src/server/pilot/safetyFlags', () => ({
  ...jest.requireActual('@/src/server/pilot/safetyFlags'),
  addReturnToTrainingStep: jest.fn(),
  advanceReturnToTrainingStep: jest.fn(),
  createReturnToTrainingPlan: jest.fn(),
  listReturnToTrainingPlans: jest.fn(),
  listReturnToTrainingSteps: jest.fn(),
}));

const mockPrincipal = requirePrincipal as jest.Mock;
const mockCoachAssigned = assertCoachAssignedToAthlete as jest.Mock;
const mockBelongs = assertAthleteBelongsToOrganization as jest.Mock;
const mockGetInjury = getInjuryById as jest.Mock;
const mockUpdateInjury = updateInjury as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;
const mockCreatePlan = createReturnToTrainingPlan as jest.Mock;
const mockListPlans = listReturnToTrainingPlans as jest.Mock;
const mockAddStep = addReturnToTrainingStep as jest.Mock;
const mockListSteps = listReturnToTrainingSteps as jest.Mock;
const mockAdvance = advanceReturnToTrainingStep as jest.Mock;

const ORG = 'org-1';
const URL = 'http://localhost/api/pilot/coach/return-to-training';
// The injury names a different athlete from the one any body names, so the
// standing check is proven to use the INJURY's athlete, not the caller's word.
const INJURY = {
  injury_id: '11111111-1111-4111-8111-111111111111',
  athlete_id: 'ATH-9',
  injury_date: '2026-09-01',
  body_area: 'wrist',
  injury_type: 'sprain_strain',
  context: 'training',
  reported_by: 'athlete',
  staff_note: 'Said it twisted.',
  expected_return_date: '2026-09-20',
  returned_on: null,
  linked_rtt_plan_id: null,
  linked_hold_id: 'hold-1',
  linked_clearance_status_id: null,
  linked_pain_report_id: null,
  entered_in_error: false,
};
const PLAN = { plan_id: 'plan-1', athlete_id: 'ATH-1', status: 'active', triggering_event: 'injury', authority_source: 'physician' };
const STEP1 = { step_id: 'step-1', plan_id: 'plan-1', week_number: 1, advanced_at: '2026-09-08', permitted_contact: 'none' };
const STEP2 = { step_id: 'step-2', plan_id: 'plan-1', week_number: 2, advanced_at: null, permitted_contact: 'light_technical' };
const STEP3 = { step_id: 'step-3', plan_id: 'plan-1', week_number: 3, advanced_at: null, permitted_contact: 'conditioned' };

function as(role: string, accountId = `acct-${role}`) {
  mockPrincipal.mockResolvedValue({ accountId, role, organizationId: ORG, athleteId: null });
}

function getReq(athleteId = 'ATH-1') {
  return new NextRequest(`${URL}?athlete_id=${athleteId}`);
}

function bodyReq(method: 'POST' | 'PATCH', body: Record<string, unknown>) {
  return new NextRequest(URL, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}

const CREATE = { action: 'create_plan', injury_id: INJURY.injury_id, authority_source: 'USA Boxing rulebook', rest_period_days: 30 };
const ADD = { action: 'add_step', athlete_id: 'ATH-1', plan_id: 'plan-1', week_number: 4, intensity_label: 'Bag work only' };
const ADVANCE = { athlete_id: 'ATH-1', plan_id: 'plan-1', step_id: 'step-2', advancement_note: 'Completed the week pain-free.' };

const writes = () =>
  [mockCreatePlan, mockAddStep, mockAdvance, mockUpdateInjury, mockAudit].reduce((n, m) => n + m.mock.calls.length, 0);
const moduleCalls = () => writes() + mockListPlans.mock.calls.length + mockListSteps.mock.calls.length + mockGetInjury.mock.calls.length;

beforeEach(() => {
  jest.resetAllMocks();
  mockCoachAssigned.mockResolvedValue(undefined);
  mockBelongs.mockResolvedValue(undefined);
  mockGetInjury.mockResolvedValue(INJURY);
  mockUpdateInjury.mockImplementation(async ({ fields }) => ({ ...INJURY, linked_rtt_plan_id: fields.linkedRttPlanId }));
  mockCreatePlan.mockImplementation(async (input) => ({
    ...PLAN,
    plan_id: 'plan-new',
    athlete_id: input.athleteId,
    triggering_event: input.triggeringEvent,
    authority_source: input.authoritySource,
    medical_clearance_on_file: input.medicalClearanceOnFile,
  }));
  mockListPlans.mockResolvedValue([PLAN]);
  mockListSteps.mockResolvedValue([STEP1, STEP2, STEP3]);
  mockAddStep.mockImplementation(async (input) => ({ step_id: 'step-new', advanced_at: null, ...input, week_number: input.weekNumber, permitted_contact: input.permittedContact }));
  mockAdvance.mockImplementation(async (input) => ({ ...STEP2, advanced_at: '2026-09-15', advanced_by_account_id: input.advancedByAccountId }));
  mockAudit.mockResolvedValue(undefined);
});

describe.each(['platform_owner', 'board', 'athlete', 'parent', 'volunteer', 'staff'])(
  'role %s is refused before anything is read or written',
  (role) => {
    test('GET', async () => {
      as(role);
      expect((await GET(getReq())).status).toBe(403);
      expect(moduleCalls()).toBe(0);
    });

    test.each([CREATE, ADD])('POST %s', async (body) => {
      as(role);
      expect((await POST(bodyReq('POST', body))).status).toBe(403);
      expect(moduleCalls()).toBe(0);
    });

    test('PATCH', async () => {
      as(role);
      expect((await PATCH(bodyReq('PATCH', ADVANCE))).status).toBe(403);
      expect(moduleCalls()).toBe(0);
    });
  },
);

describe('a coach without standing with the athlete', () => {
  beforeEach(() => {
    as('coach');
    mockCoachAssigned.mockRejectedValue(new Error('Forbidden: coach is not assigned to athlete'));
  });

  test('cannot read plans', async () => {
    expect((await GET(getReq())).status).toBe(403);
    expect(mockListPlans).not.toHaveBeenCalled();
  });

  test("gets the same 404 as a missing injury on create_plan, decided by the injury's athlete", async () => {
    const res = await POST(bodyReq('POST', { ...CREATE, athlete_id: 'ATH-1' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'Injury record not found.' });
    expect(mockCoachAssigned).toHaveBeenCalledWith('acct-coach', 'ATH-9', ORG);
    expect(writes()).toBe(0);
  });

  test('cannot add or advance a step, and no plan is read', async () => {
    expect((await POST(bodyReq('POST', ADD))).status).toBe(403);
    expect((await PATCH(bodyReq('PATCH', ADVANCE))).status).toBe(403);
    expect(mockListPlans).not.toHaveBeenCalled();
    expect(writes()).toBe(0);
  });
});

describe('an assigned coach', () => {
  beforeEach(() => as('coach', 'acct-coach-1'));

  test('reads the athlete\'s plans with steps in order and the current step, through the assignment gate', async () => {
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toMatchObject({
      ok: true,
      plans: [{ plan_id: 'plan-1', steps: [STEP1, STEP2, STEP3], current_step_id: 'step-2' }],
    });
    expect(mockCoachAssigned).toHaveBeenCalledWith('acct-coach-1', 'ATH-1', ORG);
    expect(mockBelongs).not.toHaveBeenCalled();
    expect(mockListPlans).toHaveBeenCalledWith(ORG, { athleteId: 'ATH-1' });
    expect(mockListSteps).toHaveBeenCalledWith(ORG, 'plan-1');
  });

  test('a plan with every step advanced has no current step', async () => {
    mockListSteps.mockResolvedValue([STEP1]);
    expect(await (await GET(getReq())).json()).toMatchObject({ plans: [{ current_step_id: null }] });
  });

  test('creates a plan on the injury for ITS athlete, links the injury, audits; the body cannot supply org, athlete or who entered it', async () => {
    const res = await POST(
      bodyReq('POST', {
        ...CREATE,
        organizationId: 'org-evil',
        athlete_id: 'ATH-OTHER',
        athleteId: 'ATH-OTHER',
        enteredByAccountId: 'someone-else',
        earliest_return_date: '2026-10-01',
        medical_clearance_on_file: true,
        note: '  Physician letter on file.  ',
      }),
    );
    expect(res.status).toBe(200);
    expect(mockCoachAssigned.mock.calls).toEqual([['acct-coach-1', 'ATH-9', ORG]]);
    expect(mockCreatePlan).toHaveBeenCalledTimes(1);
    expect(mockCreatePlan.mock.calls[0][0]).toEqual({
      organizationId: ORG,
      athleteId: 'ATH-9',
      triggeringEvent: 'injury',
      eventDate: '2026-09-01',
      authoritySource: 'USA Boxing rulebook',
      restPeriodDays: 30,
      earliestReturnDate: '2026-10-01',
      medicalClearanceOnFile: true,
      enteredByAccountId: 'acct-coach-1',
      enteredByRole: 'coach',
      note: 'Physician letter on file.',
    });
    // The link keeps every recorded field, clears the row's own expected
    // return (the plan now holds it), and names the new plan.
    expect(mockUpdateInjury).toHaveBeenCalledWith({
      organizationId: ORG,
      injuryId: INJURY.injury_id,
      fields: expect.objectContaining({
        bodyArea: 'wrist',
        staffNote: 'Said it twisted.',
        expectedReturnDate: null,
        linkedRttPlanId: 'plan-new',
        linkedHoldId: 'hold-1',
      }),
      updatedByAccountId: 'acct-coach-1',
    });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'create',
        actor_account_id: 'acct-coach-1',
        actor_role: 'coach',
        organization_id: ORG,
        entity_type: 'return_to_training_plan',
        entity_id: 'plan-new',
        details: { injury_id: INJURY.injury_id, triggering_event: 'injury', medical_clearance_on_file: true },
      }),
    );
    // The audit row is written before the link, so a failed link never leaves
    // an unaudited plan; and it carries no free text (authority_source can
    // name a physician).
    expect(mockAudit.mock.invocationCallOrder[0]).toBeLessThan(mockUpdateInjury.mock.invocationCallOrder[0]);
    expect(JSON.stringify(mockAudit.mock.calls[0][0].details)).not.toContain('USA Boxing');
    expect(await res.json()).toMatchObject({ ok: true, plan: { plan_id: 'plan-new', steps: [], current_step_id: null }, injury: { linked_rtt_plan_id: 'plan-new' } });
  });

  test("an injury's own expected return carries into the plan when the body gives none, instead of being dropped", async () => {
    expect((await POST(bodyReq('POST', CREATE))).status).toBe(200);
    expect(mockCreatePlan.mock.calls[0][0]).toMatchObject({ earliestReturnDate: '2026-09-20', medicalClearanceOnFile: false });
    expect(mockUpdateInjury.mock.calls[0][0].fields).toMatchObject({ expectedReturnDate: null, linkedRttPlanId: 'plan-new' });
  });

  test('a link that fails after the plan exists surfaces the error; the plan was already audited', async () => {
    const { NotFoundError } = jest.requireActual('@/src/server/pilot/errors');
    mockUpdateInjury.mockRejectedValue(new NotFoundError('Injury record not found.'));
    const res = await POST(bodyReq('POST', CREATE));
    expect(res.status).toBe(404);
    expect(mockCreatePlan).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ entity_type: 'return_to_training_plan', entity_id: 'plan-new' }));
  });

  test('create_plan refuses an injury that already has a plan, a missing or erroneous injury, and bad fields', async () => {
    mockGetInjury.mockResolvedValue({ ...INJURY, linked_rtt_plan_id: 'plan-1' });
    expect((await POST(bodyReq('POST', CREATE))).status).toBe(409);

    mockGetInjury.mockResolvedValue(null);
    expect((await POST(bodyReq('POST', CREATE))).status).toBe(404);
    mockGetInjury.mockResolvedValue({ ...INJURY, entered_in_error: true });
    expect((await POST(bodyReq('POST', CREATE))).status).toBe(404);

    mockGetInjury.mockResolvedValue(INJURY);
    for (const bad of [
      { authority_source: '' },
      { triggering_event: 'guess' },
      { rest_period_days: -1 },
      { rest_period_days: '30' },
      { earliest_return_date: '2026-02-31' },
      { earliest_return_date: '2026-08-31' }, // before the injury
      { event_date: 'yesterday' },
      { event_date: '0000-01-01' }, // Postgres has no year 0
      { medical_clearance_on_file: 'true' },
      { note: 'x'.repeat(2001) },
    ]) {
      expect((await POST(bodyReq('POST', { ...CREATE, ...bad }))).status).toBe(400);
    }
    expect(writes()).toBe(0);
  });

  test('adds a step to the athlete\'s active plan and audits', async () => {
    const res = await POST(bodyReq('POST', { ...ADD, permitted_contact: 'conditioned', permitted_scale_level: 'B', planned_note: 'Pads, no partner.' }));
    expect(res.status).toBe(200);
    expect(mockCoachAssigned.mock.calls).toEqual([['acct-coach-1', 'ATH-1', ORG]]);
    expect(mockListPlans).toHaveBeenCalledWith(ORG, { athleteId: 'ATH-1' });
    expect(mockAddStep).toHaveBeenCalledWith({
      organizationId: ORG,
      planId: 'plan-1',
      weekNumber: 4,
      intensityLabel: 'Bag work only',
      permittedContact: 'conditioned',
      permittedScaleLevel: 'B',
      plannedNote: 'Pads, no partner.',
    });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'create', entity_type: 'return_to_training_step', entity_id: 'step-new' }));
    expect(await res.json()).toMatchObject({ ok: true, step: { step_id: 'step-new' } });
  });

  test('add_step defaults contact to none and scale level to null', async () => {
    expect((await POST(bodyReq('POST', ADD))).status).toBe(200);
    expect(mockAddStep.mock.calls[0][0]).toMatchObject({ permittedContact: 'none', permittedScaleLevel: null, plannedNote: '' });
  });

  test('a week at or below one already advanced is refused, so the current step never moves backwards', async () => {
    // Week 1 advanced; weeks 2 and 3 ahead. Week 1 again would be a duplicate
    // anyway; week 0 is invalid; so advance week 2 too and try week 2 and 1.
    mockListSteps.mockResolvedValue([STEP1, { ...STEP2, advanced_at: '2026-09-15' }, STEP3]);
    for (const week_number of [1, 2]) {
      const res = await POST(bodyReq('POST', { ...ADD, week_number }));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'Week 2 has already been advanced; add a week after it.' });
    }
    expect(mockAddStep).not.toHaveBeenCalled();
    expect((await POST(bodyReq('POST', { ...ADD, week_number: 5 }))).status).toBe(200);
  });

  test('a plan with no advanced step takes any week', async () => {
    mockListSteps.mockResolvedValue([STEP2, STEP3]);
    expect((await POST(bodyReq('POST', { ...ADD, week_number: 1 }))).status).toBe(200);
  });

  test("a plan that is not in the named athlete's list is the same 404 as a missing one", async () => {
    mockListPlans.mockResolvedValue([{ ...PLAN, plan_id: 'plan-other' }]);
    expect((await POST(bodyReq('POST', ADD))).status).toBe(404);
    expect((await PATCH(bodyReq('PATCH', ADVANCE))).status).toBe(404);
    expect(writes()).toBe(0);
  });

  test('a completed or cancelled plan takes no step and advances none', async () => {
    for (const status of ['completed', 'cancelled']) {
      mockListPlans.mockResolvedValue([{ ...PLAN, status }]);
      expect((await POST(bodyReq('POST', ADD))).status).toBe(409);
      expect((await PATCH(bodyReq('PATCH', ADVANCE))).status).toBe(409);
    }
    expect(writes()).toBe(0);
  });

  test('add_step refuses bad fields and a duplicate week', async () => {
    for (const bad of [
      { week_number: 0 },
      { week_number: '4' },
      { week_number: 2.5 },
      { intensity_label: '' },
      { permitted_contact: 'full' },
      { permitted_scale_level: 'D' },
      { plan_id: '' },
    ]) {
      expect((await POST(bodyReq('POST', { ...ADD, ...bad }))).status).toBe(400);
    }
    expect(mockAddStep).not.toHaveBeenCalled();

    const { ConflictError } = jest.requireActual('@/src/server/pilot/errors');
    mockAddStep.mockRejectedValue(new ConflictError('A return-to-training step already exists for that week.', 'RTT_STEP_WEEK_DUPLICATE'));
    expect((await POST(bodyReq('POST', ADD))).status).toBe(409);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('advances the current step as the signed-in coach with their note, and audits', async () => {
    const res = await PATCH(bodyReq('PATCH', { ...ADVANCE, advancedByAccountId: 'someone-else', advancement_note: '  Completed the week pain-free.  ' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(mockCoachAssigned.mock.calls).toEqual([['acct-coach-1', 'ATH-1', ORG]]);
    expect(mockAdvance).toHaveBeenCalledWith({
      organizationId: ORG,
      stepId: 'step-2',
      advancedByAccountId: 'acct-coach-1',
      advancementNote: 'Completed the week pain-free.',
    });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'update', entity_type: 'return_to_training_step', entity_id: 'step-2', actor_account_id: 'acct-coach-1' }),
    );
    expect(await res.json()).toMatchObject({ ok: true, step: { step_id: 'step-2', advanced_by_account_id: 'acct-coach-1' } });
  });

  test('only the current step advances: a later step, an already-advanced step, a finished plan, an unknown step', async () => {
    let res = await PATCH(bodyReq('PATCH', { ...ADVANCE, step_id: 'step-3' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'Week 2 is the current step; advance it first.' });

    res = await PATCH(bodyReq('PATCH', { ...ADVANCE, step_id: 'step-1' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'Week 1 has already been advanced.' });

    mockListSteps.mockResolvedValue([STEP1, STEP2]);
    expect((await PATCH(bodyReq('PATCH', { ...ADVANCE, step_id: 'step-missing' }))).status).toBe(404);

    expect(mockAdvance).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a short note is refused by the module and nothing is audited', async () => {
    const { ValidationError } = jest.requireActual('@/src/server/pilot/errors');
    mockAdvance.mockRejectedValue(new ValidationError('Advancement note must be at least 10 characters.', 'RTT_STEP_ADVANCEMENT_NOTE_REQUIRED'));
    expect((await PATCH(bodyReq('PATCH', { ...ADVANCE, advancement_note: 'ok' }))).status).toBe(400);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a failure that is not a refusal surfaces, not a 404', async () => {
    mockCoachAssigned.mockRejectedValue(new Error('connection reset'));
    expect((await POST(bodyReq('POST', CREATE))).status).toBe(500);
    expect(writes()).toBe(0);
  });

  test('missing ids, unknown actions and a bad body are 400', async () => {
    expect((await GET(new NextRequest(URL))).status).toBe(400);
    expect((await POST(bodyReq('POST', { action: 'delete_plan' }))).status).toBe(400);
    expect((await POST(bodyReq('POST', { ...CREATE, injury_id: '' }))).status).toBe(400);
    expect((await POST(bodyReq('POST', { ...ADD, athlete_id: '' }))).status).toBe(400);
    expect((await PATCH(bodyReq('PATCH', { ...ADVANCE, step_id: '' }))).status).toBe(400);
    expect((await PATCH(new NextRequest(URL, { method: 'PATCH', body: 'not json' }))).status).toBe(400);
    expect(moduleCalls()).toBe(0);
  });
});

describe.each(['organization_admin', 'admin'])('%s', (role) => {
  beforeEach(() => as(role));

  test('reaches any live athlete in the organization through the organization check', async () => {
    expect((await GET(getReq())).status).toBe(200);
    expect((await POST(bodyReq('POST', ADD))).status).toBe(200);
    expect((await PATCH(bodyReq('PATCH', ADVANCE))).status).toBe(200);
    expect(mockBelongs.mock.calls).toEqual([[ORG, 'ATH-1'], [ORG, 'ATH-1'], [ORG, 'ATH-1']]);
    expect(mockCoachAssigned).not.toHaveBeenCalled();
  });

  test("creates a plan through the organization check on the injury's own athlete", async () => {
    expect((await POST(bodyReq('POST', CREATE))).status).toBe(200);
    expect(mockBelongs.mock.calls).toEqual([[ORG, 'ATH-9']]);
    expect(mockCreatePlan.mock.calls[0][0]).toMatchObject({ athleteId: 'ATH-9', enteredByRole: role });
  });

  test("another organization's injury is the same 404 as a missing one; another organization's athlete is refused", async () => {
    mockBelongs.mockRejectedValue(new Error('Forbidden: athlete does not belong to organization'));
    expect((await POST(bodyReq('POST', CREATE))).status).toBe(404);
    expect((await GET(getReq())).status).toBe(403);
    expect((await POST(bodyReq('POST', ADD))).status).toBe(403);
    expect((await PATCH(bodyReq('PATCH', ADVANCE))).status).toBe(403);
    expect(mockListPlans).not.toHaveBeenCalled();
    expect(writes()).toBe(0);
  });
});
