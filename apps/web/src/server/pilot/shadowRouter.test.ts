import { routeRequest, tierToSessionType, isAsyncSession, getModelStatus, describeDeployment } from './shadowRouter';

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
  // A pure mapping by design. The old signature took (role, isManualOverride)
  // and escalated quick_round to heavy_bag whenever the flag was set for an
  // authorized role -- but the flag recorded only that a tier was requested,
  // not which one, so a coach's explicit "quick_round" came out as heavy_bag.
  // Manual tiers are honored in classifyRequest, before a tier reaches this.
  test('quick tier maps to quick_round', () => {
    expect(tierToSessionType('quick_round')).toBe('quick_round');
  });

  test('heavy tier maps to heavy_bag', () => {
    expect(tierToSessionType('heavy_bag')).toBe('heavy_bag');
  });
});

describe('describeDeployment', () => {
  test('a registry deployment is reported by its display name', () => {
    expect(describeDeployment('gpt-5.6-luna-shadow')).toBe('GPT-5.6 Luna (Quick Round)');
    expect(describeDeployment('gpt-5.6-sol-shadow')).toBe('GPT-5.6 Sol (Heavy Bag)');
  });

  test('an env-configured deployment outside the registry is reported by its raw name', () => {
    // The quick path calls whatever AZURE_AI_DEPLOYMENT_NAME points at. When
    // ops points it somewhere the registry does not know, the honest label is
    // the deployment name itself -- not the router's theoretical pick.
    expect(describeDeployment('ops-canary-deployment')).toBe('ops-canary-deployment');
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
