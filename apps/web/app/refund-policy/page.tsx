import type { Metadata } from "next";
import Link from "next/link";

import { getOperatingOrganizationProfile } from "@/src/server/pilot/organizationProfileStore";

/* The donation, refund and cancellation policy Stripe asks a business website
   to carry. Terms are Jason's (2026-11-12, "go with your recommendations"):
   mistaken charges refundable within 30 days, monthly donations stop with 3
   business days' notice, replies within 5 business days. The adult $20 is a
   suggested donation, not a fee (Jason 2026-11-12, "it needs to be a
   suggested donation not a fee"). The two optional lines in the draft (giving
   is never a condition of training; a written acknowledgment for gifts of
   $250 or more) were not chosen and are left out.
   The gym's names, EIN, emails and mailing address come from its stored
   profile, as /privacy does; a line whose fact is not given is left out. */
export async function generateMetadata(): Promise<Metadata> {
  const gym = await getOperatingOrganizationProfile();
  return {
    title: "Donations, refunds and cancellations",
    description: `How ${gym.legalName} handles donation refunds, monthly donations and questions about a charge.`,
    alternates: { canonical: `${gym.url}/refund-policy` },
  };
}

function Mail({ address }: { address: string }) {
  return <a href={`mailto:${address}`}>{address}</a>;
}

export default async function RefundPolicyPage() {
  const gym = await getOperatingOrganizationProfile();
  const giving = gym.donationsEmail || gym.email;
  const contactEmails = Array.from(new Set([gym.donationsEmail, gym.email].filter(Boolean)));
  const writeTo = giving ? (
    <>
      email <Mail address={giving} />
    </>
  ) : (
    <>contact us</>
  );

  return (
    <main className="on-canvas min-h-screen">
      <article className="mx-auto w-full max-w-[760px] px-[var(--s5)] py-[var(--s7)] lg:px-[var(--s6)]">
        <h1 className="t-command" style={{ fontSize: "var(--t-2xl)" }}>
          Donations, refunds and cancellations
        </h1>
        <p className="t-body mt-[var(--s5)]" style={{ fontSize: "var(--t-md)" }}>
          {gym.legalName} &middot; 501(c)(3) nonprofit{gym.ein ? ` · EIN ${gym.ein}` : ""}
        </p>

        <section className="mt-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: "var(--t-lg)" }}>
            Donations
          </h2>
          <p className="t-body mt-[var(--s2)]">
            {gym.legalName} is an IRS-recognized 501(c)(3) nonprofit. Youth train free. Donations, sponsorships
            and the suggested adult donation of $20 a month are what keep it that way. Card payments are
            processed by Stripe.
          </p>
        </section>

        <section className="mt-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: "var(--t-lg)" }}>
            Refunds
          </h2>
          <p className="t-body mt-[var(--s2)]">
            Donations are generally not refundable. If a donation was made by mistake (the wrong amount, a
            duplicate charge, or a charge you did not authorize), {writeTo} within 30 days and we will refund it
            to the card or account it came from. Refunds usually show up within 5 to 10 business days. A
            refunded donation is no longer a tax-deductible gift, and any receipt for it is void.
          </p>
        </section>

        <section className="mt-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: "var(--t-lg)" }}>
            Monthly donations
          </h2>
          <p className="t-body mt-[var(--s2)]">
            You can stop or change a monthly donation at any time: {writeTo}. A request we receive at least 3
            business days before the next charge takes effect before that charge. Months already charged are
            not refunded, except for the mistakes listed under Refunds.
          </p>
        </section>

        <section className="mt-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: "var(--t-lg)" }}>
            Questions about a charge
          </h2>
          <p className="t-body mt-[var(--s2)]">
            If a charge looks wrong, contact us first. We answer within 5 business days, and most problems are
            fixed faster this way than through a card dispute.
          </p>
          {contactEmails.length > 0 && (
            <p className="t-body mt-[var(--s2)]">
              Email:{" "}
              {contactEmails.map((address, index) => (
                <span key={address}>
                  {index > 0 && " or "}
                  <Mail address={address} />
                </span>
              ))}
            </p>
          )}
          {gym.mailing && <p className="t-body mt-[var(--s2)]">Mail: {gym.mailing}</p>}
          <p className="t-body mt-[var(--s2)]">
            If you file a dispute with your bank or card company, we will give them our records of the charge.
          </p>
        </section>

        <section className="mt-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: "var(--t-lg)" }}>
            Sponsorships
          </h2>
          <p className="t-body mt-[var(--s2)]">Sponsorships follow the written agreement made with each sponsor.</p>
        </section>

        <p className="mt-[var(--s6)]">
          <Link href="/" className="btn btn--ghost">
            Back to the front page
          </Link>
        </p>
      </article>
    </main>
  );
}
