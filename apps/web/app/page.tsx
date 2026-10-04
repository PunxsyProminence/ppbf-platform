import type { Metadata } from "next";
import Link from "next/link";

import PhotoSlot from "@/components/PhotoSlot";
import PublicInterestForm, { programInterestLabels } from "@/components/PublicInterestForm";
import { gymPhotoSlotsFor } from "@/src/shared/gymPhotos";

/* The registry facts, stated once. The visible page and the JSON-LD both read
   from here so they cannot drift, and page.test.tsx checks each one against
   the rendered text. Sources (PR description has the citations):
   legal name and EIN -- PA Articles of Incorporation (file 0013779917,
   3/22/2024), IRS CP 575 E and Letter 947 (04/11/2024); addresses -- Jason,
   2026-10-03 ("220 N Jefferson is the physical address", "the PO box is the
   office mailing address"). The private office address is deliberately
   not published, here or in comments. Founder -- Jason, 2026-10-03 (he is
   the incorporator on the PA Articles). */
const org = {
  brand: "Punxsy Prominence Boxing & Fitness",
  legalName: "Punxsy Prominence Boxing and Fitness",
  ein: "99-2073622",
  url: "https://www.punxsyprominence.org",
  domain: "punxsyprominence.org",
  email: "admin@punxsyprominence.org",
  donationsEmail: "treasurer@punxsyprominence.org",
  grantsEmail: "grants@punxsyprominence.org",
  established: "2024",
  physical: {
    street: "220 N Jefferson St",
    city: "Punxsutawney",
    region: "PA",
    postalCode: "15767",
  },
  mailing: "PO Box 54, Big Run, PA 15715",
} as const;

const physicalAddress = `${org.physical.street}, ${org.physical.city}, ${org.physical.region} ${org.physical.postalCode}`;
const domainStatement = `${org.domain} is the official website and application of ${org.legalName}.`;

export const metadata: Metadata = {
  title: "Punxsy Prominence Boxing & Fitness",
  description:
    "Punxsy Prominence Boxing and Fitness is an IRS-recognized 501(c)(3) nonprofit using structured boxing and athlete-development programming to serve youth in Punxsutawney and surrounding rural western Pennsylvania communities. Youth participate at no charge.",
  alternates: { canonical: `${org.url}/` },
};

const structuredData = {
  "@context": "https://schema.org",
  "@type": "NGO",
  name: org.brand,
  legalName: org.legalName,
  alternateName: "PPBF",
  url: `${org.url}/`,
  description:
    "IRS-recognized 501(c)(3) nonprofit using structured boxing and athlete-development programming to help young people build discipline, confidence, accountability, and practical life skills.",
  email: org.email,
  taxID: org.ein,
  nonprofitStatus: "https://schema.org/Nonprofit501c3",
  foundingDate: org.established,
  address: {
    "@type": "PostalAddress",
    streetAddress: org.physical.street,
    addressLocality: org.physical.city,
    addressRegion: org.physical.region,
    postalCode: org.physical.postalCode,
    addressCountry: "US",
  },
  areaServed: {
    "@type": "Place",
    name: "Punxsutawney and surrounding rural Pennsylvania communities",
  },
  founder: {
    "@type": "Person",
    name: "Jason Neale",
    jobTitle: "Head Coach/Governor",
  },
};

const approach = [
  {
    title: "Safety-Focused Youth Development",
    description:
      "Every program is built around age-appropriate safety, supervision, and structured progression from day one.",
  },
  {
    title: "Non-Contact Foundational Instruction",
    description:
      "New athletes start with non-contact fundamentals: footwork, technique, and conditioning before anything else.",
  },
  {
    title: "Progressive Technical Training",
    description:
      "Athletes advance at their own pace through structured skill-building as coaches confirm readiness.",
  },
  {
    title: "Optional Competitive Pathways",
    description:
      "Athletes who are ready and choose to compete have a pathway available. Competing is never required to participate.",
  },
  {
    title: "Coaching & Mentorship",
    description:
      "Coaches mentor athletes on academic responsibility, leadership, decision-making, and community involvement.",
  },
];

/* What we run -- moved from /public (which now forwards here). The "How to
   start" lines name the option a visitor will actually see in the form's
   "What you are interested in" list, so they read from the same labels. */
const programCards = [
  {
    title: "Fitness Only -- Nobody Hits You",
    whatItIs:
      "Bags, rope, footwork, conditioning. Boxing training without the boxing. No contact, no sparring, not now and not later.",
    whoFor:
      "Adults who want a hard workout and have zero interest in getting punched. This is a full program, not a beginner phase you graduate out of.",
    nextStep: `Pick "${programInterestLabels["Boxing / Fitness"]}" in the form below and write "fitness only" in the message.`,
  },
  {
    title: "Adult Recreational Boxing",
    whatItIs:
      "Actual boxing -- stance, footwork, combinations, pad work -- taught at a pace that fits someone with a job and a bad back. Sparring is available if you ever want it and is never required.",
    whoFor: "Adults who want to learn to box, whether or not they ever step in a ring.",
    nextStep: `Pick "${programInterestLabels["Boxing / Fitness"]}" below and tell us you are an adult starting out.`,
  },
  {
    title: "Youth Boxing and Mentorship",
    whatItIs:
      "Kids and teens train with coaches who also ask about school, attitude, and how they treat people. Everyone starts non-contact: footwork, technique, conditioning, supervised the whole time.",
    whoFor:
      "Young people who need somewhere to put their energy and adults who will stay in their corner. Kids train free.",
    nextStep: `Pick "${programInterestLabels["Youth Development"]}" below. Parents, put your kid's age in the message.`,
  },
  {
    title: "Competitive Boxing",
    whatItIs:
      "For athletes who decide on their own that they want to compete. A coach confirms readiness before any of it. Nobody gets pushed toward a ring to fill a card.",
    whoFor: "Athletes who choose it. Competing is optional here and always has been.",
    nextStep: `Pick "${programInterestLabels["Competition Track"]}" below.`,
  },
  {
    title: "Adaptive Training",
    whatItIs:
      "The same work, adjusted -- around an injury, a disability, a health condition, or a body coming back from a long time off.",
    whoFor: "Anyone who has been told they cannot, or has been quietly counted out somewhere else.",
    nextStep: `Pick "${programInterestLabels["Adaptive Training"]}" below and tell us as much or as little as you want.`,
  },
  {
    title: "For Parents and Guardians",
    whatItIs:
      "Straight answers about supervision, contact rules, what a session looks like, and how to reach a coach directly. You are welcome to stay and watch any session.",
    whoFor:
      "Parents deciding whether to bring their kid through the door, and parents whose kid already trains here.",
    nextStep: `Pick "${programInterestLabels["Parent Support"]}" below and ask whatever you actually want to ask.`,
  },
  {
    title: "Volunteering",
    whatItIs:
      "Events, transportation, equipment, timekeeping, the unglamorous work that keeps a gym open. No boxing background needed.",
    whoFor: "People with a few hours and a willingness to be useful.",
    nextStep: `Pick "${programInterestLabels["Volunteer Support"]}" below and tell us when you are free.`,
  },
  {
    title: "Sponsors and Partners",
    whatItIs:
      "Businesses, schools, and community organizations who help keep training free for kids. We will tell you exactly what your support pays for.",
    whoFor: "Organizations or individuals who want to back this with money, space, or gear.",
    nextStep: `Pick "${programInterestLabels["Sponsorship / Partnership"]}" below.`,
  },
];

/* Moved from /public. The cost answer carries Jason's figure (adults $20 a
   month, 2026-10-03), replacing the old "Adults, ask us". */
const faqItems = [
  {
    question: "Do I have to fight anybody?",
    answer:
      "No. A lot of people here never get hit, on purpose or by accident, and that is a normal way to train here for as long as you want. Sparring and competing are separate choices you make later, only if you want them, and a coach signs off on readiness before either one.",
  },
  {
    question: "Is my kid going to get hurt?",
    answer:
      "Every kid starts non-contact -- footwork, technique, conditioning -- supervised the whole time. Contact comes later, only when a coach confirms a kid is ready for it, with the right gear and a coach running it. You are welcome to stay and watch any session, start to finish, and you should.",
  },
  {
    question: "What does it cost?",
    answer:
      "Youth train free. Whether a child can train here is not decided by what their family can pay. Adults pay $20 a month.",
  },
  {
    question: "When are you open?",
    answer: "Send the form below or email us and we will give you the current training times.",
  },
  {
    question: "Do I need to be in shape first?",
    answer: "No, and nobody here started that way either. Come as you are. You will be sore and you will be welcome.",
  },
  {
    question: "I have never boxed. Is that a problem?",
    answer:
      "No. Most people who walk in have never thrown a punch. First-timers and experienced fighters use the same door and the same form.",
  },
  {
    question: "Is this just for kids, or can adults train too?",
    answer:
      "Both. Youth development is why this place exists, and adults train here as well -- fitness only, recreational boxing, or competition if that is what they want.",
  },
  {
    question: "Who is actually coaching my kid?",
    answer:
      "Jason Neale is head coach. PPBF is a veteran-led, IRS-recognized 501(c)(3) nonprofit. Ask to meet whoever would be working with your kid before you commit to anything.",
  },
  {
    question: "I want to help. What is useful?",
    answer: `Time or money, and both count. Volunteers work events, drive, keep time, and fix things. Sponsors and partners cover the cost of keeping training free for kids. Pick "${programInterestLabels["Volunteer Support"]}" or "${programInterestLabels["Sponsorship / Partnership"]}" in the form and say what you have to offer.`,
  },
  {
    question: "Does sending the form create an account?",
    answer:
      "No. It only tells us you are interested so a person can get back to you. It does not create an account or enroll you in anything.",
  },
];

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      {/* Law 6, warm ground: the public face of the gym belongs on the family
          side of the two-ground split, not the ink leather the staff consoles
          use. Section separation is brass rope trim rather than the 3px black
          rules and alternating tans it replaces — a rule is hardware here. */}
      <main className="on-canvas min-h-screen">
        {/* Hero */}
        <section className="px-[var(--s5)] py-[var(--s6)] sm:py-[var(--s7)] lg:py-[var(--s8)] lg:px-[var(--s6)]">
          <div className="mx-auto flex w-full max-w-[1000px] flex-col items-center text-center">
            {/* Eyebrow hidden on small screens to save vertical space */}
            <p className="t-eyebrow hidden sm:block">Punxsy Prominence Boxing &amp; Fitness</p>
            {/* Hand-painted signage, not the lit registered stencil of
                .t-command: this is the hand-lettered board over the door of a
                community gym. */}
            <h1 className="t-painted mt-[var(--s3)] sm:mt-[var(--s4)]" style={{ fontSize: 'clamp(1.5rem, 5vw, var(--t-2xl))' }}>
              Boxing is the engagement platform.
              <br />
              Youth development is the objective.
            </h1>
            <p className="t-body mt-[var(--s4)] sm:mt-[var(--s5)] max-w-[68ch]" style={{ fontSize: 'clamp(var(--t-sm), 4vw, var(--t-md))' }}>
              Punxsy Prominence Boxing &amp; Fitness is a veteran-led, IRS-recognized 501(c)(3) nonprofit serving youth in
              Punxsutawney and surrounding rural western Pennsylvania communities.
            </p>
            {/* Programs first, sign-in second, and the order is the argument.

                This is the front door of a 501(c)(3), and the person most
                likely to be standing at it is a parent who has never been here
                -- not a member, who knows the way in and does not need the
                brightest object on the page to find it. The filled brass was
                on Log In, so the page's loudest voice spoke to the one visitor
                who needed the least help.

                Both remain one tap away; only the emphasis is swapped. */}
            <div className="mt-[var(--s5)] sm:mt-[var(--s6)] flex flex-wrap items-center justify-center gap-[var(--s3)] sm:gap-[var(--s4)]">
              <a href="#programs" className="btn text-sm sm:text-base">
                Learn About Our Programs
              </a>
              <Link href="/login" className="btn btn--ghost text-sm sm:text-base">
                Log In
              </Link>
            </div>
          </div>
        </section>

        {/* Rope trim as a centred ornament, not a full-bleed rule: run edge to
            edge and repeated down the page, brass rope reads as hazard tape,
            which is a saturated-looking warning the page never means (Law 2).
            89px is the top of the Fibonacci space scale. */}
        <div className="flex justify-center">
          <div className="rope w-[var(--s8)]" />
        </div>

        {/* Mission */}
        <section
          id="mission"
          aria-labelledby="mission-heading"
          className="mx-auto w-full max-w-[1000px] px-[var(--s5)] py-[var(--s7)] lg:px-[var(--s6)]"
        >
          <h2 id="mission-heading" className="t-command" style={{ fontSize: 'var(--t-xl)' }}>
            Our Mission
          </h2>
          <div className="mt-[var(--s5)] grid gap-[var(--s6)] md:grid-cols-2">
            <div>
              <p className="t-body max-w-[72ch]" style={{ fontSize: 'var(--t-md)' }}>
                Punxsy Prominence uses structured boxing and athlete-development programming to help young people build
                discipline, confidence, accountability, emotional control, physical fitness, academic responsibility,
                leadership, decision-making, and practical life skills.
              </p>
            </div>
            <div>
              {/* The load-bearing promise of the organization, so it gets a real
                  object: a framed paper notice rather than a coloured left border.
                  The border it replaces was --red-primary, which aliases to
                  --locked — the safety gate's red. Law 2 spends saturated colour
                  on a participant's safety state and nothing else, and this
                  sentence is the opposite of a warning. (That is about the
                  --locked token. Red itself is not reserved,
                  OD-2026-09-29-001.) */}
              <div className="frame">
                <span className="rivet rivet--tl" />
                <span className="rivet rivet--tr" />
                <span className="rivet rivet--bl" />
                <span className="rivet rivet--br" />
                <div className="frame-in mat-paper" style={{ padding: 'var(--s5) var(--s6)' }}>
                  <p className="t-command" style={{ fontSize: 'var(--t-md)', lineHeight: 1.45 }}>
                    Children participate at no charge. Financial circumstances do not determine whether a child can train.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <div className="flex justify-center">
          <div className="rope w-[var(--s8)]" />
        </div>

        {/* The room. The page said everything and showed nothing — the one
            question a nervous parent cannot settle from prose is what the
            place actually looks like. Three frames from the same manifest the
            dashboards hang (gymPhotos.ts): illustrations today, photographs
            the day somebody commits them, with no layout change either way. */}
        <section
          id="the-room"
          aria-labelledby="room-heading"
          className="mx-auto w-full max-w-[1000px] px-[var(--s5)] py-[var(--s7)] lg:px-[var(--s6)]"
        >
          <h2 id="room-heading" className="t-command" style={{ fontSize: 'var(--t-xl)' }}>
            The Room
          </h2>
          <p className="t-body mt-[var(--s3)] max-w-[68ch]">
            One building in Punxsutawney, supported by donations. Come see it before you commit to anything —
            that is the right way round.
          </p>
          <div className="mt-[var(--s5)] grid gap-[var(--s5)] sm:grid-cols-2 lg:grid-cols-3">
            {gymPhotoSlotsFor('public')
              .filter((slot) => ['entrance', 'floor', 'ring'].includes(slot.key))
              .map((slot) => (
                <PhotoSlot key={slot.key} slot={slot} shape="wide" />
              ))}
          </div>
        </section>

        {/* Proof & Credentials */}
        <div className="flex justify-center">
          <div className="rope w-[var(--s8)]" />
        </div>

        <section
          aria-labelledby="proof-heading"
          className="mx-auto w-full max-w-[1000px] px-[var(--s5)] py-[var(--s7)] lg:px-[var(--s6)]"
        >
          <h2 id="proof-heading" className="t-command" style={{ fontSize: 'var(--t-xl)' }}>
            Proven Track Record
          </h2>
          <p className="t-body mt-[var(--s5)] max-w-[72ch]" style={{ fontSize: 'var(--t-md)' }}>
            Punxsy Prominence was established in {org.established} and serves the Punxsutawney community with
            structured athletic and mentorship programming. Youth train free.
          </p>
          {/* Every number here is one Jason gave on 2026-10-03. The 200+ is
              everyone who has come through the door, not a youth count. */}
          <div className="mt-[var(--s6)] grid gap-[var(--s4)] md:grid-cols-3">
            <div className="rounded-[var(--r-md)] border-2 border-[color:rgb(var(--brass-400-rgb)_/_0.5)] p-[var(--s5)] mat-paper bg-gradient-to-br from-[rgb(var(--brass-400-rgb)_/_0.06)] to-transparent">
              <p className="t-command text-[color:var(--brass-400)]" style={{ fontSize: 'var(--t-2xl)' }}>200+</p>
              <p className="t-body text-[color:var(--bone-600)] mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>People have come through our doors since {org.established}</p>
            </div>
            <div className="rounded-[var(--r-md)] border-2 border-[color:rgb(var(--brass-400-rgb)_/_0.5)] p-[var(--s5)] mat-paper bg-gradient-to-br from-[rgb(var(--brass-400-rgb)_/_0.06)] to-transparent">
              <p className="t-command text-[color:var(--brass-400)]" style={{ fontSize: 'var(--t-2xl)' }}>Free</p>
              <p className="t-body text-[color:var(--bone-600)] mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>For youth. Adults $20 a month.</p>
            </div>
            <div className="rounded-[var(--r-md)] border-2 border-[color:rgb(var(--brass-400-rgb)_/_0.5)] p-[var(--s5)] mat-paper bg-gradient-to-br from-[rgb(var(--brass-400-rgb)_/_0.06)] to-transparent">
              <p className="t-command text-[color:var(--brass-400)]" style={{ fontSize: 'var(--t-2xl)' }}>501(c)(3)</p>
              <p className="t-body text-[color:var(--bone-600)] mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>IRS-recognized nonprofit</p>
            </div>
          </div>
        </section>

        {/* Programs */}
        <div className="flex justify-center">
          <div className="rope w-[var(--s8)]" />
        </div>

        <section
          id="programs"
          aria-labelledby="programs-heading"
          className="mx-auto w-full max-w-[1000px] px-[var(--s5)] py-[var(--s7)] lg:px-[var(--s6)]"
        >
          <h2 id="programs-heading" className="t-command" style={{ fontSize: 'var(--t-xl)' }}>
            Programs
          </h2>
          <p className="t-body mt-[var(--s5)] max-w-[72ch]" style={{ fontSize: 'var(--t-md)' }}>
            Not everybody in this building is training to fight. Most are not. Every athlete progresses at their own
            pace, and sparring and competition are optional next steps for athletes who are ready and choose that path
            &mdash; not a requirement of participation.
          </p>
          {/* Paper cards on canvas: the programme list is the printed handout
              on the counter, so it is paper rather than another frame. */}
          <div className="mt-[var(--s6)] grid gap-[var(--s4)] md:grid-cols-2">
            {programCards.map((program) => (
              <article
                key={program.title}
                className="mat-paper rounded-[var(--r-md)] border border-[color:rgb(var(--brass-800-rgb)_/_0.34)] p-[var(--s5)]"
              >
                <h3 className="t-command" style={{ fontSize: 'var(--t-md)' }}>
                  {program.title}
                </h3>
                <p className="t-body mt-[var(--s3)]">{program.whatItIs}</p>
                <p className="t-body mt-[var(--s2)]"><strong>Who it is for:</strong> {program.whoFor}</p>
                <p className="t-body mt-[var(--s2)]"><strong>How to start:</strong> {program.nextStep}</p>
              </article>
            ))}
          </div>
        </section>

        {/* How we train: the five principles from #1170, under every program above. */}
        <div className="flex justify-center">
          <div className="rope w-[var(--s8)]" />
        </div>

        <section
          id="how-we-train"
          aria-labelledby="how-we-train-heading"
          className="mx-auto w-full max-w-[1000px] px-[var(--s5)] py-[var(--s7)] lg:px-[var(--s6)]"
        >
          <h2 id="how-we-train-heading" className="t-command" style={{ fontSize: 'var(--t-xl)' }}>
            How We Train
          </h2>
          <div className="mt-[var(--s6)] grid gap-[var(--s4)] md:grid-cols-2">
            {approach.map((item, index) => (
              <article
                key={item.title}
                className="mat-paper rounded-[var(--r-md)] border border-[color:rgb(var(--brass-800-rgb)_/_0.34)] p-[var(--s5)]"
              >
                <div className="flex items-start gap-[var(--s3)]">
                  {/* brass-800, the canvas rung: --brass-500 measured 2.48:1 on
                      the paper card. */}
                  <div className="text-[color:var(--brass-800)] text-lg font-bold leading-none mt-0.5 flex-shrink-0">
                    {String(index + 1).padStart(2, '0')}
                  </div>
                  <div className="flex-1">
                    <h3 className="t-command" style={{ fontSize: 'var(--t-md)' }}>
                      {item.title}
                    </h3>
                    <p className="t-body mt-[var(--s3)]">{item.description}</p>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* Get in touch: the interest form moved from /public. */}
        <div className="flex justify-center">
          <div className="rope w-[var(--s8)]" />
        </div>

        <section
          id="interest-intake"
          aria-labelledby="interest-heading"
          className="mx-auto w-full max-w-[1000px] px-[var(--s5)] py-[var(--s7)] lg:px-[var(--s6)]"
        >
          <div className="rounded-[var(--r-lg)] border-2 border-[color:rgb(var(--brass-400-rgb)_/_0.4)] p-[var(--s6)] mat-paper">
            <h2 id="interest-heading" className="t-command" style={{ fontSize: 'var(--t-xl)' }}>
              Get in Touch
            </h2>
            <p className="t-body mt-[var(--s4)] max-w-[68ch]" style={{ fontSize: 'var(--t-md)' }}>
              This is not an application and it does not sign you or your kid up for anything. Tell us what you are
              looking for and a person here will get back to you. Your name and an email are all we need. You can also
              email <a href={`mailto:${org.email}`}>{org.email}</a> or come by {physicalAddress}.
            </p>
            <PublicInterestForm />
          </div>
        </section>

        {/* FAQ, moved from /public. Native disclosure: no client state. */}
        <div className="flex justify-center">
          <div className="rope w-[var(--s8)]" />
        </div>

        <section
          id="public-faq"
          aria-labelledby="faq-heading"
          className="mx-auto w-full max-w-[1000px] px-[var(--s5)] py-[var(--s7)] lg:px-[var(--s6)]"
        >
          <h2 id="faq-heading" className="t-command" style={{ fontSize: 'var(--t-xl)' }}>
            Questions People Ask
          </h2>
          <div className="mt-[var(--s5)] grid gap-[var(--s2)]">
            {faqItems.map((item) => (
              <details
                key={item.question}
                className="mat-paper rounded-[var(--r-md)] border border-[color:rgb(var(--brass-800-rgb)_/_0.34)]"
              >
                <summary className="flex min-h-[44px] cursor-pointer items-center px-[var(--s4)] py-[var(--s2)] t-body font-semibold">
                  {item.question}
                </summary>
                <p className="t-body px-[var(--s4)] pb-[var(--s3)]">{item.answer}</p>
              </details>
            ))}
          </div>
        </section>

        {/* Technology */}
        <div className="flex justify-center">
          <div className="rope w-[var(--s8)]" />
        </div>

        <section
          id="technology"
          aria-labelledby="technology-heading"
          className="mx-auto w-full max-w-[1000px] px-[var(--s5)] py-[var(--s7)] lg:px-[var(--s6)]"
        >
          <h2 id="technology-heading" className="t-command" style={{ fontSize: 'var(--t-xl)' }}>
            Technology Supporting Development
          </h2>
          <p className="t-body mt-[var(--s5)] max-w-[72ch]" style={{ fontSize: 'var(--t-md)' }}>
            Punxsy Prominence is developing the SHADOW application to support coaching, athlete development, program
            access, progress tracking, evidence-informed learning, and continuous organizational improvement. SHADOW
            is a decision-support and learning system in development; it does not replace coaches, medical
            professionals, or responsible human decision-making.
          </p>
        </section>

        {/* Nonprofit and Leadership Information */}
        <div className="flex justify-center">
          <div className="rope w-[var(--s8)]" />
        </div>

        <section
          id="about"
          aria-labelledby="about-heading"
          className="mx-auto w-full max-w-[1000px] px-[var(--s5)] py-[var(--s7)] lg:px-[var(--s6)]"
        >
          <h2 id="about-heading" className="t-command" style={{ fontSize: 'var(--t-xl)' }}>
            Nonprofit &amp; Leadership
          </h2>
          {/* Law 4: mono records. These are registry facts a grant officer
              checks against a filing, not prose — the same voice the ledger
              and audit surfaces use for anything auditable. */}
          <dl className="mt-[var(--s6)] grid gap-[var(--s5)] md:grid-cols-2">
              <div>
                <dt className="t-label">
                  Legal Name
                </dt>
                <dd className="t-data mt-[var(--s2)]">{org.legalName}</dd>
              </div>
              <div>
                <dt className="t-label">
                  Organization Type
                </dt>
                <dd className="t-data mt-[var(--s2)]">IRS-recognized 501(c)(3) nonprofit</dd>
              </div>
              <div>
                <dt className="t-label">
                  EIN
                </dt>
                <dd className="t-data mt-[var(--s2)]">EIN {org.ein}</dd>
              </div>
              <div>
                <dt className="t-label">
                  Established
                </dt>
                <dd className="t-data mt-[var(--s2)]">{org.established}</dd>
              </div>
              <div>
                <dt className="t-label">
                  Physical Address
                </dt>
                <dd className="t-data mt-[var(--s2)]">{physicalAddress}</dd>
              </div>
              <div>
                <dt className="t-label">
                  Mailing Address
                </dt>
                <dd className="t-data mt-[var(--s2)]">{org.mailing}</dd>
              </div>
              <div>
                <dt className="t-label">
                  Primary Service Area
                </dt>
                <dd className="t-data mt-[var(--s2)]">
                  Punxsutawney and surrounding rural Pennsylvania communities
                </dd>
              </div>
              <div>
                <dt className="t-label">
                  Head Coach / Governor
                </dt>
                <dd className="t-data mt-[var(--s2)]">Jason Neale</dd>
              </div>
              <div className="md:col-span-2">
                <dt className="t-label">
                  Official Contact
                </dt>
                <dd className="t-data mt-[var(--s2)]">
                  <a href={`mailto:${org.email}`}>{org.email}</a>
                </dd>
              </div>
              <div className="md:col-span-2">
                <dt className="t-label">
                  Official Website
                </dt>
                <dd className="t-data mt-[var(--s2)]">{domainStatement}</dd>
              </div>
          </dl>
        </section>

        {/* Support. Two monitored addresses and no payment button: there is no
            donation channel to point one at yet, and a button that goes nowhere
            is the one thing this page must not ship. */}
        <div className="flex justify-center">
          <div className="rope w-[var(--s8)]" />
        </div>

        <section
          id="support"
          aria-labelledby="support-heading"
          className="mx-auto w-full max-w-[1000px] px-[var(--s5)] py-[var(--s7)] lg:px-[var(--s6)]"
        >
          <h2 id="support-heading" className="t-command" style={{ fontSize: 'var(--t-xl)' }}>
            Support PPBF
          </h2>
          <dl className="mt-[var(--s5)] grid gap-[var(--s5)] md:grid-cols-2">
            <div>
              <dt className="t-label">Donations</dt>
              <dd className="t-data mt-[var(--s2)]">
                <a href={`mailto:${org.donationsEmail}`}>{org.donationsEmail}</a>
              </dd>
            </div>
            <div>
              <dt className="t-label">Grants and Funders</dt>
              <dd className="t-data mt-[var(--s2)]">
                <a href={`mailto:${org.grantsEmail}`}>{org.grantsEmail}</a>
              </dd>
            </div>
          </dl>
        </section>

        {/* Footer */}
        <div className="flex justify-center">
          <div className="rope w-[var(--s8)]" />
        </div>

        <footer className="px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          <div className="mx-auto flex w-full max-w-[1000px] flex-col items-center gap-[var(--s3)] text-center">
            <p className="t-command" style={{ fontSize: 'var(--t-md)' }}>
              {org.legalName}
            </p>
            <p className="t-body">501(c)(3) nonprofit &middot; EIN {org.ein}</p>
            <p className="t-body">{physicalAddress}</p>
            <p className="t-body">{domainStatement}</p>
            <p className="t-data">
              <a href={`mailto:${org.email}`}>{org.email}</a>
            </p>
            <Link href="/login" className="btn btn--ghost mt-[var(--s2)]">
              Log In
            </Link>
            <p className="t-muted mt-[var(--s3)]">
              &copy; {new Date().getFullYear()} {org.legalName}. All rights reserved.
            </p>
          </div>
        </footer>
      </main>
    </>
  );
}
