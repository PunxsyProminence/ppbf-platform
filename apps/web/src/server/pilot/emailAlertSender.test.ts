import { emailAlertSenderDependencies } from './emailAlertSender';
import { sendPlainTextMail } from './graphMailer';
import { SENDER } from './magicLinkStore';

/*
 * The real dependencies the worker tick uses (lane W4-1, EM-3b). The pg suite
 * injects its own sendMail, so this is where the alert's mail settings are
 * pinned: the sign-in sender (OW27-05 A) and no Sent Items copy (Overwatch's
 * answer A on #2159; graphMailer.test.ts proves sign-in links keep theirs).
 */

jest.mock('./graphMailer', () => ({
  ...jest.requireActual('./graphMailer'),
  sendPlainTextMail: jest.fn(async () => undefined),
}));
jest.mock('./managedIdentityToken', () => ({
  graphTokenProvider: () => async () => 'token-value',
}));
jest.mock('./db', () => ({ query: jest.fn(), queryOne: jest.fn(), withTransaction: jest.fn() }));

it('sends from the sign-in mailbox with no Sent Items copy', async () => {
  const message = { to: 'coach@example.com', subject: 'GYM: open the app', body: 'open the app' };
  await emailAlertSenderDependencies().sendMail(message);
  expect(sendPlainTextMail).toHaveBeenCalledTimes(1);
  const [sentMessage, config] = (sendPlainTextMail as jest.Mock).mock.calls[0];
  expect(sentMessage).toEqual(message);
  expect(config).toEqual({ sender: SENDER, saveToSentItems: false });
});
