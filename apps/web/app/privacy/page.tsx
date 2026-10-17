import type { Metadata } from "next";
import Link from "next/link";

import { getOperatingOrganizationProfile } from "@/src/server/pilot/organizationProfileStore";
import type { OrganizationProfile } from "@/src/shared/organizationProfile";

/* The privacy notice for the interest form on /. Wording is Jason's, relayed
   by overwatch 2026-10-04 ("1 approve 2 let fix it 3ok"); facts per his
   rulings: 12-month retention ("12 month"), not sold or shared, 13 or older.
   The 12-month automatic deletion is a separate follow-up, not built here.
   The gym's names, EIN, website, email and mailing address come from its
   stored profile (lane L31, #1469); a line whose fact is not given is left out. */
export async function generateMetadata(): Promise<Metadata> {
  const gym = await getOperatingOrganizationProfile();
  return {
    title: "Privacy",
    description: `How ${gym.legalName} handles what you send through the interest form.`,
    alternates: { canonical: `${gym.url}/privacy` },
  };
}

const sections = (gym: OrganizationProfile) => [
  {
    heading: "What we collect",
    body: "When you use the interest form we receive your name, email, phone number if you give it, who you are, the program you are interested in, how you would like us to contact you, and any message you write.",
  },
  {
    heading: "Why",
    body: "Only to answer you about our programs. Sending the form is your request for us to contact you.",
  },
  { heading: "Who sees it", body: `${gym.shortName} staff who handle new members. We do not sell or share it.` },
  { heading: "How long", body: "We keep it for 12 months, then delete it, unless you join." },
  { heading: "Age", body: "The form is for people 13 or older; a parent or guardian can send it for a younger child." },
];

export default async function PrivacyPage() {
  const gym = await getOperatingOrganizationProfile();
  return (
    <main className="on-canvas min-h-screen">
      <article className="mx-auto w-full max-w-[760px] px-[var(--s5)] py-[var(--s7)] lg:px-[var(--s6)]">
        <h1 className="t-command" style={{ fontSize: "var(--t-2xl)" }}>
          Privacy
        </h1>
        <p className="t-body mt-[var(--s5)]" style={{ fontSize: "var(--t-md)" }}>
          {gym.legalName}{gym.ein ? ` (EIN ${gym.ein})` : ""} runs this website, {gym.domain}.
        </p>
        {sections(gym).map((section) => (
          <section key={section.heading} className="mt-[var(--s5)]">
            <h2 className="t-command" style={{ fontSize: "var(--t-lg)" }}>
              {section.heading}
            </h2>
            <p className="t-body mt-[var(--s2)]">{section.body}</p>
          </section>
        ))}
        {gym.email && (
          <section className="mt-[var(--s5)]">
            <h2 className="t-command" style={{ fontSize: "var(--t-lg)" }}>
              Your choices
            </h2>
            <p className="t-body mt-[var(--s2)]">
              To see, correct or delete what you sent, email{" "}
              <a href={`mailto:${gym.email}`}>{gym.email}</a>.
            </p>
          </section>
        )}
        <section className="mt-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: "var(--t-lg)" }}>
            Contact
          </h2>
          <p className="t-body mt-[var(--s2)]">
            {[gym.legalName, gym.mailing].filter(Boolean).join(", ")}
            {gym.email && (
              <>
                {" "}&middot;{" "}
                <a href={`mailto:${gym.email}`}>{gym.email}</a>
              </>
            )}
          </p>
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
