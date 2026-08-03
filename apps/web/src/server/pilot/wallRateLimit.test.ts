import {
  WALL_MAX_PER_WINDOW,
  WALL_WINDOW_MS,
  consumeWallBudget,
  resetWallBudget,
} from './wallRateLimit';

beforeEach(resetWallBudget);

describe('the wall request budget', () => {
  it('does not throttle a television polling every thirty seconds', () => {
    // The regression this module exists to prevent. Wired to rateLimit.ts --
    // which records every call as a failed attempt and doubles the backoff --
    // the gym's own screen starts getting 429s within minutes of being turned
    // on, because it is doing exactly what it was built to do.
    let clock = 0;
    for (let hour = 0; hour < 12; hour += 1) {
      for (let poll = 0; poll < 120; poll += 1) {
        expect(consumeWallBudget('tv', clock).allowed).toBe(true);
        clock += 30_000;
      }
    }
  });

  it('refuses a caller that blows the window budget', () => {
    for (let i = 0; i < WALL_MAX_PER_WINDOW; i += 1) {
      expect(consumeWallBudget('scraper', 0).allowed).toBe(true);
    }
    const refused = consumeWallBudget('scraper', 0);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('opens up again once the window has passed', () => {
    for (let i = 0; i <= WALL_MAX_PER_WINDOW; i += 1) consumeWallBudget('scraper', 0);
    expect(consumeWallBudget('scraper', 0).allowed).toBe(false);
    expect(consumeWallBudget('scraper', WALL_WINDOW_MS).allowed).toBe(true);
  });

  it('never escalates: a refused caller is not punished for asking again', () => {
    for (let i = 0; i <= WALL_MAX_PER_WINDOW + 50; i += 1) consumeWallBudget('scraper', 0);
    // Still exactly one window away, not one window times two-to-the-fifty.
    expect(consumeWallBudget('scraper', WALL_WINDOW_MS).allowed).toBe(true);
  });

  it('budgets each address separately', () => {
    for (let i = 0; i <= WALL_MAX_PER_WINDOW; i += 1) consumeWallBudget('a', 0);
    expect(consumeWallBudget('a', 0).allowed).toBe(false);
    expect(consumeWallBudget('b', 0).allowed).toBe(true);
  });

  it('does not accumulate buckets for addresses that stopped calling', () => {
    for (let i = 0; i < 500; i += 1) consumeWallBudget(`ip-${i}`, 0);
    // One sweep a full window later clears everything that went quiet, so a
    // long-running instance does not grow a map of every address it ever saw.
    consumeWallBudget('tv', WALL_WINDOW_MS);
    for (let i = 0; i < 500; i += 1) {
      expect(consumeWallBudget(`ip-${i}`, WALL_WINDOW_MS).allowed).toBe(true);
    }
  });
});
