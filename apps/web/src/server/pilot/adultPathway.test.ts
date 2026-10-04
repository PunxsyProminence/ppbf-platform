// Unit tests for the two gates the owner decisions hang on, run without a
// database so they can be mutation-proved anywhere:
//
//   WHO MAY BE PLACED (OD-2026-10-04-010): an adult by date of birth on the
//   gym-local day, or a minor with a live coach allowance. No dob = minor.
//   WHO MAY WRITE (OD-2026-10-04-019): an active coach, organization_admin or
//   admin membership HERE, then the athlete chokepoint with that role.
//
// ./db and ./access are replaced by small fakes that answer the module's own
// queries; the real-database behaviour is in adultPathway.pg.test.ts.

type Row = Record<string, unknown>;

const memberships = new Map<string, string>(); // accountId -> membership role here
const dobs = new Map<string, string | null>(); // athleteId -> dob text
const allowances = new Set<string>(); // athleteIds with a live allowance
const placements = new Map<string, { placement_id: string; stage_key: string }>();
const executed: string[] = [];
const insertParams: unknown[][] = [];

jest.mock('./db', () => ({
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    executed.push(text);
    if (text.includes('pilot.organization_memberships')) {
      const role = memberships.get(params[0] as string);
      return role && (params[2] as string[]).includes(role) ? { role } : null;
    }
    if (text.includes('update pilot.athlete_pathway_checkpoints')) return { confirmation_id: 'c1' };
    return null;
  }),
  query: jest.fn(async () => []),
  withTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      query: async (text: string, params: unknown[] = []): Promise<{ rows: Row[] }> => {
        executed.push(text);
        const athleteId = params[1] as string;
        if (text.includes('from pilot.athletes')) {
          return { rows: dobs.has(athleteId) ? [{ dob: dobs.get(athleteId) ?? null }] : [] };
        }
        if (text.includes('from pilot.athlete_pathway_minor_allowances')) {
          return { rows: allowances.has(athleteId) ? [{ allowance_id: 'al-1', athlete_id: athleteId }] : [] };
        }
        if (text.includes('select placement_id, stage_key')) {
          const p = placements.get(athleteId);
          return { rows: p ? [p] : [] };
        }
        if (text.includes('select 1 from pilot.athlete_pathway_checkpoints')) return { rows: [] };
        if (text.includes("end_reason = 'allowance_withdrawn'")) {
          const p = placements.get(athleteId);
          return { rows: p ? [{ placement_id: p.placement_id }] : [] };
        }
        if (text.trim().startsWith('insert')) {
          insertParams.push(params);
          return { rows: [{ inserted: true }] };
        }
        return { rows: [{}] };
      },
    };
    return fn(tx);
  }),
}));

jest.mock('./access', () => ({
  assertActorCanAccessAthlete: jest.fn(async (_actor: unknown, athleteId: string) => {
    if (athleteId === 'ath-not-theirs') throw new Error('Forbidden: not this coach\'s athlete');
  }),
  accessibleAthleteIds: jest.fn(async () => new Set<string>()),
}));

import {
  confirmPathwayCheckpoint,
  grantMinorAllowance,
  pathwayEligibility,
  placeAthleteOnStage,
  withdrawMinorAllowance,
} from './adultPathway';

// Noon UTC on 2026-10-04 is the morning of 2026-10-04 at the gym.
const NOW = new Date('2026-10-04T16:00:00Z');
const ORG = 'org-1';

function actor(accountId: string, role: string) {
  return { accountId, role, organizationId: ORG } as never;
}

const coach = actor('acct-coach', 'coach');

beforeEach(() => {
  memberships.clear();
  dobs.clear();
  allowances.clear();
  placements.clear();
  executed.length = 0;
  insertParams.length = 0;
  memberships.set('acct-coach', 'coach');
  dobs.set('ath-adult', '1990-05-01');
  dobs.set('ath-minor', '2012-05-01');
  dobs.set('ath-no-dob', null);
  dobs.set('ath-not-theirs', '1990-05-01');
});

const inserts = () => executed.filter((t) => t.trim().startsWith('insert'));

describe('pathwayEligibility (OD-2026-10-04-010)', () => {
  it('an adult is eligible; a minor and an unknown dob are not', () => {
    expect(pathwayEligibility('1990-05-01', false, NOW)).toEqual({ eligible: true, basis: 'adult' });
    expect(pathwayEligibility('2012-05-01', false, NOW)).toEqual({ eligible: false, basis: 'minor' });
    expect(pathwayEligibility(null, false, NOW)).toEqual({ eligible: false, basis: 'no_date_of_birth' });
    expect(pathwayEligibility('not a date', false, NOW)).toEqual({ eligible: false, basis: 'no_date_of_birth' });
  });

  it('a live allowance makes a minor or an unknown dob eligible', () => {
    expect(pathwayEligibility('2012-05-01', true, NOW)).toEqual({ eligible: true, basis: 'allowance' });
    expect(pathwayEligibility(null, true, NOW)).toEqual({ eligible: true, basis: 'allowance' });
  });

  it('turns adult on the 18th birthday in the gym timezone, not before', () => {
    expect(pathwayEligibility('2008-10-04', false, NOW).eligible).toBe(true);
    expect(pathwayEligibility('2008-10-05', false, NOW).eligible).toBe(false);
  });
});

describe('who may be placed', () => {
  it('places an adult', async () => {
    await placeAthleteOnStage({ actor: coach, athleteId: 'ath-adult', stageKey: 'foundation', now: NOW });
    expect(inserts()).toHaveLength(1);
  });

  it('refuses a minor with no allowance, and writes nothing', async () => {
    await expect(placeAthleteOnStage({ actor: coach, athleteId: 'ath-minor', stageKey: 'foundation', now: NOW }))
      .rejects.toMatchObject({ code: 'PATHWAY_ALLOWANCE_REQUIRED' });
    expect(inserts()).toHaveLength(0);
  });

  it('refuses an athlete with no date of birth, saying why', async () => {
    await expect(placeAthleteOnStage({ actor: coach, athleteId: 'ath-no-dob', stageKey: 'foundation', now: NOW }))
      .rejects.toThrow(/no date of birth/);
    expect(inserts()).toHaveLength(0);
  });

  it('places a minor once a coach has switched the allowance on', async () => {
    allowances.add('ath-minor');
    await placeAthleteOnStage({ actor: coach, athleteId: 'ath-minor', stageKey: 'foundation', now: NOW });
    expect(inserts()).toHaveLength(1);
  });

  it('applies the same gate to ticking a goal', async () => {
    await expect(confirmPathwayCheckpoint({
      actor: coach, athleteId: 'ath-minor', stageKey: 'foundation', goalKey: 'footwork', now: NOW,
    })).rejects.toMatchObject({ code: 'PATHWAY_ALLOWANCE_REQUIRED' });
    await expect(confirmPathwayCheckpoint({
      actor: coach, athleteId: 'ath-no-dob', stageKey: 'foundation', goalKey: 'footwork', now: NOW,
    })).rejects.toMatchObject({ code: 'PATHWAY_ALLOWANCE_REQUIRED' });
    expect(inserts()).toHaveLength(0);
    await confirmPathwayCheckpoint({
      actor: coach, athleteId: 'ath-adult', stageKey: 'foundation', goalKey: 'footwork', now: NOW,
    });
    expect(inserts()).toHaveLength(1);
  });

  it('refuses a goal under the wrong stage before touching the database', async () => {
    await expect(confirmPathwayCheckpoint({
      actor: coach, athleteId: 'ath-adult', stageKey: 'foundation', goalKey: 'own_style', now: NOW,
    })).rejects.toMatchObject({ code: 'PATHWAY_INVALID' });
    expect(executed).toHaveLength(0);
  });

  it('a blank allowance reason is refused', async () => {
    await expect(grantMinorAllowance({ actor: coach, athleteId: 'ath-minor', reason: '   ' }))
      .rejects.toMatchObject({ code: 'PATHWAY_INVALID' });
    expect(inserts()).toHaveLength(0);
  });
});

describe('switching the allowance off (OD-2026-10-04-018)', () => {
  it("ends a minor's current placement, stamped with who", async () => {
    allowances.add('ath-minor');
    placements.set('ath-minor', { placement_id: 'pl-1', stage_key: 'foundation' });
    const result = await withdrawMinorAllowance({ actor: coach, athleteId: 'ath-minor', now: NOW });
    expect(result.endedPlacementId).toBe('pl-1');
    expect(executed.some((t) => t.includes("end_reason = 'allowance_withdrawn'"))).toBe(true);
  });

  it("ends a no-dob athlete's placement too", async () => {
    allowances.add('ath-no-dob');
    placements.set('ath-no-dob', { placement_id: 'pl-2', stage_key: 'foundation' });
    const result = await withdrawMinorAllowance({ actor: coach, athleteId: 'ath-no-dob', now: NOW });
    expect(result.endedPlacementId).toBe('pl-2');
  });

  it("leaves an adult's placement alone", async () => {
    allowances.add('ath-adult');
    placements.set('ath-adult', { placement_id: 'pl-3', stage_key: 'foundation' });
    const result = await withdrawMinorAllowance({ actor: coach, athleteId: 'ath-adult', now: NOW });
    expect(result.endedPlacementId).toBeNull();
    expect(executed.some((t) => t.includes("end_reason = 'allowance_withdrawn'"))).toBe(false);
  });
});

describe('who may write (OD-2026-10-04-019)', () => {
  const place = (a: never, athleteId = 'ath-adult') =>
    placeAthleteOnStage({ actor: a, athleteId, stageKey: 'foundation', now: NOW });

  it.each(['coach', 'organization_admin', 'admin'])('a %s membership here may write, recorded under that role', async (role) => {
    memberships.set('acct-x', role);
    await place(actor('acct-x', role));
    expect(insertParams).toHaveLength(1);
    expect(insertParams[0].at(-1)).toBe(role);
  });

  it.each(['athlete', 'parent', 'volunteer', 'board', 'platform_owner'])('a %s may not, and nothing is written', async (role) => {
    memberships.set('acct-y', role);
    await expect(place(actor('acct-y', role))).rejects.toMatchObject({ code: 'PATHWAY_NOT_PERMITTED' });
    await expect(grantMinorAllowance({ actor: actor('acct-y', role), athleteId: 'ath-minor', reason: 'x' }))
      .rejects.toMatchObject({ code: 'PATHWAY_NOT_PERMITTED' });
    expect(inserts()).toHaveLength(0);
  });

  it('a coach by home role with no active membership here may not', async () => {
    await expect(place(actor('acct-elsewhere', 'coach'))).rejects.toMatchObject({ code: 'PATHWAY_NOT_PERMITTED' });
  });

  it('records the membership role here, not the home role', async () => {
    // An organization_admin of another gym holding only a coach membership here.
    memberships.set('acct-z', 'coach');
    await place(actor('acct-z', 'organization_admin'));
    expect(insertParams[0].at(-1)).toBe('coach');
  });

  it("a coach may not write for an athlete who is not theirs", async () => {
    await expect(place(coach, 'ath-not-theirs')).rejects.toMatchObject({ code: 'PATHWAY_NOT_PERMITTED' });
    expect(inserts()).toHaveLength(0);
  });
});
