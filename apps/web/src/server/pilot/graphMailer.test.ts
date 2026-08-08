import {
  assertSenderIsExpected,
  magicLinkProviderIsSupported,
  MailSendError,
  sendPlainTextMail,
  type MailerDependencies,
} from './graphMailer';

const SENDER = 'Admin@punxsyprominence.org';

function okResponse(): Response {
  return { ok: true, status: 202 } as Response;
}

function deps(overrides: Partial<MailerDependencies> = {}): MailerDependencies {
  return {
    getAccessToken: async () => 'token-value',
    fetchImpl: async () => okResponse(),
    ...overrides,
  };
}

describe('Graph mailer', () => {
  test('sends as the configured mailbox, to the Graph sendMail endpoint', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    await sendPlainTextMail(
      { to: 'parent@example.com', subject: 'Your sign-in link', body: 'Click here' },
      { sender: SENDER },
      deps({
        fetchImpl: async (url, init) => {
          calls.push({ url, init });
          return okResponse();
        },
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      'https://graph.microsoft.com/v1.0/users/Admin%40punxsyprominence.org/sendMail',
    );
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.message.toRecipients[0].emailAddress.address).toBe('parent@example.com');
    expect(body.message.body.contentType).toBe('Text');
    expect(body.saveToSentItems).toBe(true);
  });

  test('presents the token as a bearer credential', async () => {
    let authorization: string | undefined;
    await sendPlainTextMail(
      { to: 'coach@example.com', subject: 's', body: 'b' },
      { sender: SENDER },
      deps({
        getAccessToken: async () => 'abc123',
        fetchImpl: async (_url, init) => {
          authorization = (init.headers as Record<string, string>).Authorization;
          return okResponse();
        },
      }),
    );
    expect(authorization).toBe('Bearer abc123');
  });

  test('refuses to send when no token was obtained', async () => {
    let called = false;
    await expect(
      sendPlainTextMail(
        { to: 'coach@example.com', subject: 's', body: 'b' },
        { sender: SENDER },
        deps({
          getAccessToken: async () => '',
          fetchImpl: async () => {
            called = true;
            return okResponse();
          },
        }),
      ),
    ).rejects.toThrow('NO_ACCESS_TOKEN');
    // The refusal must happen before the request, not after it fails.
    expect(called).toBe(false);
  });

  test('a malformed recipient is refused before any request is made', async () => {
    let called = false;
    await expect(
      sendPlainTextMail(
        { to: 'not-an-address', subject: 's', body: 'b' },
        { sender: SENDER },
        deps({
          fetchImpl: async () => {
            called = true;
            return okResponse();
          },
        }),
      ),
    ).rejects.toThrow('RECIPIENT_MALFORMED');
    expect(called).toBe(false);
  });

  test('an empty subject or body is refused', async () => {
    await expect(
      sendPlainTextMail({ to: 'a@b.co', subject: '   ', body: 'b' }, { sender: SENDER }, deps()),
    ).rejects.toThrow('MESSAGE_EMPTY');
    await expect(
      sendPlainTextMail({ to: 'a@b.co', subject: 's', body: '   ' }, { sender: SENDER }, deps()),
    ).rejects.toThrow('MESSAGE_EMPTY');
  });

  test('a Graph failure surfaces the status and NOT the response body', async () => {
    // Graph echoes request detail -- including the recipient -- in its error
    // bodies. That must never reach a log line.
    const secretBody = 'recipient parent@example.com was rejected';
    let thrown: MailSendError | undefined;
    try {
      await sendPlainTextMail(
        { to: 'parent@example.com', subject: 's', body: 'b' },
        { sender: SENDER },
        deps({
          fetchImpl: async () =>
            ({ ok: false, status: 403, text: async () => secretBody } as unknown as Response),
        }),
      );
    } catch (error) {
      thrown = error as MailSendError;
    }

    expect(thrown?.message).toBe('GRAPH_SEND_FAILED');
    expect(thrown?.statusCode).toBe(403);
    expect(JSON.stringify(thrown)).not.toContain('parent@example.com');
    expect(thrown?.message).not.toContain(secretBody);
  });

  test('a sender that is not the configured mailbox is refused', () => {
    expect(() => assertSenderIsExpected('someone.else@punxsyprominence.org', SENDER))
      .toThrow('SENDER_NOT_PERMITTED');
    expect(() => assertSenderIsExpected(SENDER, '')).toThrow('SENDER_NOT_PERMITTED');
  });

  test('sender comparison ignores case, since Entra returns either', () => {
    // Production holds both Admin@ and admin@ as separate account rows because
    // account_id is case-sensitive. The mailbox is one mailbox; a case
    // difference must not refuse a legitimate send.
    expect(() => assertSenderIsExpected('admin@punxsyprominence.org', SENDER)).not.toThrow();
    expect(() => assertSenderIsExpected('ADMIN@PUNXSYPROMINENCE.ORG', SENDER)).not.toThrow();
  });

  test('magic_link is a real provider in the canonical vocabulary', () => {
    expect(magicLinkProviderIsSupported()).toBe(true);
  });
});
