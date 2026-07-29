import { getEnabledCapabilities, isFeatureEnabled, ROUTING_MATRIX } from './featureFlags';

/**
 * Runs against the real PPBF_CAPABILITIES.json, not a mock. The bug this
 * guards was exactly a mismatch between what the code assumed the file's
 * shape was and what it actually is -- a mock built to the code's assumption
 * would have passed right through the crash.
 */
describe('isFeatureEnabled', () => {
  test('returns a boolean rather than throwing, for a real capability id', () => {
    // id 11 is "Safety Gate Matrix + Medical/Recovery Recommendation" -- the
    // id runSafetyGate actually checks. Before the fix this threw
    // "Cannot read properties of undefined (reading 'find')" unconditionally.
    expect(() => isFeatureEnabled(11)).not.toThrow();
    expect(typeof isFeatureEnabled(11)).toBe('boolean');
  });

  test('returns false for an id with no matching capability, rather than throwing', () => {
    expect(isFeatureEnabled(999999)).toBe(false);
  });

  // Every entry in original25Capabilities is currently "DRAFT", and the
  // file's own governance.active is false. This assertion is a canary: it
  // documents that today nothing is flagged on, and it will fail loudly the
  // day someone promotes a capability to "active" without also checking
  // whether isFeatureEnabled's one real caller (runSafetyGate, still unused
  // by apps/web today) needs to be reconnected before that flag takes effect.
  test('nothing is currently promoted to active', () => {
    for (let id = 1; id <= 25; id += 1) {
      expect(isFeatureEnabled(id)).toBe(false);
    }
  });
});

describe('getEnabledCapabilities', () => {
  test('returns an array rather than throwing', () => {
    expect(() => getEnabledCapabilities()).not.toThrow();
    expect(Array.isArray(getEnabledCapabilities())).toBe(true);
  });

  test('matches isFeatureEnabled: every returned capability reads back as enabled', () => {
    const enabled = getEnabledCapabilities();
    for (const cap of enabled) {
      expect(isFeatureEnabled(cap.id)).toBe(true);
    }
  });
});

describe('ROUTING_MATRIX', () => {
  // Unaffected by this fix -- ranks reads via optional chaining against a key
  // that was never present either, so it never threw. Asserted here so a
  // future edit to featureFlags.ts cannot silently break this without a red
  // test, the same protection isFeatureEnabled lacked.
  test('falls back to a sane default rank count since routingMatrix is absent from the file', () => {
    expect(ROUTING_MATRIX.ranks).toBe(6);
  });

  test('lifecycle tags and task dimensions are arrays', () => {
    expect(Array.isArray(ROUTING_MATRIX.lifecycleTags)).toBe(true);
    expect(Array.isArray(ROUTING_MATRIX.taskDimensions)).toBe(true);
  });
});
