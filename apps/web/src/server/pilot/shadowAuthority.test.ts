import { assertShadowAuthority, isShadowAutomationMode, SHADOW_AUTOMATION_MODES } from './shadowAuthority';
import { query } from './db';
import type { ActorIdentity } from './access';

jest.mock('./db', () => ({ query: jest.fn() }));

const mockQuery = jest.mocked(query);

const actor: ActorIdentity = {
  accountId: 'acct-1',
  role: 'organization_admin',
  organizationId: 'org-1',
  athleteId: null,
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    actor,
    organizationId: 'org-1',
    action: 'intake.review_action.promote',
    automationMode: 'assisted',
    confidenceTier: 'SUFFICIENT_FOR_REVIEW',
    lowRisk: false,
    reversible: false,
    withinApprovedOptions: true,
    restrictionConflict: false,
    ...overrides,
  } as Parameters<typeof assertShadowAuthority>[0];
}

/** The automation_mode value the ledger row was written with. */
function ledgerMode(): unknown {
  const call = mockQuery.mock.calls[0];
  if (!call) throw new Error('no authority-check row was written');
  return (call[1] as unknown[])[4];
}

/** Whether the ledger row recorded the decision as allowed. */
function ledgerAllowed(): unknown {
  const call = mockQuery.mock.calls[0];
  if (!call) throw new Error('no authority-check row was written');
  return (call[1] as unknown[])[8];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue([]);
});

describe('the automation-mode vocabulary', () => {
  test('is exactly the three modes the decider compares against', () => {
    expect([...SHADOW_AUTOMATION_MODES].sort()).toEqual(['assisted', 'automatic', 'manual']);
  });

  const REJECTED: Array<[string, unknown]> = [
    ['a cased near-miss', 'Automatic'],
    ['an upper-cased near-miss', 'AUTOMATIC'],
    ['a trailing-space near-miss', 'automatic '],
    ['a leading-space near-miss', ' automatic'],
    ['an unknown word', 'supervised'],
    ['an empty string', ''],
    ['an object', {}],
    ['an array', ['automatic']],
    ['a number', 0],
    ['a boolean', true],
    ['null', null],
    ['undefined', undefined],
  ];

  test('the rejected table is not empty', () => {
    expect(REJECTED.length).toBeGreaterThan(0);
  });

  test.each(REJECTED)('%s is not a vocabulary value', (_label, value) => {
    expect(isShadowAutomationMode(value)).toBe(false);
  });

  test.each([...SHADOW_AUTOMATION_MODES])('%p is a vocabulary value', (value) => {
    expect(isShadowAutomationMode(value)).toBe(true);
  });
});

// Every automatic-actor refusal in decideShadowAuthority compares
// `automationMode === 'automatic'`. A mode outside the vocabulary therefore
// skipped all of them and was recorded as an authority check that PASSED.
// Callers validate their own input now, but the decider must not depend on
// them doing so: an unrecognised mode is a mode nobody has reasoned about, and
// the only safe reading of one is refusal.
describe('an unrecognised automation mode fails closed at the decider', () => {
  const UNRECOGNISED = ['Automatic', 'AUTOMATIC', 'automatic ', 'supervised', ''];

  test('the unrecognised table is not empty', () => {
    expect(UNRECOGNISED.length).toBeGreaterThan(0);
  });

  test.each(UNRECOGNISED)('%p is denied rather than read as non-automatic', async (mode) => {
    await expect(assertShadowAuthority(input({ automationMode: mode }))).rejects.toThrow(
      /SHADOW authority denied/,
    );

    // The refusal is still recorded, with the mode as sent -- an unrecognised
    // value is exactly what an auditor needs to see.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(ledgerMode()).toBe(mode);
    expect(ledgerAllowed()).toBe(false);
  });

  test('a recognised non-automatic mode is unaffected', async () => {
    await expect(assertShadowAuthority(input({ automationMode: 'manual' }))).resolves.toBeUndefined();
    expect(ledgerAllowed()).toBe(true);
  });

  test("the vocabulary's own 'automatic' still hits the existing risk refusals", async () => {
    await expect(assertShadowAuthority(input({ automationMode: 'automatic' }))).rejects.toThrow(
      /must be low risk/,
    );
    expect(ledgerAllowed()).toBe(false);
  });
});
