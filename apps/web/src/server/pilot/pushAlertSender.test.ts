import https from 'node:https';

import { emailAlertEventStillReadable } from './emailAlertEvents';
import { EMAIL_ALERT_RETRY_WAIT_MINUTES, EMAIL_ALERT_SEND_LIMITS } from './emailAlertSender';
import { PUSH_ALERT_LEASE_SECONDS, PUSH_ALERT_MAX_TRIES } from './pushAlertQueue';
import {
  PUSH_LEASE_LEFT_TO_SEND_SECONDS,
  PUSH_POST_TIMEOUT_MS,
  PUSH_TOPIC,
  PUSH_TTL_SECONDS,
  pushAlertSenderDependencies,
  pushVapidDetails,
} from './pushAlertSender';
import { PUSH_BROWSERS_PER_PERSON } from './pushSubscriptions';
import { postPushRequest, PUSH_POST_DEFAULTS } from './pushTransport';

/*
 * The real dependencies the worker tick uses (lane W5-WP, WP-2b-2b). The pg
 * suite injects its own, so this is where the production wiring and the time
 * bounds are pinned: the public-address-only transport with its time limit,
 * the event read rule, and the lease arithmetic.
 */

jest.mock('./pushTransport', () => ({
  ...jest.requireActual('./pushTransport'),
  postPushRequest: jest.fn(async () => 201),
}));
jest.mock('./db', () => ({ query: jest.fn(), queryOne: jest.fn(), withTransaction: jest.fn() }));

const details = { method: 'POST', endpoint: 'https://push.example.test/send/x', headers: {}, body: null };

beforeEach(() => {
  jest.clearAllMocks();
});

it('posts through the public-address-only transport, cut off at 10 seconds', async () => {
  expect(await pushAlertSenderDependencies({}).post(details)).toBe(201);
  expect(postPushRequest).toHaveBeenCalledTimes(1);
  const [posted, options] = (postPushRequest as jest.Mock).mock.calls[0];
  expect(posted).toBe(details);
  expect(options).toEqual({ ...PUSH_POST_DEFAULTS, timeoutMs: PUSH_POST_TIMEOUT_MS });
  expect(options.lookup).toBe(PUSH_POST_DEFAULTS.lookup);
  expect(options.request).toBe(https.request);
});

it("asks the event's own read rule, and reads the settings it is given", () => {
  const env = { PPBF_WEB_PUSH_SUBJECT: 'mailto:push@example.test' };
  const dependencies = pushAlertSenderDependencies(env);
  expect(dependencies.stillReads).toBe(emailAlertEventStillReadable);
  expect(dependencies.env).toBe(env);
  // Settings pushKeys does not accept give no VAPID details at all.
  expect(pushVapidDetails(env)).toBeNull();
  expect(pushVapidDetails({})).toBeNull();
});

it('keeps its time bounds: every browser at once within four of five minutes of lease; 20 s or 20 sends a tick', () => {
  expect(PUSH_POST_TIMEOUT_MS).toBe(10_000);
  expect(PUSH_ALERT_LEASE_SECONDS).toBe(300);
  expect(PUSH_LEASE_LEFT_TO_SEND_SECONDS).toBe(240);
  // Posts go to all of a person's browsers at once, so one post's limit bounds a send.
  expect(PUSH_POST_TIMEOUT_MS).toBeLessThan(PUSH_LEASE_LEFT_TO_SEND_SECONDS * 1000);
  expect(PUSH_BROWSERS_PER_PERSON).toBe(10);
  expect(EMAIL_ALERT_SEND_LIMITS).toEqual({ budgetMs: 20_000, sendsPerTick: 20 });
});

it("retries on the email's waits, at most 5 tries; web-push's own TTL; one Topic web-push accepts", () => {
  expect(EMAIL_ALERT_RETRY_WAIT_MINUTES).toEqual([1, 5, 15, 60]);
  expect(EMAIL_ALERT_RETRY_WAIT_MINUTES).toHaveLength(PUSH_ALERT_MAX_TRIES - 1);
  expect(PUSH_TTL_SECONDS).toBe(2_419_200);
  // web-push 3.6.7: URL-safe base64 characters, at most 32 of them.
  expect(PUSH_TOPIC).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
});
