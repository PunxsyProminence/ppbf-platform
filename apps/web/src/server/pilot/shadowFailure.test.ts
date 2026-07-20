import { shadowFailure } from './shadowFailure';

describe('SHADOW failure taxonomy', () => {
  it('provides stable retry guidance', () => {
    expect(shadowFailure('MODEL_UNAVAILABLE', 'corr-1').retryable).toBe(true);
    expect(shadowFailure('AUTHORIZATION_DENIED', 'corr-2').retryable).toBe(false);
  });

  it('does not expose provider detail in production', () => {
    const previous = process.env.NODE_ENV;
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', configurable: true });
    expect(shadowFailure('MODEL_UNAVAILABLE', 'corr-3', 'secret provider detail').detail).toBeUndefined();
    Object.defineProperty(process.env, 'NODE_ENV', { value: previous, configurable: true });
  });
});