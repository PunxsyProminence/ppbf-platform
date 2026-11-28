import { emailAlertCodeMailer, emailAlertCodeMessage } from './emailAlertCode';
import { queryOne } from './db';
import { EMAIL_ALERT_CODE_LIFETIME_MS } from './emailAlertSwitches';
import { MailSendError, sendPlainTextMail, type MailerDependencies } from './graphMailer';
import { SENDER } from './magicLinkStore';
import { getOrganizationProfile, OrganizationProfileUnavailableError } from './organizationProfileStore';

/*
 * The code email that confirms an adult athlete's alert address (lane W4-1,
 * EM-2b-2). Jason's Q-1 A (#2159 comment 7184772035) fixes its wording, so it
 * is pinned here character for character; who gets one, and how often, is the
 * store's (emailAlertAddress.pg.test.ts).
 */

jest.mock('./graphMailer', () => ({
  ...jest.requireActual('./graphMailer'),
  sendPlainTextMail: jest.fn(async () => undefined),
}));
jest.mock('./managedIdentityToken', () => ({
  graphTokenProvider: () => async () => 'token-value',
}));
jest.mock('./organizationProfileStore', () => ({
  ...jest.requireActual('./organizationProfileStore'),
  getOrganizationProfile: jest.fn(),
}));
jest.mock('./db', () => ({ query: jest.fn(), queryOne: jest.fn(), withTransaction: jest.fn() }));

const mockSend = sendPlainTextMail as jest.Mock;
const mockProfile = getOrganizationProfile as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

const TO = 'adult.person@example.test';
const CODE = '012345';

function bodyFor(gymName: string, code: string) {
  return `Someone asked to get ${gymName} email alerts at this address.\n\n`
    + `Your code: ${code}\n\n`
    + 'The code works once and expires in 15 minutes.\n\n'
    + 'If this was not you, you can ignore this message. Nothing more is sent to this address unless the code is entered.';
}

beforeEach(() => {
  jest.clearAllMocks();
});

it('is Jason\'s wording exactly: the short name in the subject, the gym\'s name in the first of four lines', () => {
  expect(emailAlertCodeMessage({ shortName: 'EXGYM', legalName: 'Example Gym and Fitness' }, '123456')).toEqual({
    subject: 'Your EXGYM email code',
    body: bodyFor('Example Gym and Fitness', '123456'),
  });
  // The body's lifetime is the store's.
  expect(EMAIL_ALERT_CODE_LIFETIME_MS).toBe(15 * 60 * 1000);
});

it('with no name at all, leaves the name out rather than invent one', () => {
  expect(emailAlertCodeMessage({ shortName: ' ', legalName: '' }, '123456')).toEqual({
    subject: 'Your email code',
    body: bodyFor('', '123456').replace('get  email', 'get email'),
  });
});

it('reads the stored profile: short name in the subject, legal name in the body; from the sign-in mailbox with no Sent Items copy', async () => {
  mockProfile.mockResolvedValue({ shortName: 'EXGYM', legalName: 'Example Gym and Fitness' });
  await emailAlertCodeMailer()({ organizationId: 'org-1', to: TO, code: CODE });
  expect(mockProfile).toHaveBeenCalledWith('org-1');
  expect(mockQueryOne).not.toHaveBeenCalled();
  expect(mockSend).toHaveBeenCalledTimes(1);
  const [message, config, mailer] = mockSend.mock.calls[0] as [unknown, unknown, MailerDependencies];
  expect(message).toEqual({ to: TO, subject: 'Your EXGYM email code', body: bodyFor('Example Gym and Fitness', CODE) });
  expect(config).toEqual({ sender: SENDER, saveToSentItems: false });
  await expect(mailer.getAccessToken()).resolves.toBe('token-value');
});

it('with no profile to read, names the gym by its name of record in both places, as the alert does', async () => {
  mockProfile.mockRejectedValue(new OrganizationProfileUnavailableError('org-1'));
  mockQueryOne.mockResolvedValue({ organization_name: 'Example Boxing Club' });
  await emailAlertCodeMailer()({ organizationId: 'org-1', to: TO, code: CODE });
  expect(mockQueryOne.mock.calls[0][1]).toEqual(['org-1']);
  expect(mockSend.mock.calls[0][0]).toEqual({
    to: TO, subject: 'Your Example Boxing Club email code', body: bodyFor('Example Boxing Club', CODE),
  });
});

it('cuts the Graph call off at its timeout', async () => {
  mockProfile.mockResolvedValue({ shortName: 'EXGYM', legalName: 'Example Gym and Fitness' });
  const realFetch = global.fetch;
  global.fetch = jest.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  })) as unknown as typeof fetch;
  try {
    await emailAlertCodeMailer(50)({ organizationId: 'org-1', to: TO, code: CODE });
    const [, , mailer] = mockSend.mock.calls[0] as [unknown, unknown, MailerDependencies];
    await expect(mailer.fetchImpl('https://graph.example/sendMail', { method: 'POST' })).rejects.toThrow('aborted');
  } finally {
    global.fetch = realFetch;
  }
});

it('a failed send throws the mailer\'s error, which carries neither the address nor the code, and logs nothing itself', async () => {
  mockProfile.mockResolvedValue({ shortName: 'EXGYM', legalName: 'Example Gym and Fitness' });
  mockSend.mockRejectedValueOnce(new MailSendError('GRAPH_SEND_FAILED', 503));
  const logs = [jest.spyOn(console, 'error'), jest.spyOn(console, 'warn'), jest.spyOn(console, 'log')];
  try {
    const failure = await emailAlertCodeMailer()({ organizationId: 'org-1', to: TO, code: CODE }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MailSendError);
    const said = JSON.stringify({ message: (failure as Error).message, ...(failure as object) });
    expect(said).not.toContain(TO);
    expect(said).not.toContain(CODE);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  } finally {
    for (const log of logs) log.mockRestore();
  }
});
