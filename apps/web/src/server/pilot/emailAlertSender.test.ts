import { EMAIL_ALERT_LEASE_SECONDS, EMAIL_ALERT_MAX_TRIES } from './emailAlertQueue';
import {
  EMAIL_ALERT_LEASE_LEFT_TO_SEND_SECONDS,
  EMAIL_ALERT_MAIL_TIMEOUT_MS,
  EMAIL_ALERT_RETRY_WAIT_MINUTES,
  EMAIL_ALERT_SEND_LIMITS,
  emailAlertSenderDependencies,
} from './emailAlertSender';
import { sendPlainTextMail, type MailerDependencies } from './graphMailer';
import { SENDER } from './magicLinkStore';

/*
 * The real dependencies the worker tick uses (lane W4-1, EM-3b-2). The pg suite
 * injects its own, so this is where the alert's mail settings and time bounds
 * are pinned: the sign-in sender (OW27-05 A), no Sent Items copy (Overwatch's
 * answer A on #2159; graphMailer.test.ts proves sign-in links keep theirs), the
 * token fetched before the send, and a Graph call that is cut off.
 */

jest.mock('./graphMailer', () => ({
  ...jest.requireActual('./graphMailer'),
  sendPlainTextMail: jest.fn(async () => undefined),
}));
jest.mock('./managedIdentityToken', () => ({
  graphTokenProvider: () => async () => 'token-value',
}));
jest.mock('./db', () => ({ query: jest.fn(), queryOne: jest.fn(), withTransaction: jest.fn() }));

const message = { to: 'coach@example.com', subject: 'GYM: open the app', body: 'open the app' };

beforeEach(() => {
  jest.clearAllMocks();
});

it('sends from the sign-in mailbox with no Sent Items copy, with the token fetched beforehand', async () => {
  const send = await emailAlertSenderDependencies().prepareSend();
  await send(message);
  expect(sendPlainTextMail).toHaveBeenCalledTimes(1);
  const [sentMessage, config, mailer] = (sendPlainTextMail as jest.Mock).mock.calls[0] as [
    unknown, unknown, MailerDependencies,
  ];
  expect(sentMessage).toEqual(message);
  expect(config).toEqual({ sender: SENDER, saveToSentItems: false });
  await expect(mailer.getAccessToken()).resolves.toBe('token-value');
});

it('cuts the Graph call off at its timeout', async () => {
  const realFetch = global.fetch;
  global.fetch = jest.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  })) as unknown as typeof fetch;
  try {
    const send = await emailAlertSenderDependencies(50).prepareSend();
    await send(message);
    const [, , mailer] = (sendPlainTextMail as jest.Mock).mock.calls[0] as [unknown, unknown, MailerDependencies];
    await expect(mailer.fetchImpl('https://graph.example/sendMail', { method: 'POST' })).rejects.toThrow('aborted');
  } finally {
    global.fetch = realFetch;
  }
});

it('keeps its time bounds: 30 s for Graph, four of five minutes of lease to send, 20 s or 20 sends a tick', () => {
  expect(EMAIL_ALERT_MAIL_TIMEOUT_MS).toBe(30_000);
  expect(EMAIL_ALERT_LEASE_SECONDS).toBe(300);
  expect(EMAIL_ALERT_LEASE_LEFT_TO_SEND_SECONDS).toBe(240);
  expect(EMAIL_ALERT_LEASE_LEFT_TO_SEND_SECONDS * 1000 + EMAIL_ALERT_MAIL_TIMEOUT_MS)
    .toBeLessThan(EMAIL_ALERT_LEASE_SECONDS * 1000);
  expect(EMAIL_ALERT_SEND_LIMITS).toEqual({ budgetMs: 20_000, sendsPerTick: 20 });
});

it('has one wait between each pair of tries (plan 5.4: 1, 5, 15 and 60 minutes, at most 5 tries)', () => {
  expect(EMAIL_ALERT_RETRY_WAIT_MINUTES).toEqual([1, 5, 15, 60]);
  expect(EMAIL_ALERT_RETRY_WAIT_MINUTES).toHaveLength(EMAIL_ALERT_MAX_TRIES - 1);
});
