import { AUTH_PROVIDERS } from './authProviders';

/**
 * Sends mail as Admin@punxsyprominence.org through Microsoft Graph.
 *
 * WHY GRAPH RATHER THAN A MAIL SERVICE
 *
 * punxsyprominence.org is already a verified domain in the Entra tenant with
 * Email enabled, and Admin@punxsyprominence.org is already a real mailbox. So
 * there is nothing to provision, no DNS to add, no vendor to onboard, and --
 * the part that matters after the week this repository has had -- no new
 * secret. The container app's system-assigned managed identity holds the
 * permission; nothing is stored anywhere.
 *
 * THE PERMISSION IS DANGEROUS UNTIL IT IS SCOPED
 *
 * Mail.Send as an application permission is tenant-wide. Granted alone it lets
 * this app send as ANY mailbox on the domain, including every board member's.
 * An Exchange Application Access Policy restricts it to the one sender below.
 * That policy is infrastructure, so this module cannot enforce it -- but
 * assertSenderIsExpected() refuses to send from anything other than the
 * configured address, so a misconfiguration cannot quietly widen the blast
 * radius from this side.
 *
 * NOT A GENERAL MAILER
 *
 * There is one send function and it takes a subject and a plain-text body. No
 * templates, no attachments, no HTML, no bulk. Magic links are the only thing
 * this platform sends, and a narrow surface is the point: nothing here can be
 * repurposed into a way to mail athletes or guardians without a deliberate
 * change that shows up in review.
 */

const GRAPH_SEND_MAIL_URL = (sender: string) =>
  `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`;

/** Acquires a Graph access token. Injected so tests never touch Azure. */
export type AccessTokenProvider = () => Promise<string>;

/** The HTTP call itself. Injected for the same reason. */
export type MailFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface MailerConfig {
  /** The mailbox to send as. Must match the Application Access Policy. */
  sender: string;
}

export interface MailerDependencies {
  getAccessToken: AccessTokenProvider;
  fetchImpl: MailFetch;
}

export interface OutboundMessage {
  to: string;
  subject: string;
  /** Plain text only. See the note above about a narrow surface. */
  body: string;
}

export class MailSendError extends Error {
  constructor(
    readonly reason: string,
    /** Present only when Graph answered; absent when the call never completed. */
    readonly statusCode?: number,
    /** Graph's own error code, when it passed extractGraphErrorCode. */
    readonly graphErrorCode?: string,
  ) {
    // Never the response body. Graph echoes request detail in errors, and this
    // message reaches logs -- a recipient address in a log line is exactly the
    // athlete-adjacent data this platform is careful with elsewhere.
    super(reason);
    this.name = 'MailSendError';
  }
}

/**
 * Graph's error.code, and only if it cannot possibly be an address.
 *
 * A 403 from sendMail has two entirely different causes that look identical
 * from outside: ErrorAccessDenied means the Exchange Application Access Policy
 * refused the mailbox, Authorization_RequestDenied means the token lacks
 * Mail.Send. They need opposite fixes, and staging burned an hour on that
 * ambiguity because the log said only GRAPH_SEND_FAILED and 403.
 *
 * The body's `message` field is the one that echoes the recipient back --
 * "Access to OData is disabled" is safe, but Graph is not obliged to keep it
 * that way and this line reaches a log aggregator. So the code is taken and the
 * message is dropped, and the code is only passed through if it matches a shape
 * an email address CANNOT have: no @, no dot, no space, bounded length. A
 * future Graph error code that carries user data cannot get through that.
 */
export function extractGraphErrorCode(body: string): string | undefined {
  try {
    const code = (JSON.parse(body) as { error?: { code?: unknown } })?.error?.code;
    if (typeof code !== 'string') return undefined;
    return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code) ? code : undefined;
  } catch {
    // A non-JSON body (an HTML error page from a proxy, say) tells us nothing
    // worth the risk of logging part of it.
    return undefined;
  }
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Refuses a sender that is not the configured one.
 *
 * The Application Access Policy is the real control and lives in Exchange.
 * This is the second lock: if config drifts, or someone passes a sender
 * through from a request, the send fails here rather than reaching Graph with
 * a mailbox nobody intended.
 */
export function assertSenderIsExpected(sender: string, configured: string): void {
  if (!configured || sender.toLowerCase() !== configured.toLowerCase()) {
    throw new MailSendError('SENDER_NOT_PERMITTED');
  }
}

export async function sendPlainTextMail(
  message: OutboundMessage,
  config: MailerConfig,
  dependencies: MailerDependencies,
): Promise<void> {
  assertSenderIsExpected(config.sender, config.sender);

  if (!EMAIL_SHAPE.test(message.to)) {
    throw new MailSendError('RECIPIENT_MALFORMED');
  }
  if (!message.subject.trim() || !message.body.trim()) {
    throw new MailSendError('MESSAGE_EMPTY');
  }

  const token = await dependencies.getAccessToken();
  if (!token) {
    throw new MailSendError('NO_ACCESS_TOKEN');
  }

  const response = await dependencies.fetchImpl(GRAPH_SEND_MAIL_URL(config.sender), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        subject: message.subject,
        body: { contentType: 'Text', content: message.body },
        toRecipients: [{ emailAddress: { address: message.to } }],
      },
      // The sent copy is the record that a link went out and when. Retention
      // sweeps the token rows; the mailbox keeps the correspondence.
      saveToSentItems: true,
    }),
  });

  if (!response.ok) {
    // The status, plus Graph's error code if it survives the shape check. The
    // body itself never leaves this function -- it carries the recipient.
    const body = await response.text().catch(() => '');
    throw new MailSendError('GRAPH_SEND_FAILED', response.status, extractGraphErrorCode(body));
  }
}

/**
 * Guards an assumption this module rests on: magic_link is a real provider in
 * the canonical vocabulary. If it were removed, sending sign-in links would be
 * sending links to accounts that cannot use them.
 */
export function magicLinkProviderIsSupported(): boolean {
  return (AUTH_PROVIDERS as readonly string[]).includes('magic_link');
}
