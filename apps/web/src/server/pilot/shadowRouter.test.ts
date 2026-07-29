import { routeRequest, tierToSessionType, isAsyncSession, getModelStatus } from './shadowRouter';

describe('getModelStatus', () => {
  test('reports every deployed model as available', () => {
    const status = getModelStatus();
    expect(status['gpt-5.6-sol-shadow']).toEqual({ displayName: 'GPT-5.6 Sol (Heavy Bag)', available: true, tier: 'heavy' });
    expect(status['gpt-5.6-luna-shadow']).toEqual({ displayName: 'GPT-5.6 Luna (Quick Round)', available: true, tier: 'quick' });
    expect(status['gpt-5-mini-shadow']).toEqual({ displayName: 'GPT-5 Mini (Quick Round)', available: true, tier: 'quick' });
    expect(status['gpt-5-shadow']).toEqual({ displayName: 'GPT-5 (Heavy Bag)', available: true, tier: 'heavy' });
    expect(status['gpt-5-vision-shadow']).toEqual({ displayName: 'GPT-5 Vision (Film Study)', available: true, tier: 'vision' });
  });
});

describe('routeRequest', () => {
  test('quick_round routes to the current-generation quick model', () => {
    const decision = routeRequest('quick_round', 'athlete', 0.1);
    expect(decision.model.deploymentName).toBe('gpt-5.6-luna-shadow');
  });

  test('heavy_bag routes to the deployed heavy model, not the fallback', () => {
    const decision = routeRequest('heavy_bag', 'coach', 0.9);
    expect(decision.model.deploymentName).toBe('gpt-5.6-sol-shadow');
    expect(decision.model.available).toBe(true);
    expect(decision.rationale).toContain('deep reasoning');
  });

  test('scout_report and board_summary route through the heavy model when available', () => {
    expect(routeRequest('scout_report', 'admin', 0.5).model.deploymentName).toBe('gpt-5.6-sol-shadow');
    expect(routeRequest('board_summary', 'admin', 0.5).model.deploymentName).toBe('gpt-5.6-sol-shadow');
  });

  test('film_study routes to the deployed vision model, not the text-only fallback', () => {
    const decision = routeRequest('film_study', 'coach', 0.5);
    expect(decision.model.deploymentName).toBe('gpt-5-vision-shadow');
    expect(decision.model.supportsVision).toBe(true);
  });

  test('recovery_round always routes to the cost-optimized quick model', () => {
    expect(routeRequest('recovery_round', 'admin', 0.9).model.deploymentName).toBe('gpt-5.6-luna-shadow');
  });

  test('an unrecognized session type falls back to quick_round routing rather than throwing', () => {
    const decision = routeRequest('not_a_real_session_type' as never, 'athlete', 0.1);
    expect(decision.model.deploymentName).toBe('gpt-5.6-luna-shadow');
  });
});

/**
 * Regression guard for the defect this routing table was rewritten to fix: a
 * provider timeout shorter than the model's own response time, which turned
 * every SHADOW answer into the degraded fallback. A timeout must always leave
 * real headroom over the latency we expect from that deployment, and must stay
 * inside the Container Apps ingress limit or the platform truncates it anyway.
 */
describe('provider timeouts are consistent with expected latency', () => {
  const SESSION_TYPES = [
    'quick_round', 'heavy_bag', 'film_study', 'scout_report', 'board_summary', 'recovery_round',
  ] as const;
  const INGRESS_LIMIT_MS = 240_000;

  test.each(SESSION_TYPES)('%s allows the model enough time to answer', (sessionType) => {
    const decision = routeRequest(sessionType, 'admin', 0.9);
    expect(decision.model.timeoutMs).toBeGreaterThan(decision.expectedLatencyMs);
    expect(decision.model.timeoutMs).toBeLessThan(INGRESS_LIMIT_MS);
  });
});

describe('tierToSessionType', () => {
  test('quick tier without an override stays quick_round', () => {
    expect(tierToSessionType('quick_round', 'athlete', false)).toBe('quick_round');
  });

  test('heavy tier always maps to heavy_bag regardless of role', () => {
    expect(tierToSessionType('heavy_bag', 'athlete', false)).toBe('heavy_bag');
  });

  test('a manual override only escalates to heavy_bag for roles allowed to override', () => {
    expect(tierToSessionType('quick_round', 'coach', true)).toBe('heavy_bag');
    expect(tierToSessionType('quick_round', 'admin', true)).toBe('heavy_bag');
    expect(tierToSessionType('quick_round', 'organization_admin', true)).toBe('heavy_bag');
    expect(tierToSessionType('quick_round', 'platform_owner', true)).toBe('heavy_bag');
  });

  test('a manual override request from an ineligible role does not escalate', () => {
    expect(tierToSessionType('quick_round', 'athlete', true)).toBe('quick_round');
    expect(tierToSessionType('quick_round', 'parent', true)).toBe('quick_round');
  });
});

describe('isAsyncSession', () => {
  test('recovery_round, scout_report, and board_summary are async', () => {
    expect(isAsyncSession('recovery_round')).toBe(true);
    expect(isAsyncSession('scout_report')).toBe(true);
    expect(isAsyncSession('board_summary')).toBe(true);
  });

  test('quick_round, heavy_bag, and film_study are not async', () => {
    expect(isAsyncSession('quick_round')).toBe(false);
    expect(isAsyncSession('heavy_bag')).toBe(false);
    expect(isAsyncSession('film_study')).toBe(false);
  });
});
