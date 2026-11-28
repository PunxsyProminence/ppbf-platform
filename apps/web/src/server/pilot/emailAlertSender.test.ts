import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import { EMAIL_ALERT_LEASE_SECONDS, EMAIL_ALERT_MAX_TRIES } from './emailAlertQueue';
import {
  EMAIL_ALERT_LEASE_LEFT_TO_SEND_SECONDS,
  EMAIL_ALERT_MAIL_TIMEOUT_MS,
  EMAIL_ALERT_RETRY_WAIT_MINUTES,
  EMAIL_ALERT_SEND_LIMITS,
  EMAIL_ALERT_TOKEN_TIMEOUT_MS,
  emailAlertSenderDependencies,
} from './emailAlertSender';
import { sendPlainTextMail, type MailerDependencies } from './graphMailer';
import { SENDER } from './magicLinkStore';
import { getGraphAccessToken } from './managedIdentityToken';

/*
 * The real dependencies the worker tick uses (lane W4-1, EM-3b-2). The pg suite
 * injects its own, so this is where the alert's mail settings and time bounds
 * are pinned: the sign-in sender (OW27-05 A), no Sent Items copy (Overwatch's
 * answer A on #2159; graphMailer.test.ts proves sign-in links keep theirs), the
 * token fetched before the send, a token fetch that is cut off, and a Graph
 * call that is cut off.
 */

jest.mock('./graphMailer', () => ({
  ...jest.requireActual('./graphMailer'),
  sendPlainTextMail: jest.fn(async () => undefined),
}));
jest.mock('./managedIdentityToken', () => ({
  ...jest.requireActual('./managedIdentityToken'),
  graphTokenProvider: () => async () => 'token-value',
  getGraphAccessToken: jest.fn(async () => 'token-value'),
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

// A reviewer on EM-3b-2: the shared token provider has no cut-off, so the
// sender fetches the token with one: a hung identity endpoint fails the try.
it('cuts the token fetch off at its timeout: a hung identity endpoint fails the preparation as ManagedIdentityError', async () => {
  const actual = jest.requireActual('./managedIdentityToken');
  actual.resetTokenCache();
  (getGraphAccessToken as jest.Mock).mockImplementationOnce(actual.getGraphAccessToken);
  const realFetch = global.fetch;
  const env = { endpoint: process.env.IDENTITY_ENDPOINT, header: process.env.IDENTITY_HEADER };
  process.env.IDENTITY_ENDPOINT = 'http://identity.test/msi/token';
  process.env.IDENTITY_HEADER = 'identity-header';
  const urls: string[] = [];
  const signalled: boolean[] = [];
  global.fetch = jest.fn((url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    urls.push(String(url));
    signalled.push(Boolean(init?.signal));
    // Never answers; without a cut-off it gives up after three seconds.
    const giveUp = setTimeout(() => reject(new Error('never answered')), 3_000);
    init?.signal?.addEventListener('abort', () => {
      clearTimeout(giveUp);
      reject(new Error('aborted'));
    });
  })) as unknown as typeof fetch;
  try {
    const started = Date.now();
    await expect(emailAlertSenderDependencies(EMAIL_ALERT_MAIL_TIMEOUT_MS, 50).prepareSend())
      .rejects.toMatchObject({ name: 'ManagedIdentityError', message: 'IDENTITY_ENDPOINT_UNREACHABLE' });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(urls).toHaveLength(1);
    expect(urls[0].startsWith('http://identity.test/msi/token?resource=')).toBe(true);
    expect(signalled).toEqual([true]);
    expect(sendPlainTextMail).not.toHaveBeenCalled();
  } finally {
    global.fetch = realFetch;
    process.env.IDENTITY_ENDPOINT = env.endpoint;
    process.env.IDENTITY_HEADER = env.header;
    if (env.endpoint === undefined) delete process.env.IDENTITY_ENDPOINT;
    if (env.header === undefined) delete process.env.IDENTITY_HEADER;
    actual.resetTokenCache();
  }
});

// A reviewer on EM-3b-2: the cut-off covers the token response's body, not
// only its headers. A real local server answers with headers and part of a
// body, then stalls.
it('the token cut-off covers the response body: headers, then a stalled body, fail as ManagedIdentityError within the bound', async () => {
  const actual = jest.requireActual('./managedIdentityToken');
  actual.resetTokenCache();
  (getGraphAccessToken as jest.Mock).mockImplementationOnce(actual.getGraphAccessToken);
  const sockets = new Set<Socket>();
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': '200' });
    response.write('{"access_token":"t');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const env = { endpoint: process.env.IDENTITY_ENDPOINT, header: process.env.IDENTITY_HEADER };
  process.env.IDENTITY_ENDPOINT = `http://127.0.0.1:${(server.address() as AddressInfo).port}/msi/token`;
  process.env.IDENTITY_HEADER = 'identity-header';
  let giveUp: NodeJS.Timeout | undefined;
  try {
    const started = Date.now();
    const outcome = await Promise.race([
      emailAlertSenderDependencies(EMAIL_ALERT_MAIL_TIMEOUT_MS, 200).prepareSend().then(() => 'resolved', (error: unknown) => error),
      new Promise((resolve) => {
        giveUp = setTimeout(() => resolve('still waiting after 3 s'), 3_000);
      }),
    ]);
    expect(outcome).toMatchObject({ name: 'ManagedIdentityError', message: 'IDENTITY_TOKEN_MALFORMED' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(requests).toBe(1);
    expect(sendPlainTextMail).not.toHaveBeenCalled();
  } finally {
    clearTimeout(giveUp);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    process.env.IDENTITY_ENDPOINT = env.endpoint;
    process.env.IDENTITY_HEADER = env.header;
    if (env.endpoint === undefined) delete process.env.IDENTITY_ENDPOINT;
    if (env.header === undefined) delete process.env.IDENTITY_HEADER;
    actual.resetTokenCache();
  }
});

it('keeps its time bounds: 10 s for the token, 30 s for Graph, four of five minutes of lease to send, 20 s or 20 sends a tick', () => {
  expect(EMAIL_ALERT_TOKEN_TIMEOUT_MS).toBe(10_000);
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
