import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { query, queryOne } from '@/src/server/pilot/db';
import { saveFormulaObservation } from '@/src/server/pilot/formulas/repository';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

/**
 * The athlete's own latest weigh-in, and the athlete correcting a mistyped one
 * (Jason 2026-10-04, "Athlete or their coach").
 *
 * WHAT IS REAL. requirePrincipal, the database, the formula store's write and
 * the audit insert are faked; the route, access.ts and athleteBodyMass.ts are
 * the shipped code. The athlete id is always the session's.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('@/src/server/pilot/formulas/repository', () => {
  const actual = jest.requireActual('@/src/server/pilot/formulas/repository');
  return { ...actual, saveFormulaObservation: jest.fn() };
});
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockSave = saveFormulaObservation as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

const NOW = new Date('2026-10-04T18:00:00Z');
const DAY = 24 * 60 * 60 * 1_000;

interface FakeWeighIn {
  athlete_id: string;
  observation_id: string;
  numeric_value: number;
  unit: string;
  observed_at: string;
  supersedes?: string;
}

let weighIns: FakeWeighIn[];
const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
  weighIns = [
    { athlete_id: 'ath-1', observation_id: 'ath-1-old', numeric_value: 60, unit: 'kilograms', observed_at: new Date(NOW.getTime() - 8 * DAY).toISOString() },
    // Mistyped: 48 for 60.
    { athlete_id: 'ath-1', observation_id: 'ath-1-latest', numeric_value: 48, unit: 'kilograms', observed_at: new Date(NOW.getTime() - DAY).toISOString() },
    { athlete_id: 'ath-2', observation_id: 'ath-2-latest', numeric_value: 70, unit: 'kilograms', observed_at: new Date(NOW.getTime() - DAY).toISOString() },
  ];

  mockQueryOne.mockImplementation(async (sql: string, params: string[]) => {
    const text = normalize(sql);
    if (text.includes('from pilot.athletes')) {
      // assertAthleteBelongsToOrganization: both athletes are live in org-1.
      const [first, second] = params;
      const organizationId = text.indexOf('organization_id = $1') >= 0 ? first : second;
      const athleteId = organizationId === first ? second : first;
      return organizationId === 'org-1' && ['ath-1', 'ath-2'].includes(athleteId) ? { athlete_id: athleteId } : null;
    }
    if (text.includes('from pilot.shadow_formula_observations')) {
      const [organizationId, athleteId, observationId] = params;
      const hit = weighIns.find((row) => organizationId === 'org-1'
        && row.athlete_id === athleteId && row.observation_id === observationId);
      return hit ? { context_id: 'ctx', observed_at: hit.observed_at } : null;
    }
    throw new Error(`unexpected SQL in this test: ${text}`);
  });

  mockQuery.mockImplementation(async (sql: string, params: string[]) => {
    const text = normalize(sql);
    const currentOnly = text.includes('successor.supersedes_observation_id = o.observation_id');
    const [, athleteId, from, to] = params;
    return weighIns
      .filter((row) => row.athlete_id === athleteId
        && row.observed_at > from && row.observed_at <= to
        && (!currentOnly || !weighIns.some((other) => other.supersedes === row.observation_id)))
      .sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  });

  mockSave.mockImplementation(async (input: {
    athleteId: string; value: number; unit: string; observedAt: string; supersedesObservationId: string;
  }) => {
    const saved = {
      athlete_id: input.athleteId,
      observation_id: `fix-of-${input.supersedesObservationId}`,
      numeric_value: input.value,
      unit: input.unit,
      observed_at: input.observedAt,
      supersedes: input.supersedesObservationId,
    };
    weighIns.push(saved);
    return { observationId: saved.observation_id };
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-ath-1',
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: 'ath-1',
    sessionToken: 'token',
    authProvider: 'pin',
    ...overrides,
  } as PilotPrincipal;
}

async function correctAs(caller: Partial<PilotPrincipal>, fields: Record<string, unknown> = {}) {
  mockRequirePrincipal.mockResolvedValue(principal(caller));
  const response = await POST(new NextRequest('http://localhost/api/pilot/athlete/check-in/body-mass', {
    method: 'POST',
    body: JSON.stringify({ observation_id: 'ath-1-latest', body_mass: 132, body_mass_unit: 'lb', ...fields }),
  }));
  return { status: response.status, payload: (await response.json()) as Record<string, unknown> };
}

describe('the athlete corrects their own weight', () => {
  test('GET shows the latest entry and offers the correction', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    const response = await GET(new NextRequest('http://localhost/api/pilot/athlete/check-in/body-mass'));
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).toEqual({
      body_mass: {
        observation_id: 'ath-1-latest',
        kilograms: 48,
        pounds: 105.8,
        observed_at: new Date(NOW.getTime() - DAY).toISOString(),
        correctable: true,
      },
    });
  });

  test('the correction supersedes the entry, keeps it on record, and becomes the latest', async () => {
    const { status, payload } = await correctAs({});

    expect(status).toBe(200);
    expect(payload).toMatchObject({
      corrected: { observation_id: 'fix-of-ath-1-latest', supersedes_observation_id: 'ath-1-latest' },
      body_mass: { observation_id: 'fix-of-ath-1-latest', kilograms: 59.87, correctable: true },
    });
    expect(weighIns.find((row) => row.observation_id === 'ath-1-latest')).toMatchObject({ numeric_value: 48 });
    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({
      athleteId: 'ath-1',
      supersedesObservationId: 'ath-1-latest',
      createdByAccountId: 'acct-ath-1',
      source: expect.objectContaining({ qualityNotes: 'Corrected by the athlete.' }),
    }));
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ actor_role: 'athlete', entity_type: 'athlete_body_mass' }));
  });

  test('the athlete is never sent the coach\'s flag', async () => {
    const { payload } = await correctAs({}, { body_mass: 20, body_mass_unit: 'kg' });
    expect(JSON.stringify(payload)).not.toMatch(/flag|Check in with the athlete/);
  });
});

describe('refusals', () => {
  test('another athlete\'s entry cannot be reached: the id is the session\'s, so it is not found', async () => {
    const { status } = await correctAs({}, { observation_id: 'ath-2-latest', athlete_id: 'ath-2' });
    expect(status).toBe(404);
    expect(mockSave).not.toHaveBeenCalled();
    expect(weighIns.find((row) => row.observation_id === 'ath-2-latest')).toMatchObject({ numeric_value: 70 });
  });

  test.each([
    ['coach', { role: 'coach' as const, athleteId: null }],
    ['parent', { role: 'parent' as const, athleteId: null }],
    ['organization admin', { role: 'organization_admin' as const, athleteId: null }],
    ['platform owner', { role: 'platform_owner' as const, athleteId: null }],
  ])('%s has no path here and nothing is written', async (_label, caller) => {
    const { status } = await correctAs(caller);
    expect(status).toBe(403);
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('an entry older than 7 days is refused (409)', async () => {
    const { status, payload } = await correctAs({}, { observation_id: 'ath-1-old' });
    expect(status).toBe(409);
    expect(payload.code).toBe('BODY_MASS_CORRECTION_WINDOW');
    expect(mockSave).not.toHaveBeenCalled();
  });

  test('a session with no athlete record is a 400', async () => {
    const { status } = await correctAs({ athleteId: null });
    expect(status).toBe(400);
    expect(mockSave).not.toHaveBeenCalled();
  });
});
