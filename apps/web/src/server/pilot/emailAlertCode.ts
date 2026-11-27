/**
 * THE CODE EMAIL THAT CONFIRMS AN ADULT ATHLETE'S ALERT ADDRESS (lane W4-1,
 * EM-2b-2). OW27-38 B: the address is used only after the athlete enters a
 * code the app emails to it, and "that one code email may say more than 'open
 * the app'". The store decides who gets one and how often
 * (emailAlertSwitches.ts, requestEmailAlertAddressCode); this module only
 * writes and sends it.
 *
 * THE WORDING IS JASON'S (Q-1 A, #2159 comment 7184772035), kept exactly, and
 * the same for a resend (Overwatch): subject `Your <gym short name> email code`,
 * and the body below. The gym's names are the alert's (gymNames, the
 * sender's): this gym's stored profile (getOrganizationProfile; outside
 * production with no row, its development profile), short name in the
 * subject and legal name in the body, or, with no profile to read, the gym's
 * name of record (pilot.organizations) in both. The sign-in email reads the
 * operating gym's profile instead and has no name-of-record fallback. With no
 * name at all the name is left out.
 *
 * From the sign-in mailbox (OW27-05 A), with no Sent Items copy (default 7 of
 * Overwatch's GO on EM-2b, as Sent Items A did for the alert): the mailbox
 * keeps no second copy of the address or the code.
 */

import { EMAIL_ALERT_MAIL_TIMEOUT_MS, gymNames } from './emailAlertSender';
import type { EmailAlertCodeMailer } from './emailAlertSwitches';
import { sendPlainTextMail } from './graphMailer';
import { SENDER } from './magicLinkStore';
import { graphTokenProvider } from './managedIdentityToken';

export function emailAlertCodeMessage(
  names: { readonly shortName: string; readonly legalName: string },
  code: string,
): { subject: string; body: string } {
  const shortName = names.shortName.trim();
  const gymName = names.legalName.trim();
  return {
    subject: shortName ? `Your ${shortName} email code` : 'Your email code',
    body: [
      gymName ? `Someone asked to get ${gymName} email alerts at this address.` : 'Someone asked to get email alerts at this address.',
      '',
      `Your code: ${code}`,
      '',
      'The code works once and expires in 15 minutes.',
      '',
      'If this was not you, you can ignore this message. Nothing more is sent to this address unless the code is entered.',
    ].join('\n'),
  };
}

/** The real send: Graph, cut off at the alert's own timeout. A failure throws the mailer's MailSendError, which never carries the address. */
export function emailAlertCodeMailer(mailTimeoutMs: number = EMAIL_ALERT_MAIL_TIMEOUT_MS): EmailAlertCodeMailer {
  return async ({ organizationId, to, code }) => {
    const message = emailAlertCodeMessage(await gymNames(organizationId), code);
    await sendPlainTextMail({ to, ...message }, { sender: SENDER, saveToSentItems: false }, {
      getAccessToken: graphTokenProvider(),
      fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(mailTimeoutMs) }),
    });
  };
}
