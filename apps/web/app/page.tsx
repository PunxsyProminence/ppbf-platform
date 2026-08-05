import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Punxsy Prominence Boxing & Fitness",
  description:
    "Punxsy Prominence Boxing & Fitness is an IRS-recognized 501(c)(3) nonprofit using structured boxing and athlete-development programming to serve youth in Punxsutawney and surrounding rural western Pennsylvania communities. Children participate at no charge.",
};

const structuredData = {
  "@context": "https://schema.org",
  "@type": "NGO",
  name: "Punxsy Prominence Boxing & Fitness",
  alternateName: "PPBF",
  description:
    "IRS-recognized 501(c)(3) nonprofit using structured boxing and athlete-development programming to help young people build discipline, confidence, accountability, and practical life skills.",
  email: "admin@punxsyprominence.org",
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

const programs = [
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
                .t-command: this is the board over the door of a gym that has
                been run on donations for forty years. */}
            <h1 className="t-painted mt-[var(--s3)] sm:mt-[var(--s4)]" style={{ fontSize: 'clamp(1.5rem, 5vw, var(--t-2xl))' }}>
              Boxing is the engagement platform.
              <br />
              Youth development is the objective.
            </h1>
            <p className="t-body mt-[var(--s4)] sm:mt-[var(--s5)] max-w-[68ch]" style={{ fontSize: 'clamp(var(--t-sm), 4vw, var(--t-md))' }}>
              Punxsy Prominence Boxing &amp; Fitness is an IRS-recognized 501(c)(3) nonprofit serving youth in
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
                  sentence is the opposite of a warning. */}
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
            Punxsy Prominence has been serving the Punxsutawney community since 2020, providing structured athletic and mentorship programming to hundreds of young people at no cost.
          </p>
          <div className="mt-[var(--s6)] grid gap-[var(--s4)] md:grid-cols-3">
            <div className="rounded-[var(--r-md)] border-2 border-[color:rgba(212,175,74,0.5)] p-[var(--s5)] mat-paper bg-gradient-to-br from-[rgba(212,175,74,0.06)] to-transparent">
              <p className="t-command text-[color:var(--brass-400)]" style={{ fontSize: 'var(--t-2xl)' }}>500+</p>
              <p className="t-body text-[var(--bone-600)] mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>Youth trained since 2020</p>
            </div>
            <div className="rounded-[var(--r-md)] border-2 border-[color:rgba(212,175,74,0.5)] p-[var(--s5)] mat-paper bg-gradient-to-br from-[rgba(212,175,74,0.06)] to-transparent">
              <p className="t-command text-[color:var(--brass-400)]" style={{ fontSize: 'var(--t-2xl)' }}>100%</p>
              <p className="t-body text-[var(--bone-600)] mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>Free to participate</p>
            </div>
            <div className="rounded-[var(--r-md)] border-2 border-[color:rgba(212,175,74,0.5)] p-[var(--s5)] mat-paper bg-gradient-to-br from-[rgba(212,175,74,0.06)] to-transparent">
              <p className="t-command text-[color:var(--brass-400)]" style={{ fontSize: 'var(--t-2xl)' }}>501(c)(3)</p>
              <p className="t-body text-[var(--bone-600)] mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>IRS-recognized nonprofit</p>
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
            Every athlete progresses at their own pace. Sparring and competition are optional next steps for athletes
            who are ready and choose that path &mdash; not a requirement of participation.
          </p>
          {/* Paper cards on canvas: the programme list is the printed handout
              on the counter, so it is paper rather than another frame. Five
              riveted frames on one page would make the hardware the message,
              which is exactly what Law 1 forbids. */}
          <div className="mt-[var(--s6)] grid gap-[var(--s4)] md:grid-cols-2">
            {programs.map((program, index) => (
              <article
                key={program.title}
                className="mat-paper rounded-[var(--r-md)] border border-[color:rgba(107,78,18,0.34)] p-[var(--s5)] transition-all hover:border-[color:rgba(212,175,74,0.5)] hover:shadow-md"
              >
                <div className="flex items-start gap-[var(--s3)]">
                  <div className="text-[color:var(--brass-500)] text-lg font-bold leading-none mt-0.5 flex-shrink-0">
                    {String(index + 1).padStart(2, '0')}
                  </div>
                  <div className="flex-1">
                    <h3 className="t-command" style={{ fontSize: 'var(--t-md)' }}>
                      {program.title}
                    </h3>
                    <p className="t-body mt-[var(--s3)]">{program.description}</p>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* Questions Section */}
        <div className="flex justify-center">
          <div className="rope w-[var(--s8)]" />
        </div>

        <section
          aria-labelledby="questions-heading"
          className="mx-auto w-full max-w-[1000px] px-[var(--s5)] py-[var(--s7)] lg:px-[var(--s6)]"
        >
          <div className="rounded-[var(--r-lg)] border-2 border-[color:rgba(212,175,74,0.4)] p-[var(--s6)] mat-paper">
            <h2 id="questions-heading" className="t-command text-center" style={{ fontSize: 'var(--t-xl)' }}>
              Questions?
            </h2>
            <p className="t-body text-center mt-[var(--s4)] max-w-[68ch] mx-auto" style={{ fontSize: 'var(--t-md)' }}>
              We&apos;re here to help. Reach out with any questions about our programs, enrollment, or how Punxsy Prominence can serve your family.
            </p>
            <div className="flex justify-center mt-[var(--s6)]">
              <a href="mailto:admin@punxsyprominence.org" className="btn">
                Get in Touch
              </a>
            </div>
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
                <dd className="t-data mt-[var(--s2)]">Punxsy Prominence Boxing &amp; Fitness</dd>
              </div>
              <div>
                <dt className="t-label">
                  Organization Type
                </dt>
                <dd className="t-data mt-[var(--s2)]">IRS-recognized 501(c)(3) nonprofit</dd>
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
                  <a href="mailto:admin@punxsyprominence.org">admin@punxsyprominence.org</a>
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
              Punxsy Prominence Boxing &amp; Fitness
            </p>
            <p className="t-body">501(c)(3) nonprofit</p>
            <p className="t-data">
              <a href="mailto:admin@punxsyprominence.org">admin@punxsyprominence.org</a>
            </p>
            <Link href="/login" className="btn btn--ghost mt-[var(--s2)]">
              Log In
            </Link>
            <p className="t-muted mt-[var(--s3)]">
              &copy; {new Date().getFullYear()} Punxsy Prominence Boxing &amp; Fitness. All rights reserved.
            </p>
          </div>
        </footer>
      </main>
    </>
  );
}
