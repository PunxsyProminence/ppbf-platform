import { query } from './db';
import { assertActorHoldsCurrentReviewLink, REVIEW_LINK_VALID_MINUTES } from './videoScanReview';
import type { PilotPrincipal } from './auth';

jest.mock('./db', () => ({ query: jest.fn() }));

const mockQuery = query as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'coach-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

/*
 * THE PREREQUISITE BEHIND BOTH WAYS TO 'ready'.
 *
 * Letting a video through is the moment a person takes responsibility for
 * footage a scanner could not clear -- often a minor's. The console has always
 * disabled Release until a review link succeeded, but that was page state: a
 * direct POST was accepted with nothing opened.
 *
 * WHAT IT PROVES, AND THE LIMIT. It proves this platform issued THIS actor a
 * review link for THIS video against the verdict it carries NOW, recently. It
 * does NOT prove anyone watched: the browser fetches the footage straight from
 * storage, so the application never sees the read. Every message on this path
 * therefore says "review link" and never "watched" or "reviewed".
 */

test('an actor holding a current review link may proceed', async () => {
  mockQuery.mockResolvedValueOnce([{ audit_id: '1' }]);

  await expect(assertActorHoldsCurrentReviewLink(principal(), 'vs-1', 'unconfigured'))
    .resolves.toBeUndefined();
});

test('NEGATIVE CONTROL -- nobody opened a link, so the release is refused', async () => {
  // The whole point: a direct POST with nothing opened used to be accepted.
  mockQuery.mockResolvedValueOnce([]);

  await expect(assertActorHoldsCurrentReviewLink(principal(), 'vs-1', 'unconfigured'))
    .rejects.toThrow(/open the review link/i);
});

test('NEGATIVE CONTROL -- the link must belong to THIS actor', async () => {
  /*
   * An admin resolving a coach's held footage does not inherit the coach's
   * review. Admin authority decides WHOSE footage may be released, not whether
   * the person taking the irreversible action looked first.
   */
  mockQuery.mockResolvedValueOnce([]);

  await expect(assertActorHoldsCurrentReviewLink(
    principal({ accountId: 'admin-9', role: 'organization_admin' }),
    'vs-1',
    'unconfigured',
  )).rejects.toThrow(/open the review link/i);

  const [, params] = mockQuery.mock.calls[0]!;
  // The actor is in the query, which is what makes it per-actor rather than
  // per-video.
  expect(params).toContain('admin-9');
});

test('NEGATIVE CONTROL -- a link issued against a different verdict does not count', async () => {
  /*
   * A link issued while a video was 'unconfigured' must not authorise a
   * release after a re-scan moved it to 'blocked': the actor would be acting
   * on a verdict that no longer holds.
   */
  mockQuery.mockResolvedValueOnce([]);

  await expect(assertActorHoldsCurrentReviewLink(principal(), 'vs-1', 'blocked'))
    .rejects.toThrow(/open the review link/i);

  const [sql, params] = mockQuery.mock.calls[0]!;
  expect(String(sql)).toContain("details->>'scan_state'");
  expect(params).toContain('blocked');
});

test('NEGATIVE CONTROL -- the link expires, and the window is the credential its own lifetime', async () => {
  /*
   * Without a bound, a link issued months ago would satisfy this forever.
   * Fifteen minutes is not a number chosen here: it is how long the SAS that
   * review-link mints stays valid.
   */
  mockQuery.mockResolvedValueOnce([]);

  await expect(assertActorHoldsCurrentReviewLink(principal(), 'vs-1', 'unconfigured'))
    .rejects.toThrow(/open the review link/i);

  const [sql, params] = mockQuery.mock.calls[0]!;
  expect(String(sql)).toContain('created_at >=');
  expect(String(sql)).toContain('minutes');
  expect(params).toContain(String(REVIEW_LINK_VALID_MINUTES));
  expect(REVIEW_LINK_VALID_MINUTES).toBe(15);
});

test('the refusal is a Forbidden, so it reaches the caller as 403 rather than 500', async () => {
  // jsonError maps by message prefix; anything else becomes an opaque internal
  // error that tells the caller nothing they can act on.
  mockQuery.mockResolvedValueOnce([]);

  await expect(assertActorHoldsCurrentReviewLink(principal(), 'vs-1', 'unconfigured'))
    .rejects.toThrow(/^Forbidden:/);
});

test('it never claims anybody watched anything', async () => {
  /*
   * THE HONESTY CONSTRAINT, ASSERTED. The evidence is that a link was issued.
   * A message saying "you have reviewed this" would be claiming something no
   * part of this system can observe, on a safeguarding control.
   */
  mockQuery.mockResolvedValueOnce([]);

  const refusal = await assertActorHoldsCurrentReviewLink(principal(), 'vs-1', 'unconfigured')
    .catch((error: Error) => error.message);

  expect(refusal).not.toMatch(/watch|viewed|reviewed this|inspection/i);
  expect(refusal).toMatch(/review link/i);
});

test('the probe is scoped to the organization, so another gym cannot satisfy it', async () => {
  mockQuery.mockResolvedValueOnce([{ audit_id: '1' }]);

  await assertActorHoldsCurrentReviewLink(principal(), 'vs-1', 'unconfigured');

  const [sql, params] = mockQuery.mock.calls[0]!;
  expect(String(sql)).toContain('organization_id = $1');
  expect(params[0]).toBe('org-1');
  expect(params[2]).toBe('vs-1');
});
